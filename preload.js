const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('manifold', {
  // Environment
  getHomeDir: () => ipcRenderer.invoke('get-home-dir'),
  getPlatform: () => ipcRenderer.invoke('get-platform'),

  // Terminal
  createTerminal: (opts) => ipcRenderer.invoke('terminal-create', opts),
  sendInput: (id, data) => ipcRenderer.send('terminal-input', { id, data }),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send('terminal-resize', { id, cols, rows }),
  destroyTerminal: (id) => ipcRenderer.send('terminal-destroy', { id }),
  isTerminalActive: (tabId) => ipcRenderer.invoke('terminal-is-active', { id: tabId }),
  reconnectTerminal: (tabId) => ipcRenderer.invoke('terminal-reconnect', { id: tabId }),
  getConversationId: (tabId) => ipcRenderer.invoke('terminal-get-conversation-id', { id: tabId }),
  scanConversation: (cwd) => ipcRenderer.invoke('scan-conversation', { cwd }),
  forkConversation: (opts) => ipcRenderer.invoke('fork-conversation', opts),
  onTerminalData: (callback) => {
    ipcRenderer.on('terminal-data', (event, { id, data }) => callback(id, data));
  },
  onTerminalRequestSize: (callback) => {
    ipcRenderer.on('terminal-request-size', (event, { id }) => callback(id));
  },
  onConversationDetected: (callback) => {
    ipcRenderer.on('conversation-detected', (event, { id, conversationId }) => callback(id, conversationId));
  },

  // State
  saveState: (state) => ipcRenderer.invoke('save-state', state),
  saveStateDone: () => ipcRenderer.send('save-state-done'),
  loadState: () => ipcRenderer.invoke('load-state'),
  onSaveState: (callback) => ipcRenderer.on('save-state', callback),
  onWindowFocus: (callback) => ipcRenderer.on('window-focus', callback),

  // Dialogs
  pickFolder: () => ipcRenderer.invoke('pick-folder'),

  // SSH remotes
  sshLs: (opts) => ipcRenderer.invoke('ssh-ls', opts),
  sshTest: (opts) => ipcRenderer.invoke('ssh-test', opts),
  sshSetup: (opts) => ipcRenderer.invoke('ssh-setup', opts),
  tailscaleStatus: () => ipcRenderer.invoke('tailscale-status'),

  // Claude Code CLI
  claudeVersion: () => ipcRenderer.invoke('claude-version'),
  claudeUpdate: () => ipcRenderer.invoke('claude-update'),

  // Clipboard — goes through IPC to main process because sandboxed preload
  // scripts don't have access to Electron's clipboard module on Windows.
  clipboardReadText: () => ipcRenderer.invoke('clipboard-read'),
  clipboardWriteText: (text) => ipcRenderer.invoke('clipboard-write', text),

  // Edit menu IPC — menu clicks routed to the renderer's context-aware handlers
  // (see the Clipboard section in renderer.js for how each is dispatched).
  onMenuCopy: (cb) => ipcRenderer.on('menu-copy', cb),
  onMenuPaste: (cb) => ipcRenderer.on('menu-paste', cb),
  onMenuCut: (cb) => ipcRenderer.on('menu-cut', cb),
  onMenuSelectAll: (cb) => ipcRenderer.on('menu-select-all', cb),

  // Conductor — stream-json Claude session, no pty. Input never blocks on a
  // turn; the renderer queues and drains. A `remote` in the opts runs the whole
  // thing (and its agents) over ssh on that host instead.
  conductorCreate: (opts) => ipcRenderer.invoke('conductor-create', opts),
  conductorSend: (id, text) => ipcRenderer.invoke('conductor-send', { id, text }),
  conductorInterrupt: (id) => ipcRenderer.invoke('conductor-interrupt', { id }),
  conductorDestroy: (id) => ipcRenderer.send('conductor-destroy', { id }),
  conductorGetSessionId: (id) => ipcRenderer.invoke('conductor-get-session-id', { id }),
  conductorHistory: (sessionId, cwd, remote) => ipcRenderer.invoke('conductor-history', { sessionId, cwd, remote }),
  onConductorEvent: (callback) => {
    ipcRenderer.on('conductor-event', (event, { id, msg }) => callback(id, msg));
  },

  // Background agents (claude --bg / agents / logs / stop)
  agentsList: (cwd, remote) => ipcRenderer.invoke('agents-list', { cwd, remote }),
  agentDispatch: (opts) => ipcRenderer.invoke('agent-dispatch', opts),
  agentTranscript: (sessionId, cwd, remote) => ipcRenderer.invoke('agent-transcript', { sessionId, cwd, remote }),
  agentsActivity: (agents, remote) => ipcRenderer.invoke('agents-activity', { agents, remote }),
  agentLogs: (id, cwd, remote) => ipcRenderer.invoke('agent-logs', { id, cwd, remote }),
  agentStop: (id, cwd, remote) => ipcRenderer.invoke('agent-stop', { id, cwd, remote }),
  agentRemove: (opts) => ipcRenderer.invoke('agent-remove', opts),

  // UI Scale
  setZoomFactor: (factor) => webFrame.setZoomFactor(factor),
  getZoomFactor: () => webFrame.getZoomFactor(),
});
