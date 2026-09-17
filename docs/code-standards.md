# Code Standards

## Rust

- `cargo fmt` + `cargo clippy -D warnings` clean.
- Errors: `AppError` (thiserror) → string-serialized to the frontend.
- Every fs-touching command goes through `paths::resolve_*` containment.
- Long-running work runs on threads; results reach the frontend via typed
  events, not polling.
- Unit tests live in-module (`#[cfg(test)]`), focused on parsing/merging/
  normalization logic.

## TypeScript

- `strict` on; `tsc --noEmit`, `eslint`, `prettier` clean.
- Pure logic in `src/lib/` with vitest coverage; React components stay thin
  and call `src/state/actions.ts`.
- No new heavy deps. The store, fuzzy matcher, and diff parser are ~100
  lines each on purpose.
- IPC types are hand-mirrored in `src/lib/types.ts` — keep in sync with
  `#[serde(rename_all = "camelCase")]`.

## Commits

- Conventional-ish, no `chore:`/`docs:` for `.claude` paths.
- Commit at meaningful milestones; keep `main` green.
