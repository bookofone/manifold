const { app, BrowserWindow, ipcMain, dialog, Menu, screen, nativeImage, clipboard } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const pty = require('node-pty');
const crypto = require('crypto');
const dns = require('dns');
const { exec } = require('child_process');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

// Set Linux WM_CLASS so desktop environment uses our icon
if (!IS_WIN && !IS_MAC) app.setName('manifold');

const TOOL_CMD = 'claude --dangerously-skip-permissions';

const STATE_DIR = path.join(app.getPath('userData'), 'state');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

let mainWindow = null;
const terminals = new Map();

// ── Platform helpers ──

function winToWslPath(winPath) {
  if (!winPath || !IS_WIN) return winPath;
  const m = winPath.match(/^([A-Za-z]):[/\\](.*)/);
  if (!m) return winPath;
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
}

function getToolCmd() {
  return process.env.MANIFOLD_CMD || TOOL_CMD;
}

function createWindow() {
  const primary = screen.getPrimaryDisplay();
  const { x, y, width, height } = primary.workArea;

  mainWindow = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    icon: nativeImage.createFromPath(path.join(__dirname, 'icon.png')),
    backgroundColor: '#1a1a1a',
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.maximize();

  mainWindow.on('focus', () => {
    mainWindow.webContents.send('window-focus');
  });

  mainWindow.on('close', (e) => {
    e.preventDefault();
    mainWindow.webContents.send('save-state');
    // Wait for renderer to confirm save, with a safety timeout
    ipcMain.once('save-state-done', () => {
      destroyAllTerminals();
      destroyAllConductors();
      mainWindow.destroy();
    });
    setTimeout(() => {
      destroyAllTerminals();
      destroyAllConductors();
      mainWindow.destroy();
    }, 2000);
  });
}

function destroyAllTerminals() {
  for (const [id, term] of terminals) {
    if (term.flushInterval) clearInterval(term.flushInterval);
    try { term.pty.kill(); } catch (_) {}
  }
  terminals.clear();
}

// ── Environment ──

ipcMain.handle('get-home-dir', () => os.homedir());
ipcMain.handle('get-platform', () => process.platform);

// Clipboard — must go through main process because sandboxed preload scripts
// don't have access to Electron's clipboard module on Windows.
ipcMain.handle('clipboard-read', () => {
  try { return clipboard.readText(); } catch (e) { return ''; }
});
ipcMain.handle('clipboard-write', (_, text) => {
  try { clipboard.writeText(text); } catch (_) {}
});

// ── SSH helpers ──

function sendTerminalMsg(id, msg) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('terminal-data', { id, data: `\r\n\x1b[33m[SSH] ${msg}\x1b[0m\r\n` });
  }
}

function buildRemoteCmd(sshParams) {
  const { remotePath, shellOnly, customCmd, conversationId } = sshParams;
  if (shellOnly) return `cd "${remotePath}"`;
  if (customCmd) return `cd "${remotePath}" && ${customCmd}`;
  const toolArgs = conversationId ? `${getToolCmd()} --resume ${conversationId}` : getToolCmd();
  return `cd "${remotePath}" && ${toolArgs}`;
}

function spawnSshPty(id, sshParams) {
  const { remote, cleanEnv } = sshParams;
  const parts = remote.trim().split(/\s+/);
  const sshBin = parts[0];
  const sshTargetArgs = parts.slice(1);
  const remoteCmd = buildRemoteCmd(sshParams);

  // Add ServerAliveInterval to detect dead connections faster
  const sshOpts = ['-t', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];

  const ptyProcess = IS_WIN
    ? pty.spawn('wsl.exe', [sshBin, ...sshOpts, ...sshTargetArgs], {
        name: 'xterm-256color', cols: 120, rows: 30, env: cleanEnv,
      })
    : pty.spawn(sshBin, [...sshOpts, ...sshTargetArgs], {
        name: 'xterm-256color', cols: 120, rows: 30, env: cleanEnv,
      });

  // After SSH connects, send the cd + command
  let sshReady = false;
  let sshDataCount = 0;
  const onSshData = (data) => {
    sshDataCount += data.length;
    if (!sshReady && sshDataCount > 20) {
      sshReady = true;
      ptyProcess.removeListener('data', onSshData);
      setTimeout(() => {
        try { ptyProcess.write(remoteCmd + '\r'); } catch (_) {}
      }, 300);
    }
  };
  ptyProcess.on('data', onSshData);

  return ptyProcess;
}

function wireUpSshPty(id, ptyProcess, sshParams) {
  const term = terminals.get(id);
  if (!term) return;

  // Clean up old flush interval
  if (term.flushInterval) clearInterval(term.flushInterval);

  // Set up data batching for this pty
  let chunks = [];
  let chunkBytes = 0;

  ptyProcess.onData((data) => {
    chunks.push(data);
    chunkBytes += data.length;
  });

  const flushInterval = setInterval(() => {
    if (chunkBytes > 0 && mainWindow && !mainWindow.isDestroyed()) {
      const batch = chunks.length === 1 ? chunks[0] : chunks.join('');
      chunks = [];
      chunkBytes = 0;
      mainWindow.webContents.send('terminal-data', { id, data: batch });
    }
  }, 16);

  // Handle exit — attempt reconnection
  ptyProcess.onExit(() => {
    const t = terminals.get(id);
    if (!t || t.sshDead) return; // already handling reconnect or terminal was destroyed
    t.alive = false;
    if (t.flushInterval) clearInterval(t.flushInterval);
    attemptSshReconnect(id, sshParams, 0);
  });

  // Update terminal entry
  term.pty = ptyProcess;
  term.alive = true;
  term.flushInterval = flushInterval;
  term.sshDead = false;

  // Sync size: get current terminal size from renderer
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('terminal-request-size', { id });
  }
}

const SSH_RECONNECT_DELAYS = [3, 6, 15]; // seconds between attempts
const SSH_MAX_ATTEMPTS = SSH_RECONNECT_DELAYS.length;

