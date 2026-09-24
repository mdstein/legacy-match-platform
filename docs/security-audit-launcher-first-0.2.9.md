# Launcher-first 0.2.9 security audit

Date: 2026-09-04

Scope: native queue narrowing and timeout recovery, guaranteed service-level case drops, the B2G-only inventory, keyless zero-cost case opening, amplified knife rewards, launcher/local-GC inventory refresh, the permanent audited admin case/M9 grants, the temporary Global Elite override, and the unsigned Windows release artifact. This is an incremental review over `security-audit-launcher-first-0.2.8.md`.

## Executive summary

No new critical, high, medium, or low vulnerability was found in the 0.2.9 change. Case outcomes are generated once by the authenticated API using Node's cryptographic RNG and committed atomically with input consumption. The game never chooses or reports its own reward. PostgreSQL independently enforces account ownership, active-cosmetic loadouts, and automatic removal of stale selections. B2G items are explicitly non-Steam and cannot be transferred into Steam ownership.

The previously accepted unsigned-executable risk and the two documented low local/device-token risks remain unchanged. They do not block the private alpha.

## Verified controls

- The opening endpoint is launcher-Bearer-only, rate-limited with the rest of `/api`, Zod-validates decimal asset IDs, derives the player from the credential, and emits `no-store`/`nosniff` responses (`apps/api/src/app.ts:68`, `apps/api/src/app.ts:1079`). Browser cookies alone cannot invoke it; the unauthenticated case is covered by an API test.
- `openB2GCase` locks the player's case grant and both inventory inputs, validates an active same-player compatible entitlement, uses `crypto.randomInt`, consumes the case and hidden entitlement, creates exactly one reward, and records the result in one transaction (`apps/api/src/inventory-service.ts:524`, `apps/api/src/inventory-service.ts:1064`). A keyless retry returns the recorded reward rather than rerolling; a legacy explicit-key retry must match the recorded entitlement.
- The 5% knife and 10% firearm StatTrak rates are versioned as `b2g-cases-v1`. The catalog was generated from the installed final-September-2023 `items_game.txt` with SHA-256 `510e09b68a01d88edba2342972960025fd6484aaaa58365fcf47d8513de79623`, yielding 39 uniformly selected cases, 606 firearm finishes, and 456 legacy knife/finish rewards (`scripts/extract-b2g-drop-catalog.mjs`, `packages/db/src/drop-catalog.ts`).
- Level-up issuance remains in the authoritative exact-once settlement transaction. Every crossed service level allocates one compatible case/key pair; the existing player/service-level uniqueness fence prevents duplicate drops (`packages/db/src/services/settle-match.ts:177`).
- B2G items carry a fixed `source='b2g'`, constrained kind/state/econ fields, and a dedicated high-range asset sequence. Service-level and audited admin cases share one authoritative grant table. The schema's deferred ownership trigger accepts only a same-player Steam-compatible item or an active same-player B2G cosmetic; containers cannot be equipped. Delete/consume triggers remove stale loadouts (`packages/db/migrations/022_b2g_case_inventory.sql`).
- The monotonically increasing per-player B2G inventory revision causes the launcher to refresh only after an authoritative transition. Hidden entitlements are excluded from player views and launcher manifests; node match manifests explicitly filter to cosmetics, so cases and entitlements never enter server loadouts (`apps/launcher/src/client_session.rs:667`, `apps/api/src/inventory-service.ts`).
- The local bridge uses fixed-size case-open request/result frames. The launcher submits only to its paired HTTPS API origin and refreshes the signed local manifest before acknowledging success. The GC validates the pending IDs, the disappearance of the exact inputs, and the appearance of the exact reward before publishing native SO destroy/create and unlock notification messages (`apps/launcher/src/launcher_bridge.rs:295`, `vendor/csgo-gc/csgo_gc/gc_client.cpp:1439`, `vendor/csgo-gc/csgo_gc/gc_client.cpp:2500`).
- Owned-only GC mode refuses real Steam containers, B2G non-container inputs, local RNG, concurrent opens, and malformed launcher results. A CRC-pinned patch activates Panorama's existing `decodeablekeyless` route only for the dedicated 19-digit B2G asset range; stock cases, contents, animation, and notification remain unchanged. The API, not the client, selects and consumes the compatible entitlement.
- The playtest operator CLI is not exposed over HTTP, requires a 17-digit Steam ID plus direct database access, locks the player, and is idempotent. It permanently grants one audited M9 Bayonet Doppler Sapphire (paint kit 416, wear `0.007`) and one audited 100-case test batch, while recording and reversibly overriding only the player's rating to Global Elite (`apps/api/src/playtest-grant.ts`).
- Native menu changes remain length-preserving and fail closed against the exact pinned AppID 4465480 Panorama archive. Competitive exposes only Premier; Deathmatch exposes only the supported B2G group; unimplemented queues are hidden (`vendor/csgo-gc/csgo_gc/panorama_patch.cpp`).
- The launcher embeds the rebuilt GC only when its SHA-256 is `48de0bba0330e44e2f8f277306611a70ed6b6e2caede4bb979f100b5c8261207` (`apps/launcher/src/lib.rs:68`). The 0.2.9 executable SHA-256 is `00c580c047761c823c17d93cde3cf855d52b690c3b8c77cf4eebbe05743492a8` and Authenticode status is intentionally `NotSigned`.

