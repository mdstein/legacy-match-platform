# Deathmatch shutdown/start handoff — 2026-09-05

## Production evidence

Read-only API logs and database command/lease timestamps correlate the reported
repeated-GO failures with a normal server shutdown, not a Deathmatch cooldown.
All times below are UTC on 2026-09-05.

- The previous match released its lease at 18:29:23.288. Its terminal drain
  completed at 18:29:29.789.
- New launcher joins returned HTTP 503 at 18:29:25.227 and 18:29:28.181, while
  that sole instance was still draining. The next attempt scheduled start at
  18:29:31.542 and succeeded at 18:29:54.956.
- Successful cold joins took 34.463, 23.704 and 25.315 seconds. The launcher
  previously stopped waiting for HTTP after 15 seconds. Client 0.2.18 reconciles
  transport timeouts against the persisted ticket and polls for assignment;
  an explicit 503 is still correctly treated as a failure.
- The old allocator retried ready capacity for only 250 ms and considered only
  offline/starting wake candidates. Excluding the draining instance explains
  these brief no-capacity failures. No exact exception body was retained in
  those request logs; the explanation is based on code and correlated timing.

## Implemented server changes

- A fresh, unleased draining instance is eligible to wait on, but never to start
  or lease before drain acknowledgement. Once offline, one start command is
  scheduled. The existing readiness deadline remains bounded; idle servers are
  not kept running and quarantined or actively leased instances are not woken.
- Offline heartbeats reuse an outstanding start command. Concurrent joins for
  the same match share its lease after startup rather than waiting for a state
  that has already advanced from ready to leased.
- Failed DM allocation cleanup is atomic and restricted to the captured ticket
  ID, fencing token, searching phase and Deathmatch mode. A late failure cannot
  delete a newer requeue, an assigned ticket or a Competitive entry.
- The Redis integration runner excludes archived source trees under `.artifacts`
  so old release tests no longer inflate current-source results.

## Verification and rollout boundary

- API typecheck passed; production Docker build passed (runtime dependency audit:
  zero reported vulnerabilities; build-time tree reported one low-severity issue).
- PostgreSQL integration: 51 tests across 11 files passed.
- Redis integration: 21 tests across 4 files passed.
- Focused inventory-sync, event-pump and match-ingestion regression tests: 20 passed.
- New real-DB fixtures cover drain-to-offline/start and drain-to-ready, concurrent
  same-match requests, and an offline heartbeat while a start is already claimed.
- No game/launcher/Steam UI automation or real competitive match was performed.

API candidate: `aftertick-api:b2g-20260905-2110`, host bundle
`0.2.18-alpha.20260905.2110`. Deployment verification is recorded separately below.
Website image/download and local launcher 0.2.18 are intentionally unchanged.

Game-node 0.1.18 is separately built and verified (27 manifest files, no credentials).
It includes the new live-inventory consumer and matching native GC, but packaging
is not installation. Archive SHA-256:
`4156ac008646fe84f116e4748afbcbac8b8f325016ff9f3cc2608f18a4889ce4`.
The RDP-side helper is `.artifacts/diagnostics/finish-game-node-0.1.18-on-server.ps1`.
It refuses installation while SRCDS is running, backs up credentials and verifies
the installed release, service identity and artifact hashes. Old archives remain.

Real UAT must still confirm one GO gives immediate search feedback, the native
green automatic DM announcement, and connection; cancel/requeue must not produce
late handoffs. The [0.2.18 client playtest](playtest-0.2.18.md) covers that UI.

## Deployed API verification

Source checkpoint: `257682a`. The API-only release completed at approximately
21:15 UTC. Host current pointer is `/opt/aftertick/releases/0.2.18-alpha.20260905.2110`;
API image is `aftertick-api:b2g-20260905-2110`. Website image remains
`aftertick-web:b2g-20260905-0141` (0.2.16 download), and Windows game node remains
0.1.16 without the `inventorySyncVersion` capability. No new inventory commands
were sent to that older node.

Migration `030_live_inventory_sync` is recorded at 21:14:31.213819 UTC. The
custom-format database backup was created before migration and its restore catalog
was readable; a full restore drill was not performed in this rollout. Backup:
`/var/backups/aftertick/pre-0.2.18-alpha.20260905.2110.dump`, SHA-256
`53ee936acc08f66038259e5657263cd1cb2598981f7457769c984b078e9e2e22`.
The prior release pointer, image and release environment were preserved for rollback.

The existing host service restart cycled the compose services. All returned healthy;
the same Windows node resumed successful heartbeats roughly every two seconds.
At 21:15:46 UTC it was active, instance offline, with zero active leases and no new
node commands. A server was not launched for deployment verification.

Anonymous public checks on `https://play.back2go.net` at 21:16 UTC:

- `/ready`: HTTP 200, PostgreSQL/Redis/object-storage checks all `ok`.
- `/`: HTTP 200; existing website retained.
- Unauthenticated POST `/api/launcher/v1/queue/join`: HTTP 401, invalid launcher credentials.

`back2go.net` redirects to that canonical `play.back2go.net` hostname. Installed
launcher and GC hashes still match the 0.2.18 playtest checkpoint. Production
health and isolated tests do not establish an actual player reconnect or popup UAT.