function attemptSshReconnect(id, sshParams, attempt) {
  const term = terminals.get(id);
  if (!term) return;

  if (attempt >= SSH_MAX_ATTEMPTS) {
    term.sshDead = true;
    sendTerminalMsg(id, 'Connection lost. Max reconnection attempts reached. Close and reopen the tab to retry.');
    return;
  }

  const delay = SSH_RECONNECT_DELAYS[attempt];
  sendTerminalMsg(id, `Connection lost. Reconnecting in ${delay}s... (attempt ${attempt + 1}/${SSH_MAX_ATTEMPTS})`);

  term.sshReconnectTimer = setTimeout(() => {
    const t = terminals.get(id);
    if (!t) return; // terminal was destroyed while waiting

    sendTerminalMsg(id, 'Reconnecting...');
    try {
      const newPty = spawnSshPty(id, sshParams);
      wireUpSshPty(id, newPty, sshParams);
      sendTerminalMsg(id, 'Reconnected.');
    } catch (err) {
      sendTerminalMsg(id, `Reconnection failed: ${err.message}`);
      attemptSshReconnect(id, sshParams, attempt + 1);
    }
  }, delay * 1000);
}

// ── Terminal management ──

ipcMain.handle('terminal-create', (event, { id, cwd, conversationId, name, collectionName, prompt, shell: shellOnly, cmd: customCmd, provider, sessionId, resume, remote }) => {
  const home = os.homedir();
  const dir = cwd || home;

  const cleanEnv = { ...process.env, HOME: home };
  delete cleanEnv.CLAUDECODE;
  delete cleanEnv.CLAUDE_CODE_ENTRYPOINT;

  let ptyProcess;
  let initialPrompt = prompt || null;

  if (remote) {
    // Remote SSH session — parse user's SSH command, spawn directly
    const remotePath = cwd || '/';
    const sshParams = { remote, remotePath, shellOnly, customCmd, conversationId, cleanEnv };

    ptyProcess = spawnSshPty(id, sshParams);
    initialPrompt = null;
  } else if (provider === 'copilot') {
    const copilotCmd = resume
      ? `copilot --yolo --resume "${sessionId}"`
      : `copilot --yolo --session-id "${sessionId}"`;
    if (IS_WIN) {
      const wslDir = winToWslPath(dir);
      const shellCmd = `cd "${wslDir}" && ${copilotCmd}; exec bash`;
      ptyProcess = pty.spawn('wsl.exe', ['bash', '-c', shellCmd], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: dir,
        env: cleanEnv,
      });
    } else {
      const userShell = process.env.SHELL || '/bin/bash';
      const runCmd = `cd "${dir}" && ${copilotCmd}; exec ${userShell}`;
      ptyProcess = pty.spawn(userShell, ['-c', runCmd], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: dir,
        env: cleanEnv,
      });
    }
  } else if (customCmd) {
    // Custom command terminal
    if (IS_WIN) {
      const wslDir = winToWslPath(dir);
      const shellCmd = `cd "${wslDir}" && ${customCmd}; exec bash`;
      ptyProcess = pty.spawn('wsl.exe', ['bash', '-c', shellCmd], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: dir,
        env: cleanEnv,
      });
    } else {
      const userShell = process.env.SHELL || '/bin/bash';
      const runCmd = `cd "${dir}" && ${customCmd}; exec ${userShell}`;
      ptyProcess = pty.spawn(userShell, ['-c', runCmd], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: dir,
        env: cleanEnv,
      });
    }
  } else if (shellOnly) {
    // Plain terminal — no Claude
    if (IS_WIN) {
      const wslDir = winToWslPath(dir);
      ptyProcess = pty.spawn('wsl.exe', ['bash', '-c', `cd "${wslDir}" && exec bash`], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: dir,
        env: cleanEnv,
      });
    } else {
      const userShell = process.env.SHELL || '/bin/bash';
      ptyProcess = pty.spawn(userShell, [], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: dir,
        env: cleanEnv,
      });
    }
  } else {
    // Build tool command with resume support
    let toolArgs;
    if (conversationId) {
      toolArgs = `${getToolCmd()} --resume "${conversationId}"`;
    } else {
      toolArgs = getToolCmd();
    }

    if (IS_WIN) {
      const wslDir = winToWslPath(dir);
      const shellCmd = `cd "${wslDir}" && ${toolArgs}; exec bash`;
      ptyProcess = pty.spawn('wsl.exe', ['bash', '-c', shellCmd], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: dir,
        env: cleanEnv,
      });
    } else {
      const userShell = process.env.SHELL || '/bin/bash';
      const cmd = `cd "${dir}" && ${toolArgs}`;
      ptyProcess = pty.spawn(userShell, ['-c', `${cmd}; exec ${userShell}`], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: dir,
        env: cleanEnv,
      });
    }
  }

  // ── Data batching & exit handling ──
  let flushInterval;

  if (remote) {
    // SSH terminals: register in map first, then wire up (enables reconnection)
    const sshParams = { remote, remotePath: cwd || '/', shellOnly, customCmd, conversationId, cleanEnv };
    terminals.set(id, {
      pty: ptyProcess,
      alive: true,
      conversationId: conversationId || null,
      spawnTime: Date.now(),
      projectDir: null,
      convoCheck: null,
      flushInterval: null,
      sshParams,
      sshDead: false,
      sshReconnectTimer: null,
    });
    wireUpSshPty(id, ptyProcess, sshParams);
    return { id };
  }

  // Non-SSH terminals: accumulate PTY output, flush every 16ms
  let chunks = [];
  let chunkBytes = 0;

  ptyProcess.onData((data) => {
    chunks.push(data);
    chunkBytes += data.length;
  });

  flushInterval = setInterval(() => {
    if (chunkBytes > 0 && mainWindow && !mainWindow.isDestroyed()) {
      const batch = chunks.length === 1 ? chunks[0] : chunks.join('');
      chunks = [];
      chunkBytes = 0;
      mainWindow.webContents.send('terminal-data', { id, data: batch });
    }
  }, 16);

  ptyProcess.onExit(() => {
    const term = terminals.get(id);
    if (term) {
      term.alive = false;
      if (term.flushInterval) clearInterval(term.flushInterval);
    }
  });

  // Conversation ID detection — find the most recently modified .jsonl after spawn
  const isNonClaude = shellOnly || customCmd || provider === 'copilot';
  const projectDir = isNonClaude ? null : getProjectDir(dir);
  const spawnTime = Date.now();
  let detectedConvoId = conversationId || null;

  let convoCheck = null;
  if (!conversationId && !isNonClaude) {
    let checks = 0;
    convoCheck = setInterval(() => {
      checks++;
      try {
        const files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
        let best = null;
        let bestMtime = 0;
        for (const f of files) {
          try {
            const stat = fs.statSync(path.join(projectDir, f));
            if (stat.mtimeMs > spawnTime && stat.mtimeMs > bestMtime) {
              bestMtime = stat.mtimeMs;
              best = f.replace('.jsonl', '');
            }
          } catch (_) {}
        }
        if (best) {
          detectedConvoId = best;
          const term = terminals.get(id);
          if (term) term.conversationId = best;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('conversation-detected', { id, conversationId: best });
          }
          clearInterval(convoCheck);
        }
      } catch (_) {}
      if (checks > 60) clearInterval(convoCheck);
    }, 1000);
  }

  terminals.set(id, {
    pty: ptyProcess,
    alive: true,
    conversationId: detectedConvoId,
    spawnTime,
    projectDir,
    convoCheck,
    flushInterval,
  });

  // If there's an initial prompt, wait for Claude to start then type it in
  if (initialPrompt) {
    let prompted = false;
    let dataCount = 0;
    const onData = (data) => {
      dataCount += data.length;
      if (!prompted && dataCount > 100) {
        prompted = true;
        ptyProcess.removeListener('data', onData);
        setTimeout(() => {
          ptyProcess.write(initialPrompt + '\r');
        }, 500);
      }
    };
    ptyProcess.on('data', onData);
  }

  return { id };
});

