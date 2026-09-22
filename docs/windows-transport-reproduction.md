# Windows command transport reproduction

Local reproduction on 2026-09-22, based on `c331105`, branch
`fix/windows-command-transport`. Production transport was unchanged.

Command:

```text
cargo test --manifest-path src-tauri/Cargo.toml --test windows_transport --locked -- --nocapture --test-threads=1
```

Result: exit 1, expected regression failure. The fixture child ran 30 real
production `PtyRegistry`/ConPTY cases in 7.37 seconds; 11 matched and 19 failed.
All five native Node controls matched exact child-observed JSON argv, without
sentinel side effects. No timeout occurred. The parent removed its uniquely
owned temporary fixture directory after collecting the result.

| Launcher                       | Ordinary / empty / spaces | Embedded quotes / backslashes | Variables | Ampersand | Pipe     |
| ------------------------------ | ------------------------- | ----------------------------- | --------- | --------- | -------- |
| Native Node                    | Match                     | Match                         | Match     | Match     | Match    |
| Ordinary `.cmd`, unspaced path | Match                     | Match                         | Expanded  | Sentinel  | Sentinel |
| Ordinary `.cmd`, spaced path   | Corrupted                 | Corrupted                     | Expanded  | Sentinel  | Sentinel |
| Ordinary `.bat`, unspaced path | Match                     | Match                         | Expanded  | Sentinel  | Sentinel |
| Ordinary `.bat`, spaced path   | Corrupted                 | Corrupted                     | Expanded  | Sentinel  | Sentinel |
| Synthetic npm-shaped `.cmd`    | Match                     | Match                         | Expanded  | Sentinel  | Sentinel |

The variable input was `[%ONTIXA_TRANSPORT_MARKER%, !ONTIXA_TRANSPORT_MARKER!]`.
Every batch case observed `[fixture_expanded_value, !ONTIXA_TRANSPORT_MARKER!]`
instead. Only the fixture subprocess received that environment variable; no
host/global environment or delayed-expansion setting changed. This does not
prove exclamation syntax safe under other shell settings.

For `a&echo>operator-sentinel.txt&rem` and `a|echo>pipe-sentinel.txt`, every batch
case observed only `a` and created the corresponding harmless sentinel in its
own temporary cwd. Native Node observed the entire literal argument and created
neither sentinel.

Spaced `.cmd` ordinary input `["plain", "", "two words"]` became
`["with", "spaces.cmd plain \" two", "words"]`; `.bat` behaved analogously.
These fixtures also had an unspaced `launcher.cmd`/`launcher.bat` sibling. The
observation demonstrates a command/path parsing failure, not a universal result
for every spaced path. Isolated spaced-path coverage remains required before
accepting any proposed fix.

The synthetic npm-shaped fixture retains the familiar batch control flow but
substitutes an absolute known Node executable and an absolute local probe path.
It is **not** evidence that an exact real npm template has been recognized.
Any Node-direct implementation must separately test exact supported templates
and reject altered/unknown scripts instead of using a partial regex.

The first fixture responded to an accumulated ConPTY cursor query on subsequent
output chunks as well. Controls still completed, but that test-terminal behavior
should be corrected to one response per observed query before acceptance runs.

No authenticated provider, network request, registry edit, security-policy change,
or production transport modification was involved. PowerShell `.ps1` transport
was not tested and remains a separate contract.
