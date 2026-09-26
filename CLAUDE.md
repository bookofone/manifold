# Manifold — Claude Code Workspace Manager

An Electron app that runs multiple Claude Code sessions in parallel with collections, grid view, auto-naming, and conversation tracking.

## Architecture

5 core files, no framework, vanilla JS:

| File | Role |
|------|------|
| `main.js` | Electron main process: window, IPC, node-pty terminals, state persistence |
| `preload.js` | Context bridge — exposes the `manifold` IPC API to the renderer. Edit when adding IPC |
| `renderer.js` | All client-side logic: collections, tabs, grid view, keybindings, auto-naming |
| `styles.css` | Dark theme, layout, grid |
| `index.html` | HTML shell |

## Key Patterns

- **State**: Saved to `userData/state/state.json`, auto-restored on launch
- **Terminals**: `node-pty` spawns, tracked in `Map` by tab ID
- **Conversations**: Detected by watching `~/.claude/projects/<encoded-path>/*.jsonl`
- **IPC**: All renderer↔main communication through `preload.js` bridge
- **Conductor**: A tab with `provider: 'conductor'` is *not* a pty. It drives a long-lived
  `claude -p --input-format stream-json --output-format stream-json` process, so its input box
  never blocks on a turn — messages queue in the renderer and drain as the process frees up.
  It registers a shim in `terminalInstances` (`isConductor: true`) so the existing show/hide/
  grid/close paths work unchanged.
- **Remote conductor**: on a collection with `col.remote`, the same argv runs over ssh
  (`bash -lc '… exec claude …'`, every arg `shQuote`d) instead of being spawned locally, so
  the multi-line `--append-system-prompt` survives. `RequestTTY=no` keeps the JSONL clean;
  `ServerAliveInterval` turns a dropped link into exit 255, which the pane reports as a
  death with a one-click "reconnect and resume". Resume probes, transcript replay and the
  whole roster read the *remote* `~/.claude/projects/<encoded-path>`, never the local one.
- **Background agents**: `claude --bg --dangerously-skip-permissions "<task>"` dispatches
  (prompt is positional — `-p` is rejected), `claude agents --json` lists,
  `attach`/`logs`/`stop` manage. The roster filters to `kind === 'background'`: interactive
  sessions are listed too but carry no short `id`. It polls every 4s for visible conductor
  panes (15s for remote ones — each poll is a fresh ssh connection) and raises a notice when
  an agent transitions to `done`; "attach" spawns a normal pty tab running
  `claude attach <id>`, promoting a background agent to a full TUI. Under a remote conductor
  every one of these runs on the remote host, and attach opens an ssh tab.
- **Agent chat view**: clicking a roster card (not its buttons) swaps the conductor pane's chat
  to that agent: its transcript (`agent-transcript`, same `transcriptEntries` parser as the
  conductor replay) re-read every 3s (10s remote), a header with state badge, time since
  last write, recent tools, and any unanswered AskUserQuestion. The pinned "conductor" card
  swaps back; the conductor's own log keeps streaming while hidden. There is no direct send:
  input is *relayed* — a `[Manifold relay]` message tells the conductor to SendMessage the text
  verbatim to the agent's session name. The bubble stays "pending" until the text appears in
  the agent transcript, and fails visibly after 2 min or if the conductor exits.
- **Permissions**: every Claude session Manifold spawns — pty tabs, the conductor and
  dispatched agents — runs with `--dangerously-skip-permissions`. Allowlisting the conductor
  was tried and reverted: `Bash(claude *)` does not match compound commands, so routine work
  was denied with no approval surface available.

## Style

- Accent: `#D97757` (orange)
- Background: `#1a1a1a`
- Font: Share Tech Mono
- Keep it minimal — no frameworks, no abstractions

## Commands

```bash
npm start          # Run in dev mode
npm run build:linux   # Build .deb
npm run build:mac     # Build .dmg
npm run build:win     # Build .exe
```

## CI/CD

GitHub Actions workflow at `.github/workflows/release.yml`:
- Triggered on `v*` tags
- Builds for all 3 platforms
- Publishes to public repo MindFabric/manifold-releases using `RELEASE_TOKEN`

## Repos

- Private: `MindFabric/manifold`
- Public releases: `MindFabric/manifold-releases`
