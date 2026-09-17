## Summary

<!-- What does this change and why? -->

## Checklist

- [ ] `npm run check` passes (fmt + lint + typecheck + vitest)
- [ ] `cargo fmt --check && cargo clippy -- -D warnings && cargo test` pass in `src-tauri`
- [ ] No new heavy dependencies without justification in the PR description
- [ ] No AI/model SDK, telemetry, or network calls added
- [ ] IPC changes update `src/lib/types.ts` and docs if user-visible

## Test plan

<!-- How was this verified? Steps/screens welcome. -->
