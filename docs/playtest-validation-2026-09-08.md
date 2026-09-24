# Playtest validation — 2026-09-08

The automated and controllable local checks below passed. Testing found a real
B2G uninstall defect, fixed and published in [launcher 0.2.37](playtest-0.2.37.md).
The actual B2G-only remove/reinstall and subsequent game startup now pass.
This does **not** establish final in-game visual acceptance or a human 5v5 result.

Testing began on commit `81376b2` / launcher 0.2.36. After the uninstall fix,
the complete launcher suite was repeated on 0.2.37. The API and native GC did
not change. Raw run logs and local receipts are under
`.artifacts/playtest-20260908/`; production publication receipts are under
`.artifacts/diagnostics/`. Test identities were isolated; the owner's items and
progress were not used for destructive inventory tests.

## Passed checks

| Area | Evidence from this run | Log / receipt |
|---|---|---|
| Unit/component | 212 Vitest tests. Dependency-backed suites were executed separately below. | `unit-launcher.log` |
| Native launcher | Final build: 126 library tests plus four executable tests. Five existing opt-in/child fixtures remain ignored. Includes native interaction/recovery fixtures and two new uninstall regressions. | `launcher-037-final.log` |
| PostgreSQL | 93 tests across 15 files: migrations, XP conversion, inventory, trades, medals, StatTrak, friends/profiles, device authorization, settlement, recovery and retention. | `database-recheck.log` |
| Redis | 22 session/party/queue/ready-check integration tests. | `redis.log` |
| Native GC | All 10 CTest suites passed, including owned loadouts, inventory/schema, Panorama archive and ICU startup loading. | `native-gc.log` |
| Popup lifecycle | 390 Unlock→Escape cycles using the actual installed Panorama script in a mocked host; no retained timers/handlers or late UI work. Normal reveals, animation-phase closes, duplicate close, queued callbacks and late responses also passed. | `popup-lifecycle.log` |
| Browser first-run/account flows | 16 Playwright journeys, including launcher approval/setup and retry, account/history and other player/operations flows. These use test identities, not a new real Steam login. | `browser-e2e.log` |
| Built API | Readiness, CSRF, Redis session persistence and restart recovery. | `api.log` |
| Signed latency boundary | Real Rust launcher → UDP probes → signed HTTP submission → PostgreSQL integration passed. | `latency.log` |
| Full platform | Ten independent HTTP sessions, native ready checks, automatic map selection/allocation, real local SRCDS/SourceMod, node-agent crash/restart continuity, result/ELO/XP settlement, GOTV upload/analysis, no-show cooldowns and terminal drain. Forced SRCDS crash detection: 1,479 ms. | `full-platform-recheck.log` |
| Queue burst | 200 unique players/tickets, 20 ready checks, exactly 20 terminal assignments, all 200 assignments recovered. Join p95 103.9 ms; accept p95 42.9 ms. | `queue-load.log` |
| API load smoke | 10 virtual users for 10 seconds; 37,290 requests, zero failures, request p95 3.70 ms. Local smoke workload only. | `api-load.log` |
| Dependency recovery | Local API recovered in 884 ms, Redis in 3,741 ms and PostgreSQL in 3,819 ms; durable state and readiness behavior passed. | `resilience.log` |
| Observability | Six spans stored in Tempo, all three expected Prometheus targets up, Grafana Tempo health OK. | `observability.log` |
| Backup/restore and retention | Fresh checksummed PostgreSQL/Redis/MinIO backup and disposable restore passed. Backup retention dry-run, minimum-copy protection, manifest guards, apply and idempotency passed. | `backup.log`, `restore.log`, `backup-retention.log` |
| Production database backup | Existing `pre-0.2.33-alpha.20260908.0015.dump` copied and checksum-verified, restored into a disposable local database: 53 tables, no unvalidated constraints, ANALYZE succeeded. Temporary database and staged container dump removed. This backup predates the latest account/social changes. | `production-restore.log` |
| Deployment rollback | Isolated Docker deployment served healthy images, rejected an intentionally crashing candidate, and restored the exact prior API image without replacing the web proxy. Dependency readiness, headers and client-IP rate-limit isolation passed. | `deployment-rollback.log` |
| Production release | Public 0.2.37 executable bytes, SHA-256, CLI version, website version binding, six protected-route denials and all readiness dependencies passed. | `public-release-037.log` |

The synthetic full-platform run produced a 482,718-byte demo. Analyzer warnings
`no_completed_rounds` and `no_rostered_players_observed` are expected for this
fixture; the test is not ten human clients playing a competitive match.

