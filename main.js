const { app, BrowserWindow, ipcMain, dialog, Menu, screen, nativeImage, clipboard } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const pty = require('node-pty');
const crypto = require('crypto');
const dns = require('dns');
const net = require('net');
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

// The reverse, for paths Claude reports from inside WSL (an agent's cwd).
function wslToWinPath(p) {
  if (!p || !IS_WIN) return p;
  const m = p.match(new RegExp('^/mnt/([a-z])(?:/(.*))?$'));
  return m ? path.win32.join(m[1].toUpperCase() + ':', path.win32.sep, m[2] || '') : p;
}

// On Windows every Claude session lives in WSL, so its ~/.claude is the WSL
// home, reached from this side as a wsl.localhost UNC path.
let wslHomeCache;
function claudeHome() {
  if (!IS_WIN) return os.homedir();
  if (wslHomeCache === undefined) {
    wslHomeCache = null;
    try {
      const r = require('child_process').spawnSync('wsl.exe', ['-e', 'sh', '-c', 'wslpath -w ~'], { encoding: 'utf-8', timeout: 10000 });
      const out = (r.stdout || '').trim();
      if (r.status === 0 && out) wslHomeCache = out;
    } catch (_) {}
  }
  return wslHomeCache || os.homedir();
}

// argv for wsl.exe that runs `bin args` in `dir`. Plain `wsl.exe bin args`
// hands the line to a shell, which mangles a multi-line system prompt or any
// task text with quotes in it. base64 carries the quoted script through both
// the Windows command line and that shell untouched.
function wslArgv(bin, dir, args, env) {
  const cd = dir ? `cd ${shQuote(winToWslPath(dir))} && ` : '';
  const script = `${cd}${envAssign(env)}exec ${shQuote(bin)} ${args.map(shQuote).join(' ')}`;
  const b64 = Buffer.from(script, 'utf-8').toString('base64');
  return ['-e', 'bash', '-lc', `eval "$(echo ${b64} | base64 -d)"`];
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

// Single-quote a value for a POSIX remote shell. Multi-line text (the
// conductor's system prompt) passes through untouched — only the quote itself
// needs escaping — so nothing on the remote side has to decode anything.
function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Parse the user's SSH command the same way ssh-ls does, then run `remoteCmd`
// over a plain pipe: RequestTTY=no keeps JSONL clean, and ServerAliveInterval
// turns a dropped link into an exit instead of a pane that hangs forever.
function sshArgv(remote, remoteCmd) {
  const parts = remote.trim().split(/\s+/);
  return {
    bin: parts[0],
    args: [
      '-o', 'RequestTTY=no', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
      '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
      ...parts.slice(1),
      remoteCmd,
    ],
  };
}

// A non-interactive ssh gets whatever PATH the remote login shell sets, which
// often misses ~/.local/bin — the same problem CLAUDE_PATHS solves locally.
const REMOTE_PATH = 'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH";';

// bash -lc so the remote gets a login environment. Every argument is quoted
// individually, which is what lets --append-system-prompt stay multi-line.
// `env` is a few extra variables set for claude only, e.g. the model its own
// `claude --bg` children should default to.
function envAssign(env) {
  return Object.entries(env || {}).map(([k, v]) => `${k}=${shQuote(v)} `).join('');
}

function remoteClaudeCmd(remotePath, args, env) {
  const inner = `${REMOTE_PATH} cd ${shQuote(remotePath)} && ${envAssign(env)}exec claude ${args.map(shQuote).join(' ')}`;
  return `bash -lc ${shQuote(inner)}`;
}

function remoteShCmd(script) {
  return `bash -lc ${shQuote(REMOTE_PATH + ' ' + script)}`;
}

function spawnSsh(remote, remoteCmd, opts = {}) {
  const { spawn } = require('child_process');
  const { bin, args } = sshArgv(remote, remoteCmd);
  return IS_WIN ? spawn('wsl.exe', [bin, ...args], opts) : spawn(bin, args, opts);
}

// The remote host's own ~/.claude/projects/<encoded cwd> — same encoding as
// getProjectDir, but resolved against the remote $HOME at run time.
function remoteProjectDir(remotePath) {
  return '"$HOME/.claude/projects/' + remotePath.replace(/[^a-zA-Z0-9_-]/g, '-') + '"';
}

// Session ids get interpolated into remote command lines unquoted.
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

// runCmd, but the command runs on the remote host.
function runRemoteCmd(remote, script, opts = {}) {
  const { bin, args } = sshArgv(remote, remoteShCmd(script));
  return runCmd(bin, args, opts);
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
  // An attach tab is opened on the agent's own cwd, which WSL reports as /mnt/c/…
  const dir = (remote ? cwd : wslToWinPath(cwd)) || home;

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
  // Claude encodes the path it actually ran in — on Windows, the WSL one.
  const encoded = winToWslPath(cwd).replace(/[^a-zA-Z0-9_-]/g, '-');
  return path.join(claudeHome(), '.claude', 'projects', encoded);
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
      resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() });
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

// ── Claude Code CLI version / self-update (Settings → About) ──

async function claudeVersion(bin) {
  const r = await runCmd(bin, ['--version'], { env: claudeEnv(), timeout: 10000 });
  return r.ok ? (r.stdout.match(/\d+\.\d+\.\d+\S*/) || [r.stdout])[0] : null;
}

