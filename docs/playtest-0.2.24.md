# Practice skins and responsiveness release 0.2.24

Deployed 2026-09-07 UTC. This is the first implementation from the
[responsiveness plan](responsiveness-implementation-plan.md), following the
owner's confirmation that unboxing and StatTrak credit worked on node 0.1.23,
with a remaining 1–2 second visible counter delay.

## What changed

Practice with Bots creates a listen server in the client process. It was being
treated as a managed dedicated server and expected a signed online-match
inventory policy that local practice does not receive. The new GC accepts the
paired local owner's sanitized, owned loadout for this local session. Other
owners cannot use this path; dedicated authority is unchanged. Practice kills
do not award persistent online StatTrak, XP or items.

Server inventory/counter callbacks also truncated the recipient Steam ID from
64 bits to 32 bits. The networking layer now receives the complete identity.
This explains a possible direct-delivery failure that periodic launcher
inventory refresh could conceal; the old production delay was not measured
end to end, so its exact contribution remains unquantified.

Kill ingestion now runs independently of the 2-second health heartbeat, with a
default 100 ms interval, serialized state, bounded appended-byte reads and
retry-safe durable cursors. Signed API receipts carry committed absolute counts
to a small node-written file; GC checks for changes every 100 ms and delivers
count changes without requiring a full loadout refresh. Counts continue saving
during play. Duplicate ingestion does not grant kills twice, and full inventory
refresh remains a recovery path. Older clients retain the existing count-message
protocol; the practice fix requires the new client DLL.

The node task now uses priority 5 (Normal), and the SRCDS launch helper explicitly
sets the child process to Normal. The live process was verified as Normal.
There were no changes to tick rate, bot population rules, SMAC/evidence, player
occlusion, GOTV/demos or progression rules.

## Published and installed

| Component | Verified release |
| --- | --- |
| API and website | `0.2.24-alpha.20260907.0240` |
| Public launcher | `b2g-launcher-v0.2.24-windows-x86_64.exe` |
| Windows game node | `0.1.24`, running as LOCAL SERVICE |
| Match plugin | `0.1.6`, all configured plugins load |
| Matchmaking | Reopened 03:17:21 UTC; node active, instance ready, fresh heartbeat and reachable RCON |

Public download:
<https://play.back2go.net/downloads/b2g-launcher-v0.2.24-windows-x86_64.exe>.
Downloaded again through public HTTPS and verified against the staged executable:

- Launcher SHA-256: `7d23e9ff4579bdfe49a890d8d356fedba9e1a7e5d696cfcd3b03e616816c49fa` (9,810,944 bytes).
- GC DLL SHA-256: `e67e9a50354edc6da7ce45bb6ba14f01b278df7d448e9be60d9bdd23dbd3a56f`.
- Node ZIP SHA-256: `b6ac3810add6da5273ccad84d686e9ff47a4bf6fdfce36e82bac309295dfb6fa` (28 verified files).
- API image: `aftertick-api:b2g-20260907-0240`, image ID `sha256:04202c218ced6ef89f81c2555850d1888bb60274dc25383a8eca0417d269d652`.
- Web image: `aftertick-web:b2g-20260907-0240`, image ID `sha256:512a7740a48d0723a6a3e0b43672268927ecc241d2b94b8b301804afd0aac1a3`.

The deployment held the idle node in maintenance and did not interrupt an active
match. The server started under control-plane command
`9d1abedc-5793-4806-ac33-63c43929974f`, which completed before reopening. RCON
confirmed the archived-compatible server build, MetaMod, SourceMod, match
control, direct-connect support and SMAC, with zero humans connected. Public
API readiness confirmed PostgreSQL, Redis and object storage.
The new launcher's authenticated account check also confirmed that the live API
advertises release 0.2.24 and the corresponding release notes.

## Verification completed

- API/node TypeScript builds and affected unit suites passed, including
  separate node rate limits and the terminal-result/XP race during a heartbeat.
- Real PostgreSQL integration: 11 files, 52 tests passed, including signed
  counter receipts, exact duplicate recovery, conflicts and bot kill credit.
- Native x86 MSVC build and full CTest suite: 8/8 targets passed, including
  local-practice isolation, 64-bit recipient delivery, fenced counter receipts,
  stale-snapshot reconciliation and final-2023 Panorama archive compatibility.
- Launcher Rust tests: 77 library tests passed, one intentional child helper
  ignored, and the CLI integration test passed. Native window watchdog passed.
- Full platform integration passed: ten fixture sessions, native map selection
  and ready check, real SRCDS/SourceMod, agent restart with server continuity,
  no-show cancellation, signed events/results, exactly-once rating and XP,
  XP presentation before drain, GOTV upload and independent demo analysis.
  Forced SRCDS failure was detected in 1,474 ms with the expected recovery
  incident. This is a lifecycle fixture, not a human 5v5 playtest.
- Launcher and node release integrity checks, Windows installer validation,
  installed native hashes, task state, actual SRCDS priority, and public
  launcher download checksum passed.

## How to test this build

1. Close CS:GO and the previous launcher. Run the new downloaded executable, or
   from the repository:

   ```powershell
   .\apps\web\public\downloads\b2g-launcher-v0.2.24-windows-x86_64.exe ui
   ```

2. Press **GO** to prepare the current client files and launch the game. Keep
   this launcher open while playing. The running game was not replaced or
   restarted automatically during this deployment.
3. Equip an owned skin for each team, then start **Practice with Bots**. Check
   both teams, changing a loadout, restarting/changing maps, and then returning
   to online Deathmatch.
4. In Deathmatch, use an owned B2G StatTrak weapon. Observe one kill, rapid kills,
   switching away and back, death/respawn, then reconnect and complete a match.
   Confirm the count is retained and neither drops nor increments twice. Compare
   the visible delay with the previous 1–2 seconds.
5. Recheck unboxing wording/colors and XP presentation. Automated coverage
   protects these paths, but final-client presentation still needs observation.

## Remaining work

Practice skin rendering and the actual kill-to-visible-counter latency have not
yet been observed by a human on this release. No sub-100 ms result is claimed.
The two 100 ms scheduling intervals are polling settings, not an end-to-end
latency guarantee. Correlated delivery/render timing, sustained frame-time and
host profiling, and the wider presentation/reconnect matrix remain in the plan.
Server-confirmed provisional display is conditional on those measurements and
has not been implemented. Human 5v5 remains a separate capacity/gameplay gate.

## Rollback evidence

- Previous API/web pointer: `/opt/aftertick/releases/0.2.18-alpha.20260905.2110`.
  Previous image tags remain on the host.
- Protected environment backup:
  `/etc/aftertick/release.env.pre-0.2.24-alpha.20260907.0240`.
- Verified pre-release database dump:
  `/var/backups/aftertick/pre-0.2.24-alpha.20260907.0240.dump`.
  No pending database migrations were applied.
- Windows backup:
  `C:\ProgramData\Aftertick\backups\before-node-0.1.24-20260907T030453Z`.
  The prior node release, service/task, native files, addons and configuration
  were retained; credential backups remain only in the server's protected
  secrets directory.
- Local non-secret installation report:
  `.artifacts/releases/game-node-0.1.24-installed.json`.

Rollback requires holding an idle node in maintenance, restoring the coordinated
previous API/web and node/native versions, verifying health and reopening. Never
replace the DLL of an active human game session.
