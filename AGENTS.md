# AGENTS.md — notes for coding agents working in this repo

## Build / check

```bash
npm install
npm run check          # prettier + eslint + tsc + vitest
npm run tauri:dev      # run the app
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

## Conventions

- Backend modules in `src-tauri/src/` are single-purpose; commands in
  `lib.rs` are thin wrappers. All paths must pass `paths::resolve_*`
  containment checks — repo contents are untrusted.
- Frontend logic lives in `src/lib/` (pure, tested) and `src/state/actions.ts`;
  components render from the single store and call actions.
- IPC contracts: `#[serde(rename_all = "camelCase")]` in Rust, mirrored in
  `src/lib/types.ts`.
- Do NOT add AI/model SDKs, telemetry, or network calls — the terminal is
  the integration layer. The ONE sanctioned exception is the signed-update
  check against GitHub Releases (`src/lib/update.ts` → tauri-plugin-updater);
  never extend it to other endpoints or add unauthenticated fetch paths.
- Release secrets: the minisign private key lives OUTSIDE the repo
  (`~/.tauri/ai-cli-editor.key`) and as `TAURI_SIGNING_PRIVATE_KEY` in GitHub
  secrets — never commit it. `latest.json`/releases are produced by
  `.github/workflows/release.yml` on `v*` tags matching `tauri.conf.json` version.
- File paths: when using file tools, write `D:\Github\ai-cli-editor\...`
  (Windows path); in shells use `/mnt/d/Github/ai-cli-editor`.
