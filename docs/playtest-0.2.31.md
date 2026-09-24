# Launcher first-run and motion release 0.2.31

Launcher/API/web deployed September 7, 2026, verified at 22:23 UTC. Game node
remains 0.1.28 and the shared GC is unchanged.

Download: https://play.back2go.net/downloads/b2g-launcher-v0.2.31-windows-x86_64.exe

## What changed

- The native launcher follows the supplied ZIP source and live
  `https://b2g-omega.vercel.app/` reference more closely: square-source hero
  framing, secondary map artwork, a decorative default soldier avatar, wider
  header identity strip, clearer rank framing, typography and filled Play icon.
  Play, Trading, Match History and Settings remain the functional navigation.
- Controls animate over 150 ms using the reference's cubic-bezier(.4,0,.2,1).
  The hero scales to 1.05 over 500 ms on hover. A bounded native spinner shows
  actual pending work. Reduced motion keeps these effects static; idle windows
  stop their animation timer. No browser runtime or simulated download progress
  was added.
- The first-run page has one Install action. Steam performs its normal download
  confirmation; B2G monitors real download/staging state, then prepares the game
  files automatically. Partial Steam installations cannot be patched as ready.
  Confirmation, downloading, verification, preparation and failure have distinct
  messages. A Start menu shortcut is created on launcher installation.
- Continue with Steam exposes the matching authorization code in the launcher.
  Steam sign-in/approval uses the trusted browser; new players then choose their
  B2G name and region inside the native launcher. Errors preserve the entered
  name. Cancelled and old-account responses cannot complete a later attempt.
- The device-authenticated onboarding endpoint allows initial profile setup for
  the authenticated owner only. Existing repository name uniqueness and atomic
  one-time completion remain authoritative; this is not a rename route.
  The browser approval page bypasses site onboarding for new launcher users and
  supports retry after a transient failure.

## Verification and limits

- All-workspace production builds and TypeScript checks pass; the JavaScript
  unit suite passes, including native-onboarding authorization and validation.
- 116 Rust library checks and three CLI checks pass. Four child entrypoints are
  invoked through watchdog tests. Existing trading, settings, history, demo,
  console and window-responsiveness regressions remain covered.
- First-run fixtures cover missing/installing/ready/error states, signup,
  cancellation, old-account responses and partial Steam downloads/staging.
  The real offscreen HWND journey uses WM_CHAR input, native Tab traversal,
  immediate validation invalidation and footer submission to a test API.
- Native mouse/timer traces show changing hover colors, distinct hero and
  loading frames, idle timer shutdown and static reduced-motion behavior.
  These are bounded fixture measurements, not a physical mouse or FPS benchmark.
- Two browser E2E journeys pass: new-user launcher approval without site
  onboarding, and malformed-code prevention plus retry after 503. Desktop and
  mobile authorization surfaces pass the accessibility scan.
- The independent review scored F1–F6 resolved: XP clipping, validation/footer
  submission, setup motion, install copy, native semantics and authorization
  recovery. The verdict is scoped to those corrections. Native captures use
  injected state and a test API, with the size/DPI matrix rendered offscreen.
- The public executable was downloaded and its bytes, checksum and reported
  version verified. Website release binding and signup copy match. Protected
  onboarding/account/history routes return 401 without device credentials;
  PostgreSQL, Redis and object storage readiness pass.

Actual Steam installation and first-time Steam approval with a new account are
the remaining acceptance tests. Run the downloaded executable by double-clicking
it, choose Install, approve Steam's download dialog and let B2G finish setup.
Use Continue with Steam, approve the matching code, then create the native B2G
profile on the alternate account. Existing cubsfan49 skips initial name creation.
Check the hover effects and loading behavior on the physical display, then Play.
The earlier gameplay, trade, long-unboxing soak and monitor-transition checks
remain in the previous release notes; no new 5v5 result is claimed.

## Release integrity and rollback

| Artifact | SHA-256 |
|---|---|
| Launcher, 11,387,904 bytes | `ba87375f41f6af5583ad2ac3f9efbf17a15a43fabae141c6a7e1a4d9c18b948c` |
| Shared GC, unchanged | `d6fccb8aa127022bdb6a5eecdd80e33ab4e872ede9afc25ba7bc73a442a2a22a` |
| API/web image archive | `6e63b0429d5687862a38e6cafb0e3dccee77267f6570799bb5e972e00b76db4c` |
| App-host ZIP | `9a8db520fced54ae37c1820e26ea6838d9e3271fe249c519a3758db223b61b63` |

Active release: `/opt/aftertick/releases/0.2.31-alpha.20260907.2215`.
API image: `aftertick-api:b2g-20260907-2215`, ID
`sha256:6669282bce9df69d86a65f26c6722b40fe643a31749f08b2cae23f8449ee3063`.
Web image: `aftertick-web:b2g-20260907-2215`, ID
`sha256:d86d2a91f052511f611c46550367295fcc1e92bd55914ef5b34eb81b7b051aea`.
Public web asset: `/assets/index-OgJNTo8A.js`.

The deployment proved compose topology and migration files unchanged and
replaced only API/web using `up -d --no-deps --wait`. Database, Redis, tunnel
and game-server processes were not restarted by the rollout. No schema or
account progression migration was needed. A verified pg_dump backup is at
`/var/backups/aftertick/pre-0.2.31-alpha.20260907.2215.dump`, SHA-256
`5912ff916eafdced04304ae1a2de1451a6111f0473085c967a800dfb4704187b`.

Rollback target is the compatible 0.2.30 API/web release and saved release.env.
Do not return to a pre-033, 5,000-XP API or restore a database backup over new
inventory activity. The deployment wrapper restores the old pointer/environment
and API/web containers on failure, without restoring the database.

## Owner's clean-install test

The authorized local reset uses `scripts/reset-local-b2g-playtest.ps1`: it
validates standalone App 4465480 paths, closes verified game/launcher processes,
shuts down Steam, then re-enumerates settings/demos so exit-time writes are
included. Every preserved file is hash-verified in a separate backup before
game deletion, then restored at its original relative path without the game
executable or installation manifest. It removes B2G's installed bin, shortcut
and protocol registration. Steam userdata and other B2G settings/demo storage
remain in place. It does not remove Steam, CS2, other games or online inventory.

The downloaded release executable remains available to start the installation
test. The reset receipt and per-file preservation receipt are local artifacts;
personal settings and demo backups are excluded from Git.
