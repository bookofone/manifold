/* xterm and FitAddon loaded via script tags */
const Terminal = globalThis.Terminal;
const FitAddon = (globalThis.FitAddon || {}).FitAddon;
const WebglAddon = (globalThis.WebglAddon || {}).WebglAddon;
const CanvasAddon = (globalThis.CanvasAddon || {}).CanvasAddon;

if (!Terminal) console.error('xterm Terminal not loaded!');
if (!FitAddon) console.error('FitAddon not loaded!');

// Home directory - resolved async at startup
let homeDir = '/';
// Platform flag - resolved async at startup
let isMac = false;

// ── State ──
const state = {
  collections: [],
  activeCollectionIdx: -1,
  activeTabIdx: -1,
  gridCollection: null,
  defaultSource: 'claude', // 'claude' | 'copilot' | 'terminal' — what Ctrl/Cmd+T launches
  remotes: [], // { name, host, defaultPath }
};

// Terminal instances: tabId -> { terminal, fitAddon, element }
const terminalInstances = new Map();
// Last non-empty selection per terminal.
const lastDataTime = new Map(); // tabId -> Date.now() of last received data
const terminalAlive = new Map(); // tabId -> bool, cached from polling
let tabIdCounter = 0;

// ── DOM refs ──
const collectionsList = document.getElementById('collections-list');
const terminalSingle = document.getElementById('terminal-single');
const terminalGrid = document.getElementById('terminal-grid');

// ── Helpers ──
function genTabId() { return `tab-${++tabIdCounter}`; }

function getActiveCollection() {
  return state.collections[state.activeCollectionIdx] || null;
}

function getActiveTab() {
  const col = getActiveCollection();
  if (!col) return null;
  return col.tabs[state.activeTabIdx] || null;
}

// ── Terminal helpers ──
function fitTerminal(tabId) {
  const inst = terminalInstances.get(tabId);
  if (!inst) return;
  if (inst.isConductor) return; // no pty, no cols/rows — CSS handles the layout
  inst.fitAddon.fit();
  manifold.resizeTerminal(tabId, inst.terminal.cols, inst.terminal.rows);
  scrollTerminalToBottom(inst);
}

function scrollTerminalToBottom(inst) {
  inst.terminal.scrollToBottom();
  // xterm renders async after fit() — scroll again after render settles
  setTimeout(() => {
    inst.terminal.scrollToBottom();
    const vp = inst.element.querySelector('.xterm-viewport');
    if (vp) vp.scrollTop = vp.scrollHeight;
  }, 50);
}

// ── Terminal creation ──
function createTerminalInstance(tabId, cwd, conversationId, name, collectionName, prompt, shellOnly, customCmd, provider = 'claude', sessionId = null, resume = false, remote = null) {
  const term = new Terminal({
    cursorBlink: true,
    scrollback: 5000,
    // TUIs like Claude Code enable mouse reporting, which makes xterm disable
    // selection and forward drags to the pty. The only override on macOS is
    // Option+drag, and it requires this flag (defaults to false) — without it
    // text selection is impossible in every mouse-mode terminal.
    macOptionClickForcesSelection: true,
    fontFamily: '"Share Tech Mono", monospace',
    fontSize: 14,
    theme: {
      background: '#1a1a1a',
      foreground: '#d0d0d0',
      cursor: '#D97757',
      selectionBackground: '#D9775744',
      selectionForeground: '#ffffff',
      selectionInactiveBackground: '#D9775730',
      black: '#2e3436',
      red: '#cc0000',
      green: '#4e9a06',
      yellow: '#c4a000',
      blue: '#3465a4',
      magenta: '#75507b',
      cyan: '#06989a',
      white: '#d3d7cf',
      brightBlack: '#555753',
      brightRed: '#ef2929',
      brightGreen: '#8ae234',
      brightYellow: '#fce94f',
      brightBlue: '#729fcf',
      brightMagenta: '#ad7fa8',
      brightCyan: '#34e2e2',
      brightWhite: '#eeeeec',
    },
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);

  const el = document.createElement('div');
  el.className = 'terminal-container';
  el.style.width = '100%';
  el.style.height = '100%';

  terminalInstances.set(tabId, { terminal: term, fitAddon, element: el });

  // Spawn backend pty
  manifold.createTerminal({ id: tabId, cwd, conversationId: conversationId || null, name: name || tabId, collectionName: collectionName || '', prompt: prompt || null, shell: shellOnly || false, cmd: customCmd || null, provider, sessionId, resume, remote: remote || null });

  // Pipe input to pty
  term.onData((data) => manifold.sendInput(tabId, data));

  // Keyboard shortcuts are handled by handleAppShortcut (called from xterm's
  // custom key handler). Copy/paste use our IPC clipboard path exclusively —
  // Electron's Edit menu has no accelerators to avoid stealing Ctrl+C from SIGINT.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (handleAppShortcut(e)) return false;
    return true;
  });

  // Clicking a terminal moves the sidebar/grid highlight to its tab.
  el.addEventListener('mousedown', () => syncActiveTabToFocus(tabId), true);

  // Right-click context menu on terminal for copy/paste
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showTerminalContextMenu(e.clientX, e.clientY, term, tabId);
  });

  // Open terminal (double RAF to let DOM fully settle before measuring)
  requestAnimationFrame(() => {
    term.open(el);

    // GPU-accelerated rendering: WebGL → Canvas2D → DOM (slowest)
    // On Linux, WebGL often runs in software (llvmpipe/SwiftShader) which is
    // slower than DOM. Detect this and fall back to Canvas2D which is reliably
    // hardware-accelerated on all platforms.
    let rendererLoaded = false;
    if (WebglAddon) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl.dispose();
          // Try canvas fallback on context loss
          if (CanvasAddon) {
            try { term.loadAddon(new CanvasAddon()); } catch (_) {}
          }
        });
        term.loadAddon(webgl);
        // Check if WebGL is hardware-accelerated
        const testCanvas = document.createElement('canvas');
        const gl = testCanvas.getContext('webgl2') || testCanvas.getContext('webgl');
        if (gl) {
          const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
          if (debugInfo) {
            const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL).toLowerCase();
            if (renderer.includes('swiftshader') || renderer.includes('llvmpipe') || renderer.includes('softpipe') || renderer.includes('software')) {
              // Software WebGL — worse than DOM, bail out
              webgl.dispose();
            } else {
              rendererLoaded = true;
            }
          } else {
            rendererLoaded = true; // Can't detect, assume OK
          }
          gl.getExtension('WEBGL_lose_context')?.loseContext();
        }
      } catch (_) {
        // WebGL failed entirely
      }
    }
    if (!rendererLoaded && CanvasAddon) {
      try {
        term.loadAddon(new CanvasAddon());
      } catch (_) {
        // Canvas2D failed — stuck with DOM renderer
      }
    }

    requestAnimationFrame(() => {
      fitTerminal(tabId);
      const inst = terminalInstances.get(tabId);
      if (!inst) return;
      inst.opened = true;
      // An SSH session may have asked for our size before xterm was measured.
      // Answer it now that cols/rows reflect the real element.
      if (inst.pendingSizeRequest) {
        inst.pendingSizeRequest = false;
        manifold.resizeTerminal(tabId, inst.terminal.cols, inst.terminal.rows);
      }
    });
  });

  return { terminal: term, fitAddon, element: el };
}

// ── Terminal cleanup ──
function destroyTerminalInstance(tabId) {
  if (terminalInstances.get(tabId)?.isConductor) {
    destroyConductorPane(tabId);
    terminalInstances.delete(tabId);
    lastDataTime.delete(tabId);
    terminalAlive.delete(tabId);
    return;
  }
  manifold.destroyTerminal(tabId);
  pendingWrites.delete(tabId);
  hiddenBuffers.delete(tabId);
  const inst = terminalInstances.get(tabId);
  if (inst) {
    if (inst.element.parentNode) inst.element.parentNode.removeChild(inst.element);
    try { inst.terminal.dispose(); } catch (_) {}
    terminalInstances.delete(tabId);
    lastDataTime.delete(tabId);
    terminalAlive.delete(tabId);
  }
}

// ── Receive data from pty — chunked write queue with flow control ──
// Without this, dumping large output (cat hugefile, ls -laR /) into a single
// terminal.write() blocks xterm's parser and renderer, causing input lag.
// We chunk incoming data into 4KB pieces and use xterm's write(data, callback)
// to only feed the next chunk when xterm is ready. Hidden terminals buffer
// data and flush when they become visible.

const WRITE_CHUNK_SIZE = 4096;
const pendingWrites = new Map(); // tabId -> { queue: string[], draining: bool }

// No selection-aware write pausing here: terminal.write() does not clear an
// xterm selection. What does is user input, an alt-buffer switch, a scrollback
// trim past the selection, and mouse-protocol toggles. Pausing writes never
// addressed any of those — it only froze output for up to 10s.

function getWriteState(id) {
  let ws = pendingWrites.get(id);
  if (!ws) {
    ws = { queue: [], draining: false };
    pendingWrites.set(id, ws);
  }
  return ws;
}

function drainWriteQueue(id) {
  const inst = terminalInstances.get(id);
  const ws = pendingWrites.get(id);
  if (!inst || !ws || ws.queue.length === 0) {
    if (ws) ws.draining = false;
    return;
  }
  ws.draining = true;
  const chunk = ws.queue.shift();
  inst.terminal.write(chunk, () => {
    // xterm finished processing this chunk — feed next
    if (ws.queue.length > 0) {
      drainWriteQueue(id);
    } else {
      ws.draining = false;
    }
  });
}

function enqueueWrite(id, data) {
  const ws = getWriteState(id);
  // Split into chunks so xterm can breathe between renders
  for (let i = 0; i < data.length; i += WRITE_CHUNK_SIZE) {
    ws.queue.push(data.slice(i, i + WRITE_CHUNK_SIZE));
  }
  if (!ws.draining) {
    drainWriteQueue(id);
  }
}

function isTerminalVisible(tabId) {
  const tab = getActiveTab();
  if (tab && tab.id === tabId) return true;
  // Also visible if in grid view
  const gc = state.gridCollection;
  if (gc !== null && state.collections[gc]) {
    return state.collections[gc].tabs.some(t => t.id === tabId);
  }
  return false;
}

// Buffer for hidden terminals — flushed when they become visible
const hiddenBuffers = new Map(); // tabId -> string[]

// Cache conversation IDs as soon as main process detects them
manifold.onConversationDetected((tabId, conversationId) => {
  for (const col of state.collections) {
    const tab = col.tabs.find(t => t.id === tabId);
    if (tab) { tab.conversationId = conversationId; break; }
  }
});

// Respond to size requests from main process (e.g. after SSH reconnect)
// Only SSH sessions ask for this (main.js wireUpSshPty, on connect and on every
// reconnect). At connect time it arrives before xterm has been opened and fitted,
// so terminal.cols/rows are still the 80x24 constructor defaults. Replying with
// those tells the remote the wrong width: it wraps its output at column 80 while
// the visible terminal is far wider, and a drag then selects text that doesn't
// line up with what's on screen. Defer until we have real dimensions.
manifold.onTerminalRequestSize((id) => {
  const inst = terminalInstances.get(id);
  if (!inst) return;
  if (!inst.opened) { inst.pendingSizeRequest = true; return; }
  manifold.resizeTerminal(id, inst.terminal.cols, inst.terminal.rows);
});

manifold.onTerminalData((id, data) => {
  lastDataTime.set(id, Date.now());
  const inst = terminalInstances.get(id);
  if (!inst) return;

  if (isTerminalVisible(id)) {
    enqueueWrite(id, data);
  } else {
    // Buffer data for hidden terminals
    let buf = hiddenBuffers.get(id);
    if (!buf) { buf = []; hiddenBuffers.set(id, buf); }
    buf.push(data);
  }
});

// ── Conductor pane ──
//
// A conductor tab is not a pty. It talks to a long-lived `claude` process over
// stream-json, which means the input box is never blocked by a turn in flight:
// messages go into a local queue and drain as the process frees up. That is the
// whole point — one always-open thread you talk to, while the real work happens
// in detached background agents listed in the roster alongside it.

const conductorPanes = new Map(); // tabId -> pane state

