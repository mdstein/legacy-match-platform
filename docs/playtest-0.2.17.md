# B2G 0.2.17 — installed locally; production deployment pending

Recorded 2026-09-05. Do not infer live fixes from source/build completion.
Computer Use is explicitly disabled at the owner's request; no game/launcher
processes were opened, closed, or controlled during this investigation.

## Evidence and fixes

- Owner confirmed native Dust II Deathmatch connects and mid-match unboxing
  announcements appear. Colors, StatTrak and intermittent opening remain UAT gates.
- The running launcher wrote a 306-item account manifest, then overwrote it on
  server handoff with match-scoped inventories of 139, 163 and 167 cosmetics.
  Client cache retained cases but `UnlockCrate` reloaded the reduced file and
  logged `B2G rejected a non-reward case-opening request`. The latest log included
  rejected case IDs ending 0965, 1115, 1037 and 1007.
- Native-session joins now retain the freshly fetched complete account bundle.
  The match grant is still validated, including account, player and schema;
  server scope and owned-only validation are not relaxed. The legacy deep-link
  path without a paired native session remains unchanged.
- At 18:45:43 UTC production had no active sanction for cubsfan49. Re-queueing
  into the same still-live DM was accepted, but the launcher's remembered match
  ID suppressed another connection. A successful explicit DM queue request now
  rearms handoff; periodic polls and competitive requests retain deduplication.
- Rewards ending 1269 (Tec-9 Re-Entry), 1270 (Desert Eagle Code Red) and 1271
  (Five-SeveN Monkey Business) were active and still unacknowledged in production
  (`inventory_position=1073741829`). Reward 1268 had been acknowledged at position
  130. No inventory rows, New flags or rewards were reset/deleted in this work.
- Quick-open alone is **not yet proven fixed**: the native decodable popup's
  reveal sets its session `recent` property and acknowledges the reward. Closing
  it cancels the scheduled reveal. The GC reported successful completion for
  earlier rewards despite missing UI acknowledgements. Retest this path after
  correcting manifest loss; do not blindly clear or reapply New flags.
- Launcher action errors persist through background refresh, and STARTING only
  becomes RUNNING after the verified game-window callback. Self-install handles
  equivalent Windows path spellings. The real pipe test now uses an isolated
  test pipe, not the running game's production bridge.

## Candidate artifacts and verification

- Launcher `apps/web/public/downloads/b2g-launcher-v0.2.17-windows-x86_64.exe`:
  3,817,984 bytes; SHA-256
  `63e872eba1596bbce723909fe4ab3eef26c66d5fbc0718ef6e851da9cb7d666e`.
- 61 launcher tests passed; locked release build passed. Tests cover full
  manifest selection, authorization isolation, acknowledged versus new rewards,
  same-DM reconnection, deduplication and action-error state races.
- All eight native CTest targets and the pinned installed Panorama archive test
  passed. Added keyed/keyless case lifecycle tests cover reward create metadata,
  matching reveal notification ID, ordered cache versions, consumed inputs,
  duplicate completion rejection, unacknowledged restart, and acknowledged
  reload/restart without making existing items new. These do not visually test
  Panorama. The fixture models successful API acknowledgement persistence.
- API/node-agent focused tests: 37 passed. Database integration: 48 passed across
  11 current-source files, including replay-safe exact-asset StatTrak tests.
  The DB runner now excludes archived `.artifacts` source copies. API and node
  agent typechecks passed.
- Game node candidate `.artifacts/game-node/aftertick-game-node-0.1.17.zip`:
  SHA-256 `3a8b7804bc5b26d533738257beae78f7acf842cb5dd7df07639f6075f4dd431e`;
  all 27 packaged files verified; no credentials bundled.
- Candidate SourceMod plugin SHA-256
  `0796fe4d7b91e90b959749403d5077ac90b854d3293cab8a4951d3eb758d32a8`.
  Adds exact item/owner identities from death events and server-authored SayText2
  rarity colors. Node commands now require a positive announcement acknowledgement.
  None of these server changes are live yet. GC and wrapper binaries are unchanged.