ipcMain.on('terminal-input', (event, { id, data }) => {
  const term = terminals.get(id);
  if (term && term.alive) {
    try { term.pty.write(data); } catch (_) {}
  }
});

ipcMain.on('terminal-resize', (event, { id, cols, rows }) => {
  const term = terminals.get(id);
  if (term && term.alive) {
    try { term.pty.resize(cols, rows); } catch (_) {}
  }
});

ipcMain.on('terminal-destroy', (event, { id }) => {
  const term = terminals.get(id);
  if (term) {
    if (term.sshReconnectTimer) clearTimeout(term.sshReconnectTimer);
    term.sshDead = true; // prevent reconnection attempts
    if (term.convoCheck) clearInterval(term.convoCheck);
    if (term.flushInterval) clearInterval(term.flushInterval);
    try { term.pty.kill(); } catch (_) {}
    terminals.delete(id);
  }
});

ipcMain.handle('terminal-is-active', (event, { id }) => {
  const term = terminals.get(id);
  return !!(term && term.alive);
});

// Manual SSH reconnection (e.g. after max attempts exhausted)
ipcMain.handle('terminal-reconnect', (event, { id }) => {
  const term = terminals.get(id);
  if (!term || !term.sshParams) return { ok: false, error: 'Not an SSH terminal' };
  if (term.alive) return { ok: false, error: 'Terminal is still alive' };

  // Cancel any pending reconnect timer
  if (term.sshReconnectTimer) clearTimeout(term.sshReconnectTimer);
  term.sshDead = false;

  sendTerminalMsg(id, 'Reconnecting...');
  try {
    const newPty = spawnSshPty(id, term.sshParams);
    wireUpSshPty(id, newPty, term.sshParams);
    sendTerminalMsg(id, 'Reconnected.');
    return { ok: true };
  } catch (err) {
    sendTerminalMsg(id, `Reconnection failed: ${err.message}`);
    term.sshDead = true;
    return { ok: false, error: err.message };
  }
});

// Get the detected conversation ID for a terminal
ipcMain.handle('terminal-get-conversation-id', (event, { id }) => {
  const term = terminals.get(id);
  if (!term) return null;

  if (term.conversationId) return term.conversationId;

  // Fallback: find the most recently modified .jsonl in the project dir
  if (term.projectDir) {
    try {
      const files = fs.readdirSync(term.projectDir).filter(f => f.endsWith('.jsonl'));
      let best = null;
      let bestMtime = 0;
      // First try: files modified after spawn
      for (const f of files) {
        try {
          const stat = fs.statSync(path.join(term.projectDir, f));
          if (stat.mtimeMs > (term.spawnTime || 0) && stat.mtimeMs > bestMtime) {
            bestMtime = stat.mtimeMs;
            best = f.replace('.jsonl', '');
          }
        } catch (_) {}
      }
      // Second try: if nothing found, pick the most recently modified file overall
      if (!best) {
        for (const f of files) {
          try {
            const stat = fs.statSync(path.join(term.projectDir, f));
            if (stat.mtimeMs > bestMtime) {
              bestMtime = stat.mtimeMs;
              best = f.replace('.jsonl', '');
            }
          } catch (_) {}
        }
      }
      if (best) {
        term.conversationId = best;
        return best;
      }
    } catch (_) {}
  }

  return null;
});

// ── Conversation tracking helpers ──

function getProjectDir(cwd) {
  const encoded = cwd.replace(/[^a-zA-Z0-9._-]/g, '-');
  return path.join(os.homedir(), '.claude', 'projects', encoded);
}

function listConversations(projectDir) {
  try {
    return fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => f.replace('.jsonl', ''));
  } catch (_) {
    return [];
  }
}

// ── Scan for conversation by cwd (last resort) ──

ipcMain.handle('scan-conversation', (event, { cwd }) => {
  if (!cwd) return null;
  const projectDir = getProjectDir(cwd);
  try {
    const files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
    let best = null;
    let bestMtime = 0;
    for (const f of files) {
      try {
        const stat = fs.statSync(path.join(projectDir, f));
        if (stat.mtimeMs > bestMtime) {
          bestMtime = stat.mtimeMs;
          best = f.replace('.jsonl', '');
        }
      } catch (_) {}
    }
    return best;
  } catch (_) {}
  return null;
});

// ── Fork conversation ──

ipcMain.handle('fork-conversation', (event, { conversationId, cwd }) => {
  if (!conversationId || !cwd) return null;
  const projectDir = getProjectDir(cwd);
  const srcFile = path.join(projectDir, conversationId + '.jsonl');
  if (!fs.existsSync(srcFile)) return null;
  const newId = crypto.randomUUID();
  const dstFile = path.join(projectDir, newId + '.jsonl');
  fs.copyFileSync(srcFile, dstFile);
  return newId;
});

// ── State persistence ──

ipcMain.handle('save-state', (event, state) => {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    return true;
  } catch (e) {
    console.error('Failed to save state:', e);
    return false;
  }
});