function createConductorPane(tabId, cwd, name, sessionId = null, selfName = null) {
  const el = document.createElement('div');
  el.className = 'conductor-pane';
  el.innerHTML = `
    <div class="cond-main">
      <div class="cond-log"></div>
      <div class="cond-queue hidden"></div>
      <form class="cond-input-row">
        <textarea class="cond-input" rows="1" placeholder="Message the conductor — always open, never blocks" spellcheck="false"></textarea>
        <button type="submit" class="cond-send" title="Send">${'↵'}</button>
      </form>
    </div>
    <div class="cond-roster">
      <div class="cond-roster-head">
        <span class="cond-roster-title">SUBCONSCIOUS</span>
        <button class="cond-done-toggle hidden" title="Show or hide finished agents"></button>
        <button class="cond-clear-btn" title="Delete every finished agent">clear</button>
        <button class="cond-dispatch-btn" title="Dispatch a background agent">+</button>
      </div>
      <div class="cond-roster-list"></div>
      <div class="cond-roster-empty">No background agents.<br>Ask the conductor to dispatch one, or hit +.</div>
    </div>
  `;

  const pane = {
    tabId,
    cwd,
    element: el,
    log: el.querySelector('.cond-log'),
    queueEl: el.querySelector('.cond-queue'),
    input: el.querySelector('.cond-input'),
    form: el.querySelector('.cond-input-row'),
    rosterList: el.querySelector('.cond-roster-list'),
    rosterEmpty: el.querySelector('.cond-roster-empty'),
    queue: [],
    busy: false,
    started: false,
    currentTurn: null,
    selfName: selfName || null,
    sessionId: sessionId || null,
    // Completion tracking: agents can finish without saying anything, so the
    // roster poll watches for the transition itself rather than trusting them.
    agentStates: new Map(),
    lastEventAt: Date.now(),
    rosterInit: false,
    showDone: false,
    pendingNotices: [],
  };
  conductorPanes.set(tabId, pane);

  // Register a shim in terminalInstances so every existing code path that
  // shows, hides, grids, highlights or closes a tab works unchanged.
  terminalInstances.set(tabId, {
    element: el,
    isConductor: true,
    terminal: {
      focus: () => pane.input.focus(),
      dispose: () => {},
      scrollToBottom: () => {},
    },
    fitAddon: { fit: () => {} },
  });
  terminalAlive.set(tabId, true);

  // Input: Enter sends, Shift+Enter newlines. Never disabled.
  pane.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitConductorMessage(pane);
    }
    e.stopPropagation(); // don't let app shortcuts eat ordinary typing
  });
  pane.input.addEventListener('input', () => {
    pane.input.style.height = 'auto';
    pane.input.style.height = Math.min(pane.input.scrollHeight, 160) + 'px';
  });
  pane.form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitConductorMessage(pane);
  });

  el.querySelector('.cond-dispatch-btn').addEventListener('click', () => dispatchAgentPrompt(pane));
  el.querySelector('.cond-clear-btn').addEventListener('click', () => clearFinishedAgents(pane));
  el.querySelector('.cond-done-toggle').addEventListener('click', () => {
    pane.showDone = !pane.showDone;
    refreshRoster(pane);
  });

  // A restored tab replays its transcript first, so the feed doesn't come back
  // blank while the process is still starting.
  if (sessionId) replayConductorHistory(pane, sessionId);
  startConductor(pane, name);
  refreshRoster(pane);

  return { terminal: null, fitAddon: null, element: el };
}

async function replayConductorHistory(pane, sessionId) {
  const res = await manifold.conductorHistory(sessionId, pane.cwd);
  if (!res || !res.ok || !res.entries.length) return;
  if (res.truncated) condSysLine(pane, '…earlier history trimmed');
  for (const e of res.entries) {
    if (e.role === 'tool') condToolChip(pane, e.name, e.input);
    else if (e.role === 'agent') condAgentBubble(pane, e.from, e.text);
    else condBubble(pane, e.role, e.text);
  }
  condSysLine(pane, `── resumed · ${res.entries.length} earlier messages ──`);
}

async function startConductor(pane, name) {
  condSysLine(pane, pane.sessionId ? 'Resuming conductor…' : `Starting conductor in ${pane.cwd}…`);
  const res = await manifold.conductorCreate({
    id: pane.tabId, cwd: pane.cwd, model: 'sonnet',
    sessionId: pane.sessionId, name: pane.selfName,
  });
  if (!res || !res.ok) {
    condSysLine(pane, `Failed to start: ${(res && res.error) || 'unknown error'}`, true);
    terminalAlive.set(pane.tabId, false);
    return;
  }
  pane.started = true;
  pane.selfName = res.selfName || null;
}

// ── Sending: queue in, drain as the process frees up ──

function submitConductorMessage(pane) {
  const text = pane.input.value.trim();
  if (!text) return;
  pane.input.value = '';
  pane.input.style.height = 'auto';

  condBubble(pane, 'user', text);

  // Piggyback unreported agent completions onto this message. The bubble above
  // shows only what the user typed; the conductor gets the notices too, so it
  // knows without anyone burning a turn to tell it.
  let outgoing = text;
  if (pane.pendingNotices.length > 0) {
    outgoing = pane.pendingNotices.join('\n') + '\n\n' + text;
    pane.pendingNotices = [];
  }
  pane.queue.push(outgoing);
  renderQueue(pane);
  preemptAndDrain(pane);
}

// The point of the conductor is that it always answers, so a message never waits
// behind the previous one: if a turn is running it gets interrupted and the new
// message goes straight out. The queue below only holds a message for the few
// milliseconds an interrupt is in flight.
async function preemptAndDrain(pane) {
  if (pane.busy) {
    condSysLine(pane, '\u26a1 interrupted the previous turn');
    const res = await manifold.conductorInterrupt(pane.tabId);
    if (!res || !res.ok) condSysLine(pane, `Interrupt failed: ${(res && res.error) || '?'}`, true);
    pane.busy = false;
    setConductorBusy(pane, false);
  }
  drainConductorQueue(pane);
}

async function drainConductorQueue(pane) {
  if (pane.busy || pane.queue.length === 0) return;
  const text = pane.queue.shift();
  renderQueue(pane);
  pane.busy = true;
  setConductorBusy(pane, true);

  const res = await manifold.conductorSend(pane.tabId, text);
  if (!res || !res.ok) {
    condSysLine(pane, `Send failed: ${(res && res.error) || 'conductor not running'}`, true);
    pane.busy = false;
    setConductorBusy(pane, false);
  }
}

function renderQueue(pane) {
  if (pane.queue.length === 0) {
    pane.queueEl.classList.add('hidden');
    pane.queueEl.innerHTML = '';
    return;
  }
  pane.queueEl.classList.remove('hidden');
  pane.queueEl.innerHTML = `<span class="cond-queue-label">queued</span>` +
    pane.queue.map((q) => `<span class="cond-queue-chip">${escHtml(q.slice(0, 60))}</span>`).join('') +
    `<button class="cond-queue-clear" title="Discard queued messages">\u2715</button>`;
  pane.queueEl.querySelector('.cond-queue-clear').addEventListener('click', () => {
    pane.queue = [];
    renderQueue(pane);
    condSysLine(pane, 'Queue cleared.');
  });
}

function setConductorBusy(pane, busy) {
  pane.element.classList.toggle('cond-busy', busy);
  lastDataTime.set(pane.tabId, Date.now());
}

// ── Rendering ──

function condScroll(pane) {
  pane.log.scrollTop = pane.log.scrollHeight;
}

function condBubble(pane, role, text) {
  const div = document.createElement('div');
  div.className = `cond-msg cond-msg-${role}`;
  div.textContent = text;
  pane.log.appendChild(div);
  condScroll(pane);
  return div;
}

// Agent reports arrive as user turns in the transcript. Rendering them as user
// bubbles made the replay look like the person had said them, so they get their
// own shape with the sender's name on it.
function condAgentBubble(pane, from, text) {
  const div = document.createElement('div');
  div.className = 'cond-msg cond-msg-agent';
  const label = document.createElement('div');
  label.className = 'cond-msg-from';
  label.textContent = from || 'agent';
  const body = document.createElement('div');
  body.textContent = text;
  div.appendChild(label);
  div.appendChild(body);
  pane.log.appendChild(div);
  condScroll(pane);
}

function condSysLine(pane, text, isError) {
  const div = document.createElement('div');
  div.className = 'cond-sys' + (isError ? ' cond-sys-error' : '');
  div.textContent = text;
  pane.log.appendChild(div);
  condScroll(pane);
}

function condToolChip(pane, name, input) {
  const div = document.createElement('div');
  div.className = 'cond-tool';
  let detail = '';
  if (input && typeof input === 'object') {
    detail = input.command || input.description || JSON.stringify(input);
  }
  div.innerHTML = `<span class="cond-tool-name">${escHtml(name)}</span> <span class="cond-tool-detail">${escHtml(String(detail).slice(0, 180))}</span>`;
  pane.log.appendChild(div);
  condScroll(pane);
}

manifold.onConductorEvent((tabId, msg) => {
  const pane = conductorPanes.get(tabId);
  if (!pane) return;
  lastDataTime.set(tabId, Date.now());
  pane.lastEventAt = Date.now();

  switch (msg.type) {
    case 'system':
      // init re-fires on every turn, not just the first — only announce once.
      if (msg.session_id) pane.sessionId = msg.session_id;
      if (msg.subtype === 'init' && !pane.announced) {
        pane.announced = true;
        condSysLine(pane, `Conductor ready — ${msg.model || 'claude'} · session ${String(msg.session_id || '').slice(0, 8)}`);
      }
      break;

    case 'assistant': {
      const blocks = (msg.message && msg.message.content) || [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text.trim()) condBubble(pane, 'assistant', b.text);
        else if (b.type === 'tool_use') condToolChip(pane, b.name, b.input);
      }
      break;
    }

    case 'result':
      pane.busy = false;
      setConductorBusy(pane, false);
      if (msg.is_error) condSysLine(pane, `Turn failed: ${msg.subtype || 'error'}`, true);
      // A turn finishing is the cue to re-check what the subconscious is doing.
      refreshRoster(pane);
      drainConductorQueue(pane);
      break;

    case 'rate_limit_event': {
      const w = msg.rate_limit_info && msg.rate_limit_info.unifiedWindows;
      if (w && w.five_hour) {
        const pct = Math.round((w.five_hour.utilization || 0) * 100);
        const title = pane.element.querySelector('.cond-roster-title');
        if (title) title.textContent = `SUBCONSCIOUS · ${pct}% 5h`;
      }
      break;
    }

    // The process was replaced under us; whatever turn was running is gone.
    case 'manifold_reset':
      pane.busy = false;
      setConductorBusy(pane, false);
      drainConductorQueue(pane);
      break;

    case 'manifold_agent_msg':
      condAgentBubble(pane, msg.from, msg.text);
      break;

    case 'manifold_notice':
      condSysLine(pane, msg.text);
      break;

    case 'manifold_error':
      condSysLine(pane, msg.text, true);
      break;

    case 'manifold_exit':
      condSysLine(pane, `Conductor exited (code ${msg.code}).`, true);
      terminalAlive.set(tabId, false);
      pane.busy = false;
      setConductorBusy(pane, false);
      renderQueue(pane);
      break;
  }
});

// ── Roster: the subconscious ──

async function refreshRoster(pane) {
  const res = await manifold.agentsList(pane.cwd);
  if (!res || !res.ok) {
    pane.rosterEmpty.textContent = (res && res.error) || 'Could not list agents.';
    pane.rosterEmpty.classList.remove('hidden');
    pane.rosterList.innerHTML = '';
    return;
  }
  renderRoster(pane, res.agents || []);
}

function renderRoster(pane, agents) {
  // `claude agents --json` lists interactive sessions too — including this
  // conductor itself — and those have no short `id`, only a pid/sessionId.
  // Attaching to them is meaningless (they're already attached) and produced
  // `claude attach undefined`. The subconscious is background sessions only.
  agents = agents.filter((a) => a.kind === 'background' && a.id);

  // Watch for work finishing. An agent that wasn't told to report back just goes
  // quiet, so the poll detects the transition and surfaces it here.
  const seen = new Map();
  for (const a of agents) {
    const st = a.state || a.status || 'unknown';
    seen.set(a.id, st);
    const prev = pane.agentStates.get(a.id);
    if (!pane.rosterInit) continue;
    if (st === 'done' && prev !== 'done') condAgentDone(pane, a);
    // Verified: an agent that asks a question and waits reports 'blocked', and
    // stays there indefinitely. Nothing frees it but a human, so it is the one
    // state worth interrupting for.
    else if (st === 'blocked' && prev !== 'blocked') condAgentBlocked(pane, a);
  }
  pane.agentStates = seen;
  pane.rosterInit = true;
  pane.agents = agents; // full list — bulk actions must see finished ones too

  // Finished agents are noise once you've read the completion notice, so the
  // roster shows live work only. `blocked` counts as live — that's the one that
  // most needs attention.
  const isDone = (a) => (a.state || a.status) === 'done';
  const doneAgents = agents.filter(isDone);
  const liveAgents = agents.filter((a) => !isDone(a));

  const clearBtn = pane.element.querySelector('.cond-clear-btn');
  if (clearBtn) {
    clearBtn.textContent = doneAgents.length ? `clear ${doneAgents.length}` : 'clear';
    clearBtn.disabled = doneAgents.length === 0;
  }
  const doneBtn = pane.element.querySelector('.cond-done-toggle');
  if (doneBtn) {
    doneBtn.textContent = doneAgents.length ? `${doneAgents.length} done` : '';
    doneBtn.classList.toggle('hidden', doneAgents.length === 0);
    doneBtn.classList.toggle('on', !!pane.showDone);
  }

  agents = pane.showDone ? agents : liveAgents;

  // Anything waiting on a human floats to the top of the column.
  const rank = (a) => ((a.state || a.status) === 'blocked' ? 0 : 1);
  agents = agents.slice().sort((x, y) => rank(x) - rank(y));

  pane.rosterEmpty.textContent = doneAgents.length && !pane.showDone
    ? 'Nothing running.'
    : 'No background agents.\nAsk the conductor to dispatch one, or hit +.';
  pane.rosterEmpty.classList.toggle('hidden', agents.length > 0);
  pane.rosterList.innerHTML = '';

  for (const a of agents) {
    const card = document.createElement('div');
    card.className = 'cond-agent';

    // status/state come straight from the CLI; render whatever it says rather
    // than assuming a fixed enum.
    const status = a.state || a.status || 'unknown';
    const isBlocked = status === 'blocked';
    const busy = !isBlocked && status !== 'idle' && status !== 'done';
    if (isBlocked) card.classList.add('cond-agent-blocked');

    card.innerHTML = `
      <div class="cond-agent-top">
        <span class="cond-agent-dot ${isBlocked ? 'blocked' : busy ? 'busy' : ''}"></span>
        <span class="cond-agent-id">${escHtml(a.id || '')}</span>
        <span class="cond-agent-status">${isBlocked ? 'needs you' : escHtml(String(status))}</span>
      </div>
      <div class="cond-agent-name">${escHtml(a.name || '(no prompt)')}</div>
      <div class="cond-agent-feed" data-id="${escAttr(a.id)}"></div>
      <div class="cond-agent-actions">
        <button class="cond-agent-btn act-attach">attach</button>
        <button class="cond-agent-btn act-logs">logs</button>
        <button class="cond-agent-btn act-stop">stop</button>
        <button class="cond-agent-btn cond-agent-del act-del" title="Delete this agent">✕</button>
      </div>
    `;

    // Attach promotes a background agent into a real TUI tab — the handoff from
    // watching to driving, which is the one thing the terminal does better.
    card.querySelector('.act-attach').addEventListener('click', () => attachAgentTab(pane, a));
    card.querySelector('.act-logs').addEventListener('click', async () => {
      const r = await manifold.agentLogs(a.id, pane.cwd);
      condSysLine(pane, `── logs ${a.id} ──`);
      condBubble(pane, 'logs', (r && r.text) || '(no output)');
    });
    card.querySelector('.act-del').addEventListener('click', () => removeAgent(pane, a, busy));
    card.querySelector('.act-stop').addEventListener('click', async () => {
      const r = await manifold.agentStop(a.id, pane.cwd);
      condSysLine(pane, r && r.ok ? `Stopped ${a.id}.` : `Stop failed: ${(r && r.error) || '?'}`, !(r && r.ok));
      refreshRoster(pane);
    });

    pane.rosterList.appendChild(card);
  }

  renderAgentActivity(pane, agents);
}

