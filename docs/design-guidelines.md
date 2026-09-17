# Design Guidelines

- **Dark theme first.** Palette tokens in `src/styles.css` (`--bg`,
  `--accent`, …). No hardcoded colors in components — new themes slot in by
  overriding tokens.
- **Dense and quiet.** 12–12.5 px UI text, monospace for anything
  path/code/terminal. Borders over shadows; no rounded-card soup.
- **View-first.** Editors open read-only. Editing affordances exist but
  don't compete with reading.
- **Status over chrome.** Information lives in the status bar, badges, and
  the activity timeline — not modals.
- **Keyboard-first, mouse-friendly.** Every command has a shortcut or a
  palette entry; every panel is clickable.
- **No VS Code imitation.** Sidebar tabs are text tabs, not an activity
  bar; the top bar is a single thin strip; branding is the `▸_` mark.
