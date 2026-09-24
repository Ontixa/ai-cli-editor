# AI CLI Editor — Implementation Plan

> Status: living document for the v0.1 build. Concise on purpose.

## Product

Terminal-first desktop code editor for steering coding agents (Codex CLI,
Claude Code, Gemini CLI, OpenCode, Aider, arbitrary shells). AI writes code;
humans observe, review, diff, steer. No AI APIs — the PTY is the integration
layer. Local-first, vendor-neutral, no telemetry.

## Stack

- Tauri 2 + Rust backend, React 18 + TypeScript + Vite frontend
- CodeMirror 6 (view/review-first editing), xterm.js + portable-pty (real PTY)
- `notify` filesystem watcher, `ignore` crate for quick-open index
- `git` binary for changes/diff, `rg` for workspace search (embedded
  `grep-regex`/`grep-searcher` fallback when `rg` isn't installed)
- No heavy JS deps: hand-rolled store, fuzzy scorer, diff parser, link parser

## Repo layout

```
src-tauri/src/    Rust backend modules
  main.rs         entry
  lib.rs          app setup, AppState, command registration
  error.rs        AppError -> serde
  paths.rs        normalize / containment / display paths
  fs_ops.rs       list_dir, read_file, write_file, stat
  watcher.rs      notify + debouncer -> fs:batch events
  index.rs        quick-open file index (lazy, watcher-updated)
  pty.rs          session manager, reader threads, resize/kill
  git.rs          porcelain v2 parse, diff via git binary / similar
  search.rs       rg --null streaming, embedded grep-engine fallback, cancel
  platform.rs     shell selection, agent detection
  persist.rs      workspace state JSON in app data dir
src/              React frontend
  lib/            ipc, types, store factory, fuzzy, term-links,
                  diff parser, activity grouping, commands registry
  state/          app store + actions
  components/     topbar, sidebar(explorer|changes|activity),
                  editor, terminal, diff, quickopen, search, palette,
                  statusbar, empty states, error boundary
docs/             project docs
.github/          CI + issue/PR templates
```

## IPC contract

Commands: `open_workspace`, `get_workspace`, `list_dir`, `read_file`,
`write_file`, `resolve_link_target`, `list_all_files`, `git_status`,
`git_diff`, `search_start`, `search_cancel`, `pty_spawn`, `pty_write`,
`pty_resize`, `pty_kill`, `detect_agents`, `load_state`, `save_state`.

Events: `fs:batch` (dedup'd change records), `pty:out:<id>` (base64),
`pty:exit:<id>`, `search:chunk`, `search:done`, `git:stale`.

All fs commands canonicalize and enforce workspace-root containment.

## Slices

1. Scaffold + backend fs/paths/platform/persist
2. Watcher + file index
3. PTY manager
4. Git + search + agent detection
5. Frontend core (stores, commands, keyboard, layout)
6. Explorer + CodeMirror tabs + xterm terminal
7. Changes/diff + activity + quick open + search + palette + follow-agent
8. Tests, docs, CI, verification

## Key decisions

- Watch ignores: `.git` always + default dir set (node_modules, target,
  dist, build, .next, .turbo, .cache, out, coverage); configurable later.
- Debounce: 120 ms quiet / 400 ms max batch; merge per path; rename pairing.
- Large files: >4 MB or >100k lines open read-only with notice.
- Dirty files never auto-reload; external change sets a conflict banner.
- PTY output base64 over events → `term.write(Uint8Array)`.
- Editor defaults to read-only; Ctrl+E toggles edit mode per tab.
- Follow Agent: 900 ms quiet debounce, >4 files/s -> burst indicator,
  suppressed 3 s after user interaction.
- Persistence: single JSON in app data dir, debounced writes, versioned.

## Non-goals v0.1

LSP, debugger, extensions, AI chat/APIs, auth, cloud sync, SSH/devcontainers,
GitHub integration, visual git history, settings sprawl.
