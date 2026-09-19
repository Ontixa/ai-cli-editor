# AI CLI Editor

**The control plane, cockpit, and review surface for terminal-native coding agents.**

AI CLI Editor is a terminal-first workspace for people who let coding agents
write the code and mainly need to **launch, observe, isolate, review, and
steer** them. A terminal running `codex`, `claude`, `devin`, `gemini`,
`opencode`, `aider`, or any other CLI is a first-class **Agent Session** —
not just a terminal.

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

- **Agent Sessions** — every spawned terminal becomes an observable session:
  detected agent kind, PID, working directory/worktree, lifecycle state
  (starting → busy/idle → exited), elapsed time, touched files, child
  processes, command runs (test/build/tool) with exit codes where the OS
  reports them, and a live Git summary.
- **Agents cockpit** — a compact sidebar panel listing all live sessions and
  recent history: state dot, agent kind, worktree, files touched, running
  commands, exit codes. Focus, rename, checkpoint, or stop a session
  in place.
- **Git worktree isolation** — one click creates `.worktrees/<name>` on
  branch `agent/<name>` and opens a terminal (or agent) inside it. Dirty
  worktrees refuse removal unless you explicitly confirm; `worktree prune`
  cleans stale metadata.
- **Collision detection** — bounded, honest warnings when two live sessions
  touch the same file or share the same working tree. Advisory, not merge
  prediction; worktree-isolated agents generate few alerts.
- **Deterministic review classification** — every changed file is tagged by
  local heuristics (no AI): `security`, `db-migration`, `ci-config`,
  `dependencies`, `tests`, `generated`, `docs`, `binary`. Badges in Changes,
  a "review N" filter for elevated-risk files, and human-readable reasons.
- **Checkpoints** — Git-native snapshots of a session's (or the workspace's)
  working tree: patch + untracked files + metadata stored under `.git/`.
  Restore is an explicit, previewed overlay — conflicting files are listed
  first and require a forced restore; nothing is silently discarded.
- **Process observation** — a conservative monitor follows only descendants
  of app-spawned PTYs (depth- and count-bounded), so `vitest`, `cargo`,
  `pytest`, `tsc` runs show up against the session that launched them.
- **Session history** — bounded session metadata persists across restarts in
  `sessions.json`; dead processes are shown as history, never resurrected.
- **Real PTY terminals** — multiple sessions, PowerShell/cmd on Windows,
  bash/zsh on macOS/Linux. Runs `codex`, `claude`, `devin`, `gemini`,
  `opencode`, `aider`, `amp`, `qwen`, `crush`, `copilot`, and any other
  CLI. Detected agents get one-click launch buttons; missing ones get a
  one-click install chip (always confirmation-first, run in the open).
- **Token & cost metering** — the session registry scans PTY output for
  the usage reports each CLI prints (aider's sent/received + session
  cost, codex's `tokens used`, Claude's `/cost` table, Gemini's `/stats`)
  and shows per-session and per-project token counts with reported cost —
  or a clearly-marked `≈` estimate from a static price table when the CLI
  reports tokens but no price. Metered usage persists in session history.
- **Live file watching** — creations, edits, deletes and renames land in the
  tree, the Changes panel, Agent Activity, and session attribution the
  moment they happen.
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

Grab the latest signed installer (`-setup.exe`, NSIS) from
[GitHub Releases](https://github.com/tang-vu/ai-cli-editor/releases), or build
from source (below). Windows 11 is the primary target; macOS and Linux work
through the same codebase.

### Updates

The app checks GitHub Releases once on startup for a newer signed build. When
one exists, an `⬆ update` item appears in the status bar — click to download,
verify the signature, install, and relaunch. This update check is the app's
only network call; everything else stays fully local. Unsigned or tampered
artifacts are rejected by minisign signature verification.

Maintainers cut a release by pushing a version tag (`git tag v0.3.0 && git
push --tags`) — `.github/workflows/release.yml` builds, signs
(`TAURI_SIGNING_PRIVATE_KEY` secret), and publishes the installers plus the
`latest.json` the updater reads.

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

Anything that runs in a terminal. Detected automatically for quick-launch
and session labeling: Codex CLI, Claude Code, Devin CLI, Gemini CLI,
OpenCode, Aider, Amp, Qwen Code, Crush, GitHub Copilot. CLIs not on PATH
show an install chip — one click opens a confirmation dialog, then types
the documented package-manager command into a fresh terminal where the
whole install runs visibly. Unknown programs get generic session
tracking — absence of all of them is fine, a plain shell is always
available.

## Architecture

```
React + TS frontend            Rust backend (Tauri 2)
─────────────────────          ──────────────────────────────────
editor · explorer ·            fs ops (root-containment checked)
terminal · diff · activity     watcher (notify + debounced merge)
agents cockpit · review        PTY registry (portable-pty)
command registry · fuzzy       session registry + attribution
quick-open · search            proc monitor (sysinfo, descendants only)
                               worktrees + checkpoints (git binary)
                               review classifier (deterministic)
                               git via git binary (porcelain v2)
                               search via rg --null streaming
                               JSON workspace + session persistence
```

Events are typed contracts (`fs:batch`, `pty:out:<id>`, `search:chunk`,
`search:done`, `git:stale`, `session:update`) — see
`docs/system-architecture.md`.

## Limitations

- **File attribution is best-effort.** Two agents in the same directory make
  per-file attribution ambiguous; the UI says so instead of guessing.
- **Process observation is best-effort.** Only descendants of app-spawned
  PTYs are watched; exit codes depend on what the OS reports. Windows is the
  primary target; Linux/macOS use the same abstractions.
- **Collision detection is advisory.** It flags shared files/trees; it does
  not predict merge conflicts.
- **Checkpoints are not commits.** They overlay a saved patch onto the
  working tree on restore and require Git. They never rewrite history.
- **Test/build output is not parsed.** Command kinds and exit codes come
  from the process tree, not from scraping agent output.

## Privacy

Local-first by construction: no accounts, no telemetry, no cloud calls, no
source code leaves the machine. The single exception is the signed-update
check against this repo's GitHub Releases (see Updates). The webview has no
`fs`/`shell`/`http` plugin access; all filesystem commands are constrained
to the opened workspace root.

## Roadmap

v0.2 "Agent Workspace" delivers sessions, the cockpit, worktrees, collision
detection, review classification, and checkpoints. Near-term: configurable
ignore lists, bundled ripgrep, session templates, merge-readiness summaries.
Explicit non-goals live in `docs/project-roadmap.md` — LSP, extensions,
embedded AI chat, and AI APIs are out of scope by design.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and PRs welcome.

## License

[Apache-2.0](LICENSE)
