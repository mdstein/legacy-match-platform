# B2G 0.2.16 playtest checkpoint

Recorded 2026-09-05. This checkpoint separates deployed artifacts from behavior
that still needs observation in the game. It does not mark the launcher-first
goal complete.

## Deployed artifacts

- Source checkpoint: `f1aeb45b42f8d1530d110812c9f9c5534262d578` on private `main`.
- App release: `/opt/aftertick/releases/0.2.16-alpha.20260905.0141`.
- Public launcher: `https://back2go.net/downloads/b2g-launcher-v0.2.16-windows-x86_64.exe`.
  Anonymous download returned HTTP 200, 3,800,064 bytes, and SHA-256
  `6113dd278f3085b903917e245480b80799d6439b663646241ef12c8d08704e67`.
- Migration `029_case_catalog_wear_inheritance` is recorded in production.
- The owner supplied successful Windows game-node **0.1.16** post-install checks:
  active release `C:\ProgramData\Aftertick\releases\0.1.16`, task running as
  `LOCAL SERVICE`, rootless owned-only policy enabled, local-GC RCON disabled.
  GC SHA-256:
  `10349246a0c43e01da601b669fb66cf0caf34b05e39c35d54a5b63a90ee413b9`.
  Match plugin SHA-256:
  `a8325330788254631c53136ff67a86950c29bb792b2254cb5fc104f57343dd93`.
- A subsequent production read observed `na-central-01` active with a heartbeat
  two seconds old at `2026-09-05 17:34:24 UTC`. The API health endpoint returned
  HTTP 200 with `status: ok` after following the canonical-host redirect.

The heartbeat's `agent_version` is currently hard-coded to `0.1.0` in
`apps/node-agent/src/agent.ts`; it cannot independently prove the installed
release. The owner's installer output and matching binary hashes establish
the game-node version. At verification, the game-server instance reported
`offline`; node liveness does not prove a running or joinable match.

## Inventory reset and case evidence

The authorized, audited, one-time operation for cubsfan49 removed 150 active
B2G cosmetics produced directly by old case grants. It did not delete Steam
inventory, admin cosmetics, souvenir/pin results, sprays, or unopened containers.
The deletion audit records asset IDs; no automatic item-restore command was
created.

A read-only production query verified the new batch contained exactly 250
unopened cases, 39 distinct case definitions, 6–7 copies of each definition,
250 active matching virtual keys, and only `b2g-cases-v4` grants. At that point,
no active cosmetics remained directly backed by an old case grant.

The catalog uses the pinned final-client item schema, container-specific special
reward lists, inherited paint-kit wear bounds, and localized item names.
Catalog tests cover representative case families and require every glove reward
to stay within 0.06–0.80. These checks validate generated data, not the final
in-game model or image rendering.

## Required game observations

Use launcher 0.2.16 and leave it open while testing the game.

- Open fresh cases from several families, including Glove Case. Verify the result
  model, name, finish, wear, native reveal, and `New!` behavior. Acknowledged items
  should remain acknowledged after a full restart; actually new items should be
  announced.
- Select Official Matchmaking, Deathmatch, Dust II, and GO. Verify assignment,
  connection, bots, and match-end process shutdown followed by a fresh requeue.
- Verify Practice With Bots still selects and starts a local map.
- Equip a StatTrak weapon, record its count, earn kills on a B2G match, and compare
  the count during play and after relaunch.
- Open a case during a B2G match and verify the opener's message and another
  player's chat announcement.
- Recheck rank/XP presentation and equipped skins during play and after restart.
- Competitive still needs a real ten-client ready-check/accept/connect match;
  unit/integration coverage does not establish its native presentation for ten
  independent players.

## Follow-up found during verification

Persistent B2G StatTrak is implemented in signed `player.killed` ingestion;
0.2.16 also restores forwarding of the server engine's native counter update.
However, `statTrakAssetForKill` currently selects the first equipped matching
weapon in the signed manifest by weapon name. The kill event does not include
the weapon's asset ID. This can credit the wrong item when multiple team
loadouts use the same weapon, and does not prove attribution after mid-match
equipment changes or weapon pickups. Fix exact server-observed item attribution
and test event replay without incrementing twice before declaring StatTrak
complete.

The Linux release ownership fix passed the isolated activation/rollback fixture
and is installed in `/usr/local/bin/aftertick-deploy-release`. Production
readiness and the current release pointer were verified. A full exact-image
production rollback drill remains a separate gate; the fixture alone does not
prove it.
