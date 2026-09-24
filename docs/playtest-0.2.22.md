# Initial private-playtest readiness: launcher 0.2.22 / node 0.1.23

**WITHDRAWN after human startup testing on 2026-09-07 UTC.** Launcher 0.2.22
deadlocks during native control redraw after account refresh. Do not test or
distribute it, or deploy the 0.2.22 website image containing it. The readiness
designation below is superseded by [the 0.2.23 startup fix](playtest-0.2.23.md).
The old artifacts remain unchanged for investigation. Node 0.1.23 is unaffected.

Prepared 2026-09-07 UTC (2026-09-06 in Chicago). The controllable engineering
readiness goal is complete: findings are fixed, scoped checks pass, fixture
process exit is verified and the coordinated candidate is prepared for external
acceptance. It has not been installed on the user's client, published, or
deployed to production.

## Goal and completion boundary

Finish the initial-playtest implementation, polish the existing launcher and
setup flows, fix controllable defects, verify the source and release packages,
and leave a coordinated candidate ready for gameplay acceptance. Actual human
5v5, multi-machine Steam parties, Steam Guard, visible game/desktop behavior,
unavailable VPS access and owner decisions are external acceptance gates.
They are prepared below and do not prevent completing the engineering goal.

Completion requires all controllable blocking findings resolved, fresh checks
passing, immutable versioned artifacts and checksums, safe install/rollback
instructions, and clear evidence limits. Signing and automatic updates remain
outside the accepted unsigned private-alpha scope.

## Changes in this candidate

- Shared release metadata drives the website download, guide, API launcher news
  and node source version. The node build injects the selected archive version;
  its `--version` and heartbeat now report the actual release.
- The setup guide explains Connect Account → GO → queue in CS:GO, Competitive
  acceptance and automatic Deathmatch connection. Advanced commands are a
  disclosure. Clipboard failures have recovery text, copy success waits for the
  real result, Escape restores focus, and the guide fits a 320-pixel viewport.
- The native launcher keeps its existing dark Rajdhani dashboard. Closing it
  while starting/running a game explains why it must remain open. Minimize still
  works. Starting/repairing/uninstalling refuses to modify a running game.
  A live connect handoff permits an already-current GC and refuses drift.
- Closing a session releases only its exact searching ticket. Redis atomically
  preserves replacement tickets, ready checks, accepted matches and assignments.
  Any closing party member can release its searching group. Cleanup retries and
  reports failure; it never pretends an unconfirmed cancellation succeeded.
- Uninstall checks every managed file and reads backups before changing files.
  A missing original backup or changed config fails before removal. An original
  can be restored even if a failed prior update left its target missing.
- The node installer validates requested version, safe manifest paths, file
  count, sizes, hashes and existing release contents before activation. It
  refuses running SRCDS instead of force-killing it. PowerShell hashing uses
  built-in .NET, avoiding a missing optional module dependency.
- Versioned packaging refuses to overwrite older archives/executables. Node
  packages include module metadata. Current-source tests exclude archived
  `.artifacts`, vendor and skill trees, so historical tests do not inflate counts.
- The native latency fixture can explicitly suppress expected CLI error dialogs;
  ordinary launcher error dialogs remain enabled.
- The full-platform fixture requires a vacant, workspace-local loopback server.
  Its finalizer stops agent restarts, quits the authenticated fixture server and
  verifies process exit and port closure. Cleanup holds a process handle, checks
  the exact executable and creation time, and never kills an old saved process ID.

The GC protocol/inventory implementation is unchanged from the 0.2.20/0.2.21
candidate. Complete inventory handoff, incremental cache updates, keyless normal
and quick opening, New acknowledgement, revision retry/order, CT/T loadouts,
Trade Ups, sprays, owned-item StatTrak and drop-chat rules retain their existing
contract coverage. This is not evidence of how they look during live gameplay.

## Exact local candidate

