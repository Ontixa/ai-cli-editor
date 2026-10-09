# Find in Terminal

Use **Find** in the terminal header or **Terminal: Find in Terminal** in the
command palette. The command is available only for the selected, visible
terminal with an existing buffer. An exited terminal remains searchable.
Opening Find never starts or restarts a terminal.

Search is case-insensitive, literal text. Spaces and punctuation are retained;
`.*` searches for those two characters. Type a query, then press **Enter** or
**Next match**; **Shift+Enter** or **Previous match** searches backward. Both
directions wrap. The selected match is highlighted and scrolled into view.
There is no regex, replacement, result count, or search across terminals.

**Escape** or **Close terminal find** removes the search selection and focuses
the same terminal if it is still active. Find input stays separate from shell
input. `Ctrl+F` keeps its shell meaning. The existing workspace search and
command-palette shortcuts remain available.

## Scope and changes

Find reads xterm's current rendered buffer. Normal terminals include their
retained scrollback (currently up to 8,000 scrollback rows); trimmed history
cannot be recovered. Full-screen programs may use an alternate buffer, where
Find searches only that screen. ANSI escape sequences are interpreted by the
terminal, not searched as raw output. Soft-wrapped logical lines and Unicode
cell positions are handled by the official xterm search addon.

Typing a new query clears the prior search result. Output, resizing/reflow, or
switching buffers invalidates the result and clears the search selection;
**Buffer changed · search again** means the next explicit navigation starts a
fresh search. These updates do not pick another match, move focus, or scroll
to another result. A manual terminal selection that replaced the search
selection is not cleared by Find.

Find is transient: switching terminal/project tabs, hiding the panel, or closing
the terminal closes Find and resets the query. Existing terminal scrollback
retention is unchanged. Search terms and results are never persisted or sent
to the backend.

## Implementation and validation

The terminal manager resolves only existing attached terminal records. Search
owns its addon, invalidation listeners, and selection for that record's current
Find session. Closing Find disposes them before terminal teardown. No terminal
launch, PTY input, filesystem, Git, provider, or network operation is part of
search.

`@xterm/addon-search` is pinned to **0.16.0**, alongside the existing
`@xterm/xterm` **5.5.0**. The addon's [published README](https://github.com/xtermjs/xterm.js/blob/6.0.0/addons/addon-search/README.md)
states xterm v4+ support. Version 0.16.0 also owns and disposes its
[line-cache timer and listeners](https://github.com/xtermjs/xterm.js/blob/6.0.0/addons/addon-search/src/SearchLineCache.ts).
This narrow dependency avoids a custom Unicode/wrapped-line search engine and
does not upgrade the terminal. Only the active selection is used: no capped
all-match decorations, count claims, or automatic output-driven searching.

Unit tests cover ownership, invalidation and keyboard behavior. The dedicated
browser fixture uses the exact installed addon/terminal pair, real Chromium,
production UI and a strictly mocked Tauri bridge with synthetic output.
It does not launch a shell or read a user workspace.

```bash
npm run check
npm run build
```

The dedicated CI workflow installs official Chromium and runs
`npm run test:browser:terminal-find` against the exact source revision. See
[fixture validation and developer reproduction](../tests/browser/README.md).

Browser coverage includes literal/spaced queries, wrapped Unicode, forward and
backward navigation, actual focus/highlighting, output invalidation and
terminal/project lifetime changes. The repository separately checks native
compilation and Rust tests; native Tauri/WebView interaction has not been
manually validated for this feature.
