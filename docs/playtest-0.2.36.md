# B2G launcher 0.2.36 — remove B2G while keeping CS:GO

Settings → Installation provides Install CS:GO when absent, Repair game
integration, and Uninstall B2G. Confirming uninstall restores the original
Valve executable and removes the managed B2G GC. The launcher then closes;
a hidden helper removes the installed launcher, Start-menu shortcut and
`b2g://` registration. Steam's CS:GO, local settings, demos, equipped loadout,
saved shuffles and account data remain. Server-side items are unchanged.

To test reinstalling, close CS:GO, use Uninstall B2G, then download and run
the current launcher from the site. Pressing Play installs the integration
again using the existing game files. No game download is required.

Removal validates original backups and managed files before mutation, rejects
linked paths and another running installed launcher, and rechecks launcher
identity before deleting it. Game-running and installation states block the
action. A failed preparation leaves the launcher open with an error; a failure
after launcher exit produces a Windows message and `B2G/logs/uninstall.log`.

## Verification

- All 124 Rust library tests and four executable tests passed; five existing
  opt-in tests remain ignored.
- The remove/reinstall fixture preserves Steam metadata, configuration, demos,
  saved loadout and shuffles, restores the original Valve executable, removes
  the transient inventory manifest and successfully reinstalls the GC.
- The actual PowerShell helper removed only named files in an isolated fixture,
  preserved personal data, cleaned its handoff files, and rejected an executable
  changed since preparation. The test substitutes a filesystem HKCU drive and
  does not alter the user's registry or installation.
- The real Windows-account launcher registration preflight and installed game
  integration dry run passed. No actual user uninstall was performed.
- Installed, missing-game, game-running and removing UI states were rendered at
  two sizes and three DPI scales; compact states were visually inspected.

The GC DLL and game wrapper are unchanged from 0.2.35, retaining the skin-loadout
and startup fixes. This launcher-only rollout does not update the API or game node.

## Release

- Public download: https://play.back2go.net/downloads/b2g-launcher-v0.2.36-windows-x86_64.exe
- Launcher: 11,515,392 bytes; SHA-256
  `c83b191a0d48ae18dbb448a4d2957bc9cac78df09c705fe5c70180405ebe9091`.
- Hosted release: `/opt/aftertick/releases/0.2.36-alpha.20260908.0515`.
- Web image: `aftertick-web:b2g-20260908-0515`, ID
  `sha256:9a28242619eac659dde6427a8f416b48bcdfb3688dd2c3866ff5654c98636bff`.
- Public executable bytes/checksum/version, website release binding, protected
  routes and readiness passed at 05:14 UTC. Receipt:
  `.artifacts/diagnostics/public-uninstall-release-0.2.36.json`.

The rollout validated archive/image checksums, preserved the previous web
release for rollback, and verified the API container was not replaced. The
user's running launcher and CS:GO session were not stopped for this release;
download 0.2.36 and open it after closing those applications to test the button.
