# Agent Loop Runtime through the editor terminal

The editor can host Agent Loop Runtime as a terminal program. It does not have
a runtime mission launcher, structured mission inspector or runtime control API.
The Agents panel observes a generic terminal/process session; mission states,
validation results and receipts belong to the runtime and are inspected through
its output and files. This is terminal interoperability, not provider integration.

## Try the deterministic fixture

Prerequisites: an installed editor, native Node and Git on PATH, and a trusted
[Agent Loop Runtime source checkout](https://github.com/Ontixa/agent-loop-runtime)
with its dependencies installed and `dist/index.js` already built according to
that repository's instructions. This guide does not install or authenticate a
provider. The selected runtime code is trusted executable code, not sandboxed.

Open a folder in the editor, then choose **New terminal**. In PowerShell, replace
the example path with your actual runtime checkout:

```powershell
node "C:/path/to/agent-loop-runtime/scripts/demo-mission.mjs"
```

The runtime creates a new temporary Git repository and isolated worktree, runs
a deterministic Node fixture agent, and independently checks `result.txt`.
Expected output includes `State: completed`, a persisted receipt path, and
`Demo passed.`; the command exits 0. It does not change your open project.

Now exercise deliberate validation failure:

```powershell
node "C:/path/to/agent-loop-runtime/scripts/demo-mission.mjs" --fail-validation
```

This creates another temporary fixture. The agent exits successfully but writes
wrong bytes; the independent content gate rejects them. Expect `State: failed`,
`Expected rejection:` and exit 1. This expected negative result demonstrates
that successful agent execution is not equivalent to successful verification.

Each invocation prints `Evidence retained:`. Open that temporary evidence folder
as another editor project to inspect the printed worktree and receipt locations.
Opening only your original project does not permit file links outside its root.
The mission record and receipt are under the fixture repository's
`.agentloop/missions/<mission-id>/`; the worktree contains `result.txt`.
The runtime verifies that the original temporary checkout and its HEAD remain
unchanged and that the worktree changes only `result.txt`. It does not commit the
result, push, create a pull request or contact a model provider. Temporary Git
initialization creates the fixture's baseline commit, with its own local identity
and empty hooks directory. Evidence is retained; inspect it before removing only
the exact disposable folder you chose.

## Opt-in production PTY acceptance on Windows

The editor test `src-tauri/tests/runtime_interoperability.rs` invokes the unchanged
runtime demo through the production `PtyRegistry`/ConPTY path, not a mock terminal.
It requires a trusted, already-built runtime checkout and native Node/Git. Missing
or invalid prerequisites fail visibly when explicitly selected. It never installs
packages, builds the runtime, copies credentials or adds a production IPC route.

From the editor checkout, select **only the parent test**:

```powershell
$env:ONTIXA_RUNTIME_CHECKOUT = "C:/path/to/agent-loop-runtime"
cargo test --manifest-path src-tauri/Cargo.toml --test runtime_interoperability --locked -- --ignored --exact runtime_demo_through_editor_pty --nocapture --test-threads=1
```

Both tests are ignored by default. Do not omit `--exact
runtime_demo_through_editor_pty`: `runtime_fixture_child` is an internal helper
that requires the parent's owned environment, not another user-facing test.
Non-Windows builds do not exercise this Windows-only acceptance.

The supervised child checks prerequisites, snapshots runtime Git HEAD/status and
hashes the demo, manifest and built JavaScript modules before and after. Snapshot
enumeration is limited to 4,096 entries, 1,024 modules and 32 MiB, with batched Git
hashing and a bounded command line. Git inspections have a 30-second limit and
capped output; individual JSON/content reads are capped at 1 MiB.

On Windows, `portable-pty` 0.9 refreshes its base environment from system/user
registry values, which can replace parent-process TEMP/TMP overrides. The test
therefore launches a tiny fixture-owned Node bootstrap through the production
PTY. That bootstrap sets only its own process TEMP/TMP to the explicit owned
directory, restores the demo's original argv (including `--fail-validation`),
and imports the unchanged demo source. It records only TEMP, TMP and Node's
`tmpdir()` before/after, never the full environment. This containment setup is
specific to automated acceptance: the manual commands above use the terminal's
effective temp configuration. No registry, global environment, runtime source
or production PTY behavior is changed.

Two serial scenarios each have a 180-second outer bound, matching the runtime demo
test's existing bound, inside a seven-minute fixture-supervisor limit. PTY output
and parent output are bounded to 1 MiB each. A timeout/output overflow fails and
stops only the still-owned child process tree; evidence is retained.

Acceptance requires actual backend PTY exit codes 0 and 1 respectively, matching
mission/receipt state, exactly one agent invocation, the expected content-gate
result, exact file bytes, unchanged original checkout/HEAD, no remote and only
`result.txt` changed in the worktree. A missing/null backend exit is a failure,
never inferred from a success message. Receipt paths must resolve within the
newly owned fixture before inspection.

This test exercises the editor's production PTY backend, not GUI clicks, session
card rendering or a structured mission UI. It does not prove compatibility with
Codex, Devin or another provider. No successful acceptance run is claimed merely
because the test exists or appears as ignored in the normal suite.

### Initial acceptance observation

The first local run on 2026-09-22 used unchanged runtime commit
`c7843d38bf8405fe33268c6ca94fce41ba33047c`. It failed after 18.41 seconds because
the demo used the registry-selected D-drive temp directory instead of the
parent's owned C-drive fixture. The actual backend exit was numeric 0 and the
demo reported completed with its content gate passing; the harness rejected the
escaped evidence location before independent receipt checks or the negative
scenario. Runtime before/after snapshots matched. This was not a null-exit
failure or proof that the runtime mission failed. Both evidence directories
were retained; no containment check was relaxed to accept the unexpected path.

After adding the test-only Node temp bootstrap, compilation passed in 1 minute
15 seconds and the exact opt-in parent passed once in 8.05 seconds on that same
runtime commit. Both actual backend exit events were numeric: 0 for completed
and 1 for expected validation failure. Independent receipt/content checks passed
for both cases, including unchanged original checkout/HEAD and only `result.txt`
changed in each worktree. Recorded TEMP/TMP/tmpdir values showed the registry
directory before bootstrap and the exact owned fixture afterward; both evidence
trees remained contained. Runtime source/HEAD snapshots were identical before
and after. GNU linker resource-manifest warnings remained nonfatal.

This is Windows production-PTY evidence with the documented fixture bootstrap,
not GUI acceptance, universal temp inheritance or provider compatibility. The
first failed run above remains part of the record.

Final native checks on the unchanged acceptance source also passed:
`cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --locked -- -D warnings`
and `cargo test --manifest-path src-tauri/Cargo.toml --locked`. The normal suite
ran 78 unit tests, 14 backend integration tests and the existing Windows
transport parent successfully. It ignored the two new opt-in tests and the
existing transport helper by design; those ignores are not additional runtime
acceptance passes. The separate exact-parent run above supplies that evidence.
Changed-document Prettier and the new Rust test's formatting checks passed;
no repository-wide frontend formatting cleanup was performed.
