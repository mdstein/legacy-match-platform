# B2G launcher 0.2.33 — friends and player profiles

Published 2026-09-08 at 00:22 UTC. Builds on both user commits from
`claude/b2g-launcher-icons-and-profile-picture` through `fdde8b0`, preserving
their template refinements, icon renderer and five local profile pictures.

Friends is a native launcher tab. Players can search by name, B2G player ID or
trade code; send requests; accept, decline or cancel requests; and remove a
friend with explicit confirmation. Incoming requests appear in the tab badge.
Duplicate/crossed requests require explicit acceptance. Immutable request IDs
protect retries and prevent old actions from changing a replacement friendship.
Lists are paginated, requests are rate limited, and each player can have 200
friends and 50 pending requests. Existing Steam friends are not imported.

Profiles follow the information hierarchy of the supplied FACEIT reference:
identity, online status, region, membership date, level, current competitive
ELO/authentic rank, a linked Steam profile and recent results. Competitive and
Deathmatch have separate games, wins/losses/draws, win rate, K/D and ADR.
Deathmatch does not change competitive ELO. Private profiles expose only
identity and request controls. Own-profile artwork uses the local launcher
picture preference; other players use initials. Picture choices remain local.

Background results update quietly without resetting search text. Reads and
mutations run off the window thread, with account/view fencing and recovery
for a lost mutation reply. Search has a persistent native label and an explicit
accessible name; Steam's link mark uses the shared icon renderer.

## Verification

- 122 Rust library tests and three executable checks passed. Five ignored
  child entrypoints are intentionally launched by the native watchdog tests.
  The Friends journey exercises real HWND controls, typed search, native
  accessibility-name lookup after typing, Tab/Enter, a lost acceptance reply,
  navigation during completion, an exact retry and removal confirmation.
- Five isolated PostgreSQL Friends tests passed: lifecycle/retries, permissions,
  duplicate and simultaneous opposite requests, stale actions, private/self
  profiles, separate mode statistics and stable pagination.
- Wider coverage: 212 regular Vitest tests passed; database coverage comprises
  93 passing tests. Two migration expectations were updated for migration 034
  and rerun successfully; the XP conversion test also passed in that rerun.
- Workspace type checking and production API, web and launcher builds passed.
- The independent reviewer inspected 32 Friends captures across three window
  sizes and four DPI settings, including actual HWND captures and edge states.
  Its final verdict scored all three listed fixes resolved. Documentation was
  updated afterward. Captures/test logs are reproducible local evidence under
  `apps/launcher/.impeccable/review/friends/` and `.artifacts/diagnostics/`.
- Public download bytes, checksum, executable version, website release binding,
  six protected-route 401 responses and PostgreSQL/Redis/object-store readiness
  passed. Runtime DB privileges for the new table were verified read-only;
  it contained zero friendships at verification. No owner friendships changed.

## Deployment

Launcher: `b2g-launcher-v0.2.33-windows-x86_64.exe`, 11,487,232 bytes,
SHA-256 `ed42debe868dd8f973beae86072adc4acab9a0cf7b0efc76be4e4f3fca949710`.
Download: https://play.back2go.net/downloads/b2g-launcher-v0.2.33-windows-x86_64.exe

Release: `/opt/aftertick/releases/0.2.33-alpha.20260908.0015`.
API image `aftertick-api:b2g-20260908-0015`, ID
`sha256:38db5658f02be1c7206c5a364f0a6222f65641e8289092da06136dbcd4b06d09`.
Web image `aftertick-web:b2g-20260908-0015`, ID
`sha256:134d597d5a081c33ad1695fa08af8200a8200915eade1e5080eabe9b9ca0d4c7`.
Website asset: `/assets/index-CdBGNDtf.js`.

The rollout checked all preceding migrations and topology, verified a backup,
applied only additive `034_player_friends`, then replaced API/web. Initial image
preflight stopped before changes because it had configuration digests rather
than Docker's image index IDs; matching local/host IDs were verified before retry.
Backup: `/var/backups/aftertick/pre-0.2.33-alpha.20260908.0015.dump`, SHA-256
`a7244f798d744cb203d497a21ea0d3249935c05ed7a1f01cd6128cff623b9651`.
Rollback restores the saved release environment and compatible 0.2.32 API/web;
it leaves the additive table and subsequent player activity intact.
Game node remains 0.1.28 and the bundled GC/wrapper pins are unchanged.

## Human acceptance

The first GitHub run exposed test-fixture portability issues: the hosted Windows
desktop can clamp the requested window width, PrintWindow can outlast a hover
transition, and Linux cannot create the Windows COM request IDs used by two
transport journeys. Follow-up test-only changes measure actual native control
bounds, check visible motion endpoints plus deterministic interpolation, and run
the COM-dependent journeys on Windows. The complete local Windows suite passes
again; these corrections do not change the published executable or API images.

Download 0.2.33 and open **Friends → Find a player**. Search for the second
account's name or copied B2G player ID, open its profile and send a request.
On that account, open **Requests**, review the sender and accept. Check both
friend lists, request cancellation/decline, profile mode filters and Steam links.
Verify a private profile from the other account and remove/re-add a friendship.

Two-human-account behavior and appearance on the physical display remain
acceptance checks; no recruited 5v5 is required or claimed. The earlier full
installation/new-account and gameplay/soak checks remain in their release notes.
Existing local launcher/game files were found installed again and left intact;
this release did not repeat the earlier uninstall or alter personal settings.
