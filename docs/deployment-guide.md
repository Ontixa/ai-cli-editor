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

Outputs land in `src-tauri/target/release/bundle/` (`.msi` + NSIS
`-setup.exe` on Windows, `.dmg`/`.app` on macOS, `.deb`/`.AppImage` on Linux).

### Signing local builds

`tauri.conf.json` configures the updater plugin with a minisign pubkey. To
produce signed updater artifacts locally:

```bash
TAURI_SIGNING_PRIVATE_KEY_PATH="$HOME/.tauri/ai-cli-editor.key" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" \
npm run tauri:build
```

`.sig` files appear next to the installers. The private key lives outside the
repo — never commit it.

## Publishing a release (GitHub Actions)

1. Ensure `tauri.conf.json` `version` equals the intended release version.
2. `git tag v0.3.0 && git push --tags`.
3. `.github/workflows/release.yml` verifies tag == version, builds on
   `windows-latest`, signs with `TAURI_SIGNING_PRIVATE_KEY`, and publishes a
   GitHub Release containing the installers, `.sig` files, and `latest.json`.

Required repo secrets:

- `TAURI_SIGNING_PRIVATE_KEY` — contents of `~/.tauri/ai-cli-editor.key`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — key password (empty string if none)

The in-app updater reads
`…/releases/latest/download/latest.json`, verifies the minisign signature,
then installs via the NSIS installer in passive mode.

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
