# Launcher-first 0.2.7 security audit

Date: 2026-09-04
Scope: Express/React application security, launcher Bearer authorization and local bridge, owned-inventory and profile delivery, match settlement, B2G service-drop receipts, node-agent/RCON presentation, the exact-CRC Panorama patch, release artifacts, and the production edge configuration.

## Executive summary

No new critical, high, medium, or low vulnerability was found in the 0.2.7 profile/service-drop change. The implementation keeps the platform reward record separate from Steam-owned inventory, creates it in the same database transaction as authoritative XP settlement, validates the API receipt again at the game node, and permits the SourceMod presentation command only after match end for the exact rostered Steam account. The client patch is fail-closed against one pinned final-2023 archive and does not create a cosmetic item.

The three previously documented residual risks remain: one accepted medium risk for distributing an unsigned alpha executable and two low local/device-token risks. They do not block this private playtest, but the signing and device-management work remains necessary before broad distribution.

## Verified controls

- Browser sessions use a non-default, `HttpOnly`, production-`Secure`, `SameSite=Lax` cookie; Steam login regenerates the session, and cookie-authenticated mutations pass through CSRF middleware (`apps/api/src/auth/session.ts:25`, `apps/api/src/auth/steam.ts:207`, `apps/api/src/app.ts:1072`).
- Express disables framework fingerprinting, trusts exactly one Nginx hop, limits JSON bodies, applies route validation, and rate-limits `/api` (`apps/api/src/app.ts:448`, `apps/api/src/app.ts:449`, `apps/api/src/app.ts:477`, `apps/api/src/app.ts:502`).
- Nginx overwrites the forwarded client chain and applies CSP, clickjacking, MIME-sniffing, referrer, permissions, and HSTS controls (`deploy/nginx.conf:34`, `deploy/nginx.conf:38`, `deploy/nginx.conf:45`).
- The profile/drop count is self-only launcher bootstrap data and uses a parameterized query bound to the authenticated player ID (`apps/api/src/app.ts:690`). It exposes only an aggregate count, not another player's receipts.
- A service drop is a constrained platform receipt with UUID identity, one fixed reward type, one receipt per player/service level, and one per match (`packages/db/migrations/021_player_service_drops.sql:5`). It is not inserted into any Steam inventory or owned-cosmetic table.
- XP and the receipt are committed in one transaction; an idempotent match retry reads the existing ledger/receipt instead of awarding again (`packages/db/src/services/settle-match.ts:80`, `packages/db/src/services/settle-match.ts:215`).
- The node agent treats the API response as untrusted and rejects unknown roster identities, invalid UUID/type/level relationships, inconsistent XP math, missing level-up receipts, and duplicate Steam IDs before constructing RCON (`apps/node-agent/src/event-pump.ts:376`, `apps/node-agent/src/event-pump.ts:432`). RCON values are quoted and escaped (`apps/node-agent/src/agent.ts:102`).
- `sm_aftertick_present_xp` is an `ADMFLAG_ROOT` command, runs only in the ended state, checks the roster and live Steam account, bounds every numeric field, independently deduplicates XP/drop presentation, and sends only the stock generic reward fields (`infra/game-server/plugins/aftertick_match.sp:83`, `infra/game-server/plugins/aftertick_match.sp:526`). RCON is loopback-only and not exposed through the Windows firewall.
- The native patch requires the exact AppID-4465480 final archive and the exact CRC of all four touched entries, requires each source string exactly once, applies replacements transactionally, and recomputes entry CRCs (`vendor/csgo-gc/csgo_gc/panorama_patch.cpp:18`, `vendor/csgo-gc/csgo_gc/panorama_patch.cpp:248`). The launcher embeds and verifies the rebuilt DLL hash (`apps/launcher/src/lib.rs:67`).
- Frontend sink review found no raw HTML injection, string-to-code execution, untrusted `postMessage`, persistent browser auth token, or dynamic third-party script path. The 0.2.7 download is a same-origin, versioned static asset.
- `npm audit --omit=dev --audit-level=high` reported zero production dependency vulnerabilities on 2026-09-04.

