# Project Roadmap

## v0.1 — first milestone (this release)

- Open a local folder; lazy file tree with git badges
- CodeMirror viewer/editor tabs; `Ctrl+P` quick open; `Ctrl+Shift+F` search
- Real PTY terminals (shells + detected agent CLIs), clickable file links
- Live fs watching → explorer/docs/activity/git all update
- Agent Activity timeline; Follow Agent mode
- Git Changes + unified diff
- Workspace persistence

## Next

- Side-by-side diff mode
- Configurable ignored directories / watch excludes
- Persistent activity history (session resume)
- Bundled/embedded ripgrep for Windows installs without it
- Light theme + theme architecture
- Staged-diff polish, commit shortcut (normal `git commit` in terminal works
  today — a small commit box is a maybe)
- File ops in explorer (new file/rename/delete) — deliberately deferred to
  keep the tree a viewer first

## Explicit non-goals

- Extension/plugin marketplace
- LSP orchestration or language intelligence
- Debugger, notebooks, collaboration, cloud sync
- AI APIs, embedded AI chat, auth, GitHub integration
- Docker/SSH/Dev Containers, project management, visual git history
- Hundreds of settings

If a feature can't be done without breaking "small, fast, reliable", it
isn't a v1 feature.