// What each agent is actually doing, tailed from its own transcript. `claude
// logs` would replay raw terminal output (spinner frames, 100KB+); the .jsonl is
// already structured, so this reads the last few tool calls and lines instead.
async function renderAgentActivity(pane, agents) {
  const live = agents
    .filter((a) => a.sessionId && (a.state || a.status) !== 'done')
    .map((a) => ({ id: a.id, sessionId: a.sessionId, cwd: a.cwd || pane.cwd }));
  if (!live.length) return;

  const res = await manifold.agentsActivity(live);
  if (!res) return;

  for (const [id, info] of Object.entries(res)) {
    const el = pane.rosterList.querySelector(`.cond-agent-feed[data-id="${CSS.escape(id)}"]`);
    if (!el) continue;
    if (!info.events || !info.events.length) {
      el.innerHTML = '<div class="cond-feed-line cond-feed-dim">starting\u2026</div>';
      continue;
    }
    el.innerHTML = info.events.map((e) => (
      e.kind === 'tool'
        ? `<div class="cond-feed-line"><span class="cond-feed-tool">${escHtml(e.name)}</span> ${escHtml(shortTarget(e.target))}</div>`
        : `<div class="cond-feed-line cond-feed-dim">${escHtml(e.text)}</div>`
    )).join('');
  }
}

// Long absolute paths swamp a 260px column — the basename is the useful part.
function shortTarget(t) {
  if (!t) return '';
  if (t.includes('/') && !t.includes(' ')) return t.split('/').slice(-2).join('/');
  return t.length > 64 ? t.slice(0, 64) + '\u2026' : t;
}

// An agent finished. Show it immediately, and hold the note so the conductor
// picks it up on the user's next message.
function condAgentDone(pane, agent) {
  const div = document.createElement('div');
  div.className = 'cond-done';
  div.innerHTML = `<span class="cond-done-dot"></span>agent <b>${escHtml(agent.id)}</b> finished \u2014 ${escHtml(agent.name || '')}`;
  div.title = 'Click to attach';
  div.addEventListener('click', () => attachAgentTab(pane, agent));
  pane.log.appendChild(div);
  condScroll(pane);

  pane.pendingNotices.push(`[Manifold] Background agent ${agent.id} ("${agent.name || ''}") has finished.`);
  showToast(`Agent ${agent.id} finished`);
}

// Deleting a finished agent is one click: it is a spent session and a cluttered
// roster is the thing being fixed. `claude rm` will happily remove a running
// session too, so one that is still working asks first — that discards
// in-flight work.
async function removeAgent(pane, agent, isBusy) {
  if (isBusy) {
    const ok = await showConfirmDialog(`Stop and delete "${agent.name || agent.id}"? It is still working.`, 'Stop & delete');
    if (!ok) return;
  }
  const res = await manifold.agentRemove({ id: agent.id, cwd: agent.cwd || pane.cwd });
  if (!res || !res.ok) {
    condSysLine(pane, `Could not delete ${agent.id}: ${(res && res.error) || '?'}`, true);
  } else {
    // rm reports worktree follow-ups when it cannot finish the job — surface
    // those instead of pretending the delete was clean.
    const extra = (res.output || '').includes('--') ? ` \u2014 ${res.output}` : '';
    condSysLine(pane, `Deleted ${agent.id}${extra}`);
  }
  pane.agentStates.delete(agent.id);
  refreshRoster(pane);
}

async function clearFinishedAgents(pane) {
  const done = (pane.agents || []).filter((a) => (a.state || a.status) === 'done');
  if (!done.length) return;
  for (const a of done) {
    const res = await manifold.agentRemove({ id: a.id, cwd: a.cwd || pane.cwd });
    if (!res || !res.ok) condSysLine(pane, `Could not delete ${a.id}: ${(res && res.error) || '?'}`, true);
    pane.agentStates.delete(a.id);
  }
  condSysLine(pane, `Cleared ${done.length} finished agent${done.length === 1 ? '' : 's'}.`);
  showToast(`Cleared ${done.length} agent${done.length === 1 ? '' : 's'}`);
  refreshRoster(pane);
}

// An agent is waiting on an answer. Unlike a completion this will never resolve
// on its own, so it is louder, and clicking it attaches so you can reply.
function condAgentBlocked(pane, agent) {
  const div = document.createElement('div');
  div.className = 'cond-done cond-blocked-notice';
  div.innerHTML = `<span class="cond-done-dot"></span>agent <b>${escHtml(agent.id)}</b> needs you \u2014 ${escHtml(agent.name || '')}`;
  div.title = 'Click to attach and answer';
  div.addEventListener('click', () => attachAgentTab(pane, agent));
  pane.log.appendChild(div);
  condScroll(pane);

  pane.pendingNotices.push(`[Manifold] Background agent ${agent.id} ("${agent.name || ''}") is BLOCKED waiting for a human answer. It will not continue until someone replies.`);
  showToast(`Agent ${agent.id} needs you`, true);
}

function attachAgentTab(pane, agent) {
  if (!agent || !agent.id) {
    showToast('That session has no attachable id', true);
    return;
  }
  let ci = -1;
  for (let c = 0; c < state.collections.length; c++) {
    if (state.collections[c].tabs.some((t) => t.id === pane.tabId)) { ci = c; break; }
  }
  if (ci === -1) return;
  const col = state.collections[ci];

  const wasGridded = col.gridded;
  if (wasGridded) hideGridView();

  const tabId = genTabId();
  const cmd = `claude attach ${agent.id}`;
  const name = `▸ ${agent.id}`;
  const dir = agent.cwd || pane.cwd;

  col.tabs.push({ id: tabId, name, cwd: dir, cmd });
  createTerminalInstance(tabId, dir, null, name, col.name, null, false, cmd);

  col.expanded = true;
  selectTab(ci, col.tabs.length - 1);
  renderCollections();
  if (wasGridded) showGridView(ci);
  saveState();
}

async function dispatchAgentPrompt(pane) {
  const prompt = await showInputDialog('Dispatch background agent', 'Self-contained task for the agent...');
  if (!prompt) return;
  condSysLine(pane, `Dispatching: ${prompt.slice(0, 80)}…`);
  const res = await manifold.agentDispatch({ cwd: pane.cwd, prompt, model: 'sonnet' });
  if (!res || !res.ok) {
    condSysLine(pane, `Dispatch failed: ${(res && res.error) || '?'}`, true);
    return;
  }
  condSysLine(pane, `Dispatched → ${res.id}`);
  refreshRoster(pane);
}

// Backstop. Interrupting on send means the queue should never sit, but if a turn
// dies in a way that emits no frame at all, this stops the pane wedging shut.
const CONDUCTOR_STALL_MS = 120000;
setInterval(() => {
  for (const [, pane] of conductorPanes) {
    if (!pane.busy) continue;
    if (Date.now() - pane.lastEventAt < CONDUCTOR_STALL_MS) continue;
    condSysLine(pane, 'No response for 2 minutes \u2014 releasing the turn.', true);
    pane.busy = false;
    setConductorBusy(pane, false);
    drainConductorQueue(pane);
  }
}, 5000);

// Roster poll — only for panes that are actually on screen.
setInterval(() => {
  for (const [tabId, pane] of conductorPanes) {
    if (isTerminalVisible(tabId)) refreshRoster(pane);
  }
}, 4000);

function destroyConductorPane(tabId) {
  const pane = conductorPanes.get(tabId);
  if (!pane) return;
  manifold.conductorDestroy(tabId);
  if (pane.element.parentNode) pane.element.parentNode.removeChild(pane.element);
  conductorPanes.delete(tabId);
}

function addConductor(ci, cwd = null) {
  const col = state.collections[ci];
  if (!col) return;
  if (col.remote) {
    showToast('Conductor runs locally — not available on remote collections', true);
    return;
  }

  const wasGridded = col.gridded;
  if (wasGridded) hideGridView();

  const tabId = genTabId();
  const dir = cwd || col.path;
  const name = `Conductor ${col.tabs.length + 1}`;

  col.tabs.push({ id: tabId, name, cwd: dir, provider: 'conductor' });
  createConductorPane(tabId, dir, name);

  col.expanded = true;
  selectTab(ci, col.tabs.length - 1);
  renderCollections();

  if (wasGridded) showGridView(ci);
  saveState();
}

