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
                │ pty:launch,                         │ list_dir, read_file,
                │ search:chunk/done, git:stale │ write_file, git_status,
                │ session:update               │ pty_*, search_*,
                │                              │ session_*, worktree_*,
                │                              │ merge_readiness,
                │                              │ checkpoint_*,
                │                              │ review_summaries,
                │                              │ get/set_watch_excludes
┌───────────────┴──────────────────────────────▼────────────────┐
│  Rust (src-tauri)                                              │
│  paths.rs     normalize + containment (all fs entry points)    │
│  fs_ops.rs    lazy list_dir, bounded read_file, write_file     │
│  watcher.rs   notify → debounce(120ms quiet/400ms max) → merge │
│  excludes.rs  watch-exclude rules (defaults + user gitignore   │
│               patterns), hot-swapped shared matcher            │
│  index.rs     quick-open index (ignore-walk + watcher updates) │
│  pty.rs       portable-pty sessions, reader/waiter threads     │
│  session.rs   AgentSession registry: lifecycle, attribution,   │
│               collisions, git summary, bounded history         │
│  procmon.rs   process-tree monitor (sysinfo, 1.5 s, bounded)   │
│  worktree.rs  git worktree create/list/remove/prune + dirty    │
│               protection (.worktrees/, agent/<name> branches)  │
│  merge_readiness.rs per-worktree ahead/behind, dirty state,    │
│               merge-tree clean-merge probe, review reasons     │
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

| Event            | Payload                                  | Purpose                    |
| ---------------- | ---------------------------------------- | -------------------------- |
| `fs:batch`       | `FsChange[]`                             | merged fs changes          |
| `git:stale`      | `null`                                   | hint to refetch git status |
| `pty:launch`     | `{ launchId, id, event, data? , code? }` | launch-scoped output/exit  |
| `search:chunk`   | `{ id, matches: SearchMatch[] }`         | streamed results           |
| `search:done`    | `{ id, truncated }`                      | search finished            |
| `session:update` | `{ sessions, collisions }`               | session registry snapshot  |

`FsChange = { kind: "created"|"modified"|"deleted"|"renamed", path,
oldPath? }` — workspace-relative, `/`-separated, already deduplicated.

## Watcher pipeline

notify events → channel → debounce thread:

- accumulate until 120 ms quiet or 400 ms since first event
- drop excluded paths via the shared `IgnoreRules` matcher: built-in
  defaults + user gitignore-style patterns (`set_watch_excludes` swaps it
  live; `.git` is a hard rule no `!` whitelist can lift)
- merge per path: create+modify→created, create+delete→nothing,
  modify+delete→deleted, delete+create→created, rename pairs fold
- apply to file index synchronously, then emit `fs:batch` + `git:stale`

## PTY lifecycle

The frontend installs an exact launch sink, awaits the shared `pty:launch`
listener, then calls `pty_spawn` with a new UUID `launchId`. The backend echoes
that identifier and the actual PTY `id` on each event: `event: "output"` carries
base64 `data`, while `event: "exit"` carries nullable `code`. Reader/waiter events
can arrive before the spawn acknowledgement; both already have a destination.
Output stays as bytes for xterm, including split UTF-8 and trailing output after
exit. The sink records exit only once and follows its project while detached.
Closing or a failed spawn removes the sink; closing during spawn kills only the
returned owned PTY. Retry creates a fresh launch identifier. No output is retained
by the dispatcher, and unknown/retired launch identifiers are discarded.

The single dispatcher stays registered for the webview lifetime. A failed
listener registration is latched and reports that restarting the editor is required;
retrying it per launch could retain inaccessible callbacks in Tauri's public
`listen` API. Ordinary process-start failures remain retryable. No process is
started if event setup fails or the tab is closed while setup is pending.

`pty_spawn` → `openpty` → `spawn_command` → reader thread (8 KB chunks →
base64 output) + waiter thread (`try_wait` → exit → registry cleanup).
`pty_kill` removes + kills. Workspace close kills that workspace's sessions.

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
  A PTY exit freezes the session (`exited` + code). On startup, persisted
  sessions are restored as `stale` history — never as live processes.
- **Attribution** — the watcher merge hook records each fs change against
  live sessions. A session claims a path directly when its `relPrefix`
  contains it (most specific root wins); sessions sharing the same root get
  `ambiguous` instead of a guess.
- **Process observation** — `procmon` polls `sysinfo` every ~1.5 s while any
  session is live, walks only descendants of app-spawned PIDs (depth ≤ 8,
  ≤ 32 children/session), classifies children as test/build/tool/agent, and
  records exit codes where the OS reports them. No global process scans.
- **Collisions** — recomputed on each snapshot: two live sessions touching
  the same file, or sharing a working tree root, produce a bounded
  `Collision` advisory. Worktree isolation naturally avoids them.