## Findings

### SEC-001 — Unsigned launcher executable

- Rule ID: SUPPLY-UNSIGNED-001
- Severity: Medium (accepted alpha risk)
- Location: launcher release/distribution pipeline and `apps/web/public/downloads/`.
- Evidence: 0.2.7 is intentionally distributed without an Authenticode publisher identity; unsigned builds keep automatic self-update disabled.
- Impact: HTTPS protects transport, but a production-host or release-pipeline compromise could replace the executable without an independent Windows publisher signature. Windows also displays the normal unknown-publisher warning.
- Fix: obtain an Authenticode identity, sign the release, publish its digest, and compile the durable publisher identity EKU into the update verifier before enabling automatic updates.
- Mitigation: same-origin HTTPS delivery, immutable versioned filename, published SHA-256, artifact hash verification, and no unsigned automatic updater.
- False-positive notes: this is an explicit private-alpha product decision, not an accidental omission.

### SEC-002 — Local named-pipe denial of service

- Rule ID: LOCAL-PIPE-ACL-001
- Severity: Low
- Location: `apps/launcher/src/launcher_bridge.rs:621` (`create_pipe`).
- Evidence: the pipe uses the process default Windows DACL rather than an explicit current-user security descriptor/first-instance flag. It rejects remote clients and verifies the connecting process image before accepting protocol messages.
- Impact: another process in the same Windows security context may connect first and briefly interfere with the game bridge. It cannot obtain the launcher Bearer credential, and an unverified process cannot issue actions.
- Fix: attach an explicit current-user-only pipe DACL and use the first-instance pipe flag in a future hardening release.
- Mitigation: `PIPE_REJECT_REMOTE_CLIENTS`, exact CS:GO process-path verification, paired SteamID verification, bounded frames, one connection at a time, and no secret material on the pipe.
- False-positive notes: same-user malware can already tamper with the launcher/game directly; this is primarily a nuisance/availability risk.

### SEC-003 — Long-lived device Bearer credential

- Rule ID: AUTH-BEARER-LIFETIME-001
- Severity: Low
- Location: `apps/api/src/launcher-device-service.ts:124`, `apps/api/src/launcher-device-service.ts:261`, and `apps/launcher/src/lib.rs:2648`.
- Evidence: the launcher credential defaults to a 90-day Bearer lifetime and is stored in Windows Credential Manager.
- Impact: theft from the user's Windows credential context could permit account-scoped launcher actions until expiry or revocation.
- Fix: use renewable short-lived access tokens backed by a rotating device refresh credential and add a signed-in device-management/revoke-all screen.
- Mitigation: 256-bit random credentials, digest-only server storage, Windows Credential Manager, credential-free HTTPS origins, redirect refusal, expiry, last-used tracking, and explicit revocation.
- False-positive notes: exploitation requires a compromised local Windows security context or equivalent credential access.

## Verification performed

- Static security review of the Express middleware/auth/CSRF/CORS/proxy path, React sinks and navigation, SQL and settlement idempotency, node response validation/RCON encoding, SourceMod command authorization, native archive patching, artifact provenance, and Nginx edge policy.
- Full browser suite: 14/14 passed.
- Application test suite: 248/248 non-integration tests passed.
- PostgreSQL integration suite: 84/84 passed, including exact-once level-up reward retry behavior.
- Launcher suite: 41/41 passed; native GC patch suite: 7/7 passed.
- Full disposable platform loop (PostgreSQL, Redis, SRCDS, SourceMod, node agent, GOTV, settlement and recovery): passed.
- Production dependency audit: zero vulnerabilities.

This is a source/release-candidate review, not a penetration test of Steam, Cloudflare, VPSDime, or the Windows host. The deployment acceptance pass must still confirm the live migration, HTTPS/security headers, anonymous launcher digest, absence of test identity, and the installed 0.1.13 node release.