// ── Collection rendering ──
function renderCollections() {
  collectionsList.innerHTML = '';
  state.collections.forEach((col, ci) => {
    const colEl = document.createElement('div');
    colEl.className = `collection${ci === state.activeCollectionIdx ? ' collection-active' : ''}`;
    colEl.innerHTML = `
      <div class="collection-header" data-ci="${ci}">
        <span class="collection-arrow">${col.expanded ? '\u25BC' : '\u25B6'}</span>
        <div class="collection-info">
          <span class="collection-name">${escHtml(col.name)}</span>
          <span class="collection-path">${col.remote ? escHtml(col.remote.split(/\s+/).pop()) + ':' : ''}${escHtml(col.path)}</span>
        </div>
        <input class="collection-rename" type="text" value="${escAttr(col.name)}">
        <div class="collection-btns">
          <button class="collection-btn grid-btn" data-ci="${ci}" title="Grid view">${'\u229E'}</button>
          <button class="collection-btn-del del-btn" data-ci="${ci}" title="Delete collection">${'\u2715'}</button>
          <div class="add-menu-wrap">
            <button class="collection-btn add-trigger" data-ci="${ci}" title="New...">+</button>
            <div class="add-menu" data-ci="${ci}">
              <button class="add-menu-item add-btn" data-ci="${ci}"><span class="add-menu-icon">&#x2726;</span> Claude</button>
              <button class="add-menu-item copilot-btn" data-ci="${ci}"><span class="add-menu-icon">&#x2708;</span> Copilot</button>
              <button class="add-menu-item term-btn" data-ci="${ci}"><span class="add-menu-icon">&gt;_</span> Terminal</button>
              <button class="add-menu-item conductor-btn" data-ci="${ci}"><span class="add-menu-icon">&#x25C9;</span> Conductor</button>
              ${(col.commands || []).map((cmd, cmdI) => `<button class="add-menu-item cmd-btn" data-ci="${ci}" data-cmdi="${cmdI}" title="${escAttr(cmd.cmd)}"><span class="add-menu-icon">&#x26A1;</span> ${escHtml(cmd.name)}</button>`).join('')}
              <button class="add-menu-item addcmd-btn" data-ci="${ci}"><span class="add-menu-icon">+</span> Add command</button>
            </div>
          </div>
        </div>
      </div>
      <div class="collection-body ${col.expanded ? '' : 'collapsed'}" data-ci="${ci}">
        ${col.tabs.map((tab, ti) => `
          <div class="tab-row ${ci === state.activeCollectionIdx && ti === state.activeTabIdx ? 'selected' : ''}"
               data-ci="${ci}" data-ti="${ti}" draggable="true">
            <span class="row-drag" title="Drag to reorder">${'\u2847'}</span>
            <span class="row-dot" data-tabid="${tab.id}">${'\u2022'}</span>
            <span class="row-idx">${ti + 1}</span>
            <span class="row-label">${escHtml(tab.name)}</span>
            <input class="row-rename" type="text" value="${escAttr(tab.name)}">
            <button class="row-close" data-ci="${ci}" data-ti="${ti}">${'\u2715'}</button>
          </div>
        `).join('')}
      </div>
    `;
    collectionsList.appendChild(colEl);

    // Grid button active state
    if (col.gridded) {
      colEl.querySelector('.grid-btn').classList.add('active');
    }
  });

  bindCollectionEvents();
  updateAllDots();
}

function bindCollectionEvents() {
  // Collection header click — if gridded, switch to it; otherwise expand/collapse
  document.querySelectorAll('.collection-header').forEach((el) => {
    let clickTimer = null;
    el.addEventListener('click', (e) => {
      if (e.target.closest('.collection-btns')) return;
      if (e.target.classList.contains('collection-rename')) return;
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; return; }
      clickTimer = setTimeout(() => {
        clickTimer = null;
        const ci = parseInt(el.dataset.ci);
        if (state.collections[ci].gridded && state.activeCollectionIdx !== ci) {
          const col = state.collections[ci];
          if (col.tabs.length > 0) {
            selectTab(ci, 0);
          }
        } else {
          state.collections[ci].expanded = !state.collections[ci].expanded;
        }
        renderCollections();
      }, 250);
    });

    // Double-click to rename
    el.addEventListener('dblclick', (e) => {
      if (e.target.closest('.collection-btns')) return;
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      const ci = parseInt(el.dataset.ci);
      const infoEl = el.querySelector('.collection-info');
      const input = el.querySelector('.collection-rename');
      infoEl.style.display = 'none';
      input.style.display = 'block';
      input.value = state.collections[ci].name;
      input.focus();
      input.select();

      const finish = () => {
        const val = input.value.trim();
        if (val) state.collections[ci].name = val;
        infoEl.style.display = '';
        input.style.display = 'none';
        renderCollections();
        saveState();
      };
      input.onkeydown = (ev) => {
        if (ev.key === 'Enter') finish();
        if (ev.key === 'Escape') { infoEl.style.display = ''; input.style.display = 'none'; }
      };
      input.onblur = finish;
    });
  });

  // Tab row click + double-click rename
  document.querySelectorAll('.tab-row').forEach((el) => {
    let tabClickTimer = null;

    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('row-close')) return;
      if (e.target.classList.contains('row-rename')) return;
      if (e.target.classList.contains('row-drag')) return;
      if (tabClickTimer) { clearTimeout(tabClickTimer); tabClickTimer = null; return; }
      tabClickTimer = setTimeout(() => {
        tabClickTimer = null;
        const ci = parseInt(el.dataset.ci);
        const ti = parseInt(el.dataset.ti);
        selectTab(ci, ti);
      }, 250);
    });

    el.addEventListener('dblclick', (e) => {
      if (e.target.classList.contains('row-close')) return;
      if (e.target.classList.contains('row-drag')) return;
      if (tabClickTimer) { clearTimeout(tabClickTimer); tabClickTimer = null; }
      const ci = parseInt(el.dataset.ci);
      const ti = parseInt(el.dataset.ti);
      const label = el.querySelector('.row-label');
      const input = el.querySelector('.row-rename');
      label.style.display = 'none';
      input.style.display = 'block';
      input.value = state.collections[ci].tabs[ti].name;
      input.focus();
      input.select();

      const finish = () => {
        const val = input.value.trim();
        if (val) state.collections[ci].tabs[ti].name = val;
        label.style.display = '';
        input.style.display = 'none';
        renderCollections();
        saveState();
      };
      input.onkeydown = (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); finish(); }
        if (ev.key === 'Escape') { label.style.display = ''; input.style.display = 'none'; }
      };
      input.onblur = finish;
    });

    // Right-click context menu
    el.addEventListener('contextmenu', (e) => {
      if (e.target.classList.contains('row-rename')) return;
      e.preventDefault();
      const ci = parseInt(el.dataset.ci);
      const ti = parseInt(el.dataset.ti);
      showTabContextMenu(e.clientX, e.clientY, ci, ti);
    });

    // Drag and drop reordering
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', `${el.dataset.ci}:${el.dataset.ti}`);
      el.classList.add('dragging');
    });

    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      document.querySelectorAll('.tab-row.drag-over').forEach(r => r.classList.remove('drag-over'));
    });

    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drag-over');
    });

    el.addEventListener('dragleave', () => {
      el.classList.remove('drag-over');
    });

    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drag-over');
      const [srcCi, srcTi] = e.dataTransfer.getData('text/plain').split(':').map(Number);
      const dstCi = parseInt(el.dataset.ci);
      const dstTi = parseInt(el.dataset.ti);

      if (srcCi !== dstCi) return;
      if (srcTi === dstTi) return;

      const col = state.collections[srcCi];
      const [moved] = col.tabs.splice(srcTi, 1);
      const insertAt = srcTi < dstTi ? dstTi - 1 : dstTi;
      col.tabs.splice(insertAt, 0, moved);

      if (state.activeCollectionIdx === srcCi) {
        if (state.activeTabIdx === srcTi) {
          state.activeTabIdx = insertAt;
        } else if (srcTi < state.activeTabIdx && insertAt >= state.activeTabIdx) {
          state.activeTabIdx--;
        } else if (srcTi > state.activeTabIdx && insertAt <= state.activeTabIdx) {
          state.activeTabIdx++;
        }
      }

      renderCollections();
      saveState();
    });
  });

  // Close tab
  document.querySelectorAll('.row-close').forEach((el) => {
    el.addEventListener('click', () => {
      const ci = parseInt(el.dataset.ci);
      const ti = parseInt(el.dataset.ti);
      closeSession(ci, ti);
    });
  });

  // Delete collection button
  document.querySelectorAll('.del-btn').forEach((el) => {
    el.addEventListener('click', () => {
      const ci = parseInt(el.dataset.ci);
      deleteCollection(ci);
    });
  });

  // Grid toggle button
  document.querySelectorAll('.grid-btn').forEach((el) => {
    el.addEventListener('click', () => {
      const ci = parseInt(el.dataset.ci);
      toggleGrid(ci);
    });
  });

  // Add menu items
  document.querySelectorAll('.add-menu-item').forEach((el) => {
    el.addEventListener('click', () => {
      const ci = parseInt(el.dataset.ci);
      // Close menu
      const wrap = el.closest('.add-menu-wrap');
      if (wrap) wrap.classList.remove('menu-open');

      if (el.classList.contains('add-btn')) {
        addSession(ci);
      } else if (el.classList.contains('copilot-btn')) {
        addCopilot(ci);
      } else if (el.classList.contains('term-btn')) {
        addTerminal(ci);
      } else if (el.classList.contains('conductor-btn')) {
        addConductor(ci);
      } else if (el.classList.contains('cmd-btn')) {
        const cmdI = parseInt(el.dataset.cmdi);
        const col = state.collections[ci];
        if (col && col.commands && col.commands[cmdI]) {
          launchCommand(ci, col.commands[cmdI]);
        }
      } else if (el.classList.contains('addcmd-btn')) {
        addCommandToCollection(ci);
      }
    });

    // Right-click to delete custom commands
    if (el.classList.contains('cmd-btn')) {
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const ci = parseInt(el.dataset.ci);
        const cmdI = parseInt(el.dataset.cmdi);
        const col = state.collections[ci];
        if (col && col.commands && col.commands[cmdI]) {
          removeCommandFromCollection(ci, cmdI);
        }
      });
    }
  });

}

// ── Tab selection ──
// Point state at the clicked terminal WITHOUT re-rendering. selectTab() would
// call showGridView(), which rebuilds the grid DOM and would wipe the selection
// the user is in the middle of dragging — so this only moves the highlight.
function syncActiveTabToFocus(tabId) {
  let ci = -1, ti = -1;
  for (let c = 0; c < state.collections.length; c++) {
    const t = state.collections[c].tabs.findIndex((tab) => tab.id === tabId);
    if (t !== -1) { ci = c; ti = t; break; }
  }
  if (ci === -1) return;
  if (state.activeCollectionIdx === ci && state.activeTabIdx === ti) return;
  state.activeCollectionIdx = ci;
  state.activeTabIdx = ti;

  document.querySelectorAll('.tab-row').forEach((el) => el.classList.remove('selected'));
  const row = document.querySelector(`.tab-row[data-ci="${ci}"][data-ti="${ti}"]`);
  if (row) row.classList.add('selected');
  highlightGridCell(tabId);
}

function selectTab(ci, ti) {
  state.activeCollectionIdx = ci;
  state.activeTabIdx = ti;

  const col = state.collections[ci];
  if (!col) return;
  const tab = col.tabs[ti];
  if (!tab) return;

  // Auto-expand collapsed collections when navigating into them
  if (!col.expanded) {
    col.expanded = true;
    renderCollections();
  }

  document.querySelectorAll('.tab-row').forEach((el) => el.classList.remove('selected'));
  const row = document.querySelector(`.tab-row[data-ci="${ci}"][data-ti="${ti}"]`);
  if (row) row.classList.add('selected');

  if (col.gridded) {
    state.gridCollection = ci;
    showGridView(ci);
    highlightGridCell(tab.id);
  } else {
    if (state.gridCollection !== null) hideGridView();
    state.gridCollection = null;
    showSingleTerminal(tab.id);
  }
}

function flushHiddenBuffer(tabId) {
  const buf = hiddenBuffers.get(tabId);
  if (buf && buf.length > 0) {
    const data = buf.join('');
    hiddenBuffers.delete(tabId);
    enqueueWrite(tabId, data);
  }
}

function showSingleTerminal(tabId) {
  for (const child of terminalSingle.children) {
    child.style.display = 'none';
  }
  const inst = terminalInstances.get(tabId);
  if (inst) {
    if (!inst.element.parentNode || inst.element.parentNode !== terminalSingle) {
      terminalSingle.appendChild(inst.element);
    }
    inst.element.style.display = '';
    flushHiddenBuffer(tabId);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        fitTerminal(tabId);
        inst.terminal.focus();
      });
    });
  }
}

function highlightGridCell(tabId) {
  document.querySelectorAll('.grid-cell').forEach((cell) => {
    cell.classList.remove('grid-cell-active');
  });
  const inst = terminalInstances.get(tabId);
  if (inst && inst.element) {
    const cell = inst.element.closest('.grid-cell');
    if (cell) cell.classList.add('grid-cell-active');
    requestAnimationFrame(() => inst.terminal.focus());
  }
}

// ── Session management ──
function addSession(ci, cwd = null) {
  const col = state.collections[ci];
  if (!col) return;

  const wasGridded = col.gridded;
  if (wasGridded) hideGridView();

  const tabId = genTabId();
  const dir = cwd || col.path;
  const name = `Session ${col.tabs.length + 1}`;

  col.tabs.push({ id: tabId, name, cwd: dir, remote: col.remote || null });
  createTerminalInstance(tabId, dir, null, name, col.name, null, false, null, 'claude', null, false, col.remote || null);

  col.expanded = true;
  selectTab(ci, col.tabs.length - 1);
  renderCollections();

  if (wasGridded) showGridView(ci);
  saveState();
}

// Launch whichever source is set as the default (Ctrl/Cmd+T).
function addDefaultSession(ci, cwd = null) {
  switch (state.defaultSource) {
    case 'copilot': return addCopilot(ci, cwd);
    case 'terminal': return addTerminal(ci, cwd);
    case 'conductor': {
      // Conductor is local-only. On a remote collection fall back to a normal
      // session so Ctrl+T still produces something instead of a dead toast.
      if (state.collections[ci] && state.collections[ci].remote) {
        showToast('Conductor is local-only — opened a Claude session instead');
        return addSession(ci, cwd);
      }
      return addConductor(ci, cwd);
    }
    default: return addSession(ci, cwd);
  }
}

function addCopilot(ci, cwd = null) {
  const col = state.collections[ci];
  if (!col) return;

  const wasGridded = col.gridded;
  if (wasGridded) hideGridView();

  const tabId = genTabId();
  const dir = cwd || col.path;
  const name = `Copilot ${col.tabs.length + 1}`;

  const sessionId = crypto.randomUUID();
  col.tabs.push({ id: tabId, name, cwd: dir, provider: 'copilot', copilotSessionId: sessionId });
  createTerminalInstance(tabId, dir, null, name, col.name, null, false, null, 'copilot', sessionId);

  col.expanded = true;
  selectTab(ci, col.tabs.length - 1);
  renderCollections();

  if (wasGridded) showGridView(ci);
  saveState();
}

function addTerminal(ci, cwd = null) {
  const col = state.collections[ci];
  if (!col) return;

  const wasGridded = col.gridded;
  if (wasGridded) hideGridView();

  const tabId = genTabId();
  const dir = cwd || col.path;
  const name = `Terminal ${col.tabs.length + 1}`;

  col.tabs.push({ id: tabId, name, cwd: dir, shell: true, remote: col.remote || null });
  createTerminalInstance(tabId, dir, null, name, col.name, null, true, null, 'claude', null, false, col.remote || null);

  col.expanded = true;
  selectTab(ci, col.tabs.length - 1);
  renderCollections();

  if (wasGridded) showGridView(ci);
  saveState();
}

function launchCommand(ci, command) {
  const col = state.collections[ci];
  if (!col) return;

  const wasGridded = col.gridded;
  if (wasGridded) hideGridView();

  const tabId = genTabId();
  const dir = col.path;
  const name = command.name;

  col.tabs.push({ id: tabId, name, cwd: dir, cmd: command.cmd, remote: col.remote || null });
  createTerminalInstance(tabId, dir, null, name, col.name, null, false, command.cmd, 'claude', null, false, col.remote || null);

  col.expanded = true;
  selectTab(ci, col.tabs.length - 1);
  renderCollections();

  if (wasGridded) showGridView(ci);
  saveState();
}

// ── Input dialog helper ──
function showInputDialog(title, placeholder) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('input-dialog-overlay');
    const titleEl = document.getElementById('input-dialog-title');
    const field = document.getElementById('input-dialog-field');
    const okBtn = document.getElementById('input-dialog-ok');
    const cancelBtn = document.getElementById('input-dialog-cancel');

    titleEl.textContent = title;
    field.value = '';
    field.placeholder = placeholder || '';
    overlay.classList.remove('hidden');
    field.focus();

    function cleanup(val) {
      overlay.classList.add('hidden');
      field.onkeydown = null;
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      overlay.onclick = null;
      resolve(val);
    }

    okBtn.onclick = () => cleanup(field.value.trim() || null);
    cancelBtn.onclick = () => cleanup(null);
    overlay.onclick = (e) => { if (e.target === overlay) cleanup(null); };
    field.onkeydown = (e) => {
      if (e.key === 'Enter') cleanup(field.value.trim() || null);
      if (e.key === 'Escape') cleanup(null);
    };
  });
}

// Same overlay as showInputDialog, with the text field hidden — a confirm that
// looks like the rest of the app rather than a native browser box.
function showConfirmDialog(title, okLabel = 'Delete') {
  return new Promise((resolve) => {
    const overlay = document.getElementById('input-dialog-overlay');
    const titleEl = document.getElementById('input-dialog-title');
    const field = document.getElementById('input-dialog-field');
    const okBtn = document.getElementById('input-dialog-ok');
    const cancelBtn = document.getElementById('input-dialog-cancel');
    const okText = okBtn.textContent;

    titleEl.textContent = title;
    field.style.display = 'none';
    okBtn.textContent = okLabel;
    overlay.classList.remove('hidden');
    okBtn.focus();

    function cleanup(val) {
      overlay.classList.add('hidden');
      field.style.display = '';   // restore for showInputDialog
      okBtn.textContent = okText;
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      overlay.onclick = null;
      document.removeEventListener('keydown', onKey, true);
      resolve(val);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); cleanup(false); }
      if (e.key === 'Enter') { e.stopPropagation(); cleanup(true); }
    }

    okBtn.onclick = () => cleanup(true);
    cancelBtn.onclick = () => cleanup(false);
    overlay.onclick = (e) => { if (e.target === overlay) cleanup(false); };
    document.addEventListener('keydown', onKey, true);
  });
}

async function addCommandToCollection(ci) {
  const col = state.collections[ci];
  if (!col) return;

  const name = await showInputDialog('Command name', 'e.g. Dev Server');
  if (!name) return;

  const cmd = await showInputDialog('Command to run', 'e.g. npm run dev');
  if (!cmd) return;

  if (!col.commands) col.commands = [];
  col.commands.push({ name, cmd });
  renderCollections();
  saveState();
}

// ── Fork session ──
async function forkSession(ci, ti) {
  const col = state.collections[ci];
  if (!col) { showToast('No collection selected', true); return; }
  const tab = col.tabs[ti];
  if (!tab) { showToast('No session selected', true); return; }
  if (tab.provider === 'copilot') {
    if (!tab.copilotSessionId) { showToast('No Copilot session ID available', true); return; }

    if (col.gridded) hideGridView();

    const tabId = genTabId();
    const name = `${tab.name} (fork)`;
    col.tabs.push({ id: tabId, name, cwd: tab.cwd, provider: 'copilot', copilotSessionId: tab.copilotSessionId });
    createTerminalInstance(tabId, tab.cwd, null, name, col.name, null, false, null, 'copilot', tab.copilotSessionId, true);

    col.expanded = true;
    col.gridded = true;
    state.gridCollection = ci;
    selectTab(ci, col.tabs.length - 1);
    renderCollections();
    showGridView(ci);
    saveState();
    return;
  }

  if (tab.shell || tab.cmd) { showToast('Can only fork Claude or Copilot sessions', true); return; }

  const convoId = tab.conversationId || await manifold.getConversationId(tab.id) || await manifold.scanConversation(tab.cwd);
  if (!convoId) { showToast('No conversation yet — send a message first', true); return; }
  tab.conversationId = convoId;

  const newId = await manifold.forkConversation({ conversationId: convoId, cwd: tab.cwd });
  if (!newId) return;

  if (col.gridded) hideGridView();

  const tabId = genTabId();
  const name = `${tab.name} (fork)`;

  col.tabs.push({ id: tabId, name, cwd: tab.cwd, conversationId: newId });
  createTerminalInstance(tabId, tab.cwd, newId, name, col.name);

  col.expanded = true;
  col.gridded = true;
  state.gridCollection = ci;

  selectTab(ci, col.tabs.length - 1);
  renderCollections();
  showGridView(ci);
  saveState();
}

function removeCommandFromCollection(ci, cmdIdx) {
  const col = state.collections[ci];
  if (!col || !col.commands) return;
  col.commands.splice(cmdIdx, 1);
  renderCollections();
  saveState();
}

function closeSession(ci, ti) {
  const col = state.collections[ci];
  const tab = col.tabs[ti];
  if (!tab) return;

  const wasGridded = col.gridded;
  if (wasGridded) hideGridView();

  destroyTerminalInstance(tab.id);

  col.tabs.splice(ti, 1);

  if (col.tabs.length === 0 && col.gridded) {
    col.gridded = false;
    state.gridCollection = null;
  }

  if (ci === state.activeCollectionIdx) {
    if (col.tabs.length > 0) {
      const newTi = Math.min(ti, col.tabs.length - 1);
      selectTab(ci, newTi);
    } else {
      // Find another collection with tabs, or go empty
      let found = false;
      for (let i = 0; i < state.collections.length; i++) {
        if (state.collections[i].tabs.length > 0) {
          selectTab(i, 0);
          found = true;
          break;
        }
      }
      if (!found) {
        state.activeTabIdx = -1;
        for (const child of terminalSingle.children) child.style.display = 'none';
        hideGridView();
      }
    }
  }

  if (wasGridded && col.tabs.length > 0) showGridView(ci);
  renderCollections();
  saveState();
}

// ── Collection management ──
async function addCollection(askPath = false) {
  let folderPath = null;
  let name = null;

  if (askPath) {
    folderPath = await manifold.pickFolder();
    if (!folderPath) return;
    const parts = folderPath.split(/[/\\]/);
    name = parts[parts.length - 1] || folderPath;
  }

  if (!name) name = `Collection ${state.collections.length + 1}`;
  if (!folderPath) folderPath = homeDir || '/';

  const col = { name, path: folderPath, expanded: true, gridded: false, commands: [], tabs: [] };
  state.collections.push(col);
  const ci = state.collections.length - 1;

  if (askPath) {
    // Open the first session using whatever source is set as the default
    // (claude / copilot / terminal) instead of always claude. addDefaultSession
    // pushes the tab, creates the instance, selects it, renders and saves.
    addDefaultSession(ci, folderPath);
  }

  renderCollections();
  saveState();
}

function deleteCollection(ci) {
  const col = state.collections[ci];
  if (!col) return;

  if (col.gridded) {
    hideGridView();
    state.gridCollection = null;
  }

  col.tabs.forEach((tab) => {
    destroyTerminalInstance(tab.id);
  });

  state.collections.splice(ci, 1);

  state.gridCollection = null;

  if (state.collections.length === 0) {
    state.activeCollectionIdx = -1;
    state.activeTabIdx = -1;
    // Clear terminal area
    for (const child of terminalSingle.children) child.style.display = 'none';
    hideGridView();
  } else {
    if (state.activeCollectionIdx >= state.collections.length) {
      state.activeCollectionIdx = state.collections.length - 1;
    }
    if (state.activeCollectionIdx === ci || state.activeCollectionIdx < 0) {
      let found = false;
      for (let i = 0; i < state.collections.length; i++) {
        if (state.collections[i].tabs.length > 0) {
          selectTab(i, 0);
          found = true;
          break;
        }
      }
      if (!found) {
        state.activeCollectionIdx = 0;
        state.activeTabIdx = -1;
      }
    }
    for (let i = 0; i < state.collections.length; i++) {
      if (state.collections[i].gridded && i === state.activeCollectionIdx) {
        state.gridCollection = i;
      }
    }
  }

  renderCollections();
  saveState();
}

// ── Grid view ──

function toggleGrid(ci) {
  const col = state.collections[ci];
  if (col.gridded) {
    col.gridded = false;
    state.gridCollection = null;
    hideGridView();
    const tab = getActiveTab();
    if (tab) showSingleTerminal(tab.id);
  } else {
    if (state.gridCollection !== null) hideGridView();
    col.gridded = true;
    state.gridCollection = ci;
    state.activeCollectionIdx = ci;
    if (col.tabs.length > 0) {
      state.activeTabIdx = Math.min(state.activeTabIdx, col.tabs.length - 1);
      if (state.activeTabIdx < 0) state.activeTabIdx = 0;
    }
    showGridView(ci);
  }
  renderCollections();
  saveState();
}

function showGridView(ci) {
  const col = state.collections[ci];
  if (!col || !col.tabs.length) return;

  for (const [, inst] of terminalInstances) {
    if (inst.element.parentNode && inst.element.closest('#terminal-grid')) {
      inst.element.parentNode.removeChild(inst.element);
    }
  }

  terminalSingle.classList.add('hidden');
  terminalGrid.classList.remove('hidden');
  terminalGrid.innerHTML = '';

  const count = col.tabs.length;
  const cols = count <= 2 ? count : count <= 4 ? 2 : 3;
  terminalGrid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;

  col.tabs.forEach((tab, ti) => {
    const cell = document.createElement('div');
    cell.className = 'grid-cell';

    const header = document.createElement('div');
    header.className = 'grid-cell-header';
    header.textContent = tab.name;

    const closeBtn = document.createElement('button');
    closeBtn.className = 'grid-cell-close';
    closeBtn.textContent = '\u2715';
    closeBtn.title = 'Close session';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeSession(ci, ti);
    });
    header.appendChild(closeBtn);

    header.addEventListener('click', (e) => {
      if (e.target === closeBtn) return;
      selectTab(ci, ti);
    });

    cell.appendChild(header);

    const inst = terminalInstances.get(tab.id);
    if (inst) {
      if (inst.element.parentNode) inst.element.parentNode.removeChild(inst.element);
      inst.element.style.display = '';
      cell.appendChild(inst.element);
      flushHiddenBuffer(tab.id);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => fitTerminal(tab.id));
      });
    }

    terminalGrid.appendChild(cell);
  });
}

function hideGridView() {
  for (const [, inst] of terminalInstances) {
    if (inst.element.parentNode && inst.element.closest('#terminal-grid')) {
      inst.element.parentNode.removeChild(inst.element);
    }
  }
  terminalGrid.classList.add('hidden');
  terminalGrid.innerHTML = '';
  terminalSingle.classList.remove('hidden');
}

// ── State persistence ──
async function saveState() {
  // Conversation IDs are cached on tab objects by the activity poll.
  // Only fetch for tabs that still lack one (e.g. freshly spawned).
  const allTabs = state.collections.flatMap(col => col.tabs);
  const missing = allTabs.filter(t => !t.conversationId && !t.shell && !t.cmd && t.provider !== 'copilot' && t.provider !== 'conductor' && !t.remote);
  if (missing.length > 0) {
    const results = await Promise.all(
      missing.map(tab => manifold.getConversationId(tab.id).catch(() => null))
    );
    missing.forEach((tab, i) => {
      if (results[i]) tab.conversationId = results[i];
    });
  }

  const data = {
    collections: state.collections.map((col) => ({
      name: col.name,
      path: col.path,
      remote: col.remote || null,
      expanded: col.expanded,
      gridded: col.gridded || false,
      commands: col.commands || [],
      tabs: col.tabs.map((t) => ({
        name: t.name,
        cwd: t.cwd,
        conversationId: t.conversationId || null,
        conductorSessionId: conductorPanes.get(t.id)?.sessionId || t.conductorSessionId || null,
        conductorName: conductorPanes.get(t.id)?.selfName || t.conductorName || null,
        provider: t.provider || 'claude',
        copilotSessionId: t.copilotSessionId || null,
        shell: t.shell || false,
        cmd: t.cmd || null,
        remote: t.remote || null,
      })),
    })),
    activeCollection: state.activeCollectionIdx,
    activeTab: state.activeTabIdx,
    uiScale: parseInt(scaleSlider.value) || 100,
    defaultSource: state.defaultSource,
    remotes: state.remotes,
  };
  await manifold.saveState(data);
}

// ── Keybindings (single source of truth) ──
// Returns true if the event matched an app shortcut.
// Called from both xterm's key handler and the document listener.
// Toast notification
function showToast(msg, isError) {
  let el = document.getElementById('app-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'app-toast';
    el.style.cssText = 'position:fixed;top:8px;right:8px;padding:8px 14px;border-radius:6px;font-size:13px;z-index:99999;font-family:monospace;pointer-events:none;';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.background = isError ? '#cc0000' : '#D97757';
  el.style.color = isError ? '#fff' : '#000';
  el.style.display = 'block';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.style.display = 'none'; }, 3000);
}

// ── Clipboard ──
//
// One coherent model, split only where the platforms genuinely differ. See the
// Edit-menu comment in main.js for the matching menu setup.
//
// TEXT FIELDS (SSH form, rename dialog, settings):
//   • macOS  — the Edit menu's cut/paste roles do Cmd+X/Cmd+V natively; Cmd+C is
//              owned here (see handleAppShortcut) because macOS text inputs get
//              their clipboard keys from the menu and we can't register a copy
//              role without breaking terminal copy.
//   • Win/Linux — Chromium handles Ctrl+X/C/V/Z/A inside inputs on its own; the
//              menu items are click-only and route through the *ContextAware
//              helpers below.
//
// TERMINAL (xterm):
//   • Copy MUST go through app code: xterm's visual selection is not a DOM
//     selection, so no browser/menu copy command can read it. We take
//     term.getSelection() and write it via the main-process clipboard.
//   • Paste: on macOS, Cmd+V rides the Edit menu's paste role straight into
//     xterm's own native paste listener (CRLF normalize + bracketed paste). On
//     Win/Linux, Ctrl+Shift+V is handled here via term.paste().
//   • Ctrl+C always reaches the pty as SIGINT — it is never bound to copy.

// The terminal you're looking at is the one with focus. No bookkeeping needed.
function focusedTerminal() {
  const el = document.activeElement;
  if (!el) return null;
  for (const [tabId, inst] of terminalInstances) {
    if (inst.element.contains(el)) return { term: inst.terminal, tabId };
  }
  return null;
}

// True for real text fields (rename dialog, SSH form, settings). xterm's hidden
// helper textarea is excluded — it *is* the terminal, not a field to protect.
function isTextField(el) {
  if (!el || !el.tagName) return false;
  if (el.classList && el.classList.contains('xterm-helper-textarea')) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true;
}

// The one place that puts text on the clipboard.
function writeClipboard(text) {
  return manifold.clipboardWriteText(text)
    .then(() => showToast(`Copied ${text.length} chars`))
    .catch(err => showToast('Copy failed: ' + err.message, true));
}

function copyFromTerminal(term) {
  const t = term || focusedTerminal()?.term;
  const sel = t ? t.getSelection() : '';
  if (!sel) {
    showToast(`No text selected — ${isMac ? 'Option' : 'Shift'}+drag to select`, true);
    return;
  }
  writeClipboard(sel);
}

function pasteIntoTerminal(term) {
  const t = term || focusedTerminal()?.term;
  if (!t) return;
  // term.paste() handles CRLF normalization and bracketed paste, then emits via
  // onData — the same path typing takes.
  manifold.clipboardReadText()
    .then(text => { if (text) t.paste(text); })
    .catch(err => showToast('Paste failed: ' + err.message, true));
}

// Insert clipboard text at the caret of a focused input/textarea. Used by the
// Edit menu's Paste click on Win/Linux, where there is no paste role to lean on.
function pasteIntoField(el) {
  manifold.clipboardReadText()
    .then(text => {
      if (!text) return;
      el.focus();
      // execCommand keeps native undo history; fall back to a manual splice.
      if (document.execCommand('insertText', false, text)) return;
      if ('value' in el) {
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? el.value.length;
        el.value = el.value.slice(0, start) + text + el.value.slice(end);
        const pos = start + text.length;
        el.setSelectionRange?.(pos, pos);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    })
    .catch(err => showToast('Paste failed: ' + err.message, true));
}

// Context-aware entry points shared by the Edit menu clicks and (for copy) the
// macOS Cmd+C key path. Each routes to the terminal when one is focused,
// otherwise to whatever text field / selection the browser knows about.
function copyContextAware() {
  if (focusedTerminal()) copyFromTerminal();
  else document.execCommand('copy');
}
function pasteContextAware() {
  const ft = focusedTerminal();
  if (ft) { pasteIntoTerminal(ft.term); return; }
  const el = document.activeElement;
  if (isTextField(el)) pasteIntoField(el);
}
function cutContextAware() {
  if (!focusedTerminal()) document.execCommand('cut');
}
function selectAllContextAware() {
  const ft = focusedTerminal();
  if (ft) { ft.term.selectAll(); return; }
  const el = document.activeElement;
  if (isTextField(el) && el.select) el.select();
  else document.execCommand('selectAll');
}

// Edit menu clicks (see main.js for which platform registers which).
manifold.onMenuCopy(copyContextAware);
manifold.onMenuPaste(pasteContextAware);
manifold.onMenuCut(cutContextAware);
manifold.onMenuSelectAll(selectAllContextAware);

function handleAppShortcut(e) {
  const ctrl = e.ctrlKey || e.metaKey;

  // macOS Cmd+C is owned here — even inside text fields — because macOS gives
  // inputs their clipboard keys through the Edit menu, and we can't register a
  // copy role there without clobbering the terminal's (non-DOM) selection.
  // copyContextAware() copies the terminal selection when a terminal is focused,
  // otherwise the focused field / DOM selection. Cmd+V and Cmd+X stay with the
  // Edit menu's native paste/cut roles.
  if (isMac && ctrl && !e.shiftKey && !e.altKey && e.code === 'KeyC') {
    copyContextAware();
    return true;
  }

  // Everything below must not fire while typing in a real text field. Without
  // this guard a bare shortcut (e.g. Ctrl+V in the rename box) would leak into a
  // background terminal instead of the field.
  if (isTextField(e.target)) return false;

  // Ctrl+Shift combos — use e.code for reliability across platforms
  if (ctrl && e.shiftKey) {
    if (e.code === 'KeyF') {
      if (state.activeCollectionIdx >= 0 && state.activeTabIdx >= 0) forkSession(state.activeCollectionIdx, state.activeTabIdx);
      return true;
    }
    if (e.code === 'KeyT') {
      const ci = state.activeCollectionIdx >= 0 ? state.activeCollectionIdx : 0;
      if (state.collections[ci]) addTerminal(ci);
      return true;
    }
    // Terminal copy/paste/select-all. On Win/Linux this is the primary path
    // (Ctrl+C must stay SIGINT); on macOS these are aliases for Cmd+C/Cmd+V.
    // They act only when a terminal is focused so Shift+Ctrl elsewhere is free.
    const ft = focusedTerminal();
    if (e.code === 'KeyC' && ft) { copyFromTerminal(ft.term); return true; }
    if (e.code === 'KeyV' && ft) { pasteIntoTerminal(ft.term); return true; }
    if (e.code === 'KeyA' && ft) { ft.term.selectAll(); showToast('Selected all'); return true; }
  }

  // Ctrl combos (no shift)
  // Ctrl+C is absent on purpose — it must reach the terminal as SIGINT. On macOS
  // Cmd+C is handled at the top of this function; Cmd+V/Cmd+X are native Edit
  // menu roles. On Win/Linux, paste into the terminal is Ctrl+Shift+V (above).
  if (ctrl && !e.shiftKey) {
    if (e.key === 't') {
      const ci = state.activeCollectionIdx >= 0 ? state.activeCollectionIdx : 0;
      if (state.collections[ci]) addDefaultSession(ci);
      return true;
    }
    if (e.key === 'w') {
      if (state.activeCollectionIdx >= 0 && state.activeTabIdx >= 0) closeSession(state.activeCollectionIdx, state.activeTabIdx);
      return true;
    }
    if (e.key === 'p' || e.key === 'y') { addCollection(true); return true; }
    if (e.key === 'g') {
      if (state.activeCollectionIdx >= 0) toggleGrid(state.activeCollectionIdx);
      return true;
    }
    if (e.key >= '1' && e.key <= '9') {
      const ci = state.activeCollectionIdx;
      if (ci >= 0 && state.collections[ci]) {
        const ti = parseInt(e.key) - 1;
        if (ti < state.collections[ci].tabs.length) selectTab(ci, ti);
      }
      return true;
    }
  }

  // Alt combos
  if (e.altKey) {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const cols = state.collections;
      if (cols.length > 1) {
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        const ci = (state.activeCollectionIdx + dir + cols.length) % cols.length;
        if (cols[ci].tabs.length > 0) { selectTab(ci, 0); renderCollections(); }
      }
      return true;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const ci = state.activeCollectionIdx;
      const col = state.collections[ci];
      if (col && col.tabs.length > 1) {
        const dir = e.key === 'ArrowRight' ? 1 : -1;
        const ti = (state.activeTabIdx + dir + col.tabs.length) % col.tabs.length;
        selectTab(ci, ti); renderCollections();
      }
      return true;
    }
    if (e.key >= '1' && e.key <= '9') {
      const ci = state.activeCollectionIdx;
      if (ci >= 0 && state.collections[ci]) {
        const ti = parseInt(e.key) - 1;
        if (ti < state.collections[ci].tabs.length) selectTab(ci, ti);
      }
      return true;
    }
  }

  // Escape
  if (e.key === 'Escape' && !settingsOverlay.classList.contains('hidden')) {
    settingsOverlay.classList.add('hidden');
    return true;
  }

  return false;
}

document.addEventListener('keydown', (e) => {
  if (handleAppShortcut(e)) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

// ── Tab context menu ──
function showTabContextMenu(x, y, ci, ti) {
  dismissContextMenu();
  const tab = state.collections[ci]?.tabs[ti];
  if (!tab) return;

  const menu = document.createElement('div');
  menu.className = 'tab-context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const isClaudeSession = !tab.shell && (!tab.cmd || tab.provider === 'copilot');

  const items = [];
  if (isClaudeSession) {
    items.push({ label: 'Fork session', hint: 'Ctrl+Shift+F', action: () => forkSession(ci, ti) });
  }
  items.push({ label: 'Close', hint: 'Ctrl+W', action: () => closeSession(ci, ti) });

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'ctx-menu-item';
    row.innerHTML = `<span>${item.label}</span><span class="ctx-menu-hint">${item.hint}</span>`;
    row.addEventListener('click', () => { dismissContextMenu(); item.action(); });
    menu.appendChild(row);
  }

  document.body.appendChild(menu);

  // Clamp to viewport
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 4}px`;
    if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 4}px`;
  });

  // Dismiss on click outside or Escape
  setTimeout(() => {
    document.addEventListener('mousedown', dismissContextMenuOutside);
    document.addEventListener('keydown', dismissContextMenuOnEsc);
  }, 0);
}

function dismissContextMenu() {
  const existing = document.querySelector('.tab-context-menu');
  if (existing) existing.remove();
  document.removeEventListener('mousedown', dismissContextMenuOutside);
  document.removeEventListener('keydown', dismissContextMenuOnEsc);
}

function dismissContextMenuOutside(e) {
  if (!e.target.closest('.tab-context-menu')) dismissContextMenu();
}

function dismissContextMenuOnEsc(e) {
  if (e.key === 'Escape') dismissContextMenu();
}

// ── Terminal right-click context menu (copy/paste) ──

// Read visible terminal buffer content directly (bypasses selection entirely)
function getVisibleTerminalText(term) {
  const buf = term.buffer.active;
  const lines = [];
  for (let i = 0; i < term.rows; i++) {
    const line = buf.getLine(buf.viewportY + i);
    if (line) lines.push(line.translateToString(true));
  }
  // Trim trailing empty lines
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join('\n');
}

function showTerminalContextMenu(x, y, term, tabId) {
  dismissContextMenu();

  const menu = document.createElement('div');
  menu.className = 'tab-context-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const sel = term.getSelection();
  const copyHint = isMac ? '\u2318+C' : 'Ctrl+Shift+C';
  const pasteHint = isMac ? '\u2318+V' : 'Ctrl+Shift+V';

  const items = [
    {
      label: 'Copy',
      hint: copyHint,
      disabled: !sel,
      action: () => { copyFromTerminal(term); },
    },
    {
      label: 'Copy all visible',
      hint: '',
      disabled: false,
      action: () => {
        const text = getVisibleTerminalText(term);
        if (text) writeClipboard(text);
      },
    },
    {
      label: 'Select all',
      hint: 'Ctrl+Shift+A',
      disabled: false,
      action: () => {
        term.selectAll();
        term.focus();
      },
    },
    {
      label: 'Paste',
      hint: pasteHint,
      disabled: false,
      action: () => { pasteIntoTerminal(term); term.focus(); },
    },
  ];

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'ctx-menu-item';
    if (item.disabled) row.style.opacity = '0.4';
    row.innerHTML = `<span>${item.label}</span><span class="ctx-menu-hint">${item.hint}</span>`;
    if (!item.disabled) {
      row.addEventListener('click', () => { dismissContextMenu(); item.action(); });
    }
    menu.appendChild(row);
  }

  document.body.appendChild(menu);

  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 4}px`;
    if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 4}px`;
  });

  setTimeout(() => {
    document.addEventListener('mousedown', dismissContextMenuOutside);
    document.addEventListener('keydown', dismissContextMenuOnEsc);
  }, 0);
}

// ── Activity dot helpers ──
function updateDotState(dot, tabId) {
  const alive = terminalAlive.get(tabId) || false;
  if (alive) dot.classList.add('active');
  else dot.classList.remove('active');
  const lastTime = lastDataTime.get(tabId) || 0;
  if (alive && Date.now() - lastTime < 3000) {
    dot.classList.add('thinking');
  } else {
    dot.classList.remove('thinking');
  }
}

function updateAllDots() {
  document.querySelectorAll('.row-dot[data-tabid]').forEach(dot => {
    updateDotState(dot, dot.dataset.tabid);
  });
}

// ── Activity polling ──
setInterval(async () => {
  const tabIds = [...terminalInstances.keys()]
    .filter(id => !terminalInstances.get(id)?.isConductor);
  const results = await Promise.all(
    tabIds.map(id => manifold.isTerminalActive(id).catch(() => false))
  );
  tabIds.forEach((tabId, i) => {
    terminalAlive.set(tabId, results[i]);
  });
  updateAllDots();
}, 1500);

// ── Auto-save ──
setInterval(saveState, 30000);
manifold.onSaveState(() => saveState().then(() => manifold.saveStateDone()));

// ── Window focus handler ──
manifold.onWindowFocus(() => {
  const tab = getActiveTab();
  if (tab) {
    const inst = terminalInstances.get(tab.id);
    if (inst) {
      scrollTerminalToBottom(inst);
      inst.terminal.focus();
    }
  }
});

// ── Resize handler ──
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (state.gridCollection === null) {
          const tab = getActiveTab();
          if (tab) fitTerminal(tab.id);
        } else {
          const col = state.collections[state.gridCollection];
          if (col) col.tabs.forEach((t) => fitTerminal(t.id));
        }
      });
    });
  }, 50);
});

// ── Button events ──
document.getElementById('btn-new-collection').addEventListener('click', () => {
  if (state.remotes.length === 0) {
    addCollection(true).catch(err => console.error('addCollection failed:', err));
  } else {
    showCollectionMenu();
  }
});

// ── Settings modal ──
const settingsOverlay = document.getElementById('settings-overlay');

document.getElementById('settings-btn').addEventListener('click', () => {
  const opening = settingsOverlay.classList.contains('hidden');
  settingsOverlay.classList.toggle('hidden');
  if (opening) showSettingsPane('general');
});

document.getElementById('settings-close-btn').addEventListener('click', () => {
  settingsOverlay.classList.add('hidden');
});

// Sidebar nav — one pane visible at a time. Panes and nav buttons are matched
// by their shared data-pane value, so adding a section means adding markup only.
const settingsNav = document.getElementById('settings-nav');
const settingsPanes = document.getElementById('settings-panes');

function showSettingsPane(name) {
  settingsNav.querySelectorAll('.settings-nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.pane === name);
  });
  settingsPanes.querySelectorAll('.settings-pane').forEach((pane) => {
    pane.classList.toggle('active', pane.dataset.pane === name);
  });
  settingsPanes.scrollTop = 0;
}

settingsNav.querySelectorAll('.settings-nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => showSettingsPane(btn.dataset.pane));
});
settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) settingsOverlay.classList.add('hidden');
});

// ── Shortcuts table (populated after platform detection) ──
function populateShortcuts() {
  const mod = isMac ? '\u2318' : 'Ctrl';
  const shortcuts = [
    [`${mod}+T`, 'New session (default source)'],
    [`${mod}+Shift+T`, 'New terminal'],
    [`${mod}+Y`, 'New collection'],
    [`${mod}+Shift+F`, 'Fork session'],
    [`${mod}+W`, 'Close session'],
    [`${mod}+G`, 'Toggle grid view'],
    [`${mod}+1-9`, 'Switch to tab N'],
    ['Alt+1-9', 'Switch to tab N'],
    ['Alt+\u2191/\u2193', 'Jump between collections'],
    ['Alt+\u2190/\u2192', 'Cycle sessions'],
    ['Ctrl+C', 'SIGINT (always)'],
    [isMac ? 'Option+drag' : 'Shift+drag', 'Select text in terminal'],
    [isMac ? '\u2318+C' : 'Ctrl+Shift+C', 'Copy from terminal'],
    [isMac ? '\u2318+V' : 'Ctrl+Shift+V', 'Paste into terminal'],
    [`${mod}+Shift+A`, 'Select all terminal content'],
    ['Right-click', 'Copy / Paste / Select All'],
    ['Esc', 'Close settings'],
  ];
  const table = document.getElementById('shortcuts-table');
  table.innerHTML = shortcuts.map(([key, desc]) =>
    `<div class="shortcut-row"><span class="shortcut-key">${key}</span><span class="shortcut-desc">${desc}</span></div>`
  ).join('');
}

// ── Default source picker ──
const defaultSourceSeg = document.getElementById('default-source-seg');
let headerHintMod = 'Ctrl';
const SOURCE_LABELS = { claude: 'claude', copilot: 'copilot', terminal: 'terminal', conductor: 'conductor' };

function updateHeaderHints() {
  const m = headerHintMod;
  const src = SOURCE_LABELS[state.defaultSource] || 'session';
  document.getElementById('header-hints').textContent =
    `${m}+T ${src} | ${m}+Shift+F fork | ${m}+Y collection | ${m}+W close | ${m}+G grid`;
}

function renderDefaultSource() {
  defaultSourceSeg.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.source === state.defaultSource);
  });
  updateHeaderHints();
}

defaultSourceSeg.querySelectorAll('.seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    state.defaultSource = btn.dataset.source;
    renderDefaultSource();
    saveState();
  });
});

// ── UI Scale slider ──
const scaleSlider = document.getElementById('scale-slider');
const scaleValue = document.getElementById('scale-value');

function applyScale(pct) {
  const factor = pct / 100;
  manifold.setZoomFactor(factor);
  scaleValue.textContent = `${pct}%`;
  scaleSlider.value = pct;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      for (const [tabId] of terminalInstances) {
        try { fitTerminal(tabId); } catch (_) {}
      }
    });
  });
}

scaleSlider.addEventListener('input', () => {
  const pct = parseInt(scaleSlider.value);
  applyScale(pct);
});

scaleSlider.addEventListener('change', () => {
  saveState();
});

scaleSlider.addEventListener('dblclick', () => {
  applyScale(100);
  saveState();
});

document.getElementById('nuke-btn').addEventListener('click', async () => {
  if (!confirm('Factory reset — clear all saved state and start fresh?')) return;
  if (!confirm('Last chance. Reset everything?')) return;
  await manifold.saveState(null);
  location.reload();
});

// ── Remote destinations management ──

// Connection-test results, keyed by ssh cmd so they survive re-renders and the
// index shifts a delete causes. Session-only — deliberately not in `state`.
const remoteStatus = new Map();
const STATUS_TITLE = { unknown: 'Not tested', ok: 'Connection OK', fail: 'Connection failed' };

function renderRemotes() {
  const list = document.getElementById('remotes-list');
  if (!list) return;

  if (!state.remotes.length) {
    list.innerHTML = '<div class="remotes-empty">No remote destinations yet.</div>';
    return;
  }

  list.innerHTML = state.remotes.map((r, i) => {
    const hostDisplay = r.host
      ? `${r.username || ''}@${r.host}${r.port && r.port !== 22 ? ':' + r.port : ''}`
      : r.cmd;
    const tsBadge = r.tailscale ? '<span class="remote-row-badge">tailnet</span>' : '';
    const st = remoteStatus.get(r.cmd) || 'unknown';
    return `
    <div class="remote-row" data-ri="${i}">
      <div class="remote-row-info">
        <div class="remote-row-top">
          <span class="remote-row-dot ${st}" title="${STATUS_TITLE[st]}"></span>
          <span class="remote-row-name remote-editable" data-ri="${i}" data-field="name" title="Click to edit name">${escHtml(r.name)}</span>${tsBadge}
        </div>
        <div class="remote-row-meta">
          <span class="remote-editable" data-ri="${i}" data-field="cmd" title="Click to edit SSH command">${escHtml(hostDisplay)}</span>
          <span class="remote-row-sep">&middot;</span>
          <span class="remote-row-path remote-editable" data-ri="${i}" data-field="defaultPath" title="Click to edit path">${escHtml(r.defaultPath)}</span>
        </div>
      </div>
      <div class="remote-row-btns">
        <button class="remote-row-btn remote-test-btn" data-ri="${i}" title="Test connection">Test</button>
        <button class="remote-row-btn remote-browse-btn" data-ri="${i}" title="Browse to set path">Browse</button>
        <button class="remote-row-btn remote-row-btn-del remote-del-btn" data-ri="${i}" title="Delete">Remove</button>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.remote-test-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const r = state.remotes[parseInt(btn.dataset.ri)];
      if (!r) return;
      btn.textContent = 'Testing';
      btn.disabled = true;
      const result = await manifold.sshTest({ cmd: r.cmd });
      remoteStatus.set(r.cmd, result.ok ? 'ok' : 'fail');
      renderRemotes(); // repaints the dot and resets this button
      if (!result.ok) showToast(`${r.name}: ${result.error || 'connection failed'}`, true);
    });
  });

  list.querySelectorAll('.remote-editable').forEach(el => {
    el.addEventListener('click', async () => {
      const ri = parseInt(el.dataset.ri);
      const field = el.dataset.field;
      const r = state.remotes[ri];
      if (!r) return;
      const labels = { name: 'Remote name', cmd: 'SSH command', defaultPath: 'Default browse path' };
      const val = await showInputDialog(labels[field], r[field]);
      if (val) {
        r[field] = val;
        // If user manually edits cmd, clear structured fields
        if (field === 'cmd' && r.host) {
          delete r.host;
          delete r.port;
          delete r.username;
        }
        renderRemotes();
        saveState();
      }
    });
  });

  list.querySelectorAll('.remote-browse-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const ri = parseInt(btn.dataset.ri);
      const r = state.remotes[ri];
      settingsOverlay.classList.add('hidden');
      showRemoteBrowser(r, true, ri);
    });
  });

  list.querySelectorAll('.remote-del-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.remotes.splice(parseInt(btn.dataset.ri), 1);
      renderRemotes();
      saveState();
    });
  });
}

