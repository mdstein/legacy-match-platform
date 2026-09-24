# B2G 0.2.38 — launch recovery after switching accounts

The alternate-account launch exposed two independent blockers. FACEIT's desktop
overlay was still running, while the launcher footer hid that explanation behind
a generic failure. After FACEIT was closed, the real retry failed with HTTP 409:
the API required a fresh public Steam inventory even to play with stock equipment
and B2G-owned items.

The API now permits those sessions when Steam inventory is empty, private, stale
or unavailable. Imported Steam skins still require verified ownership; stale or
private Steam items are excluded and cannot be selected through the loadout API.
A valid linked Steam account and authenticated launcher session remain required.

The launcher now gives direct FACEIT exit instructions, changes Release Notes to
Launch Help after a launch error, and opens the actual failure at the top of that
window. Inventory errors retain the server's explanation with bounded response
size and displayed length.

## Verification

- PostgreSQL integration: 97 tests in 15 files passed, including empty inventory,
  HTTP 403/404/502, stale/private snapshots, and exclusion of unverified Steam items.
- Native launcher: 127 library and four executable tests passed; five existing
  opt-in tests remain ignored. Recovery state, accessible button caption, error
  body and size/DPI text metrics are covered.
- Native render fixtures for the footer and Launch Help window were inspected;
  the scoped UI detector returned no findings. Live desktop automation was
  unavailable, so no physical click or gameplay visual acceptance is claimed.
- Production API and web builds passed. The rollout verified unchanged migrations
  and Compose topology, created a database backup, and retained rollback images.
- Public executable bytes, checksum, reported version, website version binding,
  six protected-route authorization checks, and API readiness passed at 17:21 UTC.
- Real Play with the user's newly connected account succeeded on installed
  0.2.38: one owned item activated, CS:GO started, the game window was reported
  ready, and the local bridge authenticated the same Steam account. The process
  was responsive and loaded the expected CS:GO ICU, Steam API and B2G GC DLLs.
  The game was left running for the user.

Evidence is under `.artifacts/launch-failure-20260908/`; the public receipt is
`.artifacts/diagnostics/public-launch-recovery-release-0.2.38.json`.
The earlier [full validation report](playtest-validation-2026-09-08.md) still
applies to unrelated features. Human gameplay, the extended unboxing performance
soak, and a completely absent-game Steam download remain unverified.

## Published release

- Download: https://play.back2go.net/downloads/b2g-launcher-v0.2.38-windows-x86_64.exe
- Launcher: 11,525,632 bytes; SHA-256
  `0fa051a3f7d854ddd6cdd150650314a54b41ac7cc79a034e647baffe32d75aa4`.
- Hosted release: `/opt/aftertick/releases/0.2.38-alpha.20260908.1705`.
- API image: `aftertick-api:b2g-20260908-1705`; ID
  `sha256:700b04fd67ff1c959d7c1a951643233cb7cbbe98dd3f238eb3425e2120b4f19b`.
- Web image: `aftertick-web:b2g-20260908-1705`; ID
  `sha256:bd384f65ca7cd8007843ce00f17e3e72143f886ddf841940fd3f14c5938efa09`.
- Website asset: `/assets/index-CljlY7Bi.js`.

The updated launcher is installed locally. The native GC/wrapper, game node
0.1.28, Steam installation, settings, demos and existing account items were
preserved. No database migration was needed.
