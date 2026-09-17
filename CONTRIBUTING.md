# Contributing to AI CLI Editor

Thanks for helping build a small, fast, agent-agnostic editor. A few things
to know before opening a PR.

## Ground rules

- **Keep it small.** New dependencies need justification. Prefer Rust-side
  implementations over new JS packages.
- **The terminal is the integration layer.** Do not add AI/model SDKs, API
  keys, or embedded chat. Ever.
- **Local-first.** No telemetry, no network calls, no accounts.
- **View-first UX.** Defaults favor reading and reviewing code.

## Setup

```bash
npm install
npm run tauri:dev
```

Prereqs: Node 20+, Rust stable, Tauri platform deps
(<https://v2.tauri.app/start/prerequisites/>).

## Checks (must pass before merge)

```bash
npm run fmt            # prettier
npm run lint           # eslint
npm run typecheck      # tsc --noEmit
npm run test           # vitest
cargo fmt --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

## Where things live

- `src-tauri/src/` — Rust backend: `fs_ops`, `paths`, `watcher`, `index`,
  `pty`, `git`, `search`, `platform`, `persist`
- `src/lib/` — pure TS modules (commands, fuzzy, diff, term-links, activity)
  — these carry the unit tests
- `src/state/` — app store + actions
- `src/components/` — UI panels

## Conventions

- All filesystem commands must pass through `paths::resolve_*` containment
  checks — repository contents are untrusted.
- New palette entries register via `commands.register()` — never hardcode
  palette rows.
- New backend events: emit typed payloads and mirror the shape in
  `src/lib/types.ts`.
- Write tests for parsing/scoring/merging logic; UI glue is optional.

## Issues

Use the templates — they ask for exactly the info we need.
