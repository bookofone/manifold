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
  swaps back; the conductor's own log keeps streaming while hidden. Input to a *local* agent is
  sent directly (`agent-send`): main writes it into the agent's cross-session inbox, the unix
  socket SendMessage uses. The socket path is in `~/.claude/sessions/<pid>.json`, its token in
  `<pid>.<sha256(socket)>.key`; frames are NDJSON, an `auth` line then a `user` line wrapping the
  text in `<cross-session-message from-name="Manifold" from-mode="bypass">`. Without that
  `from-mode` a bypass-permissions agent *holds* the message for review. The agent picks it up
  at its next step (mid-turn, between tool calls) or at once when idle. Remote agents, or a
  direct send that errors, fall back to a *relay*: a `[Manifold relay]` message tells the
  conductor to SendMessage the text verbatim. Either way the bubble stays "pending" until the
  text appears in the agent transcript, and fails visibly after 2 min (or, for relays, if the
  conductor exits).
- **Agent ledger / diff / verify**: when the roster sees an agent go `done`, the renderer records
  `state.agentLedger[id]` (prompt = first user entry of its transcript, final assistant message,
  cwd, branch/worktree, start/end, diff stats, verify result; capped at 200, persisted, never
  touched by `claude rm`/clear). `agent-diff` runs one shell script in the agent's cwd (bash
  locally, WSL on Windows, ssh on remote): base is merge-base with the default branch when on
  another branch, else the last commit before the agent started, diffed against the working tree;
  full diffs are fetched on click, capped at 200KB, never persisted. Verify always runs, via
  `agent-verify` in the same cwd with a 5 min timeout. With no `col.verify` it is auto-detected
  inside that one script (so local, WSL and ssh alike): a package.json `test` script other than
  npm init's "no test specified" → `npm test`; else `node --check` on each existing .js/.mjs/.cjs
  file changed vs the diff base (untracked included, paths `--relative` to cwd); else PASS with
  "no checks found". The script's first lines `@@MF cmd <label>` / `@@MF run <command>` name
  what ran; the badge reads e.g. `PASS · node --check (3 files)`. `col.verify` is an override
  (add menu → "Verify: auto|off|<cmd>"): empty = auto, `off` = no verify (so no fix/merge).
  PASS/FAIL shows on the notice and history entry, and
  `[Manifold] verify: PASS|FAIL for agent <id>` is queued into the conductor's pending notices.
- **Agent brief**: `<project>/.manifold/agent-brief.md` holds durable project facts for every
  background agent (this repo's own is committed). Agents get a *pointer*, never the contents:
  `Read <abs path>/.manifold/agent-brief.md first and follow it.` as the first line of the
  prompt — absolute because a worktree lacks the file if it is untracked, and in the path the
  agent sees (WSL on Windows, the remote's own path). `conductorPrompt` tells the conductor to
  check for the file before each dispatch and to append durable facts from agent reports; the
  pane's `+` dispatch prepends the pointer itself. `brief-read`/`brief-write` go over ssh
  (base64 on write) for remote collections. Edited from the add menu ("Edit agent brief") or
  the roster header's `brief` label, which shows whether one is active (re-read per turn).
  Two behaviours act on the verify result and are always on (no toggles; old saved
  `col.autofix`/`col.automerge` values are ignored). **Auto-fix** (`AUTOFIX_MAX` = 3 attempts): on
  FAIL the same agent gets the command, exit code and output tail (`agent-send`, else a
  conductor relay) and is told to fix, re-verify, commit and finish; `ledger.autofix.attempts`
  counts rounds and survives the re-record. The pane's `fixing` set keeps the roster polling
  while hidden so the agent's next working→done is seen, which re-runs verify; the FAIL notice
  is only raised once attempts run out ("autofix exhausted"). Line shows `FAIL · fix 2/3`.
  **Auto-merge**: on PASS (including "no checks found"), `agent-merge` runs `git merge --no-edit <branch>`
  in the repo's main working tree (first `git worktree list` entry), serialised in main. It
  skips with a notice unless the agent tree has no uncommitted tracked changes, the main tree is
  clean (tracked files) and on the default branch, and the branch isn't already merged; a
  conflict is `git merge --abort`ed and `[Manifold] automerge conflict: …` queued. On success the
  ledger records the sha (`merged <sha>`), `[Manifold] automerged <branch> (<sha>)` is queued
  and the agent is `claude rm`'d. Never pushes. Same bash/WSL/ssh path as `agent-verify`.
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