| Artifact | Version / SHA-256 |
|---|---|
| `apps/web/public/downloads/b2g-launcher-v0.2.22-windows-x86_64.exe` | 0.2.22; 9,802,752 bytes; `383b60419a5c0e64ad49b19bf1309e79ae783c4a0de0776b7bebe8443fa7a71c` |
| `.artifacts/game-node/aftertick-game-node-0.1.23.zip` | 0.1.23; 1,305,673 bytes; `c36020e8b4035f19e55cb6548aea47e86757afd4b635b111f5902c94cc23b799` |
| Embedded/bundled `csgo_gc.dll` | `bcd9ae594d564c08d1e8de3b48e1d357412c1e4d36f2cf98d88b7e2b0a2637aa` |
| Client wrapper `csgo.exe` | `d95500518046b730f18586099f55d9827571720d15d0b61d99c319b06e4d94ab` |
| Server wrapper `srcds.exe` | `af53aee4cd14667b2ecad6dc25a2e1d9a6a4d38222b2dee961b13ba0a8541764` |
| `.artifacts/app-host/aftertick-app-images-0.2.22.tar` | 208,263,680 bytes; `11cc46f598a5c5b91ad5c0dcb1bf3c0e224715a0dd568586fadf432f1bc535b2` |
| `.artifacts/app-host/aftertick-app-host-0.2.22-alpha.20260907.zip` | 3 verified host-template files; `fe703586bb762d6baabfdf6a6e08c1c6dd5eddbe7c4d692f31437b8e6a4e5471` |

The image archive contains `aftertick-api:playtest-0.2.22` and
`aftertick-web:playtest-0.2.22`. Their tested image IDs are respectively
`sha256:596ad278196c88c6c80e7a86ad1806f4995e1ffff1484b1fe166edecf81830b1` and
`sha256:f98c12d421111fa579a2692c8f810e57de317d611feb6806f9d3e58105f53e4b`.
The web container's actual downloadable launcher was hashed and matches the
public checksum above. The host-template zip contains no application binaries;
load the image archive separately on an approved host. No registry push occurred.

Launcher metadata: `.artifacts/releases/launcher-0.2.22.json`; adjacent public
`.sha256` file is the delivery checksum. Node manifest verifies 28 files, includes
licenses/source provenance, contains no credentials, and reports 0.1.23 from its
actual packaged executable. Development archives 0.1.21 and 0.1.22 failed installer
acceptance and must not be distributed; their bytes remain preserved.

Stage repeatably with `npm run launcher:release`; it verifies metadata/version
and native pins and accepts an existing file only when its bytes are identical.
Use a new version for changed bytes. `npm run game:node:release` selects the shared
node version and refuses an existing archive. Verify with
`npm run game:node:release:verify` and `npm run test:game-node:installer`.

## Fresh verification

These checks ran against current source during this goal. Integration counts
below come from dedicated runners and are separate from `npm test`.