ipcMain.handle('load-state', () => {
  try {
    const data = fs.readFileSync(STATE_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    return null;
  }
});

// ── Folder picker ──

ipcMain.handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'New Collection — Select Project Folder',
    defaultPath: os.homedir(),
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// ── SSH remote helpers ──

ipcMain.handle('ssh-ls', async (event, { cmd, remotePath }) => {
  return new Promise((resolve) => {
    const { spawn } = require('child_process');

    // Parse user's SSH command and inject options + remote ls command
    const parts = cmd.trim().split(/\s+/);
    // e.g. ["ssh", "gs6-term"] → ["ssh", opts..., "gs6-term", "ls", "-1AF", "/path"]
    const sshBin = parts[0]; // "ssh"
    const sshTargetArgs = parts.slice(1); // ["gs6-term"] or ["-i", "key", "user@host"]
    const fullArgs = ['-o', 'RequestTTY=no', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', ...sshTargetArgs, 'ls', '-1AF', remotePath];

    const proc = IS_WIN
      ? spawn('wsl.exe', [sshBin, ...fullArgs])
      : spawn(sshBin, fullArgs);

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });

    const timer = setTimeout(() => { proc.kill(); resolve({ error: 'Timeout' }); }, 10000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ error: stderr.trim() || `Exit code ${code}` });
        return;
      }
      const entries = stdout.trim().split('\n').filter(Boolean);
      const dirs = entries
        .filter(e => e.endsWith('/'))
        .map(e => e.slice(0, -1))
        .filter(e => !e.startsWith('.'))
        .sort();
      resolve({ dirs, path: remotePath });
    });
  });
});

ipcMain.handle('ssh-test', async (event, { cmd }) => {
  return new Promise((resolve) => {
    const { spawn } = require('child_process');

    const parts = cmd.trim().split(/\s+/);
    const sshBin = parts[0];
    const sshTargetArgs = parts.slice(1);
    const fullArgs = ['-o', 'RequestTTY=no', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', ...sshTargetArgs, 'echo', 'ok'];

    const proc = IS_WIN
      ? spawn('wsl.exe', [sshBin, ...fullArgs])
      : spawn(sshBin, fullArgs);

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });

    const timer = setTimeout(() => { proc.kill(); resolve({ ok: false, error: 'Timeout' }); }, 10000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve({ ok: false, error: stderr.trim() || `Exit code ${code}` });
      } else {
        resolve({ ok: stdout.trim() === 'ok' });
      }
    });
  });
});

// ── Tailscale ──
//
// A Tailscale remote is still just `ssh user@host` — the tailnet handles
// reachability and, when Tailscale SSH is enabled on the target, authentication
// too. So everything downstream (spawnSshPty, ssh-ls, ssh-test) is unchanged;
// all we add here is machine discovery and a setup path that skips the
// key-copy dance when the tailnet already authenticates us.

// The CLI isn't on PATH in the GUI-app case on macOS, so check known locations.
// Homebrew first: /usr/local/bin/tailscale is often a stale shell stub left by
// an uninstalled Tailscale.app that execs a path which no longer exists and
// exits 127. Existence on disk therefore proves nothing — every candidate is
// probed by actually running it, and the first that works wins.
//
// Note: on Windows runCmd routes through wsl.exe, same as every ssh call in
// this app. That's deliberate — the ssh that resolves the MagicDNS name runs
// inside WSL, so discovery has to see the same tailnet that ssh will.
const TAILSCALE_PATHS = [
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
  '/usr/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  'tailscale', // PATH lookup — covers Linux/WSL and custom installs
];

let tailscaleBinCache;
async function findTailscaleBin() {
  if (tailscaleBinCache !== undefined) return tailscaleBinCache;
  for (const bin of TAILSCALE_PATHS) {
    const probe = await runCmd(bin, ['version'], { timeout: 4000 });
    if (probe.ok) {
      tailscaleBinCache = bin;
      return bin;
    }
  }
  tailscaleBinCache = null;
  return null;
}

ipcMain.handle('tailscale-status', async () => {
  const bin = await findTailscaleBin();
  if (!bin) {
    return { ok: false, installed: false, error: 'Tailscale CLI not found. Install Tailscale to use tailnet remotes.' };
  }

  const res = await runCmd(bin, ['status', '--json'], { timeout: 8000 });
  if (!res.ok) {
    return { ok: false, installed: true, error: res.stderr || 'tailscale status failed' };
  }

  let data;
  try {
    data = JSON.parse(res.stdout);
  } catch (_) {
    return { ok: false, installed: true, error: 'Could not parse tailscale status output' };
  }

  const clean = (n) => (n || '').replace(/\.$/, '');
  // Prefer HostName, but some devices report a generic one (iOS commonly sends
  // "localhost"), so fall back to the machine's own MagicDNS label.
  const dnsLabel = (p) => clean(p.DNSName).split('.')[0];
  const machines = Object.values(data.Peer || {})
    .map((p) => ({
      name: (p.HostName && p.HostName !== 'localhost') ? p.HostName : (dnsLabel(p) || clean(p.DNSName)),
      dns: clean(p.DNSName) || (p.TailscaleIPs || [])[0] || '',
      os: p.OS || '',
      online: p.Online === true,
      ip: (p.TailscaleIPs || [])[0] || '',
    }))
    .filter((m) => m.dns)
    // Online first, then alphabetical — you almost always want a live machine.
    .sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));

  // A stopped backend still reports the tailnet's peers. Hand them back anyway
  // so the picker can show what's there alongside an actionable warning, rather
  // than an empty list that looks like a discovery failure.
  const running = !data.BackendState || data.BackendState === 'Running';
  if (!running) {
    return {
      ok: false, installed: true, running: false, machines,
      state: data.BackendState,
      error: `Tailscale is ${String(data.BackendState).toLowerCase()} \u2014 run \`tailscale up\` to connect.`,
    };
  }

  return { ok: true, installed: true, running: true, machines, self: clean(data.Self?.DNSName) };
});

// ── SSH setup (key generation + key copy) ──

function runCmd(bin, args, opts = {}) {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    const proc = IS_WIN
      ? spawn('wsl.exe', [bin, ...args], opts)
      : spawn(bin, args, opts);

    let stdout = '', stderr = '';
    if (proc.stdout) proc.stdout.on('data', d => { stdout += d; });
    if (proc.stderr) proc.stderr.on('data', d => { stderr += d; });

    const timer = setTimeout(() => {
      try { proc.kill(); } catch (_) {}
      resolve({ ok: false, stdout, stderr: 'Timeout' });
    }, opts.timeout || 15000);

    proc.on('close', code => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: err.message });
    });
  });
}

