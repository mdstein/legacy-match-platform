# Case popup lifecycle fix 0.2.28

Launcher 0.2.28 contains explicit cleanup for closing a case animation with
Escape after Unlock. It is deployed with matching API/web as
`0.2.28-alpha.20260907.0737`; public verification passed at 07:44:56 UTC on
September 7, 2026. Game-node remains 0.1.26 and does not need an update for
this client change.

## Implementation

The GC patches the two CRC-pinned final-2023 Panorama scripts in memory. A
popup-scoped lifetime tracks animation/timeout schedules and global event
registrations across the case popup and its async action frame. Either close
path cancels and unregisters that work. Callbacks already queued by the host
check the closed state before running; duplicate cleanup is harmless.

The authoritative Unlock operation continues after Escape. The normal reward
reveal and intended tournament-journal transition are preserved. Existing
service medal, practice selection, XP/rank, keyless opening and chat fixes stay
in the same transactionally validated archive patch. All edits are staged and
size-checked before any archive mutation. Leading indentation is reclaimed
without changing ZIP entry lengths, offsets or executable tokens.

No account grants, inventory edits, game-node command, client restart, network
configuration change, profile deduplication, or StatTrak recovery optimization
was performed as part of this fix.

## Verification

- Eight native CTests pass; the real installed final-client archive patches
  successfully. Unknown lifecycle anchors reject the complete patch without
  partial archive changes.
- `node scripts/test-b2g-popup-lifecycle.mjs` executes the real patched JS in a
  mock host retaining closed panels: 390 Unlock/Escape cycles leave zero popup
  timers/events, perform no late UI work and create no unsolicited previews.
- Twenty normal reveal cycles pass. Escape and direct action-close pass at six
  points during opening, including duplicate closes and callbacks already
  queued when the popup closes. Timeout then late response does not revive it.
- The same host with original scripts retains 80 event handlers after 20
  openings and performs work on closed panels. These counts describe the test
  host, not a measurement of native Panorama retention or memory consumption.
- Launcher tests: 83 library tests and the version CLI test pass; one helper
  fixture is intentionally ignored. Embedded native integrity pins pass.
- API typecheck, the current launcher bootstrap contract test, and production
  API/web image builds pass. No dependency or database migration changes.

The native-engine stutter has not been reproduced under a frame/heap profiler.
This release fixes the observed missing explicit cleanup; a real in-game soak
is still needed to determine whether other accumulation remains.

## Artifacts

| Artifact | SHA-256 |
|---|---|
| Launcher 0.2.28, 10,008,576 bytes | `9ce5b2fa978dbd496dc77786b5624d8a6660572921985e9f162d7430ca61feaf` |
| Embedded x86 GC DLL, 1,868,800 bytes | `7df17e7b7bd426f627a4b41aedb1f5576ed4c154580ace882b277568185a46b8` |
| Unchanged x86 wrapper | `d95500518046b730f18586099f55d9827571720d15d0b61d99c319b06e4d94ab` |
| App host 0.2.28-alpha.20260907.0737 ZIP | `f1acb0b4428f674eb1f7ede537bc20b262f7d7d5e6f86e6d7127dae98c39cf1b` |
| API/web image archive | `9042ea9f46148713506fb1a125cafc0b0e548e2c57a3ccfb647558d8279eef8a` |

## Deployment verification

The public [launcher download](https://play.back2go.net/downloads/b2g-launcher-v0.2.28-windows-x86_64.exe)
was fetched and its size and SHA-256 verified against the candidate before
executing its version CLI. Its public checksum sidecar matches. The website
bundle `/assets/index-CW15uJZ8.js` binds `launcherVersion` to 0.2.28 and builds
its download filename from that binding. The verifier initially expected a
release-note string that Vite removes as unused; inspecting and verifying the
actual version binding resolved the assertion. Public API readiness reports
PostgreSQL, Redis and object storage healthy.

Deployment took an idle allocation hold transactionally, backed up PostgreSQL
and release configuration, checked immutable image/archive identities and
retained rollback handling. No migrations were pending. Allocations reopened
at 07:42:19 UTC. The post-release check found node 0.1.26 active with a one-second
heartbeat age, no active leases and its idle instance offline, as it was before
deployment. No game-node stop/start command was issued.

API image ID: `sha256:54d08d6559cb435ef3b293eac39e6cab276bce93c42e8de0a27791d0d4a81310`.
Web image ID: `sha256:baaf993d7fadb4b6e22d29e9c205e896c8bd99cf77e0c553f3cca0b795577af1`.
Database backup: `/var/backups/aftertick/pre-0.2.28-alpha.20260907.0737.dump`,
SHA-256 `c888d463e3cdeac90f3f1d36ed466203e1fa40c2651679737aef8b46fa9c1f45`.
The previous app release and environment remain available for rollback.
Public verification receipt:
`.artifacts/diagnostics/public-popup-release-0.2.28.json`.

## Remaining in-game acceptance

Close the game and old launcher once, run launcher 0.2.28, then press GO to
install/load the new GC. Test full openings and Unlock followed by Escape at
different points in the animation. Confirm each consumed case produces one
retained reward, no old popup reappears, and normal reveals still work. Continue
through several batches and then play Deathmatch without restarting the client;
compare frame times before and after the openings. Check persistence after a
later reconnect. If stutter recurs, capture client frame/thread and memory data
alongside server timing instead of attributing it to a new server backlog.

Service-medal redemption uses the shared async script, so its success, failure
and close behavior should also receive an in-game regression check.
