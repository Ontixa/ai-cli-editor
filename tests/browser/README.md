# Terminal Find browser acceptance

The dedicated `Terminal Find browser acceptance` workflow runs these checks in
real Chromium on GitHub-hosted runners, against the exact pull-request head SHA.
It uses only `contents: read`, disables persisted checkout credentials, and does
not deploy anything or consume secrets. Existing frontend, Rust, and Windows
checks remain independent.

The fixture imports the production TerminalPanel, TerminalFindBar,
CommandPalette, command registration, workbench keyboard dispatcher, actions,
terminal manager, and real xterm/SearchAddon. Only Tauri `invoke` and `listen`
are replaced. The bridge records calls, returns fixed synthetic values, and
rejects every operation outside its explicit allowlist. It never creates an
actual PTY, starts a shell/provider, reads a workspace, runs Git, restores app
state, or invokes App/boot. Project activation's normal metadata requests are
answered from in-memory constants. Browser requests outside the fixture origin
are blocked and fail the test.

The checks cover:

- Header and palette availability, explicit next/previous navigation and wrap
- Real xterm clipboard selection, rendered cell ranges, and DOM input focus
- Wide-character and surrogate-pair Unicode across a wrapped logical line,
  literal punctuation/spaces, and missing results
- Shell Ctrl+F, no PTY writes from query/Enter/Escape, blocked file bindings,
  and preserved workspace-search/command-palette shortcuts
- Query closure on terminal/project switch, deletion, and panel hiding
- Output and resize invalidation, no stale-result auto-navigation or viewport
  movement, and fresh results after an explicit search action
- Actual 8000-row scrollback trimming: a retained match shifts its buffer row,
  stale selection clears, and the visible viewport and input focus stay put
- Alternate-screen scope, exited scrollback, and empty panels without Find
  spawning terminals

Successful ordinary and wrapped-Unicode tests attach screenshots plus JSON
containing selected text, observed cell ranges, dimensions, viewport position,
and focused element. The stale-output case records before/stale/next-action
measurements. Every case attaches the synthetic bridge's call log. Failures
also retain Playwright screenshots and traces. CI uploads the scoped HTML
report and test results for seven days.

Contributor reproduction from the repository root:

```sh
npm ci
npx playwright install --with-deps chromium
npm run test:browser:terminal-find
```

The test runner starts and stops its own synthetic Vite fixture on port 4179.
The dedicated pull-request workflow runs the same checks and uploads results.
Files under `.artifacts/` are generated and ignored.

Static validation and test discovery:

```sh
npx tsc --noEmit --project tests/browser/tsconfig.json
npm run test:browser:terminal-find -- --list
npx vite build --config tests/browser/vite.config.ts
```

These are browser acceptance tests of a synthetic frontend, not a claim about
native Tauri/WebView behavior or a live shell session.
