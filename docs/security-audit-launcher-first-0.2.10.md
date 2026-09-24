# Launcher-first 0.2.10 security audit

Date: 2026-09-04

Scope: the native keyless case-completion repair, owned-only client-message policy, supported-mode Panorama hardening, rebuilt embedded GC, and unsigned Windows launcher release. This is an incremental review over `security-audit-launcher-first-0.2.9.md`.

## Executive summary

No new security vulnerability was found in the 0.2.10 change. The case failure was an availability defect: owned-only mode rejected Panorama's legacy struct-framed `k_EMsgGCUnlockCrate` before the existing authoritative launcher/API flow could run. The repair permits exactly that struct message and continues to reject unrelated client mutations. Reward selection, input consumption, idempotency, and ownership remain controlled by the authenticated API and PostgreSQL transaction.

The Deathmatch failure was a client-state defect: the supported Deathmatch mode could inherit the saved `listen`/Practice With Bots server type, while hidden stock radios had lost grouping state. The patch now forces the `official` server type, clamps session presentation to Competitive or Deathmatch, collapses unsupported controls in both XML and runtime synchronization, and keeps the exact pinned-archive fail-closed boundary.

The accepted unsigned-alpha executable risk and the two previously documented low local/device-token risks are unchanged.

## Verified controls

- `IsOwnedOnlyClientMessageAllowed` is independently tested. Struct framing permits only `k_EMsgGCUnlockCrate`; protobuf framing retains the existing hello, cache refresh, equip, supported matchmaking, profile, and event-favorites allowlist. Delete, craft, store, and other mutations remain denied.
- The permitted unlock message still passes through `UnlockCrate`, which rejects malformed requests, non-B2G containers, missing launcher authority, concurrent opens, and case/key IDs absent from the signed owned manifest. A keyless B2G open sends only the exact asset IDs to the paired local launcher.
- The launcher calls its fixed HTTPS API origin using the paired Bearer credential. The API locks and validates the player's unopened grant and active compatible hidden entitlement, selects the reward with cryptographic randomness, consumes both inputs, records one immutable result, and returns the authoritative reward asset ID.
- The GC accepts completion only for its one pending request and only after the refreshed signed manifest removes the case/entitlement and contains the exact new reward. It then emits the stock SO destroy/create and unlock notification messages needed to finish Panorama's reveal.
- The Panorama patch remains length-preserving and accepts only the six CRC-pinned entries in the exact 4,704,521-byte final AppID 4465480 archive. Unknown archives or entries are rejected transactionally.
- Unsupported mode tabs and the unused quick-selection rail use inline `visibility: collapse` plus runtime visibility enforcement. Session display and submission are clamped to Competitive or Deathmatch and to the `official` server type, preventing a saved offline/workshop mode from creating a hollow B2G page.
- The launcher embeds `csgo_gc.dll` only when its SHA-256 is `a0640bbebd1f20833cf7cd32bbba547de27edcf56906f7a6ba3cfed79119342b`. The 0.2.10 executable SHA-256 is `1428e25a2c01f56f494574b3dac231e077d2aa5b610a38e2f03097bbd36797fb`; Authenticode status is intentionally `NotSigned`.

## Verification performed

- Native GC/Panorama suite: 7/7 passed, including the owned-only allowlist regression and exact installed `code.pbin` acceptance.
- Rust launcher: 44 passed; the real singleton named-pipe test was filtered because the running installed launcher/game session owned the pipe.
- TypeScript workspace typecheck: passed.
- Vitest: 249 passed; 127 environment-gated tests skipped by their declared gates.
- API and production web builds: passed.
- Playwright launcher, recovery, and matchmaking suite: 14/14 passed.
- Impeccable detector on the two changed launcher-download components: no findings.
- Production read-only inventory check after two failed 0.2.9 animations: 100 grants, zero opened, 100 active cases, 100 active hidden entitlements, and one active cosmetic. No item was consumed by the rejected client messages.

## Production acceptance

- Commit `f975070d57ef9753556cb453b9d26ae7521a8e82` is pushed to `main`; immutable host release `0.2.10-alpha.20260904.1910` is active with healthy API and web containers. PostgreSQL, Redis, and object storage passed public readiness.
- A fresh anonymous HTTPS download returned `200`, `application/octet-stream`, and `3,744,256` bytes. Its SHA-256, the anonymously fetched checksum sidecar, and the local release artifact all equal `1428e25a2c01f56f494574b3dac231e077d2aa5b610a38e2f03097bbd36797fb`.
- The anonymously fetched production JavaScript bundle contains both the 0.2.10 download target and visible 0.2.10 launcher label. HSTS, CSP, `nosniff`, frame-ancestor denial, referrer policy, and restrictive permissions policy remain present at the edge.
- Native case reveal/persistence and Deathmatch layout/assignment remain explicit human-observation gates.

This is a source and release-candidate review, not a penetration test of Steam, Cloudflare, VPSDime, or the Windows game host.