function sshCopyIdWithPassword(host, port, username, password) {
  return new Promise((resolve) => {
    const args = ['-o', 'StrictHostKeyChecking=accept-new'];
    if (port && port !== 22) args.push('-p', String(port));
    args.push(`${username}@${host}`);

    const proc = IS_WIN
      ? pty.spawn('wsl.exe', ['ssh-copy-id', ...args], { name: 'xterm-256color', cols: 80, rows: 10 })
      : pty.spawn('ssh-copy-id', args, { name: 'xterm-256color', cols: 80, rows: 10 });

    let output = '';
    let passwordSent = false;
    const timer = setTimeout(() => {
      try { proc.kill(); } catch (_) {}
      resolve({ ok: false, error: 'Timeout — could not reach host' });
    }, 20000);

    proc.onData((data) => {
      output += data;
      if (!passwordSent && /password/i.test(output)) {
        passwordSent = true;
        proc.write(password + '\r');
      }
    });

    proc.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (exitCode === 0) {
        resolve({ ok: true });
      } else {
        const err = output.includes('Permission denied') ? 'Wrong password'
          : output.includes('Connection refused') ? 'Connection refused'
          : output.includes('No route to host') ? 'No route to host'
          : output.trim().split('\n').pop() || 'ssh-copy-id failed';
        resolve({ ok: false, error: err });
      }
    });
  });
}

ipcMain.handle('ssh-setup', async (event, { host, port, username, password, tailscale, tsIp }) => {
  const home = os.homedir();

  // MagicDNS names only resolve when Tailscale manages the system resolver.
  // Homebrew's tailscaled on macOS commonly doesn't, so a name like
  // `box.tailnet.ts.net` fails with "could not resolve hostname" even though
  // the tailnet is up. The machine's 100.x address is always routable, so fall
  // back to it and connect by IP.
  if (tailscale && tsIp && host !== tsIp) {
    try {
      await dns.promises.lookup(host);
    } catch (_) {
      host = tsIp;
    }
  }

  const target = `${username}@${host}`;
  const portArg = port && port !== 22 ? `-p ${port} ` : '';
  const cmd = `ssh ${portArg}${target}`.trim();
  const portArgs = port && port !== 22 ? ['-p', String(port)] : [];

  // Tailscale: when Tailscale SSH is enabled on the target, the tailnet
  // authenticates us and no local key is involved at all. Test that first so we
  // never generate or copy a key we don't need. If it fails the machine is
  // running plain sshd over the tailnet, so we fall through to the normal key
  // flow below — same as any other host.
  if (tailscale) {
    const tsTest = await runCmd('ssh', [
      ...portArgs, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
      '-o', 'StrictHostKeyChecking=accept-new',
      target, 'echo', 'ok',
    ]);
    if (tsTest.ok && tsTest.stdout === 'ok') {
      return { ok: true, keyAuthWorked: true, tailscaleSsh: true, cmd, host };
    }

    // Tailscale SSH answered and refused the login on policy grounds. Copying a
    // key cannot fix that, so report it instead of falling through to the key
    // flow and emitting a confusing ssh-copy-id error.
    if (/tailnet policy does not permit/i.test(tsTest.stderr || '')) {
      return {
        ok: false, cmd, host, policyDenied: true,
        error: `Tailscale SSH refused "${username}" on this machine. Use a username its tailnet SSH policy allows, or update the policy.`,
      };
    }
  }

  // Step 1: Check for local SSH key
  const keyCheck = await runCmd('bash', ['-c',
    'test -f ~/.ssh/id_ed25519 && echo "ed25519" || (test -f ~/.ssh/id_rsa && echo "rsa" || echo "none")'
  ]);
  const keyType = keyCheck.stdout || 'none';

  // Step 2: Generate key if missing
  if (keyType === 'none') {
    const gen = await runCmd('bash', ['-c',
      'mkdir -p ~/.ssh && chmod 700 ~/.ssh && ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N "" -q <<< y 2>/dev/null; test -f ~/.ssh/id_ed25519 && echo "ok" || echo "fail"'
    ]);
    if (!gen.stdout.includes('ok')) {
      return { ok: false, error: 'Failed to generate SSH key', cmd };
    }
  }

  // Step 3: Test key-based auth
  const authTest = await runCmd('ssh', [
    ...portArgs, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
    '-o', 'StrictHostKeyChecking=accept-new',
    target, 'echo', 'ok'
  ]);

  if (authTest.ok && authTest.stdout === 'ok') {
    return { ok: true, keyAuthWorked: true, cmd };
  }

  // Step 4: Key auth failed — need password
  if (!password) {
    return { ok: false, needsPassword: true, error: 'Key auth failed — enter password to copy your SSH key.', cmd };
  }

  // Step 5: Copy key using pty-based ssh-copy-id
  const copyResult = await sshCopyIdWithPassword(host, port, username, password);
  if (!copyResult.ok) {
    return { ok: false, error: copyResult.error, cmd };
  }

  // Step 6: Verify key auth now works
  const verify = await runCmd('ssh', [
    ...portArgs, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
    target, 'echo', 'ok'
  ]);

  if (verify.ok && verify.stdout === 'ok') {
    return { ok: true, cmd };
  }

  return { ok: false, error: 'Key was copied but auth verification failed', cmd };
});

// ── Conductor & background agents ──
//
// The conductor is a Claude Code session driven over stream-json instead of a
// pty: messages go in as JSON on stdin, events come back as JSONL on stdout.
// One process holds one conversation across many turns (verified: context
// survives), so the renderer can keep an input box live while a turn is still
// running and drain queued messages as the process frees up.
//
// Its tool surface is deliberately narrow. Note that --allowedTools is an
// auto-approve list, NOT a restriction — the session still loads every tool — so
// the editing tools are denied outright via --disallowedTools, Bash is
// auto-approved only for `claude ...`, and --permission-prompts none means
// anything else is refused rather than hanging on a prompt nobody can answer.
// The conductor delegates; it is not supposed to edit anything itself.

const conductors = new Map();


