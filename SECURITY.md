# Security Policy

## Reporting a vulnerability

Please report security issues privately — open a
[GitHub security advisory](https://github.com/ai-cli-editor/ai-cli-editor/security/advisories/new)
or email the maintainers listed there. Do not file public issues for
vulnerabilities.

We aim to acknowledge reports within a few days and will coordinate a fix
and disclosure with you.

## Security model (what we already do)

- **No network surface.** The app makes no network requests; there is no
  telemetry, account system, or update channel.
- **Least-privilege webview.** The frontend has `core:default` +
  `dialog:default` Tauri capabilities only — no `fs`, `shell`, or `http`
  plugin access. A CSP is set in `index.html`/`tauri.conf.json`.
- **Workspace containment.** Every path arriving over IPC is normalized and
  canonicalized; anything escaping the opened workspace root is rejected
  (`paths.rs`). Repository contents are treated as untrusted.
- **Terminal links are navigation only.** Ctrl+click resolves a path
  reference and opens the file; terminal text is never executed.
- **PTY sessions** spawn only programs the user explicitly launches
  (shell or clicked agent button) inside the workspace directory.

## Threat boundaries to keep in mind

- The PTY intentionally runs arbitrary commands — that is the product.
  Agents and shells you run have your user's full filesystem access, same
  as if you ran them in a normal terminal.
- File contents are rendered by CodeMirror/xterm, which handle their own
  output escaping; do not `dangerouslySetInnerHTML` with file or terminal
  text.
