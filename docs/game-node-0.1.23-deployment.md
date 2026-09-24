# Production game-node update: 0.1.23

Completed on 2026-09-07 at 01:41:54 UTC, following the owner's instruction to
update the game server for the old unboxing message and missing live StatTrak.

## Confirmed cause

The Windows host `the Windows game node` was still using release `0.1.16`, match plugin
`0.1.5`, and GC hash
`10349246a0c43e01da601b669fb66cf0caf34b05e39c35d54a5b63a90ee413b9`.
The old agent reported its hardcoded version `0.1.0` in heartbeats and did not
advertise `inventorySyncVersion`.

Deathmatch `e072ccf1-7edd-4327-8d4a-8981a6035126` completed before maintenance.
Its stored kill events contained weapon names but lacked the weapon asset and
original-owner fields required for permanent B2G StatTrak credit. The installed
client already had launcher 0.2.23 and the current GC; that alone could not
enable these server changes.

## Installation and verification

- Verified all 28 files in the immutable game-node 0.1.23 archive, SHA-256
  `c36020e8b4035f19e55cb6548aea47e86757afd4b635b111f5902c94cc23b799`.
- Used the existing authenticated SSH deployment keys. Contrary to older
  runbooks, unattended administrative access is now confirmed to work.
- Waited for the match to complete and its active lease to clear, then held
  `na-central-01` in draining status to prevent new allocations.
- Validated the release on the host before activation. The installer refused
  to apply while SRCDS was running; no active player session was killed.
- Backed up the previous release pointer, service scripts, scheduled task,
  server addons/configuration, wrapper and GC before applying the update.
  Credentials were backed up within the protected secrets directory and kept
  on the server. The plugin-version setting now reports 0.1.6.
- Installed the complete 0.1.23 release and verified the running node service,
  executable version and installed native hashes.
- Started the server through the control plane while maintenance was held.
  RCON confirmed match plugin 0.1.6 loaded with all six SMAC plugins, no active
  match ID and zero human players.
- Reopened matchmaking only after a fresh heartbeat reported node 0.1.23,
  `inventorySyncVersion: 1`, instance `ready`, plugin 0.1.6 and reachable RCON.
  The verification start command completed successfully.

Installed GC SHA-256:
`bcd9ae594d564c08d1e8de3b48e1d357412c1e4d36f2cf98d88b7e2b0a2637aa`.
Installed match plugin SHA-256:
`d884a14c9d4bf209a8f2d9a99a0872f41521ace9b38683faccc01f525deb0b0e`.

The host rollback backup is
`C:\ProgramData\Aftertick\backups\before-node-0.1.23-20260907T013835Z`.
The non-secret installation report was copied to
`.artifacts/releases/game-node-0.1.23-installed.json`.

## Gameplay confirmation and remaining checks

The owner subsequently confirmed that both reported issues are fixed: the old
unboxing message and missing StatTrak increments. They observed a remaining
1-2 second delay before the updated counter becomes visible. This is a
responsiveness follow-up, not a report of missing kill credit.

Persistence after reconnect/restart and the full presentation regression matrix
still need explicit verification. No synthetic rewards or kills were inserted.
Read-only responsiveness research identified the live 2000 ms event-ingestion
heartbeat, the GC policy polling gate, and SRCDS running Below Normal priority.
The research proposes faster committed delivery and optional server-confirmed
provisional display with reconciliation; no optimization was deployed in that
research task.

The API remains `0.2.18-alpha.20260905.2110`. The website and downloadable
launcher were not deployed in this server-update task. The separate pending
API endpoint for launcher queue cleanup remains part of the coordinated release
work described in the earlier checkpoint.
