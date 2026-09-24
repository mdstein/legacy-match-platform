# Player-to-player trading goal

Created 2026-09-07. Status: **complete; launcher/API/web 0.2.29 and node 0.1.27 deployed and trading enabled**.
Baseline: deployed launcher/API/web 0.2.28 and game-node 0.1.26.

Build complete player-to-player trading for B2G-owned in-game items in a
dedicated **Trading** tab of the native Windows launcher. Completion requires
working transfers, polished player flows, meaningful automated verification,
and a verified release, including the matching backend and inventory integration.

## Confirmed scope and item rules

- The owner requested a separate launcher tab and Steam-like trading with other
  B2G players. Support sending and receiving offers, counteroffers, review and
  acceptance, cancellation, decline, expiry, notifications and trade history.
- **Owner-confirmed:** reset StatTrak to zero for the new owner after successful
  settlement. Retain the pre-transfer count in the receipt/history. A cancelled,
  rejected or failed trade must not reset a counter. Fence delayed old-owner
  kill events, including an item traded away and later returned to its old owner.
- Preserve paint, wear, pattern/seed, stickers and their condition, name tags,
  rarity, souvenir/StatTrak identity and other cosmetic attributes. Preserve
  stable identity and provenance across ownership changes.
- Initial tradable scope: B2G cosmetics and unopened cases, souvenir packages
  and pin packages, plus other B2G consumables supported by the current catalog.
  Containers must carry their required opening entitlement. Hidden companion
  keys are handled with their container, not offered as standalone items.
- Earned service medals and account progression remain account-bound. Imported
  Steam items stay outside B2G transfer authority. Make eligibility and reasons
  visible rather than silently omitting confusing inventory entries.
- Item-for-item trades and clearly confirmed one-way gifts are included.
  Cash sales, fees, market prices, Steam inventory transfers and a separate
  social/chat/marketplace product are outside this goal.