| Check | Evidence |
|---|---|
| TypeScript / build | All workspace typechecks and production builds pass; native release build passes |
| Source unit tests | 183 Vitest checks pass; Rust 76 library checks and actual version CLI pass |
| PostgreSQL | 51 checks in 11 files pass, including inventory, Trade Ups, StatTrak, settlement, leases, moderation, recovery and retention |
| Redis | 22 checks in 4 files pass, including grouped native accept, direct native maps, cancellation fencing and session recovery |
| Native latency | Actual debug/release binaries pass the UDP → signed HTTP → database/replay/private-target fixture |
| Native GC | All 8 CTest suites pass; actual final-client `code.pbin` reports `archive_size=4704521 result=1` |
| Browser | 15 Playwright journeys pass, including desktop/mobile setup, denied clipboard, keyboard focus, route recovery, player/admin paths and scoped Axe scans |
| Native presentation | 12 memory-render scenarios generated; compact/error/150% DPI inspected. Fixture content is synthetic. Native OS interaction and screen-reader behavior remain unobserved |
| Built API | Readiness, CSRF and session persistence across restart pass |
| Queue burst | 200 players / 20 ready checks / 200 recovered assignments; accept p95 50.8 ms |
| Recovery | API 852 ms; Redis 3,677 ms; PostgreSQL 3,620 ms; services restored after the drill |
| Backup/restore | Fresh checksum-backed backup `.artifacts/backups/20260907T005025Z`; disposable PostgreSQL, Redis and MinIO restore passed |
| Backup retention / hosted fixture | Safe backup-pruning fixture and four hosted-preflight fixture checks pass |
| Observability | Trace `06682671e78e6bbb17525e740aefc795`, 6 stored spans, three healthy targets, Grafana Tempo OK |
| Server package | SourceMod + six pinned SMAC modules build; 28 manifest files and exact node CLI verified; fixture installer version/tamper rejection and idempotent GC install pass |
| Demo analyzer | Go tests pass (cache reused); current analyzer executable builds |
| Full platform | Ten simulated sessions, direct selected-map allocation, real SourceMod surrender, exactly-once Elo/XP, 493,055-byte GOTV, node restart/no-show/crash recovery pass; fixture server process exit and port closure verified |
| Deployment rollback / Linux activation | Real API/web images, readiness and ingress checks, injected crash and exact-image restoration pass; protected-token and immutable Linux pointer-rollback fixture passes |

No new human gameplay, Steam login, public-route measurement or production
acceptance was performed. Historical results are in the older checkpoints and
`remaining-work.md`; they do not replace the gates below.

Final full-platform fixture: match `e96a30ad-27c8-4970-8d97-d4af6f7f2e94`, demo
`a014863bd52ddf5b688e84cdee84e411faf844378cde07ad35a9856e6888feda`, crash
recovery 1,472 ms. The analyzer correctly reports no completed human rounds and
no rostered human players; this is a real server with simulated control-plane
participants. The temporary schema was removed and the fixture server stopped.
Recovery and deployment reports are `.artifacts/resilience/latest.json` and
`.artifacts/deployment-rollback/latest.json`. A working-tree source hash record
is `.artifacts/releases/source-0.2.22.json`, based on commit
`938cc3a145ebc29c4cd564a3520e7efa6b84ab15`; changes remain uncommitted.

No known controllable release-blocking finding remains in this audit's scope.
Passing automation and inspected memory renders establish the candidate's
engineering readiness, while the external checklist remains mandatory before
calling real gameplay accepted.

## Coordinated installation and rollback

Deploy the API containing `/api/launcher/v1/queue/session-ended` before giving
testers this launcher. Keep migrations through 030; this candidate adds no DB
migration. Deploy the paired web build with the exact launcher download and
checksum, then install the verified node in a drained maintenance window. The
last documented production API is 0.2.18-alpha.20260905.2110 and node is 0.1.16;
these are historical deployment notes, not a fresh VPS inspection.

1. Back up production state using the existing operator runbook. Verify no active
   leases/players and drain the node. Stop its service after the game is empty.
2. Verify the node archive's external checksum, extract into a new release folder,
   and run `Install-AftertickGameNode.ps1 -Version 0.1.23 -ReleaseRoot <extracted>
   -CredentialsFile <protected-node.env> -ValidateOnly` before elevated activation.
   Omit `-ValidateOnly` only for the approved maintenance action. Credentials stay
   on the host. Never place them in the archive or a support message.
3. Confirm the running heartbeat says 0.1.23 and advertises live owned inventory
   support (`metadata.inventorySyncVersion: 1`), then verify readiness, the bundled
   GC hash for StatTrak compatibility, and the public UDP route.
