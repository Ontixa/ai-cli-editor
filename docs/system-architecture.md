# System Architecture

## Overview

Desktop app: Tauri 2 shell, Rust backend, React/TypeScript frontend.
No network, no plugins beyond `dialog`. The PTY is the integration layer.

```
┌─ Webview (React) ─────────────────────────────────────────────┐
│  components/    explorer editor terminal changes diff          │
│                 activity quickopen search palette statusbar    │
│                 agents (session cockpit)                       │
│  state/         single store + actions                         │
│  lib/           ipc · commands · fuzzy · diff · term-links ·   │
│                 activity · agents · editor-manager · store ·   │
│                 types                                          │
└───────────────▲──────────────────────────────┬────────────────┘
                │ events: fs:batch,            │ invoke():
                │ pty:out:N, pty:exit:N,       │ list_dir, read_file,
                │ search:chunk/done, git:stale │ write_file, git_status,
                │ session:update               │ pty_*, search_*,
                │                              │ session_*, worktree_*,
                │                              │ checkpoint_*,
                │                              │ review_summaries
┌───────────────┴──────────────────────────────▼────────────────┐
│  Rust (src-tauri)                                              │
│  paths.rs     normalize + containment (all fs entry points)    │
│  fs_ops.rs    lazy list_dir, bounded read_file, write_file     │
│  watcher.rs   notify → debounce(120ms quiet/400ms max) → merge │
│  index.rs     quick-open index (ignore-walk + watcher updates) │
│  pty.rs       portable-pty sessions, reader/waiter threads     │
│  session.rs   AgentSession registry: lifecycle, attribution,   │
│               collisions, git summary, bounded history         │
│  procmon.rs   process-tree monitor (sysinfo, 1.5 s, bounded)   │
│  worktree.rs  git worktree create/list/remove/prune + dirty    │
│               protection (.worktrees/, agent/<name> branches)  │
│  checkpoint.rs git-native patch snapshots + safe restore plan  │
│  review.rs    deterministic file classification (path+content) │
│  git.rs       git status porcelain v2, git diff, similar       │
│  search.rs    rg --null streaming, bounded fallback walk       │
│  platform.rs  shell selection, agent + PATH detection,         │
│               per-process exit code (windows-sys)              │
│  persist.rs   versioned JSON in app data dir, tmp+rename       │
│               (workspace-state.json + sessions.json)           │
└────────────────────────────────────────────────────────────────┘
```

## Event contracts

| Event            | Payload                          | Purpose                    |
| ---------------- | -------------------------------- | -------------------------- |
| `fs:batch`       | `{ root, changes, rescan? }`     | merged fs changes          |
| `git:stale`      | `null`                           | hint to refetch git status |
| `pty:out:N`      | `string` (base64 bytes)          | terminal output            |
| `pty:exit:N`     | `{ id, code }`                   | process exit               |
| `search:chunk`   | `{ id, matches: SearchMatch[] }` | streamed results           |
| `search:done`    | `{ id, truncated }`              | search finished            |
| `session:update` | `{ sessions, collisions }`       | session registry snapshot  |

`FsChange = { kind: "created"|"modified"|"deleted"|"renamed", path,
oldPath? }` — workspace-relative, `/`-separated, already deduplicated.

## Watcher pipeline

notify events → channel → debounce thread (one per workspace root):

- accumulate until 120 ms quiet or 400 ms since first event
- drop ignored components (`.git` always; default noise dirs)
- merge per path: create+modify→created, create+delete→nothing,
  modify+delete→deleted, delete+create→created, rename pairs fold
- apply to file index synchronously, then emit `fs:batch` + `git:stale`
- the backlog channel is bounded; on `TryRecv` overflow or a notify
  error the batch emits `rescan: true` — the backend resets the file
  index and the frontend invalidates expanded dirs, reconciles open
  docs, refetches git state, and logs a rescan notice in Activity

## PTY lifecycle

`pty_spawn` → `openpty` → `spawn_command` → reader thread (8 KB chunks →
base64 → `pty:out`) + waiter thread (`child.wait` → `pty:exit` → registry
cleanup). `pty_kill` removes + kills. `open_workspace` kills all sessions.

