# Incremental inventory refresh candidate: 0.2.20

2026-09-05. **Built and tested locally; not installed or published.** This
supersedes launcher 0.2.19 for the next test. Keep using game-node **0.1.20**;
its existing archive and installer have not changed. The installed local client
remains 0.2.18. No game, Steam, launcher GUI or RDP session was controlled.

## What changed

This includes [0.2.19's live StatTrak path and chat wording](playtest-0.2.19.md).
The announcement uses the actual player's name, for example:

`cubsfan49 has opened a container and found: PP-Bizon | Lumen`

Only the item name has its native rarity color. No written rarity label or
`[B2G]` prefix is included. StatTrak/Souvenir qualifiers remain part of the name.

A follow-up source review found that saving a kill increments the API inventory
revision. Although the new server counter message was already an item-only
update, the launcher's periodic bootstrap would then request a full inventory
subscription. That second path could reintroduce inventory flicker and interfere
with native profile/reveal state.

Periodic refresh now emits only removed, added and changed inventory objects.
An unchanged snapshot emits nothing; a counter-only change updates that item
without replacing the inventory/profile subscription or replaying case reveals.
New rewards retain their New flag, and acknowledging one updates its position
without recreating it. Existing count-only network authentication and monotonic
counter protection remain unchanged.

The launcher also retains its last successfully applied inventory revision after
a failed fetch/write so the next poll retries. It uses the fetched bundle's
revision when that is newer than bootstrap, avoiding redundant refreshes. Queue
and profile updates continue even if an inventory fetch fails.

## Verification and boundaries

- All 8 native CTest suites passed, plus the installed final Panorama archive
  compatibility check (`archive_size=4704521 result=1`, read-only).
- New real client-GC worker tests cover unchanged/count-only refreshes, exact
  remove/create messages, increasing SO versions, malformed-file recovery, New
  flag preservation, acknowledgement updates and no repeated messages.
- Rust: 70 library tests and 1 actual version CLI test passed. New tests cover
  failed-fetch retry and fetched-versus-advertised revision ordering.
- Release executable reports `B2G Launcher 0.2.20`; embedded DLL pin matches.
- The preceding coordinated build passed 39 API/node/chat contract tests and
  51 PostgreSQL integration tests. No API, node protocol, case odds or plugin
  source changed in this client-only follow-up.
- Rendered chat colors, on-weapon live counter changes, quick-open UI and
  profile stability still require human observation in the actual game.

At the read-only production check at 22:09 UTC, API migration
`030_live_inventory_sync` was applied, the active node had no
`inventorySyncVersion` capability, and there were zero active leases. Therefore
the server side of live StatTrak was not yet enabled there. API deployment is
`0.2.18-alpha.20260905.2110`; the website still advertises launcher 0.2.16.

## Artifacts and next test

- Launcher: `apps/web/public/downloads/b2g-launcher-v0.2.20-windows-x86_64.exe`
  (3,873,280 bytes), SHA-256
  `d28437b59c4160a2f5b78ed6264f7f4552335ea65ed024887fdf641be0b79a80`.
- Client GC: `bcd9ae594d564c08d1e8de3b48e1d357412c1e4d36f2cf98d88b7e2b0a2637aa`.
- Existing node: `.artifacts/game-node/aftertick-game-node-0.1.20.zip`, SHA-256
  `fc496f941feda3ec2a95e9790591a27782fa314e600f0cfa20cc8e92bec9a023`.
- That immutable server archive retains GC hash
  `d2d3344ae3ca84356c1b2850f03fb28177d1fec3223ce7bc98769f0a76d277e2`.
  The client-only changes do not alter the counter wire format. Different DLL
  hashes between these two versions are intentional; do not edit its helper's
  pins or replace files inside the archive.

After the DM ends, run the existing helper in elevated Windows VPS PowerShell
through your authenticated RDP redirected drive:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
$b2g='\\tsclient\C\Users\max\Desktop\goagain'
& "$b2g\.artifacts\diagnostics\finish-game-node-0.1.20-on-server.ps1"
```

It refuses installation while srcds is running and verifies the active release
and bundled hashes. No working unattended Windows admin channel is established.

Close the game and old launcher yourself, then open the versioned 0.2.20
executable above. Confirm its header says 0.2.20 and use GO to apply its embedded
GC. In Dust II DM, equip an owned B2G StatTrak gun, note its count, and test kills
with a few seconds allowed for signed event delivery and policy polling. Repeat
after reconnect/restart. Check blue/red container announcements, normal and
quick unboxing, New flags before/after acknowledgement and restart, rank/XP,
inventory stability, CT/T loadouts, and DM leave/requeue.

This is not yet a public-site release or a visually verified game build. Existing
0.2.18/0.2.19 launcher and game-node archives remain available unchanged.
