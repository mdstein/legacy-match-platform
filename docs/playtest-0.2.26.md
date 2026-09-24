# Medal and service-drop polish 0.2.26

Deployed 2026-09-07 UTC as `0.2.26-alpha.20260907.0450`. Matchmaking reopened
at 04:57:38 UTC with node 0.1.26 ready, plugin 0.1.7 and fresh RCON health.
The initial maintenance guard detected a newly started match and deferred the
rollout. An allocation-only hold let the active session end before installation;
no active human match or local game was interrupted.

Public download: [launcher 0.2.26](https://play.back2go.net/downloads/b2g-launcher-v0.2.26-windows-x86_64.exe).
The downloaded executable, SHA-256 sidecar, version CLI and public API readiness
were verified. PostgreSQL, Redis and object storage checks passed; MetaMod,
SourceMod, match control, lobby compatibility and anti-cheat were loaded.

API image: `sha256:f593a3bcba4323c10225a1e16e70d8f5003ac0a2f838988afa5bfbb68ad4f57f`.
Web image: `sha256:91da7e5750e1a0bf1b8eb37731cbdff6483e57d26b861c57e1a3eb9979459c4f`.
No pending database migrations. Pre-release backup:
`/var/backups/aftertick/pre-0.2.26-alpha.20260907.0450.dump`, SHA-256
`b3be25a17925685eb121a86bc46686e4c244d82101aa10de2fd892dfed854930`.
Prior app images/environment and game-node backup are retained; the latter is
`C:\ProgramData\Aftertick\backups\before-node-0.1.26-20260907T045522Z`.
Rolling the API back after v4 container grants requires preserving v4 opening
compatibility; the unmodified 0.2.25 API does not accept those grants.

## Changes

- The native medal action is hidden below level 40 and on other players'
  profiles. At level 40 it shows the stock localized Redeem Service Medal label.
- Each of the two independent level-up container rolls changes from **70% case,
  10% souvenir package, 20% pin package** to **93% case, 5% souvenir, 2% pin**.
  There are still **three visible rewards total: two containers and one graffiti**.
  Graffiti retains 50 charges. Case keys are hidden entitlements.
- Policy is `b2g-service-drops-v4`; both generated catalog and generator agree.
  Container-opening rarity odds are unchanged. Existing v3 packages remain
  openable, and completed v2/v3/v4 receipts retain replay compatibility.
- [Correct legacy rarity palette](drop-chat-palette.md), especially purple
  `#8847ff` instead of the light player-name purple `#ba81f0`.
- The owner confirmed successful service-medal redemption on 0.2.25. No account
  level, XP, inventory or prestige was manually changed for this follow-up.

## Candidate and checks

- Launcher 0.2.26: 9,846,784 bytes, SHA-256
  `6daaba1a69e98805397e80058b0329761365539ebce4068814824086089da922`.
- Embedded GC: `4402b8646294b8c70ce24df028e7fd8b98bc78229891dfd739342d46039b63da`.
- Node 0.1.26 ZIP: 28 verified files, SHA-256
  `7c6da3f3b700f2bf518ccc4e67a94cac5b0d18462f247b56afff37774eb528b8`.
- SourcePawn match plugin version 0.1.7 and all six existing SMAC modules compile.
- Full native CTest 8/8; actual final code.pbin patch passes. Executing the medal
  snippet in isolated JS contexts passes six own/other profile states at 1/39/40.
- Focused odds/chat/progression tests: 54/54, including every one of the 10,000
  possible level-up roll values. Full database integration: 62/62, including
  old/new pin and souvenir opening, concurrent result replay and one reward.
- API/node TypeScript checks pass. Rust: 79 tests passed, one ignored, version
  CLI passed. API/web images and immutable launcher packaging succeed.

## Human follow-up

Close CS:GO and start through launcher 0.2.26. Confirm the banner is absent
below level 40 and available at level 40. Open a purple item during Deathmatch
and capture the darker rarity-colored item name. Confirm an existing pin or
souvenir package still opens. Statistical drop percentages are established by
the exhaustive sampler check, not by expecting a particular small reward batch.

The [next launcher goal](launcher-reference-polish-goal.md) uses the owner's
exact ZIP as the visual authority and excludes unnecessary launcher features.
