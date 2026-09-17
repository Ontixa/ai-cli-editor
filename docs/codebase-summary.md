# Codebase Summary

## Backend (`src-tauri/src/`)

| File          | Responsibility                                                                         |
| ------------- | -------------------------------------------------------------------------------------- |
| `main.rs`     | entry → `lib::run()`                                                                   |
| `lib.rs`      | `AppState`, all `#[tauri::command]`s, builder wiring                                   |
| `error.rs`    | `AppError` (serde string), `AppResult`                                                 |
| `paths.rs`    | `normalize`, `resolve_existing`, `resolve_for_write`, `rel_of` — workspace containment |
| `fs_ops.rs`   | `list_dir` (lazy, sorted), `read_file` (8 MB cap, binary sniff), `write_file`          |
| `watcher.rs`  | notify → debounce/merge → `fs:batch`; `merge_raw_events` is pure/tested                |
| `index.rs`    | `FileIndex` — quick-open path list, watcher-patched                                    |
| `pty.rs`      | `PtyRegistry`, `SpawnSpec`, reader+waiter threads, base64 out                          |
| `git.rs`      | `status` (porcelain v2 -z), `diff` (git binary / similar)                              |
| `search.rs`   | `rg --null` streaming chunks; bounded walk fallback                                    |
| `platform.rs` | `default_shell`, `detect_agents`, PATH probing                                         |
| `persist.rs`  | `load`/`save` JSON state, atomic-ish rename                                            |

## Frontend (`src/`)

| Path                    | Responsibility                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `lib/ipc.ts`            | typed `invoke` wrappers + `listen` helpers                                                           |
| `lib/types.ts`          | IPC contract mirrors                                                                                 |
| `lib/store.ts`          | `Store<T>` + `useStore` (useSyncExternalStore)                                                       |
| `lib/commands.ts`       | `CommandRegistry`, shortcut normalize/match                                                          |
| `lib/fuzzy.ts`          | quick-open scorer/ranker                                                                             |
| `lib/term-links.ts`     | `path:line:col` extraction from terminal text                                                        |
| `lib/diff.ts`           | unified-diff parser → render model                                                                   |
| `lib/activity.ts`       | timeline ingest + grouping                                                                           |
| `lib/editor-manager.ts` | CodeMirror state/view lifecycle outside React                                                        |
| `lib/cm-theme.ts`       | editor + syntax theme                                                                                |
| `state/app.ts`          | `AppState` shape + store instance                                                                    |
| `state/actions.ts`      | all actions + backend event wiring                                                                   |
| `commands/setup.ts`     | every command/shortcut registration                                                                  |
| `components/…`          | topbar, sidebar (explorer/changes/activity/search), editor tabs, diff, terminal, overlays, statusbar |

## Key flows

- **Open folder** → `open_workspace` sets canonical root, restarts watcher,
  resets index, kills PTYs → `fs:batch` streams changes.
- **Save** → `write_file` → watcher event suppressed via self-write marker.
- **External modify** → `fs:batch` → doc reload (clean) or `conflict` banner
  (dirty).
- **Terminal link** → `extractLinkRefs` → `resolve_link_target`
  (containment-checked) → `openFile(path, {line, col})`.
