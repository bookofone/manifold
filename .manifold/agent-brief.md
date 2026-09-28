# Agent brief — Manifold

Durable facts for every background agent working in this repo. Read before starting.

## Project
- Electron app, vanilla JS, no framework. `CLAUDE.md` is the architecture reference — read it.
- 5 core files: `main.js` (main process, IPC, pty, state), `preload.js` (IPC bridge — edit when adding IPC), `renderer.js` (all UI logic), `styles.css`, `index.html`.
- Style: minimal, no abstractions, match the surrounding idiom and comment density.
- Theme: accent `#D97757`, background `#1a1a1a`, font Share Tech Mono.

## Git
- Always work on a branch in a git worktree. Never commit to `main`. Never push. Never merge unless told to.

## Verifying
- Always run: `node --check main.js && node --check preload.js && node --check renderer.js`
- `npm start` does NOT work from WSL: `node_modules` holds the Windows electron build.
- To see the GUI, launch the Windows `electron.exe` via `powershell.exe`, always with a throwaway
  `--user-data-dir` (a temp dir) so the user's real state is never touched, e.g.
  `powershell.exe -Command "& '<repo win path>\node_modules\electron\dist\electron.exe' '<repo win path>' --user-data-dir=$env:TEMP\manifold-test-<name>"`

## Reporting
- When finished, report back to the conductor with SendMessage (the dispatch prompt names the session).