4. Close CS:GO and the old launcher. On this workstation, the prepared apply action
   is `npm run uat:preflight -- -Apply`. It installs the checksum-selected launcher,
   repairs the pinned GC and records before/after state without launching a game.
   Run it only as an authorized installation action, then require
   `localFilesReady: true` from `npm run uat:preflight` before gameplay.

Fresh read-only preflight at 00:52 UTC found AppID 4465480 / client 1575, no game
processes, installed launcher 0.2.21 and GC 0.2.18. It intentionally failed
`localFilesReady` because this candidate is not installed. Evidence:
`.artifacts/game-client-uat/3c102984403f43e58c6fad664daa6887/preflight.json`.

Keep prior app image IDs, node release and launcher 0.2.21 available. For rollback,
first drain/stop the affected session/server. Restore the prior application image
references/pointer using the existing host runbook. Reinstall a previously
verified node archive in the maintenance window; do not point a running server
at mixed files. The new installer requires its requested version to match its
archive. Client rollback uses the unchanged 0.2.21 executable; it shares this GC
pin. To restore Valve files, use the candidate's `game-uninstall --dry-run`, then
`game-uninstall` only after it validates the originals. Do not delete backups or
uninstall across unrecognized files; repair/Steam verification is the recovery.

## Tester handoff and external acceptance

After coordinated installation, use one paired Steam account on the final legacy
client. Keep the B2G launcher open (minimized is fine). Choose Competitive or
Deathmatch inside CS:GO. Competitive needs the native accept prompt; Deathmatch
connects automatically. Queue/matchmaking work happens in the client.

- **First solo session:** verify account/rank/XP/access, GO, full inventory, CT/T
  equips, DM connection, return to menu, requeue, game exit and launcher restart.
  Confirm searching clears on game exit and a committed match remains recoverable.
- **Inventory presentation:** open normally and quick-open; verify reveal and New
  markers, acknowledge, restart, and confirm they stay acknowledged. Earn/add an
  item mid-match, remove/consume an item, and check incremental updates preserve
  existing loadouts. Perform a valid Trade Up and reject invalid inputs. Unseal
  and use a spray. Check knife/special rewards and original chat wording/colors.
- **StatTrak:** get kills with the exact owned tracked item, switch weapons and
  teams, check another player's weapon, reconnect/restart, and compare the live
  count with the durable item count. Verify no credit to the wrong owned item and
  no double credit after retry. Protocol replay tests already pass.
- **Native desktop:** Tab/Space/Enter on each control, Escape/dialog focus, resize,
  100/125/150/200% DPI and monitor changes, long names/errors, minimize/restore,
  service outage/retry, pairing expiry/rejection and reauthorization. Confirm the
  close-during-game notice is understandable. Test screen-reader output separately.
- **Party and real 5v5:** two-to-five-person Steam lobbies on separate machines,
  leader/follower behavior, invites/leave/disconnect, ten native accepts, decline
  and timeout, direct selected-map allocation, full match, reconnect/pause,
  surrender/forfeit, exactly one result/Elo/XP settlement, GOTV and next queue.
- **Hosted operation:** deployed checksums/versions and download success, clean
  host installation, public connectivity, node restart/drain, capacity limits and
  production backup/restore/retention acceptance. These need access/approval.

If the launcher is forcibly killed or the network remains unavailable during
cleanup, reopen it and cancel matchmaking; server cancellation may be unconfirmed.
Ready checks still follow the normal deadline/penalty policy. Do not close an
accepted match to bypass it. API/browser fixtures do not prove real 5v5 timing,
in-game rendering, input, anti-cheat effectiveness, or live server capacity.

For a useful report, record launcher/node version, local time and timezone, mode,
map, match ID, exact steps, expected/actual behavior and whether restart changes
it. `b2g-launcher diagnostics --json` identifies log locations; `doctor --json`
records installation checks. Share only the relevant launcher/GC/game log excerpt
after reviewing it for credentials, pairing codes, server passwords and personal
data. Keep the original local logs available for an approved investigation.
