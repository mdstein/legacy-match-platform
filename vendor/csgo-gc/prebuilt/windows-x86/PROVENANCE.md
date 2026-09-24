# B2G local Game Coordinator binaries

- Upstream: `https://github.com/GT-610/csgo-gc`
- Pinned upstream commit: `85cf811daf214a54fe803a6b6a156b28a5cd2945`
- B2G policy source: the vendored tree in this repository
- Architecture: Windows x86, static MSVC runtime, Release
- Toolchain: Visual Studio 2026 18.7.1 / MSVC 19.51.36248
- vcpkg baseline: `aa2d37682e3318d93aef87efa7b0e88e81cd3d59`

SHA-256:

- `csgo.exe`: `65bf01f46fd9bd923bbd2cbd30eea004c3e1a00a3075fafcea87c63805dea148`
- `srcds.exe`: `af53aee4cd14667b2ecad6dc25a2e1d9a6a4d38222b2dee961b13ba0a8541764`
- `csgo_gc.dll`: `210895abd0cf57e8cc6d4c3b090e30cc4243162df8f081867c5037cd5ca1635f`

Launcher 0.2.35 repairs restored equipment before publishing it to the client
or a game server. Schema team restrictions separate AK/M4 preferences, and
duplicate team/slot selections resolve deterministically without removing any
owned item. Valid saved team choices and ownership-generation checks remain
intact. The game node stays on its existing 0.1.28 binary; no wire or server
validation change is required. All ten native suites and the real Panorama /
390 Escape-close regression pass. A copied 172-item inventory is accepted by
both server validation paths after repair.

Launcher 0.2.34 explicitly loads the game's ICU pair from its absolute bin
directory before the Steam/Source startup path. Windows' system ICU otherwise
wins over PATH on a clean installation and lacks the legacy ICU 58 exports.
The GC DLL and dedicated-server wrapper remain unchanged. Both runtime-loader
regressions and all eight existing CTests pass, as does the 390 Escape-close
archive regression. Microsoft documents the dependency search flags at
https://learn.microsoft.com/en-us/windows/win32/api/libloaderapi/nf-libloaderapi-loadlibraryexw.

Launcher 0.2.30 / node 0.1.28 use 1,000 XP per profile level. The signed
final-client Panorama archive patches the profile card, XP tooltips and end-of-match
progress display. All eight CTests and the real archive / 390 Escape-close
regression pass. The existing ownership and counter protocol stays compatible.

Launcher 0.2.29 / node 0.1.27 add ownership epochs to counter evidence,
committed receipts and native loadout/ack snapshots. Saved equipment from a
previous ownership epoch is ignored, including a trade away and back while
offline. All eight native suites pass; the Escape popup regression remains
green. This candidate DLL is shared by the coordinated client/server release.

Launcher 0.2.28 added explicit teardown for case-opening popup timers and event
handlers, including Escape during pending requests or animation. The exact
2023 script harness passes 390 quick closes, normal reveals, close timing
races, and late replies after timeout. The full native suite passes. This is
script-lifecycle regression evidence; a long in-engine FPS soak remains a
playtest check. The game node retains its independently pinned 0.1.26 GC.