// ── Add Remote inline form ──

function buildSshCmd(host, port, username) {
  const portPart = port && port !== 22 ? `-p ${port} ` : '';
  return `ssh ${portPart}${username}@${host}`;
}

// Which connection type the form is currently in. A Tailscale remote still
// produces a plain `ssh user@host` cmd, so the only lasting difference is the
// `tailscale` flag we store for display.
let remoteFormType = 'ssh';
let tsSelectedMachine = null;
let tsBackendRunning = true;

function setRemoteFormType(type) {
  remoteFormType = type;
  tsSelectedMachine = null;

  document.getElementById('remote-form-type').querySelectorAll('.seg-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.type === type);
  });

  const isTs = type === 'tailscale';
  // Tailnet handles routing and ports, so Host and Port are picker-driven.
  document.getElementById('remote-form-ts-row').classList.toggle('hidden', !isTs);
  document.getElementById('remote-form-host-row').classList.toggle('hidden', isTs);
  document.getElementById('remote-form-port-row').classList.toggle('hidden', isTs);
  document.getElementById('remote-form-password-row').classList.add('hidden');

  const status = document.getElementById('remote-form-status');
  status.classList.add('hidden');
  status.innerHTML = '';

  const sub = document.getElementById('remote-form-sub');
  if (sub) sub.textContent = isTs ? 'Pick a machine from your tailnet' : 'Connect over SSH';

  const submit = document.getElementById('remote-form-submit');
  submit.disabled = false;
  submit.textContent = isTs ? 'Add Machine' : 'Connect & Add';

  if (isTs) loadTailnetMachines();
}

