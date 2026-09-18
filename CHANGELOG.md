# Changelog

All notable changes to this project will be documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/).

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
