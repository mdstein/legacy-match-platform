# Live inventory synchronization — rollout status

Recorded 2026-09-05. This advances the launcher-first 2023 restoration goal;
it does not establish in-game completion or replace the broader goal.

## Current status, 2026-09-05 21:16 UTC

- API and migration 030 are now deployed in `0.2.18-alpha.20260905.2110`.
  Public readiness and the old node's heartbeat compatibility are verified.
- Local launcher 0.2.18 contains the native follow-up described below, with pinned
  GC SHA-256 `e2bec65583cb177ff480441072d912389ef2294a113a410a5a1032aede63e5f5`.
- Windows game node is still 0.1.16, not capability-enabled for live inventory sync.
  Game-node 0.1.18 is built/verified but **not installed**. Its archive hash is
  `4156ac008646fe84f116e4748afbcbac8b8f325016ff9f3cc2608f18a4889ce4`.
  The prepared helper is `.artifacts/diagnostics/finish-game-node-0.1.18-on-server.ps1`.
- Website/download remains 0.2.16. No installed game/launcher files were changed
  during the API rollout, and no game was launched or controlled.

See [DM server handoff](dm-server-handoff.md) for deployment/backup evidence.
The source-checkpoint record below describes verification before this rollout;
its source-only labels and old hashes are historical, not current installation claims.

## Implemented and verified

The API now produces a signed `sync-inventory` command during a capable node's
heartbeat when its active roster's database-owned cosmetics differ from the
lease snapshot. The read, lease update, revision increment and command insertion
share the same transaction. The lease is locked; only the authenticated node's
active, unexpired, currently reported ready instance can receive an update.
Terminal/draining matches and older nodes without `inventorySyncVersion: 1` do
not receive new inventory commands. Unchanged snapshots do not enqueue work.
Only cosmetics are sent to the server; cases remain in the complete client bundle.

Fresh leases start at manifest revision 1. DM roster additions share that revision
sequence and reread cosmetics inside the locked transaction, so a caller's earlier
inventory read cannot overwrite a newer snapshot. Competitive rosters remain fixed.

The node validates the signature, fenced lease, expiry, target instance, unchanged
match configuration, roster ownership, item fields and unique owners/assets. It
atomically writes the policy file and persists the updated event-pump manifest
without beginning a new match or resetting its cursor, sequence or XP/result
state. It does not start/stop SRCDS. Inventory-only updates do not issue RCON.
If a newer inventory snapshot includes an unapplied DM roster append, it applies
that append through the existing acknowledged roster flow before recording success.

Older revisions are superseded without writing. Equal revisions must have equal
content. The policy file contains the match/lease/fence, revision and canonical
manifest digest. This atomic on-disk watermark also prevents rollback if the file
write succeeded but roster synchronization or event-pump persistence failed,
including after a node restart. A retry of the current pending revision can finish.

Verification completed locally:

- API and node-agent typechecks and production builds passed.
- `npm run test:integration:db`: 49 tests across 11 files passed, including the
  new migration's application/repeatability, capability and cross-node isolation,
  concurrent heartbeat deduplication, counter updates, consumed-item removal and
  terminal-match exclusion. The real DB-issued command is executed by the real
  node verifier/policy writer/event pump in an isolated temporary server directory.
- Three focused node test files: 33 tests passed, including five inventory-sync
  tests for DM/Competitive, durable restart/replay, forged or conflicting updates,
  out-of-order roster delivery and simulated persistence failure after policy write.
- All eight native CTest targets and the pinned installed Panorama archive check
  passed. Case/owned-loadout fixtures include the new policy watermark headers,
  verifying that the native loader continues to accept the extended file format.
- Test processes did not launch SRCDS, Steam, the launcher, a game window or UI
  automation. Fixtures are isolated from the user's inventory and game installation.

## Still required before claiming live mid-match item support

1. Package and deploy the native protocol follow-up below alongside the capable
   API/node. Source tests now cover running-GC publication and equip retry, but
   no SRCDS/game process has run these changes.
