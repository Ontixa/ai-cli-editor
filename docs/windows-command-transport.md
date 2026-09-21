# Windows command transport

Quick launch accepts an executable plus an argument vector. That vector is not
an instruction to interpret shell operators. Windows batch files add a separate
`cmd.exe` parser, so they need a narrower contract than native executables.

## Supported npm Node shims

The editor recognizes one complete npm `.cmd` template, represented by
`src-tauri/tests/fixtures/npm-node.cmd`. LF and CRLF line endings are accepted;
extra comments, lines, commands, flags, changed spacing or other templates are
not treated as equivalent. Recognition reads at most 32 KiB.

The only variable template field is a relative script path below `node_modules`.
Its components allow ASCII letters, digits, `@`, `_`, `-` and `.`, but no empty,
`.` or `..` components, trailing dots, shell syntax, absolute paths or alternate
data streams. The existing script must resolve inside the shim's directory;
symlinks escaping that directory are rejected. This includes `npm link` layouts
whose linked package resolves outside the shim directory; they need another
supported launch method rather than silently bypassing the containment check.

For a recognized shim the editor runs native `node.exe` directly, with the script
path followed by the original argument vector. A sibling `node.exe` takes
precedence; otherwise the editor resolves `node.exe` on PATH. A missing or invalid
native Node target is an error, not a fallback to shell interpretation. This path
supports spaced installation directories and literal shell metacharacters in
arguments. It does not install Node or invoke an authenticated provider to probe it.

The chosen executable and script contents remain trusted code that the user has
chosen to run. Template/path checks are not a sandbox or race-resistant filesystem
boundary: files can change between inspection and launch. This change does not
claim protection against concurrent replacement, and adds no junction/symlink-race
test. Existing canonical path checks reject an already-resolved escape, not a
future replacement.

## Other batch files

Unrecognized `.cmd` files and `.bat` files keep their batch semantics; they are
never guessed to be Node scripts. Their program paths must contain no whitespace.
Both paths and arguments must use only ASCII letters, digits, space and
`_ . / \ : = + -` (spaces are permitted in arguments, not program paths).
Empty arguments are permitted. Shell expansion, escaping, grouping, quotes,
control characters and other characters are rejected before opening a PTY or
creating a child process.

Allowed batch launches use `cmd.exe /d /v:off /c`: AutoRun and delayed expansion
are disabled for this child only. No registry or global shell settings change.
This restricts argument transport; it does **not** assert that arbitrary batch
file contents are harmless or prevent an explicitly launched script from running
its own commands.

For an unsupported launch, use a native executable, an unmodified supported npm
shim, or enter the command intentionally in an interactive shell. The editor does
not claim universal batch quoting or silently reinterpret an unknown script.

## Scope and verification

Unix command handling and the existing PowerShell `.ps1` wrapper are unchanged.
Batch results do not establish PowerShell transport safety.

The Windows acceptance fixture uses the actual production PTY path and compares
JSON arguments written by the child process. It includes native Node controls,
exact npm templates in spaced and unspaced locations, sibling/PATH Node selection,
altered templates, restricted batch success and rejection with no child side
effects. It needs native Node on PATH and a non-spaced temporary parent for the
unspaced batch cases. All scripts, output and harmless sentinel files are confined
to its uniquely owned temporary directory. See the
[original reproduction](windows-transport-reproduction.md) for the pre-fix result.