## Findings

### SEC-001 — Unsigned launcher executable

- Rule ID: SUPPLY-UNSIGNED-001
- Severity: Medium (accepted alpha risk)
- Location: launcher release/distribution pipeline and `apps/web/public/downloads/`.
- Evidence: 0.2.9 is intentionally distributed without an Authenticode publisher identity; unsigned builds keep automatic self-update disabled.
- Impact: HTTPS protects transport, but a production-host or release-pipeline compromise could replace the executable without an independent Windows publisher signature. Windows displays the normal unknown-publisher warning.
- Fix: obtain an Authenticode identity, publish its digest, pin the durable publisher identity in the updater, and sign every release before enabling automatic updates.
- Mitigation: same-origin HTTPS delivery, immutable versioned filename, published SHA-256, embedded GC hash verification, and no unsigned automatic updater.
- False-positive notes: this is an explicit private-alpha decision.

### SEC-002 — Local named-pipe denial of service

- Rule ID: LOCAL-PIPE-ACL-001
- Severity: Low
- Location: `apps/launcher/src/launcher_bridge.rs` (`create_pipe`).
- Evidence: the pipe uses the process default Windows DACL instead of an explicit current-user descriptor/first-instance flag. Remote clients are rejected and the connecting process image is verified before protocol use.
- Impact: another process in the same Windows security context may connect first and briefly disrupt the bridge. It cannot obtain the launcher credential, and an unverified process cannot issue actions.
- Fix: attach a current-user-only pipe DACL and first-instance flag in a future hardening release.
- Mitigation: remote-client rejection, exact CS:GO process-path and SteamID verification, bounded frames, one connection at a time, and no secret material on the pipe.
- False-positive notes: this is primarily a same-user availability risk.

### SEC-003 — Long-lived device Bearer credential

- Rule ID: AUTH-BEARER-LIFETIME-001
- Severity: Low
- Location: `apps/api/src/launcher-device-service.ts` and Windows Credential Manager storage in `apps/launcher/src/lib.rs`.
- Evidence: the launcher credential defaults to a 90-day Bearer lifetime.
- Impact: theft from the user's Windows credential context could permit account-scoped launcher operations until expiration or revocation.
- Fix: use short-lived access tokens backed by a rotating device refresh credential and add device/revoke-all management.
- Mitigation: 256-bit random credentials, digest-only server storage, Windows Credential Manager, HTTPS origins, redirect refusal, expiry, last-used tracking, and explicit revocation.
- False-positive notes: exploitation requires local credential-context compromise or equivalent access.

## Verification performed

- TypeScript workspace typecheck: passed.
- Vitest: 249 passed; 127 environment-dependent tests skipped by their declared gates.
- PostgreSQL integration: 20 files / 85 tests passed, including keyless and cross-paired entitlement consumption, concurrent retry recovery, cross-account denial, database-level container-equip rejection, exactly-once reward creation, manifest refresh, and consumed-loadout removal.
- Rust launcher: 44 passed; one real named-pipe test was filtered because the currently running installed launcher owns the singleton pipe. The rest of the bridge/parser/session suite passed.
- Native GC/Panorama suite: 7/7 passed; the patch also accepted the exact installed 4,704,521-byte AppID 4465480 `code.pbin` and its six pinned entry CRCs.
- Playwright: 14/14 passed after a production web build.
- `npm audit --omit=dev --audit-level=high`: zero production dependency vulnerabilities.
- Release doctor: launcher 0.2.9 found AppID 4465480 client build 1575, legacy inventory access ready, and no blocking condition.

## Production acceptance

- Commit `27d154e5f3b876c27a0247b0c5efde36114eb981` is pushed to `main`; immutable host release `0.2.9-alpha.20260904.1835` is active.
- Migration `022_b2g_case_inventory` applied once through the release migrator. API and web containers reached healthy state, and public `/ready` returned ready with PostgreSQL, Redis, and object storage all healthy.
- A fresh anonymous HTTPS download returned `200`, `application/octet-stream`, and `3,741,696` bytes. Its SHA-256 and the anonymously fetched checksum sidecar both equal `00c580c047761c823c17d93cde3cf855d52b690c3b8c77cf4eebbe05743492a8`. HSTS, CSP, `nosniff`, frame-ancestor denial, referrer policy, and restrictive permissions policy were present at the edge.
- The operator transaction permanently granted `cubsfan49` 100 unopened keyless B2G cases plus equipped asset `8000000000000000200`: definition 508, Doppler Sapphire paint kit 416, wear `0.007`. It recorded the prior rating `1000` and temporarily set rating `2500`; the later rank-only revert will preserve all B2G inventory and rewards.
- PostgreSQL acceptance confirmed one equipped M9, exactly 100 admin grants, 100 active cases, 100 active hidden entitlements, and the applied migration. The remaining case-open/reveal and Deathmatch checks are explicitly human-observation gates.

This is a source and release-candidate review, not a penetration test of Steam, Cloudflare, VPSDime, or the Windows game host.