function renderTsPicker(machines, warning) {
  const picker = document.getElementById('remote-form-ts-picker');
  const banner = warning
    ? `<div class="remote-ts-warn">${escHtml(warning)}</div>`
    : '';
  if (!machines.length) {
    picker.innerHTML = banner || '<div class="remote-ts-empty">No other machines on this tailnet.</div>';
    return;
  }
  picker.innerHTML = banner + machines.map((m, i) => `
    <button class="remote-ts-item" data-mi="${i}" title="${escHtml(m.dns)}">
      <span class="remote-ts-dot ${m.online ? 'online' : 'offline'}"></span>
      <span class="remote-ts-name">${escHtml(m.name)}</span>
      <span class="remote-ts-ip">${escHtml(m.ip)}</span>
      <span class="remote-ts-os">${escHtml(m.os)}</span>
    </button>`).join('');

  picker.querySelectorAll('.remote-ts-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const m = machines[parseInt(btn.dataset.mi)];
      tsSelectedMachine = m;
      picker.querySelectorAll('.remote-ts-item').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      // Prefill the name from the machine unless the user already typed one.
      const nameEl = document.getElementById('remote-form-name');
      if (!nameEl.value.trim()) nameEl.value = m.name;
    });
  });
}

async function loadTailnetMachines() {
  const picker = document.getElementById('remote-form-ts-picker');
  picker.innerHTML = '<div class="remote-ts-empty">Loading tailnet\u2026</div>';
  try {
    const res = await manifold.tailscaleStatus();
    tsBackendRunning = res.running !== false;

    // A stopped tailnet still lists its peers — show them under a warning.
    if (!res.ok && !(res.machines || []).length) {
      picker.innerHTML = `<div class="remote-ts-empty remote-ts-error">${escHtml(res.error || 'Tailscale unavailable')}</div>`;
      return;
    }
    renderTsPicker(res.machines || [], res.ok ? null : res.error);
  } catch (err) {
    picker.innerHTML = `<div class="remote-ts-empty remote-ts-error">${escHtml(err.message)}</div>`;
  }
}