These binaries are unsigned. The B2G launcher verifies their embedded hashes,
backs up the Valve executable before replacement, and restores that exact
backup on uninstall. The dedicated server independently enforces the
match-scoped owned-item policy; the client process is not a trust boundary.
Launcher 0.2.26 / node 0.1.26 hide the medal action below level 40. The owner
confirmed successful redemption in 0.2.25; the visibility follow-up passed the
native suite, exact final archive patch check, and six isolated JavaScript
profile states. The prior 0.2.25 release added persistent redemption through
the authenticated launcher. Stock previews remain read-only; a committed API
receipt and matching owned snapshot are required before a native award and
level reset. Years 2015–2023 cycle by tier, skipping tiers absent from the final
schema. Shared class 0 / flair slot 55 is supported for owned medals while
weapon equipment retains team validation. The native claim, receipt rejection,
duplicate delivery, shared equipment persistence, and exact final archive patch
were tested; visual redemption remains a human playtest check.
The client GC's B2G extension communicates only with the launcher over a
local, PID-verified named pipe and never receives the launcher account token.
For the pinned final September 2023 client, it also drives the stock Panorama
ready-check popup and forwards only the local player's explicit acceptance.
Deathmatch instead uses the stock `@de_dust2` automatic announcement and its
`deferred` callback. It displays no acceptance count, never calls Competitive
acceptance, and has a bounded launcher fallback if native notification fails.
Correlated queue commands acknowledge GO before HTTP work, preserve pending
state through old bootstrap messages, and reject superseded join/cancel replies.
It restores the retired official-play selector and suppresses the legacy-build
notice only after exact Panorama DLL and signed-archive integrity checks pass.
Party queue requests are populated from the authenticated Steam lobby roster,
and only the Steam lobby owner may initiate B2G matchmaking for that roster.
Panorama player-profile requests cross the same PID-verified bridge and receive
only the bounded B2G rank/service fields allowed by platform profile privacy.
The exact final-2023 end-of-match script is CRC-pinned and relabels only the
generic reward path as `B2G Service Drop`; no Valve item is created or mutated.
For B2G cases, a CRC-pinned Panorama patch activates the stock keyless-decode
path only for the dedicated 19-digit B2G asset range. The client forwards the
B2G case ID with key ID zero; a compatible free entitlement stays hidden and is
consumed by the server-authoritative transaction. The result returns through
the PID-verified bridge, uses the final-2023 native UnlockCrate animation, and
posts the server-selected localized reward name to in-game chat.
The same owned-only bridge accepts native Trade Up Contracts for exactly ten
B2G-earned cosmetics of one rarity and StatTrak class. The authenticated API
consumes those inputs atomically and returns a signed, collection-valid reward;
Steam-owned assets remain visible but can never be submitted or consumed.
It also preserves equipped B2G loadouts, reconciles legacy empty and stale
loadout entries, acknowledges viewed inventory items, supports free item naming,
and applies the final-client graffiti lifecycle.
Official Deathmatch exposes the final client's valid `mg_de_dust2` tile and
routes that sole selection into B2G matchmaking, while Competitive and local
Practice With Bots retain their stock validation paths.
Owned-only weapon StatTrak uses absolute counts from the signed live server policy,
sent only to the ticket-authenticated owner. The client changes only the counter
attribute, without a full inventory refresh, a new-item notification, or an echo
to the server. Duplicate/stale values do not increment or roll back the number.
Legacy additive messages remain disabled in owned-only mode to prevent double
credit; Steam-mirrored assets are never mutated. Permanent credit comes only from
the API's exactly-once signed kill ingestion, including eligible DM bot kills.
Compatible API/node releases send signed, exact-batch-bound committed counter
receipts independently of the health heartbeat. The GC checks bounded receipt
files every100ms and retains full signed inventory refresh as recovery. Server
transport preserves the recipient's complete64-bit Steam ID. These are committed
counts, not provisional increments, and never wait until match end for saving.
Local Practice with Bots uses only the in-process paired owner's inventory;
dedicated-server connections still require their fenced match policy. Practice
kills do not gain a new path to persistent online rewards.
Periodic launcher inventory refreshes also emit only added/removed/changed item
objects, never a full subscription or replayed case reveal. This avoids resetting
Panorama's inventory/profile state when persisted counts change the API revision.
The 0.2.20 client retains the same live-count wire format as the separately pinned
0.1.20 server archive; their intentionally different DLL hashes are not a mismatch.

This build also contains the source-checkpointed signed-node inventory refresh
consumer documented in `docs/live-inventory-sync.md`: strict bounded policy
parsing, lease/revision/expiry enforcement, server-owned cache deltas, and
peer-bound loadout refresh. Server use requires the coordinated API/node update;
shipping this client DLL alone does not deploy that server functionality.