## Installation boundary and next checks

Before this update, the installed launcher was an earlier unpublished 0.2.17 candidate, SHA-256
`2c2b1560e9c0fd3841c01eb22c2a168e35fdd5d86a105c60da9b2c3b74522f4d`.
Version labels alone cannot distinguish it; verify the executable hash.
At 19:01:09 UTC both processes were confirmed absent and the approved local
installer completed. Installed hash now matches the candidate above; GC, wrapper
and recoverable Valve backup checks passed, with no processes launched.
Evidence: `.artifacts/game-client-uat/6270d3712c5340c8a127b84469e99239/preflight.json`.
The same directory contains a verified `before-install` backup of replaced files.
The public site/API remain on the 0.2.16 release recorded in the previous checkpoint.
No production maintenance/deployment occurred during the reported failures.

Run `npm run uat:preflight` read-only. Installation via
`npm run uat:preflight -- -Apply` requires both CS:GO and B2G launcher to be
closed; it snapshots replaced files and refuses a live game. The protected local
installation also requires the applicable tool approval. Do not kill the user's
game or use desktop automation to get around this boundary.

The local build is ready for the owner's game test. Test normal and quick opening before joining, during DM,
after leaving, and after rejoining the same DM. Check native reward preview,
New label, acknowledgement, and no duplicate old New items after restart. Confirm
the handoff log says `full paired client` with the full account count.

Exact StatTrak requires coordinated API + game-node deployment and live capture
of nonempty item/owner event fields. Native in-match counters and newly unboxed
items absent from the initial server manifest remain unproven. Rarity colors
still require in-game observation. The overarching launcher-first goal is open.

## Server acknowledgement follow-up (source only, not in 0.2.17)

A separate real server-message regression reproduced a stale snapshot mismatch:
the client's reward acknowledgement changes `CSOEconItem.inventory` from the New
mask to a display position, but the match-owned manifest can retain the original
value. Strict comparison then rejects an otherwise owned equip update. The new
`owned_loadout_tests` server test failed at its first acknowledged single-item
update before the fix; it passed after the fix.

The server now replaces only that display-position field with its trusted
manifest value before validating and forwarding the item. Cache subscriptions,
single updates and multiple updates all serialize the normalized item. Exact
ownership, identity, definition, attributes, quality, rarity and valid equip-slot
checks remain; the shared exact comparator has not been weakened. Client item
creation and deletion are still blocked. No client New flags or database items
are changed by this server normalization.

The native suite and pinned installed Panorama archive check pass; the owned
loadout/case/server regression target also passed 20 consecutive runs. Added server
fixtures cover both directions of acknowledgement drift, valid two-team loadouts,
preserved owner/version, malformed and forged metadata rejection in all three
paths, network-owner mismatch, and blocked create/destroy messages. The test
worker uses a same-thread welcome barrier; a timeout is a test failure rather
than being mistaken for successful rejection. These are protocol tests, not
visual in-game verification.

This server fix is not installed, published, or bundled into the existing
0.1.17 game-node candidate. The locally built follow-up DLL has SHA-256
`16cadc67a73bbf877a1641f256f75a47e31c1af6251c70c8b7d9afebc12f2db2`;
the pinned prebuilt, local game DLL and launcher remain unchanged. It needs a
separately versioned/pinned server release before live testing. This does not
implement authoritative mid-match inventory additions or StatTrak synchronization.

Read-only preflight at 19:15:42 UTC again confirmed the installed 0.2.17 launcher
hash above, matching pinned GC/wrapper and Valve backup, and no running game or
launcher. No new game session was present in the logs after the installation.
Evidence: `.artifacts/game-client-uat/e9572f7b7dfe400faa4139b7e66d4c2d/preflight.json`.
