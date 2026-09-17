# System Architecture

## Overview

Desktop app: Tauri 2 shell, Rust backend, React/TypeScript frontend.
No network, no plugins beyond `dialog`. The PTY is the integration layer.

```
┌─ Webview (React) ─────────────────────────────────────────────┐
│  components/    explorer editor terminal changes diff          │
│                 activity quickopen search palette statusbar    │
│  state/         single store + actions                         │
│  lib/           ipc · commands · fuzzy · diff · term-links ·   │
│                 activity · editor-manager · store · types      │
└───────────────▲──────────────────────────────┬────────────────┘
                │ events: fs:batch,            │ invoke():
                │ pty:out:N, pty:exit:N,       │ list_dir, read_file,
                │ search:chunk/done, git:stale │ write_file, git_status,
                │                              │ pty_*, search_*, …
┌───────────────┴──────────────────────────────▼────────────────┐
│  Rust (src-tauri)                                              │
│  paths.rs     normalize + containment (all fs entry points)    │
│  fs_ops.rs    lazy list_dir, bounded read_file, write_file     │
│  watcher.rs   notify → debounce(120ms quiet/400ms max) → merge │
│  index.rs     quick-open index (ignore-walk + watcher updates) │
│  pty.rs       portable-pty sessions, reader/waiter threads     │
│  git.rs       git status porcelain v2, git diff, similar       │
│  search.rs    rg --null streaming, bounded fallback walk       │
│  platform.rs  shell selection, agent + PATH detection          │
│  persist.rs   versioned JSON in app data dir, tmp+rename       │
└────────────────────────────────────────────────────────────────┘
```

## Event contracts

| Event          | Payload                          | Purpose                    |
| -------------- | -------------------------------- | -------------------------- |
| `fs:batch`     | `FsChange[]`                     | merged fs changes          |
| `git:stale`    | `null`                           | hint to refetch git status |
| `pty:out:N`    | `string` (base64 bytes)          | terminal output            |
| `pty:exit:N`   | `{ id, code }`                   | process exit               |
| `search:chunk` | `{ id, matches: SearchMatch[] }` | streamed results           |
| `search:done`  | `{ id, truncated }`              | search finished            |

`FsChange = { kind: "created"|"modified"|"deleted"|"renamed", path,
oldPath? }` — workspace-relative, `/`-separated, already deduplicated.

## Watcher pipeline

notify events → channel → debounce thread:

- accumulate until 120 ms quiet or 400 ms since first event
- drop ignored components (`.git` always; default noise dirs)
- merge per path: create+modify→created, create+delete→nothing,
  modify+delete→deleted, delete+create→created, rename pairs fold
- apply to file index synchronously, then emit `fs:batch` + `git:stale`

## PTY lifecycle

`pty_spawn` → `openpty` → `spawn_command` → reader thread (8 KB chunks →
base64 → `pty:out`) + waiter thread (`child.wait` → `pty:exit` → registry
cleanup). `pty_kill` removes + kills. `open_workspace` kills all sessions.

On Windows, `.cmd`/`.bat`/`.ps1` programs are wrapped in `cmd /c` /
`powershell -File` so npm shims (codex, claude, …) launch correctly.

## State

One `Store<AppState>` (immutable replace + selector subscriptions).
Tabs are `file:<path>` / `diff:<path>:<staged|wt>`. CodeMirror
`EditorState`s live in `editorManager` outside React; mounted `EditorView`s
are attached/detached per visible tab.

## Reliability rules

- Unsaved edits are never overwritten: external modify on a dirty doc sets
  `conflict` (banner) instead of reloading.
- Self-writes are suppressed via a 2 s marker so our own save doesn't
  trigger a reload loop.
- Files deleted on disk keep their content + a "deleted" banner.
- `load_state` validates `version` and falls back to defaults on corrupt
  JSON; saves are tmp+rename.
