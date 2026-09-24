# Service medal release 0.2.25

Follow-up: the owner confirmed successful redemption. [Release 0.2.26](playtest-0.2.26.md)
removes the below-level-40 banner. The grant and pending-test observations below
describe the original deployment checkpoint, not the account's current state.

Deployed 2026-09-07 UTC. Matchmaking reopened at 04:22:30 UTC after the active
Deathmatch completed, with node 0.1.25 freshly ready and no active lease. No
running human match was interrupted. The user's local game was left running;
it must be closed and started through launcher 0.2.25 to load the new GC.

## Published artifacts

- API/web release: `0.2.25-alpha.20260907.0420`.
- Public launcher: [0.2.25 Windows x64](https://play.back2go.net/downloads/b2g-launcher-v0.2.25-windows-x86_64.exe), 9,846,784 bytes,
  SHA-256 `466c8a572a3b3552dc84ccd5a6ae80f2617ce4062b40eeae7651098af03c6372`.
  The public executable, checksum sidecar, and `--version` were verified.
- Game-node archive: `0.1.25`, 28 verified files, SHA-256
  `b47e2070d9b11219fe819ac2489ea7d6085d2d6cd1094906692c73dbad0f2079`.
- Shared native DLL: `c96fbba937fe47d76e5ad9584937d42aed7d74731885bed785e8bfb9b7c2c677`.
- API image ID: `sha256:9fabe6d32912641f4afbf8d5a4da7e7badf4a06580efad6863aa5ed0981aea2c`.
- Web image ID: `sha256:a0a8c2fbdf2b6203b643ff6da7d618df94ca9d162bbd098d8763cb6f091c4a21`.

## Behavior and validation

[Service medal implementation and human checklist](service-medals.md) describes
the stock native preview/confirmation, all 51 valid tiers, shared equipment slot,
atomic level reset, same-asset upgrades, and recovery behavior. The database
catalog uses the final September 2023 schema. The first two passes visit every
year from 2015 to 2023; pass three begins with 2016. No undefined tiers are minted.

- Full database regression: 58/58 tests in 12 files, including six medal tests,
  migration repeatability, concurrent/idempotent claims, capacity, all 51 tiers,
  equipped upgrades, rollback, and level-drop settlement after prestige.
- Native MSVC x86 Release build and CTest: 8/8. Real named-pipe tests cover
  authoritative preview, failure reason transport, rejection without a saved
  medal, one award/reset, duplicate response rejection, and shared equipment.
- Exact final `code.pbin` patch test passed; both patched scripts also passed
  full-script JavaScript syntax checks. These do not constitute visual testing.
- Rust launcher: 79 unit tests passed, one ignored; version CLI passed.
  API/node typechecks, API route tests, node policy tests, and API/web image builds passed.
- Production: migration 031 applied; API readiness passed PostgreSQL, Redis and
  object storage. Medal preview without authentication returned 401. The game
  node reported 0.1.25, fresh ready state and RCON health; MetaMod, SourceMod,
  match control, lobby reservation compatibility and anti-cheat were loaded.

## Owner's test account

The existing paired launcher identified `cubsfan49`, player
`f22214d3-15e3-4ad3-97ae-e70682f18ac5`, Steam `76561198000000077`.
The expressly requested grant set profile level to 40 and XP to 0, preserving
lifetime XP (1,044), prestige zero and inventory. It created one audit record
(`playtest.service_medal_level40`, operation `service-medals-0.2.25-owner-test`).
It awarded no medals or level-up drops. The database showed zero redemption
receipts, and the downloaded public launcher confirmed level 40 / XP 0 from
the live authenticated API with release version 0.2.25.

The owner must perform the actual first redemption: cancel the 2015 preview
once, reopen and confirm, verify level 1 / XP 0 and one medal, equip it, restart,
and check persistence and the disabled “Level up to upgrade” label. Native
appearance, keyboard/controller interaction and live reveal are still unverified.

## Rollback evidence

The app rollout retained the prior 0.2.24 release, image references, and protected
environment backup. The pre-migration database backup is
`/var/backups/aftertick/pre-0.2.25-alpha.20260907.0420.dump`, SHA-256
`bb41ac72f8862c79f781980a9ec4dcaa3ea35be59612bab2e905f9fdbcd2b17a`;
its archive listing was checked. Migration 031 is additive to old application
reads, though old releases do not implement prestige-aware level-drop inserts.
Do not roll back the application after claims begin without assessing those writes.

Windows rollback files are retained under
`C:\ProgramData\Aftertick\backups\before-node-0.1.25-20260907T041839Z`.
The installer verified the installed native hashes and Local Service task with
Normal scheduling priority. Secrets stayed on the hosts and were not bundled.

## XP pacing

This release does not change XP rewards. B2G requires 5,000 XP per level,
awards Competitive XP at 30 per team round won (capped at 1,000 per match),
and does not currently implement weekly bonus XP. A 16-round win gives 480 XP,
a 15–15 draw 450 XP, and a loss with 10 rounds won 300 XP.
