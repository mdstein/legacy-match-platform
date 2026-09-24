# Launcher-first 0.2.8 security delta

Date: 2026-09-04

Scope: the final-2023 native Deathmatch classifier, authoritative local rank/XP presentation, the expanded build-pinned Panorama archive patch, and the unsigned Windows release artifact. This is an incremental review over `security-audit-launcher-first-0.2.7.md`.

## Result

No new critical, high, medium, or low vulnerability was found in the 0.2.8 change. The previously accepted unsigned-executable risk and the two documented low local/device-token risks remain unchanged.

## Controls verified

- Deathmatch is recognized only from the exact observed final-client wire value `518` when ticket data is absent. The observed Casual, War Games, and Danger Zone values remain rejected, preventing a shared low-byte flag from routing unsupported modes into a B2G server.
- Launcher profile state remains a fixed 40-byte local message from the PID-verified CS:GO process boundary. Rank, level, XP, and queue phase are bounded before use; credentials never enter the bridge or game process.
- Rank and service progress are published only as ephemeral CS:GO presentation objects. The change neither creates a Steam economy item nor mutates the immutable owned-item manifest.
- The Panorama change is fail-closed to the exact AppID 4465480 final archive and now pins five entry CRCs, including `playercard.js`. Every source marker must occur exactly once before any write; all replacements are length-preserving and transactional, and entry CRCs are recomputed in memory.
- The placement gate now defers to a positive authoritative B2G rank rather than inventing Competitive wins. The real B2G wins value remains unchanged.
- SOCache updates use consecutive versions and publish non-empty persona/account objects only after validated launcher state. A later refresh rebuilds the same authoritative snapshot.
- The versioned public executable is unsigned by design, has automatic self-update disabled, and is paired with a same-origin SHA-256 file. Release SHA-256: `6da473d444d21a29ba74f57a1730527f38637646a7af3e9883cb61a76a4955ff`.

## Verification

- Native GC/Panorama suite: 7/7 passed, including authoritative live/snapshot profile messages.
- Final installed `code.pbin`: exact archive patch accepted in memory (`4,704,521` bytes).
- Launcher suite: 43/43 passed, including the authenticated Windows named-pipe test and exact Deathmatch/unsupported-mode fixtures.
- API launcher contract tests: 16/16 passed.
- Web production build: passed.
- Installed launcher and embedded GC hashes match their release inputs; Authenticode status is `NotSigned` as required for this alpha channel.

## Production acceptance

- Commit `739a1f8` passed the GitHub `verify` workflow and was activated on the VPSDime application host as immutable release `0.2.8-alpha.20260904.2132`.
- The API and web containers reached Docker `healthy`; `/ready` returned HTTP 200 with PostgreSQL, Redis, and object storage all `ok`.
- A fresh anonymous request through Cloudflare downloaded exactly `3,712,512` bytes from `https://play.back2go.net/downloads/b2g-launcher-v0.2.8-windows-x86_64.exe`. Its SHA-256 was `6da473d444d21a29ba74f57a1730527f38637646a7af3e9883cb61a76a4955ff`, exactly matching the independently fetched same-origin checksum.
- The anonymous response carried `application/octet-stream`, HSTS, CSP, Permissions-Policy, Referrer-Policy, and `X-Content-Type-Options: nosniff`; the downloaded file remained `NotSigned` as required for the accepted alpha policy.
- The deployed JavaScript bundle contains the versioned `b2g-launcher-v0.2.8-windows-x86_64.exe` target. The installed per-user launcher has the same SHA-256 and reports AppID 4465480 build/client `1575` ready with no blocking condition.
- A live authenticated `0.2.8` GO session refreshed two verified owned items, submitted a signed NA Central route measurement, verified the expected SteamID at the named-pipe boundary, and delivered `rank=7`, `wins=0`, `level=3`, `xp=0` to the local GC. Visual Panorama acceptance remains an explicit human-observation gate.