ipcMain.handle('claude-version', async () => {
  const bin = await findClaudeBin();
  if (!bin) return { ok: false, error: 'Claude Code CLI not found' };
  const version = await claudeVersion(bin);
  return version ? { ok: true, version } : { ok: false, error: 'Could not read version' };
});

// Running sessions are left alone — they keep the old binary until reopened.
ipcMain.handle('claude-update', async () => {
  const bin = await findClaudeBin();
  if (!bin) return { ok: false, error: 'Claude Code CLI not found' };
  const before = await claudeVersion(bin);
  const r = await runCmd(bin, ['update'], { env: claudeEnv(), timeout: 300000 });
  claudeBinCache = undefined; // the update may have moved or replaced the binary
  const newBin = await findClaudeBin();
  const after = newBin ? await claudeVersion(newBin) : null;
  const output = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
  if (!r.ok) return { ok: false, before, after, output, error: r.stderr || r.stdout || 'Update failed' };
  return { ok: true, before, after, updated: !!(after && before !== after), output };
});

// The conductor runs with permissions bypassed, matching every other Claude
// session Manifold spawns (see TOOL_CMD). Allowlisting was tried and abandoned:
// patterns like `Bash(claude *)` don't match compound commands, so ordinary work
// (`for id in ...; do claude logs $id; done`) got denied with no way to approve
// it. Dispatched agents get the same treatment — see conductorPrompt.
//
// The conductor also gets an addressable session name so dispatched agents can
// message it back when they finish, instead of the work completing silently and
// only surfacing when the user thinks to ask.
// Models come from Settings. Anything else is dropped rather than handed to a
// shell and a system prompt: aliases (fable, opus, sonnet, haiku) or full ids.
const MODEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9._\[\]-]{0,63}$/;
function cleanModel(m, fallback) {
  return typeof m === 'string' && MODEL_RE.test(m) ? m : fallback;
}