document.getElementById('remote-form-type').querySelectorAll('.seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => setRemoteFormType(btn.dataset.type));
});

function showAddRemoteForm() {
  const form = document.getElementById('add-remote-form');
  document.getElementById('add-remote-btn').classList.add('hidden');
  form.classList.remove('hidden');

  document.getElementById('remote-form-name').value = '';
  document.getElementById('remote-form-host').value = '';
  document.getElementById('remote-form-port').value = '22';
  document.getElementById('remote-form-username').value = '';
  document.getElementById('remote-form-password').value = '';
  document.getElementById('remote-form-password-row').classList.add('hidden');
  setRemoteFormType('ssh');

  const status = document.getElementById('remote-form-status');
  status.classList.add('hidden');
  status.innerHTML = '';

  const submit = document.getElementById('remote-form-submit');
  submit.disabled = false;
  submit.textContent = 'Connect & Add';

  document.getElementById('remote-form-name').focus();
}

function hideAddRemoteForm() {
  document.getElementById('add-remote-form').classList.add('hidden');
  document.getElementById('add-remote-btn').classList.remove('hidden');
}

function showFormSpinner(message) {
  const status = document.getElementById('remote-form-status');
  status.classList.remove('hidden');
  status.innerHTML = `<div class="status-step"><span class="status-step-icon"><span class="spinner"></span></span> <span class="remote-form-status-info">${escHtml(message)}</span></div>`;
}

function showFormStatus(message, type = 'info') {
  const status = document.getElementById('remote-form-status');
  status.classList.remove('hidden');
  const cls = type === 'error' ? 'remote-form-status-error'
    : type === 'success' ? 'remote-form-status-success'
    : 'remote-form-status-info';
  status.innerHTML = `<div class="${cls}">${escHtml(message)}</div>`;
}