// GUI launches get a minimal PATH, so `claude` is usually not on it — same
// problem the Tailscale lookup solves, same fix: probe known locations and
// keep the first that answers.
const CLAUDE_PATHS = [
  path.join(os.homedir(), '.local', 'bin', 'claude'),
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
  '/usr/bin/claude',
  'claude', // PATH lookup — covers Linux/WSL and custom installs
];

let claudeBinCache;
async function findClaudeBin() {
  if (claudeBinCache !== undefined) return claudeBinCache;
  for (const bin of CLAUDE_PATHS) {
    const probe = await runCmd(bin, ['--version'], { timeout: 5000 });
    if (probe.ok) { claudeBinCache = bin; return bin; }
  }
  claudeBinCache = null;
  return null;
}

// Claude Code refuses to nest: if Manifold was itself launched from a session,
// these leak in and the child thinks it's a subagent.
function claudeEnv() {
  const env = { ...process.env, HOME: os.homedir() };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  return env;
}

// The conductor runs with permissions bypassed, matching every other Claude
// session Manifold spawns (see TOOL_CMD). Allowlisting was tried and abandoned:
// patterns like `Bash(claude *)` don't match compound commands, so ordinary work
// (`for id in ...; do claude logs $id; done`) got denied with no way to approve
// it. Dispatched agents get the same treatment — see conductorPrompt.
//
// The conductor also gets an addressable session name so dispatched agents can
// message it back when they finish, instead of the work completing silently and
// only surfacing when the user thinks to ask.
function conductorPrompt(selfName) {
  return [
    'You are the conductor of a Manifold workspace.',
    '',
    'Your session is named "' + selfName + '". Background agents can reach you at',
    'that name with the SendMessage tool.',
    '',
    'You do not do heavy work yourself. Your job is to stay responsive and delegate:',
    '',
    '- Dispatch background work with:',
    '    claude --bg --dangerously-skip-permissions "<full self-contained prompt>"',
    '  The flag is required: without it the agent stalls on approval prompts that',
    '  nobody can answer.',
    '  Run it with cwd set to the project directory. It returns a short session id.',
    '  ALWAYS append this sentence to a dispatched prompt, so the work reports back',
    '  instead of finishing silently:',
    '    "When you are completely finished, use SendMessage to send a one-paragraph',
    '     summary of what you did to the session named ' + selfName + '."',
    '- Inspect running work with the ListAgents tool, or claude agents --json.',
    '  Prefer those for status. `claude logs <id>` replays raw terminal output',
    '  (spinner frames and all) and is often over 100KB, so use it only when you',
    '  actually need to see what an agent printed.',
    '- Read a session\'s output with: claude logs <id>',
    '- Stop one with: claude stop <id>',
    '- Delete a finished one with: claude rm <id>. This clears it from the roster',
    '  and removes its worktree. Only works once the session has exited, so stop it',
    '  first if it is still running. The user can also delete agents from the',
    '  sidebar, so the roster may change without you doing anything.',
    '',
    'When an agent messages you that it finished, relay the result to the user',
    'straight away in one or two sentences.',
    '',
    'Keep your own replies short. When you dispatch something, say what you dispatched',
    'and give the id. When asked for status, check with the tools rather than guessing.',
    'A background agent\'s prompt must be fully self-contained: it does not see this',
    'conversation.',
  ].join('\n');
}

ipcMain.handle('conductor-create', async (event, { id, cwd, model, sessionId, name }) => {
  const bin = await findClaudeBin();
  if (!bin) return { ok: false, error: 'Claude Code CLI not found. Install it to use a conductor.' };

  // Unique per conductor so two of them never answer to the same address, but
  // stable across restarts: the renderer persists this and hands it back, so an
  // agent dispatched before a restart can still reach the conductor afterwards.
  const selfName = name || `manifold-conductor-${String(id).replace(/[^a-zA-Z0-9-]/g, '')}-${crypto.randomUUID().slice(0, 4)}`;
  const dir = cwd || os.homedir();

  const send = (msg) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('conductor-event', { id, msg });
    }
  };

  // A conductor only gets a transcript once a turn completes, so a tab closed
  // before its first message leaves a session id that resolves to nothing.
  // `--resume` on a missing id is fatal (exit 1, "No conversation found"), so
  // check the file rather than letting a stale id kill the pane.
  let resumeId = null;
  if (sessionId) {
    const f = path.join(getProjectDir(dir), sessionId + '.jsonl');
    if (fs.existsSync(f)) resumeId = sessionId;
    else send({ type: 'manifold_notice', text: 'Previous conversation not found on disk — starting fresh.' });
  }

  const { spawn } = require('child_process');

  const launch = (withResume) => {
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', model || 'sonnet',
      '--name', selfName,
      '--dangerously-skip-permissions',
      '--append-system-prompt', conductorPrompt(selfName),
    ];
    // Resuming reuses the same session id and carries the conversation, so a
    // restarted conductor still remembers what was said.
    if (withResume) args.push('--resume', withResume);

    const proc = spawn(bin, args, { cwd: dir, env: claudeEnv() });
    let sawInit = false;
    let stderrTail = '';

    // stdout is JSONL, but a frame can be split across chunks — buffer to newline.
    let buf = '';
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); }
        catch (_) { continue; /* non-JSON noise on stdout — ignore */ }
        // An agent reporting back arrives as a user turn. Classify it here so
        // the live feed and the replayed history use one implementation.
        if (msg.type === 'user') {
          const c = (msg.message || {}).content;
          const text = typeof c === 'string' ? c
            : Array.isArray(c) ? c.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n')
            : '';
          const cls = classifyConductorTurn(text);
          if (cls && cls.role === 'agent') {
            send({ type: 'manifold_agent_msg', from: cls.from, text: cls.text });
          }
        }
        if (msg.type === 'system' && msg.subtype === 'init') {
          sawInit = true;
          if (msg.session_id) {
            const c = conductors.get(id);
            if (c) c.sessionId = msg.session_id;
          }
        }
        send(msg);
      }
    });

    proc.stderr.on('data', (d) => {
      const text = String(d);
      stderrTail = (stderrTail + text).slice(-1000);
      send({ type: 'manifold_error', text: text.slice(0, 2000) });
    });

    proc.on('exit', (code) => {
      // Died before it ever came up while resuming: the session is unusable, so
      // fall back to a fresh one instead of leaving the pane dead.
      if (withResume && !sawInit) {
        send({ type: 'manifold_notice', text: 'Could not resume that conversation — starting fresh.' });
        // The turn that was in flight died with the process. Without this the
        // renderer stays "busy" forever and every later message piles up behind
        // a turn that will never finish.
        send({ type: 'manifold_reset' });
        const fresh = launch(null);
        const c = conductors.get(id);
        if (c) { c.proc = fresh; c.sessionId = null; }
        return;
      }
      conductors.delete(id);
      send({ type: 'manifold_exit', code });
    });

    proc.on('error', (err) => {
      send({ type: 'manifold_error', text: err.message });
    });

    return proc;
  };

  const proc = launch(resumeId);
  conductors.set(id, { proc, cwd: dir, selfName, sessionId: resumeId });
  return { ok: true, selfName, resumed: !!resumeId };
});

