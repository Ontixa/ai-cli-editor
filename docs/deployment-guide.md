# Deployment / Build Guide

## Local dev

```bash
npm install
npm run tauri:dev
```

## Release build

```bash
npm run tauri:build
```

Outputs land in `src-tauri/target/release/bundle/` (`.msi` on Windows,
`.dmg`/`.app` on macOS, `.deb`/`.AppImage` on Linux).

## Platform notes

- **Windows 11** is the primary target: WebView2 ships with the OS, ConPTY
  powers terminals, default shell is `pwsh` → `powershell` → `cmd`.
  `.cmd`/`.bat`/`.ps1` agent shims are wrapped automatically.
- **macOS**: default shell from `$SHELL` (zsh). Shortcuts use `Cmd`
  (`Mod` in the registry maps to it).
- **Linux**: needs `libwebkit2gtk-4.1-dev` et al. — see
  <https://v2.tauri.app/start/prerequisites/>. CI installs them on Ubuntu.

## Icon regeneration

```bash
node scripts/make-icon.mjs   # writes src-tauri/icons/icon.png
npx tauri icon               # regenerates the full icon set
```
