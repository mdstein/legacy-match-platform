# Responsiveness implementation plan

Started 2026-09-07 UTC from the responsiveness research and the report that
Practice with Bots does not display owned skins.

## Outcomes and constraints

- StatTrak should show accepted kills promptly while continuing to persist
  during the match. Never save all progress only at match completion.
- Practice with Bots must display the paired player's owned, equipped skins.
  A local practice session must not bypass dedicated-server inventory authority
  or grant persistent online rewards.
- Preserve 128 tick, bots, anti-cheat/evidence, GOTV/demos, inventory mutations,
  loadouts, progression, and all match lifecycle behavior.
- Preserve existing workspace changes. Package and validate complete changes
  before release; never interrupt an active human session for installation.

## Implementation sequence

1. **Shipped in 0.2.24 / node 0.1.24 - correctness.** Reproduce the local-practice
   inventory path; fix scoped local inventory delivery. Add explicit Normal
   task/process priority and bounded latency diagnostics. Verify regression
   coverage before packaging.
2. **Shipped - ingestion scheduling.** Replace whole-log reads with bounded
   positioned reads. Serialize stateful pump operations and run an independent
   abortable ingestion loop, preserving retries, partial lines, terminal result
   receipts, sequence/cursor durability, and lifecycle observation.
3. **Shipped; rendered latency measurement pending - committed count delivery.** Return narrow authenticated absolute
   counts after database commit, scoped to lease/owner/asset and accepted event
   coverage. Deliver them independently of health heartbeats/full inventory
   revisions. Preserve recovery through authoritative inventory refreshes and
   compatibility with older peers. Measure the rendered result.
4. **Conditional - provisional display.** Only if committed delivery still
   misses the feel target, add a separate server-confirmed pending ledger and
   explicit reconciliation. Do not put provisional values into the current
   monotonic confirmed-count cache.
5. **Pending - controlled profiling.** Capture comparable frame-time/scheduling,
   plugin, I/O and network measurements. Optimize demonstrated costs; retain
   all features. Human 5v5 capacity remains a later validation gate.

## Verification and release

Run affected node/API tests (including real database ingestion), native GC tests
and x86 build, installer checks, launcher checks if its embedded GC changes, and
release integrity verification. Check duplicate/out-of-order/retry kills, bot and
picked-up-weapon eligibility, stale inventory, disconnect/restart, log rotation,
terminal results and XP presentation. Practice checks cover both teams, loadout
changes, map restart and return to online Deathmatch.

Measure local kill-confirmation-to-render latency separately from database
commit latency; provisional target p95 below 100 ms is a proposed goal, not a
claimed result. Report completed source/test/package/deployment stages
separately and keep exact rollback packages available.

## First implementation completed

On 2026-09-07 the coordinated API/web release `0.2.24-alpha.20260907.0240`,
launcher `0.2.24`, and game node `0.1.24` were deployed. Matchmaking reopened at
03:17:21 UTC after fresh node/RCON health and plugin checks. See the
[release and testing checkpoint](playtest-0.2.24.md) for evidence and hashes.

- Practice uses the paired local account's owned loadout. Dedicated servers
  continue to require the signed match inventory policy. Local practice does
  not grant persistent online rewards.
- Fixed server outbound delivery truncating a player's 64-bit Steam ID to
  32 bits. This could prevent direct inventory/counter messages from arriving
  and leave the slower launcher refresh as the visible fallback.
- The node reads only appended event bytes, in bounded chunks, on an independent
  100 ms loop. Health heartbeats stay at 2 seconds. Stateful operations are
  serialized; retry, rotation, lifecycle observation and result/XP races have
  regression coverage. Node requests have a separate bounded API rate budget.
- The API returns signed, lease-bound committed absolute counts for accepted
  events, including exact retries. The node validates them and atomically
  publishes a small counter file. GC checks for changes every 100 ms and sends
  the existing absolute-count message without waiting for a full loadout refresh.
  Periodic full inventory synchronization remains available for recovery.
- GC avoids copying unchanged inventories during the faster polling cycle.
  The Windows task and actual SRCDS process now use Normal priority.
- Node heartbeat diagnostics expose bounded batch bytes, event count, upload
  time and flush time. These are not an end-to-end render-latency measurement.

## Next work and decision gates

1. Observe practice skins on both teams, changes to equipped items, map restart,
   and return to Deathmatch using the released client. Verify StatTrak during
   rapid kills, switching weapons, disconnect/reconnect and a completed match.
2. Add opt-in correlated timestamps at event append, ingestion/commit, GC receipt
   application and client counter application. Use event sequence and asset in
   bounded diagnostic records; do not put those IDs in metric labels. Compare
   p50/p95/p99 delivery time and separately observe when the weapon renders it.
3. If committed updates still miss the feel target, implement a separate
   server-confirmed provisional ledger with explicit accepted/rejected event
   reconciliation, lease resets and crash recovery. Continue durable saves
   during play. Do not overload the monotonic committed-count cache.
4. Profile repeatable local/maintenance fixtures before further host tuning:
   same map, tick rate, bot count and seed where possible; record warmup and
   steady state separately. Capture server frame-time tails and late frames,
   per-thread CPU/ready time, plugin costs, disk I/O, packet loss and choke.
   Compare one change at a time with SMAC, GOTV, demos and normal progression
   enabled. An idle or bot-only result cannot establish human 5v5 capacity.
5. Accept further optimizations only when the measured target improves and the
   relevant gameplay/lifecycle checks still pass. Keep the exact current release
   as the comparison and rollback point. Human 5v5 remains an external gate.