async function submitAddRemoteForm() {
  const nameEl = document.getElementById('remote-form-name');
  const hostEl = document.getElementById('remote-form-host');
  const portEl = document.getElementById('remote-form-port');
  const usernameEl = document.getElementById('remote-form-username');
  const passwordEl = document.getElementById('remote-form-password');
  const submitBtn = document.getElementById('remote-form-submit');

  const isTs = remoteFormType === 'tailscale';
  const name = nameEl.value.trim();
  // In Tailscale mode the host comes from the picker, not the text field.
  const host = isTs ? (tsSelectedMachine ? tsSelectedMachine.dns : '') : hostEl.value.trim();
  const port = isTs ? 22 : (parseInt(portEl.value) || 22);
  const username = usernameEl.value.trim();
  const password = passwordEl.value;

  if (!name) { nameEl.focus(); showFormStatus('Name is required', 'error'); return; }
  if (isTs && !tsSelectedMachine) { showFormStatus('Pick a machine from your tailnet', 'error'); return; }
  if (isTs && !tsBackendRunning) {
    showFormStatus('Tailscale isn\u2019t connected \u2014 run `tailscale up`, then reopen this form.', 'error');
    return;
  }
  if (!host) { hostEl.focus(); showFormStatus('Host is required', 'error'); return; }
  if (!username) { usernameEl.focus(); showFormStatus('Username is required', 'error'); return; }
  if (!isTs && (port < 1 || port > 65535)) { portEl.focus(); showFormStatus('Port must be 1-65535', 'error'); return; }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Setting up...';
  showFormSpinner(isTs
    ? 'Connecting over the tailnet\u2026'
    : 'Checking SSH key and testing connection...');

  try {
    const result = await manifold.sshSetup({ host, port, username, password: password || null, tailscale: isTs, tsIp: isTs && tsSelectedMachine ? tsSelectedMachine.ip : null });

    if (result.ok) {
      const cmd = result.cmd || buildSshCmd(host, port, username);
      const effHost = result.host || host;
      state.remotes.push({ name, cmd, host: effHost, port, username, defaultPath: '/', ...(isTs ? { tailscale: true } : {}) });
      renderRemotes();
      saveState();
      hideAddRemoteForm();
      showToast(`Remote "${name}" added`);
      return;
    }

    if (result.policyDenied) {
      showFormStatus(result.error, 'error');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Retry';
      document.getElementById('remote-form-username').focus();
      return;
    }

    if (result.needsPassword) {
      document.getElementById('remote-form-password-row').classList.remove('hidden');
      passwordEl.focus();
      showFormStatus(isTs
        ? 'Reachable over the tailnet, but Tailscale SSH isn\u2019t enabled on this machine \u2014 enter its password once to copy your SSH key.'
        : 'Key auth failed — enter password to copy your SSH key to the server.', 'error');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Copy Key & Add';
      return;
    }

    showFormStatus(result.error || 'Setup failed', 'error');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Retry';
  } catch (err) {
    showFormStatus(`Error: ${err.message}`, 'error');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Retry';
  }
}

document.getElementById('add-remote-btn').addEventListener('click', showAddRemoteForm);
document.getElementById('add-remote-form-close').addEventListener('click', hideAddRemoteForm);
document.getElementById('remote-form-cancel').addEventListener('click', hideAddRemoteForm);
document.getElementById('remote-form-submit').addEventListener('click', submitAddRemoteForm);

['remote-form-name', 'remote-form-host', 'remote-form-port', 'remote-form-username', 'remote-form-password'].forEach(id => {
  document.getElementById(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitAddRemoteForm(); }
    if (e.key === 'Escape') { hideAddRemoteForm(); }
  });
});

// ── Collection source menu ──

function showCollectionMenu() {
  const existing = document.querySelector('.collection-source-menu');
  if (existing) { existing.remove(); return; }

  const btn = document.getElementById('btn-new-collection');
  const rect = btn.getBoundingClientRect();

  const menu = document.createElement('div');
  menu.className = 'collection-source-menu';
  menu.style.left = `${rect.left}px`;
  menu.style.bottom = `${window.innerHeight - rect.top + 4}px`;

  // Local option
  const localItem = document.createElement('button');
  localItem.className = 'collection-menu-item';
  localItem.innerHTML = '<span class="collection-menu-icon">&#x25B8;</span> Local folder...';
  localItem.addEventListener('click', () => {
    menu.remove();
    addCollection(true);
  });
  menu.appendChild(localItem);

  // Divider
  if (state.remotes.length > 0) {
    const divider = document.createElement('div');
    divider.className = 'collection-menu-divider';
    menu.appendChild(divider);
  }

  // Remote options
  for (const remote of state.remotes) {
    const item = document.createElement('button');
    item.className = 'collection-menu-item';
    item.innerHTML = `<span class="collection-menu-icon">&#x2192;</span> ${escHtml(remote.name)}`;
    item.title = remote.host || remote.cmd;
    item.addEventListener('click', () => {
      menu.remove();
      showRemoteBrowser(remote);
    });
    menu.appendChild(item);
  }

  // "New Remote..." option
  const divider2 = document.createElement('div');
  divider2.className = 'collection-menu-divider';
  menu.appendChild(divider2);

  const newRemoteItem = document.createElement('button');
  newRemoteItem.className = 'collection-menu-item';
  newRemoteItem.innerHTML = '<span class="collection-menu-icon">+</span> New Remote...';
  newRemoteItem.addEventListener('click', () => {
    menu.remove();
    settingsOverlay.classList.remove('hidden');
    setTimeout(() => showAddRemoteForm(), 100);
  });
  menu.appendChild(newRemoteItem);

  document.body.appendChild(menu);

  setTimeout(() => {
    const dismiss = (e) => {
      if (!e.target.closest('.collection-source-menu')) {
        menu.remove();
        document.removeEventListener('mousedown', dismiss);
      }
    };
    document.addEventListener('mousedown', dismiss);
  }, 0);
}

// ── Remote folder browser ──

let remoteBrowserState = {
  remote: null,
  currentPath: '/',
};

function showRemoteBrowser(remote, pickPathMode = false, remoteIdx = -1) {
  remoteBrowserState.remote = remote;
  remoteBrowserState.currentPath = remote.defaultPath || '/';

  const selectBtn = document.getElementById('remote-browser-select');
  document.getElementById('remote-browser-title').textContent = pickPathMode
    ? `SET PATH: ${remote.name.toUpperCase()}`
    : `BROWSE: ${remote.name.toUpperCase()}`;
  selectBtn.textContent = pickPathMode ? 'Set Path' : 'Select';
  document.getElementById('remote-browser-overlay').classList.remove('hidden');

  navigateRemote(remoteBrowserState.currentPath);

  document.getElementById('remote-browser-close').onclick = () => closeRemoteBrowser();
  document.getElementById('remote-browser-cancel').onclick = () => closeRemoteBrowser();
  document.getElementById('remote-browser-copy').onclick = () => {
    manifold.clipboardWriteText(remoteBrowserState.currentPath);
    const btn = document.getElementById('remote-browser-copy');
    btn.textContent = '\u2713';
    setTimeout(() => { btn.innerHTML = '&#x2398;'; }, 1500);
  };
  selectBtn.onclick = () => {
    const selectedPath = remoteBrowserState.currentPath;
    closeRemoteBrowser();
    if (pickPathMode && remoteIdx >= 0 && state.remotes[remoteIdx]) {
      state.remotes[remoteIdx].defaultPath = selectedPath;
      renderRemotes();
      saveState();
      settingsOverlay.classList.remove('hidden');
    } else {
      addRemoteCollection(remoteBrowserState.remote, selectedPath);
    }
  };
  document.getElementById('remote-browser-overlay').onclick = (e) => {
    if (e.target.id === 'remote-browser-overlay') closeRemoteBrowser();
  };
}

function closeRemoteBrowser() {
  document.getElementById('remote-browser-overlay').classList.add('hidden');
}

async function navigateRemote(remotePath) {
  remoteBrowserState.currentPath = remotePath;

  // Update breadcrumb
  const breadcrumb = document.getElementById('remote-browser-breadcrumb');
  const parts = remotePath.split('/').filter(Boolean);
  let breadcrumbHtml = '<button class="breadcrumb-segment" data-path="/">/</button>';
  let accumulated = '';
  for (const part of parts) {
    accumulated += '/' + part;
    breadcrumbHtml += `<span class="breadcrumb-sep">/</span><button class="breadcrumb-segment" data-path="${escAttr(accumulated)}">${escHtml(part)}</button>`;
  }
  breadcrumb.innerHTML = breadcrumbHtml;

  breadcrumb.querySelectorAll('.breadcrumb-segment').forEach(btn => {
    btn.addEventListener('click', () => navigateRemote(btn.dataset.path));
  });

  // Update path display
  document.getElementById('remote-browser-path').textContent = `${remoteBrowserState.remote.cmd}:${remotePath}`;

  // Show loading
  const list = document.getElementById('remote-browser-list');
  list.innerHTML = '<div class="remote-browser-loading">Loading...</div>';

  // Fetch directory listing
  const result = await manifold.sshLs({ cmd: remoteBrowserState.remote.cmd, remotePath });

  if (result.error) {
    list.innerHTML = `<div class="remote-browser-error">${escHtml(result.error)}</div>`;
    return;
  }

  if (result.dirs.length === 0) {
    list.innerHTML = '<div class="remote-browser-loading">No subdirectories</div>';
    return;
  }

  let listHtml = '';
  if (remotePath !== '/') {
    const parent = remotePath.split('/').slice(0, -1).join('/') || '/';
    listHtml += `<button class="remote-dir-item" data-path="${escAttr(parent)}"><span class="remote-dir-icon">&uarr;</span><span class="remote-dir-name">..</span></button>`;
  }

  for (const dir of result.dirs) {
    const fullPath = remotePath === '/' ? `/${dir}` : `${remotePath}/${dir}`;
    listHtml += `<button class="remote-dir-item" data-path="${escAttr(fullPath)}"><span class="remote-dir-icon">&#x25B8;</span><span class="remote-dir-name">${escHtml(dir)}</span></button>`;
  }

  list.innerHTML = listHtml;

  list.querySelectorAll('.remote-dir-item').forEach(item => {
    item.addEventListener('click', () => navigateRemote(item.dataset.path));
  });
}

function addRemoteCollection(remote, remotePath) {
  const parts = remotePath.split('/');
  const name = parts[parts.length - 1] || remote.name;

  const col = {
    name,
    path: remotePath,
    remote: remote.cmd,
    expanded: true,
    gridded: false,
    commands: [],
    tabs: [],
  };
  state.collections.push(col);
  const ci = state.collections.length - 1;

  const tabId = genTabId();
  const tabName = 'Session 1';
  col.tabs.push({ id: tabId, name: tabName, cwd: remotePath, remote: remote.cmd });
  createTerminalInstance(tabId, remotePath, null, tabName, col.name, null, false, null, 'claude', null, false, remote.cmd);

  selectTab(ci, 0);
  renderCollections();
  saveState();
}

// ── Utility ──
function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// ── Workspace init ──

async function initWorkspace(savedData) {
  const loaded = await restoreFromState(savedData);

  if (!loaded) {
    const gTabId = genTabId();
    state.collections.push({
      name: 'General',
      path: homeDir,
      expanded: true,
      gridded: false,
      tabs: [{ id: gTabId, name: 'Session 1', cwd: homeDir }],
    });
    createTerminalInstance(gTabId, homeDir, null, 'Session 1', 'General');
  }

  if (loaded) {
    const aci = Math.min(loaded.activeCollection, state.collections.length - 1);
    const col = state.collections[aci];
    const ati = Math.min(loaded.activeTab, (col ? col.tabs.length - 1 : 0));
    selectTab(Math.max(0, aci), Math.max(0, ati));
  } else {
    selectTab(0, 0);
  }
  renderCollections();
  // Delay first save so conversation detection has time to run
  setTimeout(saveState, 10000);
}

async function restoreFromState(data) {
  if (!data || !data.collections || !data.collections.length) return false;

  for (let ci = 0; ci < data.collections.length; ci++) {
    const colData = data.collections[ci];

    const col = {
      name: colData.name || `Collection ${ci + 1}`,
      path: colData.path || homeDir || '/',
      remote: colData.remote || null,
      expanded: colData.expanded !== false,
      gridded: colData.gridded || false,
      commands: colData.commands || [],
      tabs: [],
    };

    const tabs = colData.tabs && colData.tabs.length > 0
      ? colData.tabs
      : [{ name: 'Session 1', cwd: col.path }];

    for (const tabData of tabs) {
      const tabId = genTabId();
      const cwd = tabData.cwd || col.path;
      const provider = tabData.provider || 'claude';
      const copilotSessionId = tabData.copilotSessionId || null;
      const isNonClaude = tabData.shell || tabData.cmd;
      const tabRemote = tabData.remote || col.remote || null;
      col.tabs.push({
        id: tabId,
        name: tabData.name || 'Session',
        cwd,
        conversationId: tabData.conversationId || null,
        provider,
        copilotSessionId,
        shell: tabData.shell || false,
        cmd: tabData.cmd || null,
        remote: tabRemote,
      });
      if (provider === 'conductor') {
        createConductorPane(tabId, cwd, tabData.name || 'Conductor', tabData.conductorSessionId || null, tabData.conductorName || null);
      } else {
        createTerminalInstance(tabId, cwd, isNonClaude ? null : (tabData.conversationId || null), tabData.name || 'Session', col.name, null, tabData.shell || false, tabData.cmd || null, provider, copilotSessionId, provider === 'copilot' && !!copilotSessionId, tabRemote);
      }
    }

    state.collections.push(col);
  }

  if (state.collections.length === 0) return false;

  return {
    activeCollection: data.activeCollection || 0,
    activeTab: data.activeTab || 0,
  };
}

// ── Init ──
(async () => {
  try {
    homeDir = await manifold.getHomeDir() || '/';
    const platform = await manifold.getPlatform();
    isMac = platform === 'darwin';
    document.body.classList.add(`platform-${platform}`);

    const mod = isMac ? 'Cmd' : 'Ctrl';
    headerHintMod = mod;
    updateHeaderHints();
    populateShortcuts();

    const savedState = await manifold.loadState();

    // Apply saved UI scale early
    if (savedState && savedState.uiScale) {
      applyScale(savedState.uiScale);
    }

    // Restore default-source preference
    if (savedState && savedState.defaultSource) {
      state.defaultSource = savedState.defaultSource;
    }
    // Restore remote destinations
    if (savedState && savedState.remotes) {
      state.remotes = savedState.remotes;
    }
    renderRemotes();

    document.getElementById('default-source-kbd').textContent = `${mod}+T`;
    renderDefaultSource();

    await initWorkspace(savedState);
  } catch (err) {
    console.error('Init failed:', err);
  }
})();
