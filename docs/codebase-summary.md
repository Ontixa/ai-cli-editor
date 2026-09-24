# Codebase Summary

## Backend (`src-tauri/src/`)

| File            | Responsibility                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------- |
| `main.rs`       | entry → `lib::run()`                                                                            |
| `lib.rs`        | `AppState`, all `#[tauri::command]`s, builder wiring                                            |
| `error.rs`      | `AppError` (serde string), `AppResult`                                                          |
| `paths.rs`      | `normalize`, `resolve_existing`, `resolve_for_write`, `rel_of` — workspace containment          |
| `fs_ops.rs`     | `list_dir` (lazy, sorted), `read_file` (8 MB cap, binary sniff), `write_file`                   |
| `watcher.rs`    | notify → debounce/merge → `fs:batch`; `merge_raw_events` is pure/tested                         |
| `excludes.rs`   | `IgnoreRules` — built-in + user gitignore patterns; shared matcher swapped live                 |
| `index.rs`      | `FileIndex` — quick-open path list, watcher-patched                                             |
| `pty.rs`        | `PtyRegistry`, `SpawnSpec`, reader+waiter threads, base64 out                                   |
| `session.rs`    | `AgentSession` registry: lifecycle, file attribution, collisions, git summary, bounded history  |
| `export.rs`     | `export_session` — bounded JSON session receipt (metadata only), capped + re-provenanced write  |
| `procmon.rs`    | descendant-only process monitor (sysinfo), command classification, exit codes, CPU/RSS sampling |
| `worktree.rs`   | `git worktree` create/list/remove/prune under `.worktrees/`, dirty protection                   |
| `checkpoint.rs` | Git-native patch + metadata snapshots under `<git-dir>/aice-checkpoints/`; safe restore         |
| `review.rs`     | deterministic per-file review classification (path + content heuristics)                        |
| `git.rs`        | `status` (porcelain v2 -z), `diff` (git binary / similar)                                       |
| `search.rs`     | `rg --null` streaming chunks; bounded walk fallback                                             |
| `platform.rs`   | `default_shell`, `detect_agents`, PATH probing, per-process exit code                           |
| `persist.rs`    | `load`/`save` JSON state + `sessions.json` (v2), atomic-ish rename                              |

## Frontend (`src/`)

| Path                       | Responsibility                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `lib/ipc.ts`               | typed `invoke` wrappers + `listen` helpers                                                                  |
| `lib/types.ts`             | IPC contract mirrors                                                                                        |
| `lib/store.ts`             | `Store<T>` + `useStore` (useSyncExternalStore)                                                              |
| `lib/commands.ts`          | `CommandRegistry`, shortcut normalize/match                                                                 |
| `lib/fuzzy.ts`             | quick-open scorer/ranker                                                                                    |
| `lib/term-links.ts`        | `path:line:col` extraction from terminal text                                                               |
| `lib/diff.ts`              | unified-diff parser → render model                                                                          |
| `lib/activity.ts`          | timeline ingest + grouping                                                                                  |
| `lib/watch-excludes.ts`    | watch-exclude pattern parse/format/sanitize/merge (mirrors `excludes.rs`)                                   |
| `lib/agents.ts`            | session display helpers: names, age, review labels, collision summaries                                     |
| `lib/session-resources.ts` | process-tree CPU/RSS readout shaping: byte/percent formatting, staleness                                    |
| `lib/session-export.ts`    | receipt shaping/capping + export-path validation (mirrors `export.rs`/`paths.rs`)                           |
| `lib/terminal-labels.ts`   | syncs terminal-tab labels with the owning session's label (rename follows the tab)                          |
| `lib/presets.ts`           | session-preset model: built-ins, draft validation/caps, sanitize, launch resolution, worktree naming        |
| `lib/editor-manager.ts`    | CodeMirror state/view lifecycle outside React                                                               |
| `lib/cm-theme.ts`          | editor + syntax theme                                                                                       |
| `state/app.ts`             | `AppState` shape + store instance                                                                           |
| `state/actions.ts`         | all actions + backend event wiring                                                                          |
| `commands/setup.ts`        | every command/shortcut registration                                                                         |
| `components/…`             | topbar, sidebar (agents/explorer/changes/activity/search), editor tabs, diff, terminal, overlays, statusbar |

## Key flows

- **Open folder** → `open_workspace` sets canonical root, restarts watcher,
  resets index, kills PTYs → `fs:batch` streams changes.
- **Save** → `write_file` → watcher event suppressed via self-write marker.
- **External modify** → `fs:batch` → doc reload (clean) or `conflict` banner
  (dirty).
- **Terminal link** → `extractLinkRefs` → `resolve_link_target`
  (containment-checked) → `openFile(path, {line, col})`.
- **Terminal spawn** → `pty_spawn` → PTY + `AgentSession` (rooted at `cwd`
  when given, e.g. a worktree) → `session:update` snapshot.
- **fs change** → watcher merge → file index + session attribution +
  per-session git summary → `fs:batch` + `session:update` when state moved.
- **Checkpoint** → `checkpoint_create` captures `git diff HEAD` + untracked
  files under `<git-common-dir>/aice-checkpoints/`; restore previews
  conflicts via `checkpoint_plan` before `checkpoint_restore` applies.
- **Isolated agent** → `worktree_create` makes `.worktrees/<name>` on
  `agent/<name>` → `newTerminal({ cwd })` spawns the agent inside it.
- **Session preset** → resolve target (detected agent / program / shell) →
  `worktree_create` when `cwdMode: "worktree"` → `newTerminal` → `pty_spawn`
  (argv bounded backend-side).
