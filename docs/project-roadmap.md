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
- **Session export** — `export_session` writes a bounded JSON receipt
  (agent kind, lifecycle, worktree root, counts + capped samples of
  touched files and command runs, git + usage summaries) to a
  workspace-contained path — metadata only, never terminal output or
  file contents. Palette command + per-session card action
- **Resource usage display** — the procmon poll also sums CPU% (of total
  machine capacity) and RSS over each session's process tree into a
  live-only `SessionResources` sample on `session:update`; cockpit cards
  show a compact `cpu x% · y MB` readout that renders "—" per
  unobtainable metric and greys when the sample goes stale
- **Session presets** — named launch recipes (agent CLI / custom command /
  shell + argv + cwd mode) launched through the existing
  `worktree_create` + `pty_spawn` paths; three built-ins ("Isolated agent —
  new worktree", "In-place agent session", "Shell — new worktree") plus
  bounded user presets persisted in `workspace-state.json`
  (`lib/presets.ts`, SessionPresetDialog, palette + Agents cockpit)

## Next

- ~~Bundled/embedded ripgrep for Windows installs without it~~ — delivered
  as embedded ripgrep: the fallback search now runs the same `grep-regex` +
  `grep-searcher` engine ripgrep itself is built on, over the existing
  bounded `ignore` walk. Hosts without `rg` keep the full search contract —
  real regex queries, smart-case, UTF-16 decoding, and binary detection —
  on every platform, with no sidecar binary to ship

## Explicit non-goals

- Extension/plugin marketplace
- LSP orchestration or language intelligence
- Debugger, notebooks, collaboration, cloud sync
- AI APIs, embedded AI chat, auth, GitHub integration
- Docker/SSH/Dev Containers, project management, visual git history
- Hundreds of settings

If a feature can't be done without breaking "small, fast, reliable", it
isn't a v1 feature.