The interaction reference is Valve's
[Steam Trading guidance](https://help.steampowered.com/en/faqs/view/46A2-2B3C-95CC-8878)
and [Trade Offers guidance](https://help.steampowered.com/en/faqs/view/1115-91C5-050C-1D60).
Use the familiar offer model without claiming Steam interoperability or adding
Steam-specific mobile authentication, economy holds or reversal policies.

## Repository findings that shape implementation

The existing `player_b2g_trade_ups` table implements ten-item crafting within
one account; it is not player-to-player trading. Its result foreign key includes
`(player_id, asset_id)`. Changing an item's owner directly would conflict with
historical references. Audit all such keys and separate durable item identity
and original grant history from current ownership before enabling transfers.

`apps/api/src/inventory-service.ts` currently owns container opening, inventory
reconciliation, trade-ups and counter-related queries. B2G containers also have
grant records and opening entitlements. The new transaction must update the
necessary ownership relationships without rewriting historical grant/reward facts.

The launcher manifest currently has a 512-item limit. Check all count/truncation
paths and both inventories' post-swap capacity, including hidden entitlements
and imported items, before accepting. A successfully traded item must not become
invisible or unusable because a manifest silently stops at its limit.

Signed committed StatTrak receipts, periodic inventory recovery, active matches
and equipment mappings already exist. Trading must coordinate with those paths;
updating only a database owner field is insufficient.

## Implementation sequence and acceptance gates

### 1. Ownership model and offer contract

Audit item/grant/entitlement/loadout/history references and all competing mutation
paths. Define the tradability table, per-side item limits, inbox limits, expiry,
inventory visibility rules and pending-offer reservation/invalidation policy.
Counterparty lookup should expose an exact B2G identity and share code/link,
without requiring a full friends system or exposing private account information.

Use a durable offer state machine with explicit revisions. Sending an offer
records consent to its exact terms. A recipient may accept while the sender is
offline, or counter with new terms requiring the other player to review again.
Changing terms never carries prior approval forward. Terminal outcomes and
receipts are durable; retries return the same result.

Gate: reviewed schema/transition contract and migration tests, including
existing inventories, historical grants/trade-ups, rollback compatibility and
the ownership-generation mechanism for delayed events.

### 2. Atomic backend and API

Implement shared contracts and a focused trading service rather than adding
another large UI-specific branch to the inventory monolith. Authenticate all
reads/actions, enforce participant access and validate item IDs server-side.
Use consistent player/item lock ordering, expected revisions and idempotency.

Settlement must move both sides or neither. Validate ownership, eligibility,
capacity and exact offer terms at commit. Handle competing offers and consumption
through unboxing/trade-ups, accept-versus-cancel, expiry and retries. Reconcile
current ownership, container entitlements, equipment, StatTrak reset, revisions
and immutable receipts within the transaction. Emit durable retryable updates
after commit; failed notification delivery cannot repeat or undo the transfer.

Gate: meaningful database and API tests establish conservation of items,
exactly-once settlement, authorization and deterministic terminal outcomes
under concurrent operations, failed transactions and lost responses.

### 3. Inventory and live-session integration

Deliver the new authoritative inventory to both launchers and client GCs. Notify
relevant game servers, clear the old owner's equipped reference safely, and let
the recipient equip/use received items and open received containers. Reconcile
missed updates after reconnect or service restart without routine client restarts.

Reset the transferred StatTrak counter only once at settlement. Old ownership
generations must not authorize delayed counters, snapshots or kills, including
when the same asset returns to an earlier owner. Preserve unrelated kills,
unboxing, medals, progression, practice skins and inventory acknowledgements.

Gate: controlled two-player journeys prove cosmetic preservation, container
opening after transfer, equipment cleanup, counter reset and live/offline
recovery. No test mutates the owner's real account or trades with real players.

### 4. Native Trading tab

Operate mode: a player identifies a trading partner, chooses items, reviews
exact terms and understands the outcome. Inherit `apps/launcher/DESIGN.md`, the
0.2.27 visual refinement and current 0.2.28 behavior. This is an extension of
the launcher, not a visual redesign. The old omission of extra navigation does
not prohibit the explicitly requested Trading tab.

Provide an offer inbox/outbox/history, counterparty lookup, two-sided inventory
selection and a clear **You give / You receive** review. Use real bounded item
thumbnails, search/filtering, accurate rarity/details and distinct selection.
Show partner identity, item changes, expiry and final outcomes in words. Gifts
need an explicit review of the empty side. Incoming offers need a useful count
and notification without taking focus or interrupting gameplay.

Finish keyboard navigation, visible focus, scrolling, empty inventories, loading,
offline/stale/auth-expired states, pending acceptance, errors and recovery.
Switching tabs must preserve the Play surface, game bridge and session workers.
Use background I/O, bounded caches/refresh, and explicit lifecycle cleanup.
No browser runtime is added. Follow the relevant design skill's bounded native
review workflow when building; establish the Trading surface brief then.

Gate: working native control journeys and coherent renders at supported
1024x664, 1280x780 and 1360x800 sizes and 100/125/150/200% DPI. Measure initial
load, switching/selection, responsiveness, idle use and large-inventory behavior.
Distinguish actual HWND checks from synthetic/offscreen renders.

### 5. Full regression, operations and delivery

Run controlled two-account end-to-end flows for ordinary exchange, counteroffer,
gift, rejection, cancellation, expiry, offline acceptance and reconnect. Include
duplicate requests, unauthorized participants, stale revisions, concurrent
consumption, exhausted capacity, acceptance/cancellation races, service restart,
notification loss and delayed previous-owner counters. Ensure prior trade-up,
unboxing/Escape, service-medal, matchmaking and launcher regressions stay green.

Provide a trading enable/disable control that stops new mutations safely while
preserving history and recovery, bounded offer retention, useful diagnostics and
an operator runbook. Build only the launcher/API/node artifacts actually needed,
with coordinated contracts, integrity pins and truthful release notes. Prepare
database/config backups and rollback-compatible deployment; do not interrupt
human matches or replace a running client's loaded files. Verify published
downloads, checksums, version metadata and service readiness.

Gate: feature complete and delivered, tests/evidence recorded, documentation and
exact playtest instructions available. Report remaining human appearance and
live gameplay acceptance separately. Recruiting players, real 5v5 playtesting
and unavailable owner-only authentication are not blockers to controlled work.

## Goal completion rule

### Local implementation checkpoint, 2026-09-07

- Migration 032 establishes stable item identity, separate original/current grant
  ownership, ownership generations, offers/revisions/items/events and idempotency.
  Trading defaults to disabled. This migration has not reached production.
- The trading service and authenticated launcher routes implement offers,
  counteroffers, gifts, acceptance, cancellation, decline, expiry, history,
  lookup, preferences, inventory pagination and durable notification cursors.
  Settlement locks both players consistently, revalidates exact terms, checks
  capacity and moves opening entitlements atomically.
- Twenty-three trading integration tests pass, including real two-credential HTTP
  exchange, authorization/revocation, competing offers, cancellation races,
  injected rollback, capacity and recipient opening of cases/pin packages.
- Ownership generations now travel through authoritative inventory, SourceMod
  capture-time kill evidence, signed API receipts, node policy and native GC
  counter messages. A five-test StatTrak DB suite includes a real trade away
  and back, racing kill ingestion, heartbeat synchronization and delayed replay.
  Node receipt/projection, API attribution and launcher parsing checks pass.
- The x86 GC build passes all eight configured CTests, including client counter
  reset and authenticated generation-bearing messages. SourceMod compiles.
  The 390 Escape-opening cleanup regression remains green.
- No owner account was changed. No trading artifact has been deployed, staged
  as a public release or installed over the running client. Remaining gates
  include coordinated release packaging, deployment and public verification.

The goal remains active until all five gates are met. A plan, static tab,
mock inventory, API-only settlement or unverified build is not completion.
Routine implementation decisions should use the confirmed scope and existing
architecture; seek clarification only for a material unresolved product rule.

### Integration and native checkpoint

- Native Trading tab implemented with 1,445 catalog art mappings, background
  image workers, exact review, gifts, counteroffers, folders, history and
  durable timeout/restart recovery. Full launcher suite: 105 passed; two helper
  entry points run through watchdog tests.
- Impeccable reviewer scored all three material fixes resolved after two
  bounded fix batches. Disposition: ship at fix-list scope. Final 50 captures
  and design documentation recorded; screen-reader and live-game acceptance
  remain human checks.
- Trading DB suite: 23 passing, including case-open/accept and crafting/accept
  races, pin/souvenir/graffiti usability, missing entitlements, equipment races,
  ownership-generation loadout/ack fencing and operator control diagnostics.
  The unseal path now avoids the reserved SQL alias `grant`.
- Related inventory, StatTrak, service medal, settlement and migration suites:
  48 tests passing together. Node receipt/projection/restart and API attribution:
  38 tests passing. Saved native loadouts reject an old ownership generation.
- Operator CLI and runbook added; active offers expire in bounded batches.
  Historical receipts and request IDs remain durable for recovery.
- No trading release has been deployed and no real player inventory changed.

### Completion, 2026-09-07 19:18 UTC

All controllable acceptance gates are complete. Launcher/API/web 0.2.29 and
node 0.1.27 are deployed; migration 032 and audited trading enablement verified.
Public executable/checksum/version/art, API readiness and authentication boundary,
installed native hashes, fresh node heartbeat and RCON readiness passed.
The updated server had zero human players before allocations reopened.
No real player inventory was used for testing or altered by the deployment.

Full evidence, artifact hashes and exact test instructions: `docs/playtest-0.2.29.md`.
Operations and compatibility limits: `docs/player-trading-operations.md`.
Remaining human observations are identified separately; real recruitment and
5v5 testing do not block this completed implementation/release goal.