- **Persistence** — `sessions.json` `{ "version": 2, "sessions": [...] }`,
  tmp+rename, capped history; corrupt/incompatible → empty.

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
- **Merge readiness** probes each non-main worktree read-only:
  `rev-list --left-right --count base...head` for ahead/behind, porcelain
  v2 status for dirty/untracked counts, `merge-tree --write-tree` for a
  clean-merge verdict (writes only unreachable odb objects — never refs,
  index, or worktrees), and path-only `review` classification of the
  branch's changed files. Per-worktree failures degrade to an `error`
  field; ≤24 worktrees / ≤100 classified paths / ≤25 conflict names.
  Refreshes on activation, worktree/commit mutations, and the cockpit's
  manual button — never polled.

### Human review progress

Human confirmations are separate from deterministic risk classification.
`review_diff` accepts an explicit workspace root, relative path, comparison
(`staged`) and optional original path. The backend validates ownership and
containment, captures HEAD/index/worktree bytes, renders a diff from those
captured bytes, and rereads the comparison context before returning it. A
SHA-256 fingerprint binds the workspace, path, comparison, branch/HEAD, entries,
modes and exact source bytes. Configured Git filters, external diff and textconv
programs are not used. Mark reviewed rechecks the fingerprint before storing a
confirmation, and request generations reject delayed results after selection,
project or content changes.

Only the open diff is loaded or checked. There is no repository-wide diff
polling. Workspace file events remove affected confirmations, including both
sides of renames and directory descendants. A separate selective Git metadata
watcher observes HEAD, index and refs (including linked-worktree common refs),
ignores object-store traffic, and invalidates workspace confirmations on Git
context changes. These new metadata events and window-focus revalidation reload
only the selected bounded snapshot. They do not refresh the Git change list or
risk classification. After metadata changes, the sidebar labels its last-loaded
list and offers Refresh. Progress totals and list-derived staging/commit
controls stay unavailable until that list is refreshed. A pending or failed
status read also leaves the cached list unknown; only a successful current
request restores progress totals and list-derived controls. Existing explicit and filesystem-driven Git refreshes retain
their normal behavior. In-app saves, renames, deletes, staging, commits and checkpoint
restores invalidate explicitly. Focus/manual refresh clears current validation;
background projects keep only candidates until fresh validation.

`humanReviews` in the existing local `workspace-state.json` stores at most 200
newest confirmations. Each contains workspace root, path, staged flag,
fingerprint and timestamp; no source or diff content is persisted. Invalid
records are dropped, and runtime verification is never restored from disk.
Saved candidates appear as unreviewed until their diff is reopened and matches.
Persistence failure leaves progress in the current session and displays a
warning. The Changes counter counts staged and worktree comparisons separately;
the Unreviewed filter includes saved candidates awaiting validation.

Review snapshots are limited to 2 MiB combined input, 1 MiB patch, a 5-second
Git deadline and a 250 ms local diff budget. Rendering is capped at 4,000 total
diff lines; omitted or incomplete content cannot be marked reviewed. New/deleted
file modes and renamed old/new paths are displayed alongside the comparison.
Common staged text renames preview original HEAD content against the destination
index; their worktree side previews the destination index against disk. Rename
and existing-file mode-change previews remain unreviewable.

Safe text previews remain available where possible for non-files reference
storage (including reftable), watcher-excluded paths and unhealthy metadata
watchers, while confirmation is disabled with an explicit reason. A changed
Git directory pointer requires reopening the workspace before confirmation can
resume. Binary/non-UTF-8 content, conflicts, symlinks, submodules, special files,
partial/promisor clones, unsafe or oversized reads and workspaces opened below
the repository root may have no safe text preview; those show a reason instead.
Metadata-only/empty comparisons cannot be confirmed. This is local review
bookkeeping, not a staging, commit or merge gate.

## State

One `Store<AppState>` (immutable replace + selector subscriptions).
Tabs are `file:<path>` / `diff:<path>:<staged|wt>`. CodeMirror
`EditorState`s live in `editorManager` outside React; mounted `EditorView`s
are attached/detached per visible tab.

## Reliability rules

- Active-document modifications are reconciled under the workspace-owner
  queue, after pending saves settle. A complete text snapshot equal to the last
  loaded or successfully saved content leaves the exact editor state intact;
  equality says nothing about which process wrote the file.
- Different disk text reloads clean buffers. Dirty buffers and incomplete,
  binary, or failed reads keep their open content/history and show a conflict
  banner. Explicit Reload can discard the approved buffer, but never newer
  edits made while it waits. Unchanged observations preserve existing warnings.
- Background-project events keep conflict/deletion bookkeeping without reading
  through another workspace. On activation, clean buffers reconcile with disk;
  dirty buffers retain their existing warnings and only re-check existence.
- Write attempts and queued observations belong to a document identity and
  workspace. Failed writes acknowledge no text; retired documents and older
  observations cannot commit over newer state. Mounted and detached reloads
  retain undo history, and unchanged observations preserve cursor/scroll.
- Save still directly writes the captured buffer. This notification handling
  does not provide cross-process compare-and-write or atomic conflict rejection.
- Files deleted on disk keep their content + a "deleted" banner.
- `load_state` validates `version` and falls back to defaults on corrupt
  JSON; saves are tmp+rename.
