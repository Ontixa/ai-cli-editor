# Changelog

All notable changes to this project will be documented here. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