On Windows, `.cmd`/`.bat`/`.ps1` programs are wrapped in `cmd /c` /
`powershell -File` so npm shims (codex, claude, …) launch correctly.

## Agent sessions (v0.2)

`pty_spawn` registers an `AgentSession` in a global registry after the PTY
spawns. A session carries: stable id, pty id, agent kind, program, PID,
workspace root + `relPrefix` (non-empty for worktree sessions), state
(`starting|busy|idle|exited|stale`), timestamps, touched-file history,
command runs, child processes, git summary.

- **Lifecycle** — PTY output marks the session busy (5 s window or while
  child processes are observed); quiet live sessions are `idle`;
  `pty:exit` freezes the session (`exited` + code). On startup, persisted
  sessions are restored as `stale` history — never as live processes.
- **Attribution** — the watcher merge hook records each fs change against
  live sessions. A session claims a path directly when its `relPrefix`
  contains it (most specific root wins); sessions sharing the same root get
  `ambiguous` instead of a guess.
- **Process observation** — `procmon` polls `sysinfo` while any session is
  live: ~1.5 s for the visible workspace, a slower tier (~6 s) for
  background project tabs. It walks only descendants of app-spawned PIDs
  (depth ≤ 8, ≤ 32 children/session), records per-session CPU%/RSS as
  `Option` (unknown ≠ 0), classifies children as test/build/tool/agent,
  and records exit codes where the OS reports them. PID reuse is guarded
  by comparing process start-times — a recycled pid is never attributed
  to a dead session. No global process scans.
- **Usage metering** — `meter.rs` is a byte-buffered state machine fed
  raw PTY output (UTF-8/ANSI splits across chunks are safe). Only
  `\n`-terminated lines count; `\r` fragments are in-place redraws and
  `\r\n` is committed. Cumulative reports are tracked per report-family
  key: a lower value than last seen folds the epoch into a base and a
  repeated equal value is a no-op; identical per-message deltas always
  count (no global dedupe). Cache-read and cache-write are separate
  counters; `tokensTotal` is `max(reported, in+out)` so an explicit total
  never stacks on top of its own components. `sources` records which
  report families contributed. Cost: the CLI's own reported `$` wins;
  otherwise a static per-model price table produces an estimate only
  when the CLI named a known model. `flush()` at exit counts a final
  unterminated report line.
- **Collisions** — recomputed on each snapshot: two live sessions touching
  the same file, or sharing a working tree root, produce a bounded
  `Collision` advisory. Worktree isolation naturally avoids them.
- **Persistence** — `sessions.json` `{ "version": 2, "sessions": [...],
"usage": {...} }`, tmp+rename, capped history; corrupt/incompatible →
  empty. Finalized per-agent usage counters persist beside sessions;
  `metered_final` on each archived session marks whether its usage was
  already folded in, so restore can't double-count. Legacy
  `tokensCached` migrates into `tokensCacheRead`.

## Worktrees, checkpoints, review

- **Worktrees** live under `<repo>/.worktrees/<name>` on branch
  `agent/<name>` (validated, auto-added to `.git/info/exclude`). Removal
  refuses dirty trees unless `force`; `worktree prune` drops stale admin
  metadata.
- **Checkpoints** store `patch.diff` (HEAD diff, binary included) + copies
  of untracked files + `meta.json` under
  `<git-common-dir>/aice-checkpoints/<id>/` (shared across worktrees).
  `checkpoint_plan` previews affected/conflicting files and HEAD drift;
  `checkpoint_restore` refuses when files are dirty unless `force`, then
  applies via `git apply --3way` (plain `apply` fallback).
- **Review** classifies every changed file locally: path heuristics
  (secrets, deps, CI, migrations, generated, tests, docs, binary, auth)
  plus added-line content signals (keys, crypto, destructive shell/SQL,
  exec/spawn, env access). Rank orders the review queue; reasons are always
  human-readable. Capped at 200 files per call.

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