2. Capture real new-item equip, StatTrak and spray updates, including the player's
   visible in-hand counter. Server-cache protocol coverage is not proof that the
   engine's weapon entity and the player's local inventory display both update.
3. Verify normal and quick-open reveal/New/acknowledgement behavior before and
   during DM without full-cache flicker. Do not reintroduce the reduced client
   manifest bug or treat repeated source tests as visual UAT.
4. Build separately versioned launcher/GC/game-node candidates with matching pins;
   include migration 030 in the coordinated API release. The existing 0.1.17
   archive and installed 0.2.17 launcher do **not** contain this work.
5. Deploy with the appropriate rollback checkpoints and no active-game overwrite,
   then capture real in-game reward, equip, StatTrak, rarity-color and same-DM
   reconnect evidence. No production deployment was performed for this checkpoint.

At the original API source checkpoint, the last installed local build was the 0.2.17 candidate documented in
`playtest-0.2.17.md`. Its complete-client-inventory and DM reconnect fixes are
separate from this source-only synchronization work. The broad launcher, party,
ten-human Competitive accept/match flow and production acceptance requirements
remain open until verified at their actual scope.

## Native server-cache follow-up — source only

The server GC now polls the node policy on its worker (once per second) and
binds authenticated Steam connections to the match/lease/fence. It accepts only
newer revisions for that lease or a higher fence for a replacement lease. Old
connections cannot carry inventory authority into a replacement lease. Missing
or malformed reads retain the last good snapshot only until its original expiry;
expiry revokes published items. The node remains the signature-verification
boundary; the native file digest is a revision watermark, not a native signature.

Publication uses an initial subscription followed by server-generated item
create/update/destroy deltas. Actual accepted CT/T loadout selections are preserved;
the policy's equipped boolean cannot equip both teams. New items are created
unequipped before a validated loadout batch applies them. Whole batches and the
resulting loadout are checked before publication. Client create/destroy messages,
forged static metadata, owner mismatches and overlapping slots remain rejected.
Server-owned cache versions advance across disconnect/reconnect and never use
client-supplied versions. Unchanged snapshots emit no repeated full subscription.

Trusted policy counter, custom-name and spray-use values replace stale client
display values during validation; the shared exact owned-item comparator remains
unchanged. Client values cannot refill a spray or overwrite a counter/name.
Static identity, finish, quality, rarity and slot checks still apply.

On policy changes or a rejected early equip, the server requests a fresh equipped
loadout through a payload-free, rate-limited P2P message. The client accepts it
only from its current ticket-bound server. The response uses the existing
network-only SOCache path; it does not refresh the local Panorama inventory.
Coalesced requests are retried by the worker until a valid loadout arrives.

The new policy regression exposed the generic KeyValues parser's duplicate-key
merge behavior. Strict bounded parsing is now opt-in for B2G inventory files:
duplicate keys, excessive nesting, malformed authority and invalid UTC expiry
are rejected. It also decodes the escaped quotes/backslashes emitted by both
the Rust and TypeScript writers, avoiding malformed inventories from item names.
Stock game schemas retain their existing parser behavior.

Verification: all eight native CTest targets and the pinned installed Panorama
archive test pass. New real GC-worker/message tests cover counter/name updates,
early equip and timed retry, timer-driven policy detection, incremental creation,
consumed-item removal, stale/conflicting revisions, expiry, fence changes,
reconnect versions, ownership/static forgery rejection, spray depletion and
quoted-name agreement between client/server loaders. Simulated Steam transport
tests cover ticket-bound refresh requests, wrong peers, extra payload, rate
limiting and absence of local inventory reset messages. No game/UI automation
or production writes were performed.

Built DLL SHA-256:
`907e817a3f4e4302fb4a71c49f1587f6170124d3c081cad3656d31c51473efd0`.
This binary is **not** pinned, installed or included in the existing 0.2.17 /
0.1.17 candidates. Separately versioned packaging and coordinated deployment
remain required. The user's additional DM GO feedback/repeated-click report is
being investigated separately; this inventory checkpoint does not fix that UI.
