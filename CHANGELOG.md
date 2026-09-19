# Changelog

All notable changes to this project will be documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased] — editor-reliability

### Added

- **Cache-read vs cache-write token counters** — separate fields through
  meter → session snapshot → persisted archive → UI; legacy
  `tokensCached` archives migrate into `tokensCacheRead`.
- **Usage provenance** — each session records which report families
  contributed (`tokens used`, `cache read`, …); shown on session cards
  and in exports.
- **Per-session CPU%/RSS** — conservative sysinfo sampling, `Option`
  values shown as `—` when unknown; two-tier polling (~1.5 s visible
  workspace, ~6 s hidden project tabs).
- **PID-reuse guard** — process start-times are recorded at spawn and
  checked on each procmon pass so a recycled PID is never attributed to
  a dead session.
- **Session export** — `session_export` command + Agents-panel button
  copy a structured JSON summary (root/worktree, git, files, commands,
  usage + provenance); never terminal output or file contents.
- **Session templates** — structured `program + argv[]` launchers with
  optional cwd and an optional test command typed into the PTY on
  demand; no shell-string interpolation.
- **Watcher rescan** — bounded backlog; overflow/notify-error emits
  `rescan: true`, resets the file index, invalidates frontend dir/doc
  state, refetches git, and logs an Activity notice.
- **Close confirmation** — closing a project tab with live sessions asks
  first; close kills only app-spawned PTYs.
- **PTY-backed e2e suite** (`tests/session_e2e.rs`) — real ConPTY
  sessions through `SessionRegistry`: metering + exit finalization,
  identical-delta double counting, workspace isolation, stale-restore
  without double counting, ~2 MB output burst, detach-on-close.
  Harness answers ConPTY's DSR query like a real terminal.

### Fixed

- **Meter correctness** — byte-buffered feed handles UTF-8/ANSI split
  across PTY chunks; only `\n`-committed lines advance counters (`\r`
  redraws are in-place repaints, `\r\n` commits); cumulative reports are
  tracked per report-family key so a counter reset folds a new epoch
  instead of dropping or double-counting, while identical repaints are
  no-ops; `tokensTotal` uses `max(reported, in+out)` so explicit totals
  no longer stack on their own components; unterminated trailing output
  is flushed at exit.
- **Honest cost** — estimates are keyed on the CLI-reported model via a
  static price table; unknown model → no estimate instead of a guess.
- **Restore can't double-count** — `metered_final` rides the archive;
  re-restoring the same `sessions.json` (crash between save steps) is a
  no-op. Restored sessions stay `stale` — no pid, no PTY, never live.
- **Unknown ≠ 0** — CPU/memory/model/context render `—` when the OS or
  CLI didn't report a value.
- Exit events arriving before PTY registration are stashed and applied
  at `spawn` (instant-exit race).

## [0.2.0] — Agent Workspace

### Added

- **Agent Sessions**: every spawned PTY becomes a first-class session —
  agent kind (codex/claude/devin/gemini/opencode/aider/shell), PID,
  workspace/worktree root, lifecycle state, touched files, child processes,
  command runs with exit codes, live Git summary (`session.rs`).
- **Agents cockpit**: sidebar panel with compact session cards — state,
  worktree, files touched, running commands; focus/rename/checkpoint/stop
  actions; collapsible session history.
- **Process observation**: `procmon.rs` polls only descendants of
  app-spawned PIDs (1.5s, depth ≤ 8, ≤ 32 children/session); best-effort
  exit codes via `GetExitCodeProcess` on Windows.
- **File attribution + collision detection**: watcher events attribute to
  sessions (direct/likely/ambiguous); same-file and shared-tree warnings.
- **Signed auto-updates**: `tauri-plugin-updater` checks GitHub Releases on
  startup — the app's only network call — and installs verified builds from
  a status-bar prompt; `release.yml` publishes signed installers +
  `latest.json` on `v*` tags.
- **Git worktrees**: `worktree_list/create/remove/prune`; `.worktrees/`
  convention, `agent/<name>` branches, dirty protection, forced removal only
  on explicit confirm, auto-excluded via `.git/info/exclude`.
- **Checkpoints**: Git-native patch + metadata under the repo's git dir;
  restore plan with conflict/HEAD-mismatch/missing-repo detection; forced
  restore only on explicit confirm; delete support.
- **Deterministic review classifier**: `review.rs` path/content heuristics —
  security/db-migration/ci-config/dependencies/tests/generated/docs/binary —
  with badges and a risk filter in the Changes panel.
- **Persistence v2**: `sessions.json` (versioned envelope, atomic write,
  bounded history, corrupt → empty).
- **`pty_spawn` accepts `cwd`** for worktree-rooted terminals; `PtyInfo`
  exposes `pid`.
- New events/commands: `session:update`, `session_list/rename/stop/files`,
  `worktree_*`, `checkpoint_*`, `review_summaries`.
- TS unit tests for session/age/collision/review helpers; Rust unit +
  integration tests for sessions, worktrees, checkpoints, review.

### Fixed

- Windows test binaries crashed (`STATUS_ENTRYPOINT_NOT_FOUND`): test
  targets lacked the Common Controls v6 manifest — `cdylib` removed,
  `build.rs` links Tauri's resource into test binaries.
- ConPTY stalls on its startup DSR query (`ESC[6n`) when no terminal
  answers; integration tests now reply `ESC[1;1R` like a real terminal.

## [0.1.0]

### Added

- Initial release: Tauri 2 desktop app (Rust + React/TS + CodeMirror 6 +
  xterm.js + portable-pty)
- Workspace open, lazy file explorer with git badges and keyboard nav
- View-first editor tabs (read-only default, `Ctrl+E` edit mode, `Ctrl+S`)
- Real PTY terminals: multiple sessions, shells or agent CLIs, resize,
  `path:line:col` Ctrl+click links
- Debounced filesystem watcher driving the tree, open docs, Agent Activity
  and git state
- Agent Activity timeline (created/modified/deleted/renamed + terminal
  lifecycle, grouped repeats)
- Follow Agent mode with burst detection and focus protection
- Git Changes panel (staged/unstaged/untracked) + unified diff viewer
- Quick Open (`Ctrl+P`), workspace search (`Ctrl+Shift+F`, rg + fallback),
  command palette (`Ctrl+Shift+P`)
- Local workspace persistence (tabs, layout, follow preference)
