# Editor rename browser acceptance

The dedicated `Editor rename browser acceptance` workflow runs real Chromium
on a GitHub-hosted runner against the exact pull-request head SHA. Checkout
credentials are not persisted, permissions are limited to `contents: read`,
and the workflow uses the existing pinned Playwright dependency with `npm ci`.
It does not deploy, use secrets, or change repository access.

The fixture mounts production `EditorArea` and `EditorHost` with actual
CodeMirror states, selections, history, and DOM editors. Its controls call
production edit/save/rename/tab/project actions. Successful synthetic rename
IPC queues a watcher event; a separate control delivers that event through
production `onFsBatch` and `applyFsBatch`. Tests deliberately navigate before
delivery to exercise interrupted flows. There is no replacement editor or
test-only rename implementation in the application.

Only Tauri `invoke` and `listen` are substituted. The strict bridge keeps
synthetic text in memory, records all calls and events, rejects every command
or listener outside its allowlist, and never forwards to a native backend,
filesystem, shell, PTY, or Git. Project metadata requests receive inert
constants. The fixture omits App/boot and persistence. Browser routes allow
only fixture-origin static resources; application fetch/XHR and WebSockets
are blocked and fail acceptance. Tests serve the built fixture through Vite
preview, so no development HMR client or WebSocket is present.

Coverage includes actual keyboard edits; text, selection and undo/redo
preservation; a single rendered editor; new edits updating dirty/cursor state;
exact edited bytes saved under the new name; repeated and duplicate rename
events; actual vertical/horizontal scroll retention; tab/project interruption
with two projects' same relative filename;
failed/no-op renames; and read-only mode. Each successful case attaches a
screenshot and state evidence. Every case attaches its synthetic IPC/event
log. Failures retain screenshots and traces. CI uploads only the scoped report
and results for seven days.

Static validation (does not launch a browser):

```sh
npx tsc --noEmit --project tests/browser/editor-rename/tsconfig.json
npx vite build --config tests/browser/editor-rename/vite.config.ts
npm run test:browser:editor-rename -- --list
```

Hosted Chromium runs:

```sh
npm ci
npx playwright install --with-deps chromium
npm run test:browser:editor-rename
```

Playwright builds and serves the synthetic Vite fixture on port 4180. Generated output lives
under the existing ignored `tests/browser/.artifacts/editor-rename/` directory.
This verifies frontend behavior in Chromium, not native Tauri/WebView or real
filesystem-watcher behavior.
