# Live StatTrak and native drop-chat candidate: 0.2.19

Superseded for the next test by [launcher 0.2.20](playtest-0.2.20.md), which fixes
the separate periodic inventory-refresh path. Keep the same game-node 0.1.20.
The evidence and immutable artifacts below describe the earlier candidate.

2026-09-05. **Built and tested locally; not installed or published.**
The existing local launcher/GC remains 0.2.18. The last confirmed Windows
game-node deployment is 0.1.16; this candidate requires game-node 0.1.20.
API 0.2.18-alpha.20260905.2110 already contains the required per-kill ingestion
and signed live-inventory synchronization. No production service was changed
while preparing this candidate.

## StatTrak behavior and cause

The previous server GC forwarded engine kill increments, but the owned-only
client rejected all incoming server item mutations. Meanwhile, the old deployed
match plugin lacked the exact weapon asset/original-owner fields required for
safe permanent credit. Waiting for match settlement does not repair either gap.

This candidate uses one authoritative count path: the API commits eligible signed
`player.killed` events exactly once, the node receives updated signed cosmetics,
and the server GC sends a bounded owner/asset/absolute-count message to that
player's authenticated connection. Deathmatch does not wait for match end; this
also supports bot kills when the event proves the attacker used their own B2G
StatTrak item. Suicide, another player's weapon, missing item evidence, non-StatTrak
items and Steam-mirrored items cannot receive B2G permanent counter credit.

This is live synchronization, not a zero-latency local prediction: the default
two-second node heartbeat plus one-second GC policy poll and network/event
delivery introduce a short delay and can combine rapid kills into one update.
The on-weapon rendering and actual server kill-event fields still need human UAT.

The client accepts only the count-only message from its current ticket-bound
server, for its own existing B2G StatTrak weapon. It publishes a single SO item
update, does not echo it back, and does not replace the full inventory or emit a
new-item notification. Duplicate/older counts are ignored. Accepted counts survive
a concurrent stale inventory refresh in memory; a restart reads the API's saved
inventory. Legacy additive engine events remain rejected in owned-only mode so
the same kill cannot be counted both as an increment and an absolute snapshot.

## Unboxing chat

Announcements now read `cubsfan49 has opened a container and found: PP-Bizon | Lumen`, with the item
name in Mil-Spec blue; Hand Wraps | Giraffe uses Covert red. Written rarity names
and their colon are removed. StatTrak/Souvenir qualifiers remain part of the
colored item name. All seven rarity levels retain the pinned native SayText2
palette, with a neutral server author rather than the opener's team color.
The UI clarification/consistency skills kept this limited to native palette and
copy changes; no case odds, item metadata, inventory or Panorama layout changed.

## Verification

- All 8 native CTest suites passed, plus the exact final Panorama archive check
  (`archive_size=4704521 result=1`). New real GC-worker/fake Steam-transport tests
  exercise authentication, wrong peers/owners, malformed/trailing payloads,
  forbidden client mutations, duplicate/additive/stale counts, UINT32_MAX,
  inventory-refresh preservation and persisted restart state.
- Real server-worker tests verify initial/changed absolute counter publication
  and absence of repeated counter messages for unchanged policies.
- Rust: 68 library tests plus the real version CLI test passed. Release build
  reports `B2G Launcher 0.2.19`; this includes the previous version-banner fix.
- 39 focused API/node/chat-contract tests passed; 51 real PostgreSQL integration
  tests across 11 files passed, including exactly-once StatTrak persistence.
- SourcePawn plugin compiled. The node archive verified all 27 files and contains
  no credentials. Its helper is pinned to the plugin *inside that archive*;
  SourcePawn rebuild timestamps can change a later standalone plugin hash.
- No game/Steam/launcher GUI was opened, closed or controlled. No production
  deploy, active server restart, installed client replacement or in-game visual
  verification was performed.

## Artifacts and testing

- Launcher: `apps/web/public/downloads/b2g-launcher-v0.2.19-windows-x86_64.exe`
  SHA-256: `5e12445044fee2339376aa54c1b79d5b4d943e0bf2231b7277e7f05ccd621290`.
- GC DLL: `d2d3344ae3ca84356c1b2850f03fb28177d1fec3223ce7bc98769f0a76d277e2`.
- Node: `.artifacts/game-node/aftertick-game-node-0.1.20.zip`
  SHA-256: `fc496f941feda3ec2a95e9790591a27782fa314e600f0cfa20cc8e92bec9a023`.
- Bundled match plugin: `f8164c5f0311b2776086b947995ebeb321b82fe1a8248b63ab3332fab4556d58`.
- Server helper: `.artifacts/diagnostics/finish-game-node-0.1.20-on-server.ps1`.

After the DM has ended and no srcds process remains, run in the elevated Windows
VPS PowerShell through the existing redirected drive:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
$b2g='\\tsclient\C\Users\max\Desktop\goagain'
& "$b2g\.artifacts\diagnostics\finish-game-node-0.1.20-on-server.ps1"
```

The helper refuses installation while srcds is running. It backs up credentials,
installs the separate version and verifies its active pointer/service/policies
and all three native artifact hashes. Do not run the older 0.1.18/0.1.19 helpers for this
test. Windows remote installation still requires the owner's authenticated RDP
session; no working unattended admin channel has been established here.

On the local PC, close CS:GO and the old launcher yourself, then open the 0.2.19
candidate above. Its installation replaces the per-user launcher; its normal GO
path applies the new embedded GC with existing backup/verification safeguards.
Verify the header reads 0.2.19. Queue Dust II DM, equip your own B2G StatTrak gun,
note its count, get one kill and wait a few seconds. Test a bot and a human when
available. Check the held weapon and inventory count; repeat after reconnect and
restart. Unbox a blue and a red item to check native chat colors, and recheck
quick-open/New-item behavior and CT/T loadout persistence. Report any failure
with the local GC `B2G live StatTrak synchronized` log and the server installer
result; do not send account tokens or server credentials.

Existing versioned 0.2.18 launcher and 0.1.18 node archives were not overwritten.
The production website's download is still 0.2.16, not this local candidate.

The owner refined the chat wording after 0.1.19 was already packaged. The
replacement 0.1.20 server archive carries that copy-only change; the existing
0.1.19 archive is preserved and the 0.2.19 launcher/GC binary is unchanged.
