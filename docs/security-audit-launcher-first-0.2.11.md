# Launcher-first 0.2.11 security audit

Date: 2026-09-04

Scope: authoritative B2G Trade Up Contracts, the case-odds policy change, the
Practice With Bots/official-mode Panorama boundary, the extra administrator
Glove Case grant, rebuilt embedded GC, and unsigned Windows launcher release.
This is an incremental review over `security-audit-launcher-first-0.2.10.md`.

## Executive summary

No new production vulnerability was found. Trade Up is a server-authoritative,
B2G-only inventory transition: the route authenticates a paired launcher bearer
credential, strictly validates ten unique numeric asset IDs, and binds the
request to that credential's player. PostgreSQL locks all ten player-owned rows,
checks their active B2G cosmetic state, rarity, StatTrak class, collection, and
next-tier recipe, consumes them, creates one reward, and records an idempotency
fingerprint in the same transaction. Real Steam assets never enter this table or
mutation path.

The local GC accepts only the legacy struct-framed Craft message in addition to
the already-approved keyless case message. It rejects requests before verified
Steam identity, refuses non-B2G inputs, allows only one pending inventory
mutation, and applies a result only after a refreshed signed manifest proves all
ten inputs disappeared and the exact B2G reward appeared.

The menu repair narrows B2G overrides to `server=official`. Official play shows
only Competitive and Deathmatch and uses their supported B2G map groups, while
Practice With Bots retains Valve's stock local tabs, presets, maps, and GO path.
The exact pinned-archive, fixed-length, fail-closed patch boundary is unchanged.

## Verified controls

- Boundary validation: `apps/api/src/app.ts:72` requires exactly ten unique
  1–20 digit IDs; `apps/api/src/app.ts:1101` authenticates the paired launcher
  before calling the inventory service. Global JSON size and API rate limits are
  applied at `apps/api/src/app.ts:488` and `apps/api/src/app.ts:514`.
- Authorization and injection resistance: `apps/api/src/inventory-service.ts:1237`
  never accepts a player ID from the request body. Every query is parameterized
  and scoped by the authenticated `playerId`.
- Atomicity and replay safety: `apps/api/src/inventory-service.ts:1248` derives a
  canonical sorted-input fingerprint; the transaction-scoped advisory lock and
  unique database constraint make retries idempotent. Overlapping contracts lock
  the item rows and cannot consume an item twice.
- Ownership policy: `apps/api/src/inventory-service.ts:1316` reads only the
  authenticated player's B2G table; active state, item kind, rarity, StatTrak
  class, collection, and output availability are checked before the atomic
  consume at line 1389. Steam inventory is stored separately and cannot be
  submitted to this mutation.
- Durable constraints: `packages/db/migrations/023_b2g_trade_ups.sql:20` records
  ten inputs, bounded rarity and recipe data, selected collection/rolls, and one
  result with unique player/fingerprint and player/result constraints.
- Local trust boundary: `vendor/csgo-gc/csgo_gc/gc_client.cpp:325` permits only
  struct UnlockCrate and Craft mutations in owned-only mode. The Craft handler
  at line 2776 verifies signed-manifest B2G ownership; the completion handler at
  line 1506 requires the one matching pending request and a refreshed signed
  manifest transition before `inventory.cpp:1447` emits ten destroys and one
  create.
- Distribution integrity: `apps/launcher/src/lib.rs:68` pins the embedded GC to
  SHA-256 `9448c960f53539b83d32c40ff8896d09166793e4b3102652819cbaaa1bc0bcfb`.
  The 0.2.11 executable and anonymous production download both hash to
  `326ce76814ff143a38ad715dfa67f12055bd128dbb76ed75620184c9d950d63b`.
- Grant safety: `apps/api/src/playtest-grant.ts:14` uses a distinct release-scoped
  audit purpose. The production transaction created one batch containing exactly
  100 definition-4288 Glove Cases and 100 hidden included entitlements; rerunning
  the helper finds that batch instead of duplicating it.
- Web hardening: the anonymous executable response returned HTTPS 200,
  `application/octet-stream`, exact length 3,765,248, HSTS, CSP with
  `frame-ancestors 'none'`, `nosniff`, referrer policy, and a restrictive
  permissions policy. The production bundle visibly targets launcher 0.2.11.

## Findings

### NPM-LOW-001 — development-only esbuild advisory

- Rule ID: REACT-SUPPLY-001 / EXPRESS-DEPS-001
- Severity: Low
- Location: `package-lock.json:8112`, transitive
  `node_modules/tsup/node_modules/esbuild` version 0.27.7
- Evidence: `npm audit` reports GHSA-g7r4-m6w7-qqqr, an arbitrary-file-read issue
  involving the Windows development server. `npm audit --omit=dev
  --audit-level=high` reports zero production vulnerabilities.
- Impact: a local user able to interact with a developer-run esbuild server on
  Windows may reach files available to that development process. The package is
  absent from the pruned production runtime and no B2G production server runs
  esbuild.
- Fix: upgrade the build toolchain when its direct package releases a compatible
  patched dependency, then rerun the full build and deployment suite.
- Mitigation: do not expose local development servers to untrusted networks;
  production continues to use only prebuilt Node/Nginx artifacts.
- False-positive notes: this does not affect the deployed API, Nginx web image,
  native launcher, or game server.

No Critical, High, or Medium finding was introduced by 0.2.11. The intentionally
unsigned alpha and previously documented low local device-token risks are
unchanged and remain accepted for the private playtest.

## Verification performed

- Vitest: 41 files / 251 tests passed.
- Rust launcher: 46/46 passed, including the real PID-authenticated named pipe
  exchange and exact Trade Up wire layout.
- PostgreSQL integration: 20 files / 86 tests passed, including migrations,
  authoritative Trade Up consumption, idempotency, and real inventory exclusion.
- Native GC/Panorama: 7/7 passed; the exact installed 4,704,521-byte final-2023
  `code.pbin` was accepted by the patch test.
- Complete workspace build and TypeScript typecheck: passed.
- Production dependency audit: zero vulnerabilities. Full audit: one Low,
  development-only advisory described above.
- Anonymous Trade Up request: rejected with HTTP 401 and the generic message
  `Invalid launcher credentials.`

## Production acceptance

- Commit `258d02362f2f75f7a4da8ebb24aa18b15f9f4929` was used to build the
  release candidate. Immutable host release `0.2.11-alpha.20260904.2027` is
  active with healthy API, web, PostgreSQL, Redis, and Cloudflare connector
  containers; migration `023_b2g_trade_ups.sql` applied successfully.
- A fresh anonymous HTTPS download returned 200, `application/octet-stream`, and
  3,765,248 bytes. The downloaded executable, its anonymous checksum sidecar,
  and the local release artifact all equal the pinned 0.2.11 SHA-256 above.
- The same anonymous production bundle contains both
  `b2g-launcher-v0.2.11-windows-x86_64.exe` and the visible label
  `Download launcher 0.2.11`.
- The hash-verified public artifact is installed locally. Launcher doctor reports
  version 0.2.11, standalone AppID 4465480 build 1575, owned-inventory access
  ready, no blocking reason, and matching installed GC hash.

This is a source/release review and authenticated production acceptance check,
not a penetration test of Steam, Cloudflare, VPSDime, or the Windows game host.
