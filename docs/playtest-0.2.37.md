# B2G launcher 0.2.37 — remove obsolete B2G backups

The real uninstall test found that earlier upgrades could save a previous B2G
GC DLL as `.b2g-original`. Uninstall then restored that DLL, leaving part of B2G
behind. The launcher now recognizes exact known B2G versions, avoids creating
those false originals during upgrades, and removes existing managed backups
during uninstall. Genuine unrelated original files are still restored.

Two new regression tests cover the observed failure, managed upgrades,
interrupted removal and preservation of unrelated originals. The full final
launcher suite passes: 126 library plus four executable tests, with five
existing opt-in fixtures ignored.

The actual installed B2G removal/reinstall passed with Steam CS:GO retained and
104 preserved files verified. The subsequent game startup loaded the correct
ICU and GC DLLs, published all 172 owned items and authenticated the local
bridge. The launcher is installed locally and was reopened after testing.
See the [complete test report and remaining checks](playtest-validation-2026-09-08.md).

## Published release

- Download: https://play.back2go.net/downloads/b2g-launcher-v0.2.37-windows-x86_64.exe
- Launcher: 11,518,464 bytes; SHA-256
  `cfa528528d0ed67bc421a30a3f53e6072a33d2fe9590f1a65dc33787be2063e8`.
- Hosted release: `/opt/aftertick/releases/0.2.37-alpha.20260908.0630`.
- Web image: `aftertick-web:b2g-20260908-0630`; ID
  `sha256:3d25b2b8887ce52913539a6a61ad0d4a2c17b894830e92544c7b30e7aad4a170`.
- Website asset: `/assets/index-QBhPY22A.js`.
- Public bytes/checksum/version, website binding, protected routes and readiness
  passed at 06:32 UTC; receipt:
  `.artifacts/diagnostics/public-uninstall-release-0.2.37.json`.

The GC DLL and wrapper remain unchanged from 0.2.35. The rollout preserved the
previous web release for rollback and verified the API container was unchanged.
API remains the 0.2.33 deployment; game node remains 0.1.28.