function conductorPrompt(selfName, remote, agentModel, briefFile) {
  return [
    'You are the conductor of a Manifold workspace.',
    '',
    // Without this it reasons about the machine Manifold is running on, and
    // hands the user paths and agent ids that only exist on the other end.
    ...(remote ? [
      'You are running on a remote host, reached over SSH (' + remote + ').',
      'Every path, file and command you see is on that host, not on the machine',
      'showing you this window. Agents you dispatch run there too.',
      '',
    ] : []),
    'Your session is named "' + selfName + '". Background agents can reach you at',
    'that name with the SendMessage tool.',
    '',
    'You do not do heavy work yourself. Your job is to stay responsive and delegate:',
    '',
    '- Dispatch background work with:',
    '    claude --bg --dangerously-skip-permissions --model ' + agentModel + ' "<full self-contained prompt>"',
    '  The permissions flag is required: without it the agent stalls on approval',
    '  prompts that nobody can answer. The model is the user\'s choice for agents;',
    '  keep it unless the user explicitly asks for a different model for a task.',
    '  Run it with cwd set to the project directory. It returns a short session id.',
    '  ALWAYS append this sentence to a dispatched prompt, so the work reports back',
    '  instead of finishing silently:',
    '    "When you are completely finished, use SendMessage to send a one-paragraph',
    '     summary of what you did to the session named ' + selfName + '."',
    '- Agent brief: before each dispatch, check whether ' + briefFile + ' exists.',
    '  If it does, the dispatched prompt must BEGIN with this exact line (a pointer,',
    '  not the file contents \u2014 the agent reads it itself; the absolute path',
    '  matters because an agent in a git worktree may not have the file):',
    '    "Read ' + briefFile + ' first and follow it."',
    '  The brief holds durable project facts every agent needs (how to build and',
    '  test, style rules, git rules). When an agent reports a durable fact that',
    '  future agents would otherwise rediscover, append it to the brief concisely',
    '  (create the file if missing). Never delete or rewrite what is already there.',
    '- Inspect running work with the ListAgents tool, or claude agents --json.',
    '  States: working (busy), done (finished), blocked (asked a question and is',
    '  waiting on a human \u2014 it will never continue on its own; tell the user),',
    '  stopped, idle.',
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

// ── Agent brief ──
//
// <project>/.manifold/agent-brief.md: durable project facts for every
// background agent. Agents are pointed at it rather than handed its contents,
// by absolute path so an agent in a git worktree still finds it. The path is
// the one the agent sees: WSL on Windows, the remote host's own path over ssh.
const BRIEF_REL = '.manifold/agent-brief.md';
function briefAgentPath(cwd, remote) {
  if (remote) return !cwd || cwd === '.' ? BRIEF_REL : cwd.replace(/\/+$/, '') + '/' + BRIEF_REL;
  return winToWslPath(cwd).replace(/[\/\\]+$/, '') + '/' + BRIEF_REL;
}

ipcMain.handle('brief-read', async (event, { cwd, remote }) => {
  if (!cwd) return { ok: false, error: 'no project directory' };
  const agentPath = briefAgentPath(cwd, remote);
  if (remote) {
    const res = await runRemoteCmd(remote, `cd ${shQuote(cwd)} && { if [ -f ${BRIEF_REL} ]; then echo '@@MF yes'; cat ${BRIEF_REL}; else echo '@@MF no'; fi; }`, { timeout: 15000 });
    const out = String(res.stdout || '');
    const m = out.match(/^@@MF (yes|no)\n?/m);
    if (!m) return { ok: false, error: (res.stderr || 'could not reach remote host').trim().slice(0, 300) };
    const text = out.slice(m.index + m[0].length);
    return { ok: true, exists: m[1] === 'yes' && !!text.trim(), text, agentPath };
  }
  const file = path.join(cwd, BRIEF_REL);
  if (!fs.existsSync(file)) return { ok: true, exists: false, text: '', agentPath };
  try { const text = fs.readFileSync(file, 'utf-8'); return { ok: true, exists: !!text.trim(), text, agentPath }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('brief-write', async (event, { cwd, remote, text }) => {
  if (!cwd) return { ok: false, error: 'no project directory' };
  if (remote) {
    // base64 so the text needs no quoting and survives any content.
    const b64 = Buffer.from(String(text), 'utf-8').toString('base64');
    const res = await runRemoteCmd(remote, `cd ${shQuote(cwd)} && mkdir -p .manifold && echo ${b64} | base64 -d > ${BRIEF_REL}`, { timeout: 15000 });
    return res.ok ? { ok: true } : { ok: false, error: (res.stderr || 'write failed').trim().slice(0, 300) };
  }
  try {
    fs.mkdirSync(path.join(cwd, '.manifold'), { recursive: true });
    fs.writeFileSync(path.join(cwd, BRIEF_REL), String(text), 'utf-8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('conductor-create', async (event, { id, cwd, model: rawModel, agentModel: rawAgentModel, sessionId, name, remote }) => {
  const model = cleanModel(rawModel, 'sonnet');
  const agentModel = cleanModel(rawAgentModel, 'sonnet');
  // Every `claude` the conductor runs inherits this, so an agent it dispatches
  // lands on the chosen model even if the --model flag is left off. The
  // conductor's own --model flag outranks it.
  const childEnv = { ANTHROPIC_MODEL: agentModel };
  // A remote conductor runs the remote host's own `claude`, so the local probe
  // says nothing about whether it will work.
  let bin = null;
  if (!remote) {
    bin = await findClaudeBin();
    if (!bin) return { ok: false, error: 'Claude Code CLI not found. Install it to use a conductor.' };
  }

  // Unique per conductor so two of them never answer to the same address, but
  // stable across restarts: the renderer persists this and hands it back, so an
  // agent dispatched before a restart can still reach the conductor afterwards.
  const selfName = name || `manifold-conductor-${String(id).replace(/[^a-zA-Z0-9-]/g, '')}-${crypto.randomUUID().slice(0, 4)}`;
  const dir = cwd || (remote ? '.' : os.homedir());

  const send = (msg) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('conductor-event', { id, msg });
    }
  };

  // A conductor only gets a transcript once a turn completes, so a tab closed
  // before its first message leaves a session id that resolves to nothing.
  // `--resume` on a missing id is fatal (exit 1, "No conversation found"), so
  // check the file rather than letting a stale id kill the pane.
  // On a remote the transcript lives on the far side, so the probe has to go
  // over ssh — checking the local disk would reject every valid session id.
  let resumeId = null;
  if (sessionId) {
    let found;
    if (remote) {
      found = SAFE_ID.test(sessionId) &&
        (await runRemoteCmd(remote, `test -f ${remoteProjectDir(dir)}/${sessionId}.jsonl`, { timeout: 15000 })).ok;
    } else {
      found = fs.existsSync(path.join(getProjectDir(dir), sessionId + '.jsonl'));
    }
    if (found) resumeId = sessionId;
    else send({ type: 'manifold_notice', text: `Previous conversation not found${remote ? ' on the remote host' : ' on disk'} — starting fresh.` });
  }

  const { spawn } = require('child_process');

  const launch = (withResume) => {
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', model,
      '--name', selfName,
      '--dangerously-skip-permissions',
      '--append-system-prompt', conductorPrompt(selfName, remote || null, agentModel, briefAgentPath(dir, remote)),
    ];
    // Resuming reuses the same session id and carries the conversation, so a
    // restarted conductor still remembers what was said.
    if (withResume) args.push('--resume', withResume);

    // Remote: one ssh carrying the same argv, quoted for the far shell. stdin
    // and stdout are ordinary pipes either way, so everything below is shared.
    const proc = remote
      ? spawnSsh(remote, remoteClaudeCmd(dir, args, childEnv), { env: process.env })
      : IS_WIN
        ? spawn('wsl.exe', wslArgv(bin, dir, args, childEnv), { env: claudeEnv() })
        : spawn(bin, args, { cwd: dir, env: { ...claudeEnv(), ...childEnv } });
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
      // 255 is ssh's own failure code — the link dropped, or never came up.
      // Relaunching would hit the same wall, so say so and let the pane show it
      // as dead. Reopening the tab resumes the conversation from its session id.
      if (remote && code === 255) {
        send({ type: 'manifold_error', text: stderrTail.trim() || 'SSH connection lost.' });
        conductors.delete(id);
        send({ type: 'manifold_exit', code });
        return;
      }
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

    // A half-closed pipe (ssh dropped mid-turn) raises EPIPE on the stream, not
    // at the write call — unhandled, that would take down the main process.
    proc.stdin.on('error', (err) => {
      send({ type: 'manifold_error', text: `Lost the conductor's input stream: ${err.message}` });
    });

    return proc;
  };

  const proc = launch(resumeId);
  conductors.set(id, { proc, cwd: dir, selfName, sessionId: resumeId, remote: remote || null });
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

  // Messages the user sent to an agent through the conductor; the agent view
  // shows them, the conductor feed need not replay the instruction.
  if (/^\[Manifold relay\]/.test(t)) return { role: 'system', text: 'relay' };
  if (/^<task-notification\b/.test(t)) return { role: 'system', text: 'background task notification' };
  if (/^<[a-z-]+>/i.test(t) && /<\/[a-z-]+>/i.test(t)) return { role: 'system', text: t.slice(0, 120) };

  // Completion notices are piggybacked onto the next message; the person didn't
  // type them, so show only what they actually wrote.
  const stripped = t.replace(/^(?:\[Manifold\][^\n]*\n?)+\s*/, '').trim();
  if (!stripped) return { role: 'system', text: t.slice(0, 120) };
  return { role: 'user', text: stripped };
}

// Rebuild a restored pane's feed from the session transcript — on local disk,
// or read back over ssh when the conductor lives on a remote host. The
// conversation is already persisted by Claude Code, so there is no reason to
// duplicate it into Manifold's state file.
ipcMain.handle('conductor-history', async (event, { sessionId, cwd, remote }) => {
  if (!sessionId || !cwd) return { ok: false, entries: [] };
  let raw;
  if (remote) {
    if (!SAFE_ID.test(sessionId)) return { ok: false, entries: [] };
    // tail, not cat: these run to hundreds of KB and only the last MAX entries
    // are replayed anyway. A clipped first line fails JSON.parse and is skipped
    // below, which is exactly the behaviour we want.
    const res = await runRemoteCmd(remote, `tail -c 2000000 ${remoteProjectDir(cwd)}/${sessionId}.jsonl`, { timeout: 20000 });
    if (!res.ok) return { ok: false, entries: [] };
    raw = res.stdout;
  } else {
    try { raw = fs.readFileSync(path.join(getProjectDir(cwd), sessionId + '.jsonl'), 'utf-8'); }
    catch (_) { return { ok: false, entries: [] }; }
  }

  const { entries } = transcriptEntries(raw.split('\n'));
  // Long-running conductors accumulate; replaying everything would stall the
  // pane on open, so keep the tail.
  const MAX = 200;
  return { ok: true, entries: entries.slice(-MAX), truncated: entries.length > MAX };
});

// Messages the user types to an agent from Manifold arrive in its transcript
// as peer messages under this name; the parser turns them back into "you".
const MANIFOLD_PEER = 'Manifold';
const MANIFOLD_PREFIX = '[From the user, via Manifold]\n';

// One transcript parser for the conductor replay and the agent chat view.
// Also returns the question an agent is stuck on: an AskUserQuestion call with
// no tool_result yet.
function transcriptEntries(lines) {
  const entries = [];
  const answered = new Set();
  let ask = null;
  const pushUser = (text) => {
    const c = classifyConductorTurn(text);
    if (!c || c.role === 'system') return;
    // agent-send escapes the envelope tag inside the body; undo that for display.
    if (c.role === 'agent' && c.from === MANIFOLD_PEER) entries.push({ role: 'user', text: c.text.replace(MANIFOLD_PREFIX, '').replace(/<\\(?=\/?cross-session-message)/gi, '<') });
    else entries.push(c);
  };
  for (const line of lines) {
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
        for (const b of content) if (b.type === 'tool_result') answered.add(b.tool_use_id);
      }
      pushUser(text);
    } else if (m.type === 'attachment' && m.attachment && m.attachment.type === 'queued_command') {
      // A message that arrived mid-turn is folded in at the next step as an
      // attachment, never as a user line.
      pushUser(m.attachment.prompt);
    } else if (m.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (b.type === 'text' && b.text && b.text.trim()) entries.push({ role: 'assistant', text: b.text });
        else if (b.type === 'tool_use') {
          entries.push({ role: 'tool', name: b.name, input: b.input });
          if (b.name === 'AskUserQuestion') ask = b;
        }
      }
    }
  }
  const question = ask && !answered.has(ask.id) ? (ask.input && ask.input.questions) || [] : null;
  return { entries, question };
}

function destroyAllConductors() {
  for (const [, c] of conductors) {
    try { c.proc.stdin.end(); } catch (_) {}
    try { c.proc.kill(); } catch (_) {}
  }
  conductors.clear();
}

// ── Background agent roster ──

// A remote conductor dispatches its agents on the remote host, so the roster
// has to be read there too — same argv, run through ssh instead of spawned
// locally. Every handler below goes through here so there is one place that
// knows the difference.
async function runClaude(remote, cwd, args, timeout) {
  if (remote) {
    // runCmd does the WSL wrap itself, so hand it the ssh argv unwrapped.
    const { bin, args: sshArgs } = sshArgv(remote, remoteClaudeCmd(cwd || '.', args));
    return runCmd(bin, sshArgs, { timeout });
  }
  const bin = await findClaudeBin();
  if (!bin) return { ok: false, stdout: '', stderr: 'Claude Code CLI not found' };
  // runCmd prepends wsl.exe on Windows; '-e' makes it exec the quoted script.
  if (IS_WIN) return runCmd('-e', wslArgv(bin, cwd, args).slice(1), { env: claudeEnv(), timeout });
  return runCmd(bin, args, { cwd: cwd || os.homedir(), env: claudeEnv(), timeout });
}

ipcMain.handle('agents-list', async (event, { cwd, remote }) => {
  // --cwd scopes the listing to sessions started under this collection's path.
  const args = ['agents', '--json'];
  if (cwd) args.push('--cwd', remote ? cwd : winToWslPath(cwd));

  const res = await runClaude(remote, cwd, args, 10000);
  if (!res.ok) return { ok: false, error: res.stderr || 'agents --json failed' };
  try {
    return { ok: true, agents: JSON.parse(res.stdout || '[]') };
  } catch (_) {
    return { ok: false, error: 'Could not parse agents listing' };
  }
});

ipcMain.handle('agent-dispatch', async (event, { cwd, prompt, model, remote }) => {
  // --bg takes the prompt as the positional argument; pairing it with -p is
  // rejected ("the job would be unattachable"), which is the whole point here —
  // a dispatched agent has to stay attachable.
  const args = ['--bg', '--dangerously-skip-permissions', prompt];
  const m = cleanModel(model, null);
  if (m) args.push('--model', m);

  const res = await runClaude(remote, cwd, args, 30000);
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

function activityEvents(lines) {
  const events = [];
  for (const line of lines) {
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
  return events;
}

// Remote transcripts, in one ssh round-trip for the whole roster — a connection
// per agent every 4s would be a storm. Each tail is fenced by a marker line;
// no JSONL line starts with '@', so the split is unambiguous.
async function remoteActivity(remote, agents) {
  const out = {};
  const safe = agents.filter((a) => SAFE_ID.test(a.sessionId));
  if (!safe.length) return out;
  const script = safe.map((a) => (
    `printf '@@MF %s\\n' ${shQuote(a.id)}; tail -c ${ACTIVITY_TAIL_BYTES} ${remoteProjectDir(a.cwd)}/${a.sessionId}.jsonl 2>/dev/null; echo`
  )).join('; ');

  const res = await runRemoteCmd(remote, script, { timeout: 15000 });
  if (!res.ok) return out;

  for (const chunk of String(res.stdout).split(/^@@MF /m)) {
    const nl = chunk.indexOf('\n');
    if (nl === -1) continue;
    const id = chunk.slice(0, nl).trim();
    if (!id) continue;
    const events = activityEvents(chunk.slice(nl + 1).split('\n').filter((l) => l.trim()));
    out[id] = { events: events.slice(-3), mtime: 0 };
  }
  return out;
}

ipcMain.handle('agents-activity', async (event, { agents, remote }) => {
  const list = (agents || []).filter((a) => a && a.sessionId && a.cwd);
  if (remote) return remoteActivity(remote, list);

  const out = {};
  for (const a of list) {
    const file = path.join(getProjectDir(a.cwd), a.sessionId + '.jsonl');
    let events = [];
    let mtime = 0;
    try {
      mtime = fs.statSync(file).mtimeMs;
      events = activityEvents(tailJsonl(file, ACTIVITY_TAIL_BYTES));
    } catch (_) { /* transcript not written yet — agent is still starting */ }
    out[a.id] = { events: events.slice(-3), mtime };
  }
  return out;
});

// The agent chat view: one agent's conversation, re-read every few seconds
// while it is selected. Same parser as the conductor replay, plus the file's
// mtime (for "active 12s ago") and any question the agent is blocked on.
const AGENT_VIEW_TAIL_BYTES = 400 * 1024;
ipcMain.handle('agent-transcript', async (event, { sessionId, cwd, remote }) => {
  if (!sessionId || !cwd) return { ok: false, error: 'No transcript yet' };
  let lines, mtime = 0;
  if (remote) {
    if (!SAFE_ID.test(sessionId)) return { ok: false, error: 'Bad session id' };
    const f = `${remoteProjectDir(cwd)}/${sessionId}.jsonl`;
    // First line is the mtime (GNU stat, then BSD), the rest is the tail.
    const res = await runRemoteCmd(remote, `{ stat -c %Y ${f} 2>/dev/null || stat -f %m ${f} 2>/dev/null || echo 0; } ; tail -c ${AGENT_VIEW_TAIL_BYTES} ${f}`, { timeout: 20000 });
    if (!res.ok) return { ok: false, error: (res.stderr || 'Could not read the remote transcript').trim().slice(0, 300) };
    lines = String(res.stdout).split('\n');
    mtime = (parseInt(lines.shift(), 10) || 0) * 1000;
  } else {
    const file = path.join(getProjectDir(cwd), sessionId + '.jsonl');
    try { mtime = fs.statSync(file).mtimeMs; lines = tailJsonl(file, AGENT_VIEW_TAIL_BYTES); }
    catch (_) { return { ok: false, error: 'No transcript yet — the agent is still starting' }; }
  }
  const { entries, question } = transcriptEntries(lines);
  const MAX = 300;
  return { ok: true, entries: entries.slice(-MAX), truncated: entries.length > MAX, question, mtime };
});

// Talk to an agent directly: write the message into its cross-session inbox,
// the unix socket SendMessage uses, instead of asking the conductor to relay.
// Each session publishes ~/.claude/sessions/<pid>.json (socket path) and a
// 0600 key file <pid>.<sha256(socket)>.key holding the token its inbox wants as
// the first line. Frames are newline-delimited JSON. The from-mode attestation
// has to be in the envelope: without it a bypass-permissions agent holds the
// message for review instead of acting on it. There is no ack on the socket;
// the renderer confirms delivery by finding the text in the transcript.
function agentInbox(pid, sessionId) {
  const dir = path.join(claudeHome(), '.claude', 'sessions');
  let meta;
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, `${pid}.json`), 'utf-8')); } catch (_) {}
  if (!meta || meta.sessionId !== sessionId) throw new Error('session is not running');
  try { process.kill(pid, 0); } catch (_) { throw new Error('session is not running'); }
  const sock = meta.messagingSocketPath;
  if (!sock) throw new Error('session has no messaging socket');
  const hash = crypto.createHash('sha256').update(path.resolve(sock)).digest('hex');
  let key;
  try { key = JSON.parse(fs.readFileSync(path.join(dir, `${pid}.${hash}.key`), 'utf-8')); } catch (_) {}
  if (!key || !key.peerToken) throw new Error('no messaging key for this session');
  return { sock, token: key.peerToken };
}

ipcMain.handle('agent-send', async (event, { pid, sessionId, text, remote }) => {
  if (remote) return { ok: false, error: 'direct send is local only' };
  if (!pid || !sessionId || !text) return { ok: false, error: 'missing agent or text' };
  let inbox;
  try { inbox = agentInbox(pid, sessionId); } catch (e) { return { ok: false, error: e.message }; }
  const tag = 'cross-session-message';
  const body = (MANIFOLD_PREFIX + text).replace(new RegExp(`<(?=/?${tag})`, 'gi'), '<\\');
  const frames = [
    { type: 'auth', token: inbox.token },
    {
      type: 'user', session_id: sessionId, from: 'manifold', uuid: crypto.randomUUID(), msg_id: crypto.randomUUID(),
      message: { role: 'user', content: `<${tag} from-name="${MANIFOLD_PEER}" from-mode="bypass">\n${body}\n</${tag}>` },
    },
  ];
  return new Promise((resolve) => {
    let err = null;
    const s = net.createConnection({ path: inbox.sock }, () => s.end(frames.map((f) => JSON.stringify(f)).join('\n') + '\n'));
    s.setTimeout(5000, () => { err = 'timed out'; s.destroy(); });
    s.on('error', (e) => { err = e.message; });
    s.on('close', () => resolve(err ? { ok: false, error: err } : { ok: true }));
  });
});

ipcMain.handle('agent-logs', async (event, { id, cwd, remote }) => {
  const res = await runClaude(remote, cwd, ['logs', id], 10000);
  return { ok: res.ok, text: res.stdout || res.stderr };
});

// `claude rm` deletes a session and its worktree. Its help reads like it only
// handles exited sessions ("Unlike `stop`, works on already-exited sessions"),
// but it removes a running one too — verified — so no stop step is needed.
// Its stdout can carry worktree follow-ups (--discard-unpushed /
// --force-remove-worktree tokens) when it can't finish the job, so the output
// is handed back rather than swallowed.
ipcMain.handle('agent-remove', async (event, { id, cwd, remote }) => {
  const res = await runClaude(remote, cwd, ['rm', id], 15000);
  const output = (res.stdout || res.stderr || '').trim();
  return { ok: res.ok, output, error: res.ok ? null : (output || 'rm failed') };
});

ipcMain.handle('agent-stop', async (event, { id, cwd, remote }) => {
  const res = await runClaude(remote, cwd, ['stop', id], 10000);
  return { ok: res.ok, error: res.ok ? null : (res.stderr || 'stop failed') };
});

// ── Agent outcomes: diff + verify ──
//
// Both run as one shell script so the same text works locally (bash, or bash
// inside WSL on Windows) and on a remote host over ssh. The script cd's into
// the agent's cwd itself: the path Claude reports is already a WSL/remote path.
function runLocalSh(script, opts = {}) {
  if (IS_WIN) {
    // Same base64 carriage as wslArgv — a raw script would be re-parsed by the
    // shell wsl.exe hands its command line to.
    const b64 = Buffer.from(script, 'utf-8').toString('base64');
    return runCmd('-e', ['bash', '-lc', `eval "$(echo ${b64} | base64 -d)"`], opts);
  }
  return runCmd('bash', ['-lc', script], opts);
}

function runAgentSh(remote, script, timeout) {
  return remote ? runRemoteCmd(remote, script, { timeout }) : runLocalSh(script, { timeout });
}

const DIFF_MAX_BYTES = 200 * 1024;
const DIFF_MAX_FILES = 50;

// The base an agent's work is measured against:
//   - on a branch other than the default (a worktree, or a branch it made):
//     merge-base with the default branch, so committed and uncommitted work
//     both count and whatever landed on main since does not;
//   - on the default branch itself: the last commit before the agent started,
//     so its own commits count;
//   - otherwise plain HEAD — uncommitted changes only.
// Every case diffs base against the working tree. Untracked files never show
// in `git diff`; they are counted separately rather than added with -N, which
// would touch the agent's index.
// Sets $br, $def (default branch), $base and $how (see above) in the agent's cwd.
function diffBaseSh(startedAt) {
  const start = Math.floor((startedAt || 0) / 1000);
  return [
    `br=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)`,
    `def=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@')`,
    `[ -n "$def" ] && git rev-parse --verify --quiet "refs/heads/$def" >/dev/null || def=`,
    `[ -z "$def" ] && for b in main master; do git rev-parse --verify --quiet "refs/heads/$b" >/dev/null && { def=$b; break; }; done`,
    `base=; how=`,
    `[ -n "$def" ] && [ "$br" != "$def" ] && base=$(git merge-base HEAD "$def" 2>/dev/null) && how="merge-base with $def"`,
    `[ -z "$base" ] && [ ${start} -gt 0 ] && base=$(git rev-list -1 --before=@${start} HEAD 2>/dev/null) && [ -n "$base" ] && how="HEAD at agent start"`,
    `[ -z "$base" ] && { base=HEAD; how="uncommitted only"; }`,
  ].join('\n');
}

ipcMain.handle('agent-diff', async (event, { cwd, remote, startedAt, full }) => {
  if (!cwd) return { ok: false, error: 'no cwd' };
  const dir = remote ? cwd : winToWslPath(cwd);
  const script = [
    `cd ${shQuote(dir)} 2>/dev/null || { echo '@@MF gone'; exit 0; }`,
    `git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo '@@MF nogit'; exit 0; }`,
    diffBaseSh(startedAt),
    `gd=$(cd "$(git rev-parse --absolute-git-dir)" && pwd -P); gc=$(cd "$(git rev-parse --git-common-dir)" && pwd -P)`,
    `wt=; [ "$gd" != "$gc" ] && wt=$(git rev-parse --show-toplevel)`,
    `echo '@@MF ok'; echo "$br"; echo "$wt"; echo "$how"`,
    `echo '@@MF files'; git diff --numstat "$base" | head -n ${DIFF_MAX_FILES}`,
    `echo '@@MF total'; git diff --shortstat "$base"; echo; git diff --name-only "$base" | wc -l`,
    `echo '@@MF untracked'; git ls-files --others --exclude-standard | wc -l`,
    full ? `echo '@@MF diff'; git diff "$base" | head -c ${DIFF_MAX_BYTES + 1}` : '',
  ].join('\n');

  const res = await runAgentSh(remote, script, full ? 30000 : 15000);
  const out = String(res.stdout || '');
  if (/^@@MF gone/m.test(out)) return { ok: false, error: 'worktree removed' };
  if (/^@@MF nogit/m.test(out)) return { ok: false, error: 'not a git repo' };
  if (!/^@@MF ok/m.test(out)) return { ok: false, error: (res.stderr || 'diff failed').trim().slice(0, 300) };

  // Sections are fenced by marker lines, as in remoteActivity.
  const sec = {};
  for (const chunk of out.split(/^@@MF /m)) {
    const nl = chunk.indexOf('\n');
    if (nl !== -1) sec[chunk.slice(0, nl).trim()] = chunk.slice(nl + 1);
    else if (chunk.trim()) sec[chunk.trim()] = '';
  }
  const [branch, worktree, base] = (sec.ok || '').split('\n');
  const files = (sec.files || '').split('\n').filter((l) => l.trim()).map((l) => {
    const [a, d, ...p] = l.split('\t');
    return { path: p.join('\t'), add: a === '-' ? null : +a, del: d === '-' ? null : +d };
  });
  const total = (sec.total || '').trim().split('\n');
  const shortstat = total[0] || '';
  const num = (re) => +((shortstat.match(re) || [])[1] || 0);
  const r = {
    ok: true,
    branch: branch || null,
    worktree: worktree || null,
    base: base || null,
    files,
    fileCount: parseInt(total[total.length - 1], 10) || 0,
    added: num(/(\d+) insertion/),
    deleted: num(/(\d+) deletion/),
    untracked: parseInt(sec.untracked, 10) || 0,
  };
  if (full) {
    const d = sec.diff || '';
    r.truncated = d.length > DIFF_MAX_BYTES;
    r.diff = d.slice(0, DIFF_MAX_BYTES);
  }
  return r;
});

// Run a verify check in the agent's cwd: a login shell so the user's PATH has
// node/npm, stderr folded into the tail. On timeout the local ssh/wsl end is
// killed; a remote command may outlive it. With no `cmd` the check is detected
// in the same script: a real package.json "test" script runs `npm test`, else
// `node --check` on every existing .js/.mjs/.cjs file the agent changed or
// added (diff base as in agent-diff, untracked included), else nothing to
// check, which passes. Its first two lines (`@@MF cmd`, `@@MF run`) say what ran.
const VERIFY_TIMEOUT_MS = 5 * 60 * 1000;
const VERIFY_TAIL_CHARS = 3000;
function verifyDetectSh(startedAt) {
  return [
    diffBaseSh(startedAt),
    `if [ -f package.json ] && node -e 'const t=((require("./package.json").scripts)||{}).test; process.exit(t && !/no test specified/.test(t) ? 0 : 1)' 2>/dev/null; then`,
    `  echo '@@MF cmd npm test'; echo '@@MF run npm test'; npm test; exit $?`,
    `fi`,
    `files=$({ git -c core.quotePath=false diff --relative --name-only --diff-filter=d "$base" 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null; } | grep -E '\\.(js|mjs|cjs)$' | sort -u | while IFS= read -r f; do [ -f "$f" ] && printf '%s\\n' "$f"; done)`,
    `n=$(printf '%s' "$files" | grep -c .)`,
    `if [ "$n" -eq 0 ]; then echo '@@MF cmd no checks found'; echo '@@MF run'; echo 'no package.json test script and no changed .js/.mjs/.cjs files'; exit 0; fi`,
    `s=s; [ "$n" -eq 1 ] && s=`,
    `echo "@@MF cmd node --check ($n file$s)"; echo "@@MF run node --check on each of: $(printf '%s' "$files" | tr '\\n' ' ')"`,
    `rc=0`,
    `while IFS= read -r f; do node --check "$f" || { echo "FAIL: $f"; rc=1; }; done <<MF_FILES`,
    `$files`,
    `MF_FILES`,
    `[ $rc -eq 0 ] && echo "ok: $n file$s parsed"`,
    `exit $rc`,
  ].join('\n');
}

ipcMain.handle('agent-verify', async (event, { cwd, cmd, remote, startedAt }) => {
  if (!cwd) return { ok: false, error: 'no cwd' };
  const dir = remote ? cwd : winToWslPath(cwd);
  const body = cmd ? `{ ${cmd}\n} 2>&1` : `{\n${verifyDetectSh(startedAt)}\n} 2>&1`;
  const script = `cd ${shQuote(dir)} 2>/dev/null || { echo 'worktree removed'; exit 97; }\n${body}`;
  const t0 = Date.now();
  const res = await runAgentSh(remote, script, VERIFY_TIMEOUT_MS);
  const timedOut = res.code === undefined && res.stderr === 'Timeout';
  let tail = String(res.stdout || '');
  let label = cmd || 'auto-detect';
  let run = cmd || '';
  const m = !cmd && tail.match(/^@@MF cmd (.*)\n@@MF run ?(.*)\n?/m);
  if (m) { label = m[1]; run = m[2]; tail = tail.slice(0, m.index) + tail.slice(m.index + m[0].length); }
  if (timedOut) tail += '\n[timed out after 5 min]';
  else if (res.code !== 0 && res.stderr) tail += '\n' + res.stderr; // ssh/wsl's own errors
  return {
    ok: true,
    pass: res.code === 0,
    cmd: label,
    run,
    none: !cmd && label === 'no checks found',
    code: typeof res.code === 'number' ? res.code : null,
    timedOut,
    ms: Date.now() - t0,
    tail: tail.slice(-VERIFY_TAIL_CHARS),
  };
});

// Auto-merge a verified agent's branch into the repo's main working tree (the
// first entry of `git worktree list`), which must be clean and on the default
// branch. Never pushes. A conflict is aborted so the tree is left as it was.
// Merges are serialised: two agents passing at once would fight over index.lock.
let mergeChain = Promise.resolve();
ipcMain.handle('agent-merge', (event, { cwd, branch, remote }) => {
  const run = mergeChain.then(() => agentMerge(cwd, branch, remote));
  mergeChain = run.catch(() => {});
  return run;
});

async function agentMerge(cwd, branch, remote) {
  if (!cwd || !branch) return { ok: false, error: 'no cwd or branch' };
  const dir = remote ? cwd : winToWslPath(cwd);
  const script = [
    `cd ${shQuote(dir)} 2>/dev/null || { echo '@@MF skip'; echo 'agent worktree removed'; exit 0; }`,
    `b=${shQuote(branch)}`,
    `git rev-parse --verify --quiet "refs/heads/$b" >/dev/null || { echo '@@MF skip'; echo "no local branch $b"; exit 0; }`,
    `git update-index -q --refresh; git diff-index --quiet HEAD -- || { echo '@@MF skip'; echo 'agent worktree has uncommitted changes'; exit 0; }`,
    `main=$(git worktree list --porcelain | sed -n '1s/^worktree //p')`,
    `cd "$main" 2>/dev/null || { echo '@@MF skip'; echo 'main working tree not found'; exit 0; }`,
    `def=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@')`,
    `[ -n "$def" ] && git rev-parse --verify --quiet "refs/heads/$def" >/dev/null || def=`,
    `[ -z "$def" ] && for x in main master; do git rev-parse --verify --quiet "refs/heads/$x" >/dev/null && { def=$x; break; }; done`,
    `[ -z "$def" ] && { echo '@@MF skip'; echo 'no default branch'; exit 0; }`,
    `[ "$b" = "$def" ] && { echo '@@MF skip'; echo "agent worked on $def itself, nothing to merge"; exit 0; }`,
    `cur=$(git rev-parse --abbrev-ref HEAD)`,
    `[ "$cur" = "$def" ] || { echo '@@MF skip'; echo "main working tree is on $cur, not $def"; exit 0; }`,
    `git update-index -q --refresh; git diff-index --quiet HEAD -- || { echo '@@MF skip'; echo "main working tree has uncommitted changes"; exit 0; }`,
    `git merge-base --is-ancestor "$b" HEAD && { echo '@@MF skip'; echo "$b is already merged into $def"; exit 0; }`,
    `if out=$(git merge --no-edit "$b" 2>&1); then echo '@@MF merged'; git rev-parse --short HEAD; echo "$def"; exit 0; fi`,
    `if [ -n "$(git ls-files -u)" ]; then echo '@@MF conflict'; else echo '@@MF failed'; fi`,
    `git merge --abort >/dev/null 2>&1`,
    `echo "$out" | tail -n 20`,
  ].join('\n');

  const res = await runAgentSh(remote, script, 60000);
  const m = String(res.stdout || '').match(/^@@MF (\w+)\n?([\s\S]*)/m);
  if (!m) return { ok: false, error: (res.stderr || 'merge failed to run').trim().slice(0, 300) };
  const lines = m[2].split('\n');
  if (m[1] === 'skip') return { ok: true, status: 'skipped', reason: lines[0] };
  if (m[1] === 'merged') return { ok: true, status: 'merged', sha: lines[0], into: lines[1] };
  return { ok: true, status: m[1], output: m[2].trim().slice(-VERIFY_TAIL_CHARS) };
}

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
