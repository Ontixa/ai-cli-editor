# Changelog

All notable changes to this project will be documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Session presets**: named, reusable launch recipes — a detected agent
  CLI, custom command, or interactive shell plus argv and a cwd mode
  (workspace root or a fresh `.worktrees/<name>` checkout). Launching a
  preset goes through the existing `worktree_create` + `pty_spawn` paths;
  nothing runs outside the normal terminal/session machinery. Ships with
  "Isolated agent — new worktree", "In-place agent session", and "Shell —
  new worktree"; user-defined presets persist in `workspace-state.json`
  with bounded counts/lengths, and `pty_spawn` now bounds command argv
  (≤64 args, ≤4 KiB each, ≤512-char program, 80-char labels). Entry
  points: palette ("New Agent Session from Preset…", plus one-click
  isolated/in-place agent commands) and a "+ preset…" button in the Agents
  cockpit.
- **Merge-readiness summary**: each agent worktree row in the Agents
  cockpit now reports commits ahead/behind the base branch, uncommitted
  and untracked file counts, a read-only clean-merge verdict from
  `git merge-tree --write-tree` (never checks out or mutates anything),
  and the review classification of the branch's changed files — with
  expandable reasons per worktree. The scan is bounded and fail-closed:
  a broken worktree degrades to an `error` entry instead of blanking the
  report (`merge_readiness` IPC).
- **Configurable watch excludes**: user-supplied gitignore-style patterns
  (palette → "Configure Ignored Paths…") on top of the built-in defaults
  (`node_modules`, `target`, `dist`, …). The shared matcher
  (`src-tauri/src/excludes.rs`) is swapped live — running watchers, the
  quick-open index walk, and the fallback search pick changes up without a
  restart; `!` entries can lift a default, `.git` is never un-ignored.
  Patterns persist in `workspace-state.json` and are validated on save.

### Fixed

- Windows command transport now bypasses `cmd.exe` only for the exact supported
  npm Node shim template, preserving literal arguments through native Node.
  Other `.cmd`/`.bat` launches use a restricted literal domain and reject
  unsupported paths or arguments before spawning. See the
  [Windows transport contract](docs/windows-command-transport.md).
- Windows agent detection now selects launchable executable or interpreter
  shims instead of npm's extensionless Unix shell scripts. Supported
  `PATHEXT` ordering and PATH-directory precedence are preserved, and
  explicitly named `.exe`, `.com`, `.cmd`, `.bat`, and `.ps1` launchers are
  resolved exactly. Extensionless-only installs are not advertised as
  available on Windows; Unix lookup is unchanged.

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