Trading coverage includes exact reviewed terms, counteroffer approval reset,
gifts, cancellation races, concurrent offers, atomic rollback, offline durable
notifications, a two-credential HTTP journey, transferred container opening,
graffiti ownership, equipment invalidation and StatTrak reset for the new owner.
Friends coverage includes request/accept/decline/cancel, crossed requests,
private-profile restrictions and separate Competitive/Deathmatch statistics.
Progression coverage includes retaining existing XP at the 1,000-XP threshold,
rewards, service-medal cycling/unsupported-tier skips and duplicate-redemption
protection. These establish data/API behavior, not physical desktop presentation.

## Actual installation and game startup

The first real 0.2.36 uninstall removed the installed launcher, Start-menu
shortcut and protocol registration, restored Valve's executable, and preserved
personal files. It also restored `csgo_gc.dll.b2g-original`, whose exact hash
matched B2G releases 0.2.30–0.2.34. That left an obsolete B2G DLL installed.
The original implementation had mistaken an upgrade's previous B2G file for a
pre-existing original. A new regression reproduced the failure before the fix.

0.2.37 recognizes exact known B2G hashes when upgrading and uninstalling.
Known B2G backups are removed; unrelated pre-existing files remain recoverable.
The actual remove/reinstall test then passed, with 104 preserved files verified
and Steam CS:GO retained. Steam's independent `LastPlayed` timestamp update is
the only permitted difference in its app manifest; all other preserved content
was checked unchanged. Receipt: `reinstall-037/receipt.json`.

Launching the reinstalled executable through its `play` command successfully:

- Started Steam App 4465480 and obtained a responding CS:GO process/window.
- Loaded `icuuc.dll`, `icui18n.dll` and `launcher.dll` from CS:GO's own `bin`.
- Loaded the pinned B2G GC DLL, loaded and published all 172 owned items into
  the client inventory, and verified the account-bound local bridge.
- Submitted a signed regional latency measurement.

The startup session recorded one HTTP 502 refresh during the website cutover;
the session remained running and public readiness subsequently passed. This
does not establish zero-interruption deployment. The test game session was
closed, its bridge exited successfully, and installed launcher 0.2.37 was
reopened and verified responding. No skins were consumed or reassigned.

The actual uninstall test invoked the production CLI and cleanup helper. It
did not click Settings → Uninstall on the physical desktop.

## Production observations and limits

The NA Central dedicated probe on UDP 27125 returned 10/10 responses, median
25.9 ms, p95 28.0 ms and zero packet loss. A later real game session successfully
submitted signed route evidence. This measures the network route, not server
tick time, rendering latency or kill-to-counter presentation.

The general hosted probe did not receive game A2S/GOTV responses on 27115/27120.
Read-only host and database checks found an active 0.1.28 node with a two-second
heartbeat age, zero active leases, and no SRCDS process. The match instance was
offline. This is consistent with on-demand match processes; active production
game/GOTV reachability was not established by that idle probe.

The production retention timer is active and its last service run succeeded.
Local retention/restore tests and one production PostgreSQL backup restore
passed. Production object-store recovery, telemetry retention, off-host backup
coverage and delivery of a real operator alert remain separate checks.

## Still unverified

| Remaining check | Why it remains / acceptance needed |
|---|---|
| Practice and Deathmatch visual acceptance | Observe CT/T skins, equips, respawn, map changes and reconnect; observe the correct rarity colors, sprays, Trade Up reveal and level-40-only medal action. Startup and item publication passed, but rendered gameplay was not observed. |
| Extended unboxing/performance soak | Run mixed normal and Unlock→Escape openings, then Deathmatch without restarting; collect comparable frame times and memory, and measure kill-to-visible-StatTrak timing plus persistence. The 390-cycle script test does not prove the native engine no longer stutters. |
| Physical launcher flows | Click uninstall/repair, first-run navigation, live trade/friend/profile flows on two launchers, demo playback, network recovery and real monitor/DPI transitions. Native fixtures and backend journeys passed. |
| Truly fresh Steam installation and signup | Requires an absent-game machine/VM and a separate real Steam account's approval/Guard steps. B2G-only reinstall intentionally kept CS:GO. No alternate account was supplied during this run. |
| Human multiplayer | Real parties, multiple independent clients and ten-human 5v5 remain external. The real local server fixture uses synthetic player sessions. |
| Operational acceptance | Active production match/GOTV reachability, production failover/rollback exercise, complete production object/telemetry/backup recovery and an authorized alert receiver. Local drills do not prove these production outcomes. |

Native desktop automation was attempted but the Computer Use native pipe was
unavailable (`The system cannot find the file specified`, OS error 2). No
physical desktop clicks or in-game visual assertions are claimed.

Initial harness/environment failures are retained in the logs: a five-second
migration timeout under concurrent build load passed a focused retry and then
the complete 93-test rerun; sandbox traversal blocked the first full-platform
build before the test ran, and the escalated full rerun passed; sandbox UDP
probes lost all packets, while the unrestricted retry passed. The immutable
release guard also rejected staging changed bytes as 0.2.36 before the corrected
0.2.37 build; no published version was overwritten.
