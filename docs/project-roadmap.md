# Project Roadmap

## v0.1 — first milestone (shipped)

- Open a local folder; lazy file tree with git badges
- CodeMirror viewer/editor tabs; `Ctrl+P` quick open; `Ctrl+Shift+F` search
- Real PTY terminals (shells + detected agent CLIs), clickable file links
- Live fs watching → explorer/docs/activity/git all update
- Agent Activity timeline; Follow Agent mode
- Git Changes + unified/split diff, stage/commit box, explorer file ops
- Light + dark themes; workspace persistence

## v0.2 — Agent Workspace (this release)

- **Agent Sessions** — every PTY becomes an observable session: agent kind,
  PID, worktree root, lifecycle state, touched files, command runs, git
  summary (`session.rs`, `pty_spawn` cwd support)
- **Agents cockpit** — session cards, collision banner, history; focus /
  rename / checkpoint / stop actions
- **Process observation** — descendant-only monitor, bounded depth/children,
  command classification, exit codes where obtainable (`procmon.rs`)
- **File attribution** — watcher → session touches (direct/likely/ambiguous)
  - same-file / shared-tree collision warnings
- **Git worktrees** — `.worktrees/<name>` on `agent/<name>` branches, dirty
  protection, prune (`worktree.rs`)
- **Checkpoints** — Git-native patch snapshots + previewed, conflict-aware
  restore (`checkpoint.rs`)
- **Review queue** — deterministic classification with reasons + risk filter
  in Changes (`review.rs`)
- **Persistence v2** — `sessions.json` history across restarts; dead
  processes stay dead
- Windows test toolchain fixes (manifest linking, ConPTY DSR in tests)

## v0.3 — (in progress)

- **Configurable watch excludes** — user gitignore-style patterns on top
  of the built-in defaults (`excludes.rs`), shared live by the watcher,
  quick-open index, and search fallback; persisted in
  `workspace-state.json`, edited via palette → "Configure Ignored Paths…"
- **Merge-readiness summary** — per-worktree ahead/behind counts, dirty /
  untracked state, a read-only `git merge-tree --write-tree` clean-merge
  probe, and review-category reasons on each worktree row in the Agents
  cockpit (`merge_readiness.rs`); bounded, fail-closed per worktree

## Next

- Bundled/embedded ripgrep for Windows installs without it
- Session templates / one-click "new isolated agent" presets
- Session export (bounded metadata receipt)
- Resource usage display in the cockpit

## Explicit non-goals

- Extension/plugin marketplace
- LSP orchestration or language intelligence
- Debugger, notebooks, collaboration, cloud sync
- AI APIs, embedded AI chat, auth, GitHub integration
- Docker/SSH/Dev Containers, project management, visual git history
- Hundreds of settings

If a feature can't be done without breaking "small, fast, reliable", it
isn't a v1 feature.
