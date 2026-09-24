# Launcher-first 0.2.0 security audit

Date: 2026-09-02
Scope: launcher device authorization, launcher Bearer API routes, owned-inventory delivery, the Windows launcher/CS:GO bridge, and the production web edge.

## Executive summary

No critical or high-severity vulnerability was found in the reviewed launcher-first path. The review found no committed production credential, client-side browser token storage, unvalidated launcher API payload, cross-origin credential redirect, or route that exposes launcher account state without a Bearer credential.

One accepted medium risk remains: the alpha launcher executable is intentionally unsigned. Two low residual risks are documented below. These findings do not invalidate the playtest architecture, but the unsigned-binary risk should be removed before broad public distribution.

## Verified controls

- The Express application disables framework fingerprinting, trusts exactly one reverse-proxy hop, applies an explicit JSON limit, and rate-limits all `/api` routes (`apps/api/src/app.ts:409`, `apps/api/src/app.ts:410`, `apps/api/src/app.ts:438`, `apps/api/src/app.ts:464`).
- Production CORS is built from the configured HTTPS public origin and explicit origin allowlist. The deployed Nginx proxy is the sole public hop and replaces forwarded client headers.
- Browser sessions use a non-default cookie name with `HttpOnly`, production `Secure`, and `SameSite=Lax`; Steam login regenerates the session before establishing identity (`apps/api/src/auth/session.ts:26`, `apps/api/src/auth/session.ts:33`, `apps/api/src/auth/steam.ts:211`).
- Cookie-authenticated mutations are behind CSRF middleware. Launcher mutations use explicit Bearer authorization instead of ambient cookies (`apps/api/src/app.ts:643`, `apps/api/src/app.ts:666`, `apps/api/src/app.ts:678`, `apps/api/src/app.ts:696`, `apps/api/src/app.ts:897`).
- Device and access credentials are generated from 32 random bytes, only SHA-256 digests are persisted, exchange rows are locked transactionally, and access checks enforce expiry and revocation (`apps/api/src/launcher-device-service.ts:135`, `apps/api/src/launcher-device-service.ts:175`, `apps/api/src/launcher-device-service.ts:254`, `apps/api/src/launcher-device-service.ts:293`).
- Launcher HTTP requests require credential-free HTTPS URLs, reject redirects, bound response sizes, and store the access credential in Windows Credential Manager rather than a plaintext file (`apps/launcher/src/lib.rs:2462`, `apps/launcher/src/lib.rs:2639`).
- The local game bridge rejects remote clients, caps every frame at 64 KiB, verifies the connecting process is the exact discovered CS:GO executable, and binds its first message to the paired SteamID (`apps/launcher/src/launcher_bridge.rs:11`, `apps/launcher/src/launcher_bridge.rs:335`, `apps/launcher/src/launcher_bridge.rs:396`, `apps/launcher/src/launcher_bridge.rs:432`). No web or launcher credential crosses this pipe.
- The production edge sets CSP, clickjacking protection through `frame-ancestors`, MIME sniffing protection, referrer policy, permissions policy, and HSTS (`deploy/nginx.conf:34`).
- `npm audit --omit=dev --audit-level=high` reported zero production dependency vulnerabilities on 2026-09-02.

## Findings

### SEC-001 — Unsigned launcher executable

- Severity: Medium (accepted alpha risk)
- Location: launcher release/distribution pipeline; unsigned builds deliberately disable automatic self-update.
- Evidence: the release is intentionally distributed without Authenticode publisher identity. The launcher only enables its pinned-publisher update path when a publisher EKU is compiled in.
- Impact: TLS protects download transport, but a compromise of the production host or release pipeline could replace the executable without a Windows publisher signature providing an independent integrity check. Users also receive the normal unknown-publisher warning.
- Fix: obtain an Authenticode code-signing identity, sign the release, publish the hash, and compile the pinned publisher identity EKU into the updater before enabling automatic updates.
- Current mitigation: HTTPS-only same-origin download, no unsigned automatic update, a versioned artifact, and release hash verification in the deployment workflow.
- False-positive note: this is an explicitly accepted product decision for the private alpha, not an accidental omission.

### SEC-002 — Local named-pipe denial of service

- Severity: Low
- Location: `apps/launcher/src/launcher_bridge.rs:386` (`create_pipe`).
- Evidence: the pipe uses the launcher process's default Windows DACL rather than an explicit current-user security descriptor. It rejects remote clients and verifies the client PID image path before accepting protocol messages.
- Impact: another process in the same Windows security context may be able to connect first and briefly interfere with the bridge. It cannot obtain the Bearer credential, and an unverified process cannot issue queue actions.
- Fix: attach an explicit current-user-only pipe DACL and use a first-instance pipe flag in a future hardening release.
- Mitigation: `PIPE_REJECT_REMOTE_CLIENTS`, exact process-path verification, paired SteamID verification, one connection at a time, bounded frames, and no secret material on the pipe.
- False-positive note: malware already running as the same user can generally tamper with the game or launcher directly; this finding primarily concerns local nuisance/denial of service.

### SEC-003 — Long-lived device Bearer credential

- Severity: Low
- Location: `apps/api/src/launcher-device-service.ts:254` and Windows Credential Manager storage at `apps/launcher/src/lib.rs:2639`.
- Evidence: launcher credentials default to a 90-day lifetime and are Bearer tokens.
- Impact: local credential theft could allow account-scoped launcher actions until expiry or revocation.
- Fix: add renewable short-lived access tokens backed by a rotating device refresh credential, plus a launcher-device management screen with revoke-all support.
- Mitigation: 256-bit random token, digest-only database storage, Windows Credential Manager storage, HTTPS-only requests, redirect refusal, expiry, last-used tracking, and an existing revoke endpoint/CLI command.
- False-positive note: exploitation requires access to the user's Windows credential context or another local compromise.

## Verification performed

- Static review of Express middleware ordering, Steam OpenID/session lifecycle, CSRF separation, route schemas, CORS/proxy topology, launcher credential issuance/storage, inventory fetch bounds, outbound redirect policy, and local pipe authentication.
- Secret-pattern scan across the working tree and staged diff, including previously supplied GSLT and server-password values: no match.
- Frontend sink scan for raw HTML injection, string-to-code execution, unsafe `postMessage`, persistent browser auth tokens, and script-bearing URLs: no applicable application finding.
- Production dependency audit: zero vulnerabilities.
- Application/launcher test suite: 113 application tests and 33 launcher tests passed, including a real Windows named-pipe handshake and state exchange.

This is a source and local-build review, not a penetration test of the live VPS, Steam client, Windows host, or Cloudflare account. Production verification should still confirm deployed headers, anonymous artifact hashes, migration state, and that no debug/test identity environment variable is enabled.