ipcMain.handle('conductor-send', (event, { id, text }) => {
  const c = conductors.get(id);
  if (!c) return { ok: false, error: 'Conductor not running' };
  const frame = {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
  try {
    c.proc.stdin.write(JSON.stringify(frame) + '\n');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Preempt the running turn. The CLI advertises interrupt_receipt_v1 and answers
// a control_request with {subtype:'success', response:{still_queued:[...]}}, so a
// new message can take over instead of waiting behind the old one.
let conductorReqSeq = 0;
ipcMain.handle('conductor-interrupt', (event, { id }) => {
  const c = conductors.get(id);
  if (!c) return { ok: false, error: 'Conductor not running' };
  const frame = {
    type: 'control_request',
    request_id: `manifold_${++conductorReqSeq}`,
    request: { subtype: 'interrupt' },
  };
  try {
    c.proc.stdin.write(JSON.stringify(frame) + '\n');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.on('conductor-destroy', (event, { id }) => {
  const c = conductors.get(id);
  if (!c) return;
  try { c.proc.stdin.end(); } catch (_) {}
  try { c.proc.kill(); } catch (_) {}
  conductors.delete(id);
});

ipcMain.handle('conductor-get-session-id', (event, { id }) => {
  const c = conductors.get(id);
  return c ? (c.sessionId || null) : null;
});

// Not every `user` turn in a conductor transcript came from the person. Agents
// reporting back arrive as user turns wrapped in a <cross-session-message>
// envelope, and background-task notices arrive as <task-notification>. Replaying
// those as user bubbles made it look like the person had said them — in one real
// session, 28 "you" bubbles for 15 actual messages.
function classifyConductorTurn(text) {
  const t = String(text || '').trim();
  if (!t) return null;

  const xs = t.match(/<cross-session-message\b[^>]*from-name="([^"]*)"[^>]*>([\s\S]*?)(?:<\/cross-session-message>|$)/);
  if (xs) return { role: 'agent', from: xs[1], text: xs[2].trim() };

  if (/^<task-notification\b/.test(t)) return { role: 'system', text: 'background task notification' };
  if (/^<[a-z-]+>/i.test(t) && /<\/[a-z-]+>/i.test(t)) return { role: 'system', text: t.slice(0, 120) };

  // Completion notices are piggybacked onto the next message; the person didn't
  // type them, so show only what they actually wrote.
  const stripped = t.replace(/^(?:\[Manifold\][^\n]*\n?)+\s*/, '').trim();
  if (!stripped) return { role: 'system', text: t.slice(0, 120) };
  return { role: 'user', text: stripped };
}

// Rebuild a restored pane's feed from the session transcript on disk. The
// conversation is already persisted by Claude Code, so there is no reason to
// duplicate it into Manifold's state file.
ipcMain.handle('conductor-history', (event, { sessionId, cwd }) => {
  if (!sessionId || !cwd) return { ok: false, entries: [] };
  const file = path.join(getProjectDir(cwd), sessionId + '.jsonl');
  let raw;
  try { raw = fs.readFileSync(file, 'utf-8'); }
  catch (_) { return { ok: false, entries: [] }; }

  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch (_) { continue; }
    const content = m.message && m.message.content;

    if (m.type === 'user') {
      // Tool results are plumbing, not conversation — they carry no text block
      // and fall out here naturally.
      let text = '';
      if (typeof content === 'string') text = content;
      else if (Array.isArray(content)) {
        text = content.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n');
      }
      const c = classifyConductorTurn(text);
      if (c && c.role !== 'system') entries.push(c);
    } else if (m.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (b.type === 'text' && b.text && b.text.trim()) entries.push({ role: 'assistant', text: b.text });
        else if (b.type === 'tool_use') entries.push({ role: 'tool', name: b.name, input: b.input });
      }
    }
  }

  // Long-running conductors accumulate; replaying everything would stall the
  // pane on open, so keep the tail.
  const MAX = 200;
  return { ok: true, entries: entries.slice(-MAX), truncated: entries.length > MAX };
});

function destroyAllConductors() {
  for (const [, c] of conductors) {
    try { c.proc.stdin.end(); } catch (_) {}
    try { c.proc.kill(); } catch (_) {}
  }
  conductors.clear();
}

// ── Background agent roster ──

ipcMain.handle('agents-list', async (event, { cwd }) => {
  const bin = await findClaudeBin();
  if (!bin) return { ok: false, error: 'Claude Code CLI not found' };

  // --cwd scopes the listing to sessions started under this collection's path.
  const args = ['agents', '--json'];
  if (cwd) args.push('--cwd', cwd);

  const res = await runCmd(bin, args, { cwd: cwd || os.homedir(), env: claudeEnv(), timeout: 10000 });
  if (!res.ok) return { ok: false, error: res.stderr || 'agents --json failed' };
  try {
    return { ok: true, agents: JSON.parse(res.stdout || '[]') };
  } catch (_) {
    return { ok: false, error: 'Could not parse agents listing' };
  }
});

ipcMain.handle('agent-dispatch', async (event, { cwd, prompt, model }) => {
  const bin = await findClaudeBin();
  if (!bin) return { ok: false, error: 'Claude Code CLI not found' };

  // --bg takes the prompt as the positional argument; pairing it with -p is
  // rejected ("the job would be unattachable"), which is the whole point here —
  // a dispatched agent has to stay attachable.
  const args = ['--bg', '--dangerously-skip-permissions', prompt];
  if (model) args.push('--model', model);

  const res = await runCmd(bin, args, { cwd: cwd || os.homedir(), env: claudeEnv(), timeout: 30000 });
  if (!res.ok) return { ok: false, error: res.stderr || 'dispatch failed' };

  // --bg prints a banner then a hint block:
  //   backgrounded \u00b7 9661d8d4
  //     claude agents             list sessions
  //     claude attach 9661d8d4    open in this terminal
  // Pull the id off the banner; fall back to the attach hint if that changes.
  const out = (res.stdout || '').trim();
  const id = (out.match(/backgrounded\s*\u00b7\s*(\S+)/) ||
              out.match(/claude\s+attach\s+(\S+)/) || [])[1] || null;
  if (!id) return { ok: false, error: 'Dispatched but could not read the session id', raw: out };
  return { ok: true, id, raw: out };
});

// Read the last slice of a .jsonl without loading the whole file — these run to
// 750KB while an agent is working, and this is polled every few seconds.
function tailJsonl(file, bytes) {
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - bytes);
  const len = stat.size - start;
  if (len <= 0) return [];
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(len);
  try { fs.readSync(fd, buf, 0, len, start); } finally { fs.closeSync(fd); }
  let text = buf.toString('utf-8');
  // A partial first line is unparseable when we started mid-file.
  if (start > 0) {
    const nl = text.indexOf('\n');
    text = nl === -1 ? '' : text.slice(nl + 1);
  }
  return text.split('\n').filter((l) => l.trim());
}

const ACTIVITY_TAIL_BYTES = 48 * 1024;

ipcMain.handle('agents-activity', (event, { agents }) => {
  const out = {};
  for (const a of agents || []) {
    if (!a || !a.sessionId || !a.cwd) continue;
    const file = path.join(getProjectDir(a.cwd), a.sessionId + '.jsonl');
    let events = [];
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
      for (const line of tailJsonl(file, ACTIVITY_TAIL_BYTES)) {
        let m;
        try { m = JSON.parse(line); } catch (_) { continue; }
        const c = (m.message || {}).content;
        if (m.type !== 'assistant' || !Array.isArray(c)) continue;
        for (const b of c) {
          if (b.type === 'tool_use') {
            const i = b.input || {};
            const target = i.file_path || i.command || i.pattern || i.description || '';
            events.push({ kind: 'tool', name: b.name, target: String(target).slice(0, 120) });
          } else if (b.type === 'text' && b.text && b.text.trim()) {
            events.push({ kind: 'text', text: b.text.trim().replace(/\s+/g, ' ').slice(0, 160) });
          }
        }
      }
    } catch (_) { /* transcript not written yet — agent is still starting */ }
    out[a.id] = { events: events.slice(-3), mtime };
  }
  return out;
});

ipcMain.handle('agent-logs', async (event, { id, cwd }) => {
  const bin = await findClaudeBin();
  if (!bin) return { ok: false, error: 'Claude Code CLI not found' };
  const res = await runCmd(bin, ['logs', id], { cwd: cwd || os.homedir(), env: claudeEnv(), timeout: 10000 });
  return { ok: res.ok, text: res.stdout || res.stderr };
});

// `claude rm` deletes a session and its worktree. Its help reads like it only
// handles exited sessions ("Unlike `stop`, works on already-exited sessions"),
// but it removes a running one too — verified — so no stop step is needed.
// Its stdout can carry worktree follow-ups (--discard-unpushed /
// --force-remove-worktree tokens) when it can't finish the job, so the output
// is handed back rather than swallowed.
ipcMain.handle('agent-remove', async (event, { id, cwd }) => {
  const bin = await findClaudeBin();
  if (!bin) return { ok: false, error: 'Claude Code CLI not found' };
  const opts = { cwd: cwd || os.homedir(), env: claudeEnv(), timeout: 15000 };

  const res = await runCmd(bin, ['rm', id], opts);
  const output = (res.stdout || res.stderr || '').trim();
  return { ok: res.ok, output, error: res.ok ? null : (output || 'rm failed') };
});

ipcMain.handle('agent-stop', async (event, { id, cwd }) => {
  const bin = await findClaudeBin();
  if (!bin) return { ok: false, error: 'Claude Code CLI not found' };
  const res = await runCmd(bin, ['stop', id], { cwd: cwd || os.homedir(), env: claudeEnv(), timeout: 10000 });
  return { ok: res.ok, error: res.ok ? null : (res.stderr || 'stop failed') };
});

// ── App lifecycle ──

app.whenReady().then(() => {
  const send = (ch) => mainWindow?.webContents.send(ch);

  // Edit menu — platform-aware, because copy/paste has different constraints on
  // each OS:
  //
  //   macOS: text inputs get Cmd+X/C/V from the Edit menu's roles, so we DO
  //     register cut/paste roles (Cmd-based keys never collide with the
  //     terminal's Ctrl-based keys, e.g. Ctrl+C = SIGINT). The one exception is
  //     Copy: xterm's visual selection isn't a DOM selection, so a plain
  //     role:'copy' can't read it — we route Cmd+C through the renderer instead
  //     (registerAccelerator:false shows the ⌘C hint without stealing the key).
  //
  //   Windows/Linux: every Ctrl-accelerator a menu role registers (Ctrl+C/X/A/Z)
  //     would be stolen from the terminal, so ALL items are click-only with no
  //     registered accelerator. Text inputs still get native Ctrl+X/C/V/Z/A from
  //     Chromium directly (they don't need the menu on these platforms); the
  //     terminal uses Ctrl+Shift+C / Ctrl+Shift+V, handled in renderer.js.
  const editMenu = IS_MAC
    ? {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { label: 'Copy', accelerator: 'Cmd+C', registerAccelerator: false, click: () => send('menu-copy') },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      }
    : {
        label: 'Edit',
        submenu: [
          { label: 'Cut', click: () => send('menu-cut') },
          { label: 'Copy', click: () => send('menu-copy') },
          { label: 'Paste', click: () => send('menu-paste') },
          { type: 'separator' },
          { label: 'Select All', click: () => send('menu-select-all') },
        ],
      };

  if (IS_MAC) {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      editMenu,
      {
        label: 'Window',
        submenu: [
          { role: 'minimize' },
          { role: 'zoom' },
          { role: 'close' },
        ],
      },
    ]));
  } else {
    Menu.setApplicationMenu(Menu.buildFromTemplate([editMenu]));
  }

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
});

app.on('window-all-closed', () => {
  if (!IS_MAC) app.quit();
});

app.on('will-quit', () => {
  destroyAllTerminals();
  destroyAllConductors();
});
