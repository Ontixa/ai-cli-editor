# AI CLI Editor

**The lightweight editor for Codex, Claude Code, Gemini CLI and coding agents.**

AI CLI Editor is a terminal-first code editor for people who let coding agents
write the code and mainly need to **view, review, diff, and steer** them.

AI writes code. Humans steer, observe, inspect, review, occasionally edit,
test, and commit.

```
┌──────────────────────────────────────────────────────────────┐
│ ▸_ AI CLI Editor    workspace        Ctrl+Shift+P  ⌄ panels  │
├──────────┬───────────────────────────────────────────────────┤
│ Files    │  tabs: auth.ts  auth.test.ts  ± diff              │
│ Changes  │  ┌─────────────────────────────────────────────┐  │
│ Activity │  │  CodeMirror — view/review first             │  │
│          │  └─────────────────────────────────────────────┘  │
├──────────┴───────────────────────────────────────────────────┤
│  $ codex resume          (real PTY: bash/zsh/PowerShell/…)   │
└──────────────────────────────────────────────────────────────┘
```

<!-- TODO: replace ASCII mock with a real screenshot once v0.1 lands.
     Capture strategy: run `npm run tauri:dev`, open a small repo, run a
     coding CLI in the terminal panel, screenshot at 1440x900. -->

## Why

Heavy editors do too much when a coding agent does the typing. Language
servers, extension hosts, and giant object graphs mostly get in the way of a
workflow that is really:

1. launch agent → 2. watch it work → 3. review diffs → 4. commit.

AI CLI Editor keeps only what that loop needs — a real terminal, a real file
tree, a real diff — and stays fast and stable through long agent sessions.

## Features

- **Real PTY terminals** — multiple sessions, PowerShell/cmd on Windows,
  bash/zsh on macOS/Linux. Runs `codex`, `claude`, `gemini`, `opencode`,
  `aider`, and any other CLI. Detected agents get one-click launch buttons.
- **Live file watching** — creations, edits, deletes and renames land in the
  tree, the Changes panel, and Agent Activity the moment they happen.
- **Agent Activity** — a session timeline of what the agent touched:
  `23:31:02  M  src/auth.ts`, grouped when edits repeat.
- **Follow Agent** — optionally surfaces the file the agent is currently
  editing; backs off during bursts and never rips focus while you type.
- **Git changes + diff viewer** — staged/unstaged/untracked, unified or
  side-by-side diff, one-click stage/unstage, and a commit box that passes
  your message straight to `git commit` (never through a shell).
- **Explorer file operations** — right-click to create files/folders (nested
  paths allowed), rename, and delete; all path-checked against the workspace
  root.
- **Dark + light themes** — command-palette toggle, persisted across
  sessions, applied to the editor and the terminal too.
- **CodeMirror 6 editor** — view-first by design; `Ctrl+E` toggles edit mode
  for the small fixes humans still make. `Ctrl+S` saves.
- **Quick Open (`Ctrl+P`)** — fuzzy filename search over a lazy,
  watcher-maintained index. No content indexing.
- **Workspace search (`Ctrl+Shift+F`)** — streams results through ripgrep
  when installed, with a built-in fallback when it isn't.
- **Clickable terminal paths** — `src/foo.ts:123:20` Ctrl+click opens the
  file at that line (Windows paths included).
- **Local persistence** — reopens your last workspace, tabs, layout, and
  Follow preference. Corrupt state degrades to defaults.

## Philosophy

- **The terminal is the integration layer.** No AI APIs, no vendor lock-in,
  no embedded chat. If it runs in a terminal, it works here.
- **View-first, edit-second.** Files open read-only; editing is one
  keystroke away and never gets in the way of reading.
- **Small and fast are features.** No recursive repo parsing, no language
  servers, no giant hidden DOM. Lazy everything.

## Installation

Binaries are not published yet — build from source (below). Windows 11 is the
primary target; macOS and Linux work through the same codebase.

## Development

Prerequisites: Node 20+, Rust stable, and
[Tauri system dependencies](https://v2.tauri.app/start/prerequisites/)
(WebView2 on Windows — preinstalled on Windows 11).

```bash
npm install
npm run tauri:dev      # dev mode with hot reload
npm run tauri:build    # release bundle
npm run check          # fmt + lint + typecheck + unit tests
cargo test --manifest-path src-tauri/Cargo.toml
```

## Keyboard shortcuts

| Keys             | Action                         |
| ---------------- | ------------------------------ |
| `Ctrl+P`         | Quick Open (fuzzy files)       |
| `Ctrl+Shift+P`   | Command Palette                |
| `Ctrl+Shift+F`   | Search workspace               |
| `Ctrl+`` `       | Toggle terminal                |
| `Ctrl+Shift+`` ` | New terminal                   |
| `Ctrl+S`         | Save file                      |
| `Ctrl+E`         | Toggle edit mode (view ↔ edit) |
| `Ctrl+W`         | Close tab                      |
| `Ctrl+Tab`       | Next / previous tab (`+Shift`) |
| `Ctrl+B`         | Toggle sidebar                 |

Shortcuts pass through to the shell while the terminal has focus (so
`Ctrl+P`/`Ctrl+S`/`Ctrl+W` keep their readline meanings inside agents).

## Supported coding CLIs

Anything that runs in a terminal. Detected automatically for quick-launch:
Codex CLI, Claude Code, Gemini CLI, OpenCode, Aider. Absence of any of them
is fine — a plain shell is always available.

## Architecture

```
React + TS frontend            Rust backend (Tauri 2)
─────────────────────          ──────────────────────────────────
editor · explorer ·            fs ops (root-containment checked)
terminal · diff · activity     watcher (notify + debounced merge)
command registry · fuzzy       PTY registry (portable-pty)
quick-open · search            git via git binary (porcelain v2)
                               search via rg --null streaming
                               JSON workspace persistence
```

Events are typed contracts (`fs:batch`, `pty:out:<id>`, `search:chunk`,
`search:done`, `git:stale`) — see `docs/system-architecture.md`.

## Privacy

Local-first by construction: no accounts, no telemetry, no cloud calls, no
source code leaves the machine. The webview has no `fs`/`shell`/`http`
plugin access; all filesystem commands are constrained to the opened
workspace root.

## Roadmap

Near-term: configurable ignore lists, persistent activity history, bundled
ripgrep, more themes. Explicit non-goals live in
`docs/project-roadmap.md` — LSP, extensions, and AI APIs are out of scope
by design.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and PRs welcome.

## License

[Apache-2.0](LICENSE)
