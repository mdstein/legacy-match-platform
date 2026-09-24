# Launcher-first 0.2.13 security audit

Date: 2026-09-04

Scope: final-client case-specific regular and special reward pools, the expanded
six-tier souvenir policy, historical reward repair/audit tooling, the second
administrator Cobblestone-package batch, migration 027, and the active 0.2.13
application release. This is an incremental review over
`security-audit-launcher-first-0.2.11.md` and includes the 0.2.12 inventory work.

## Executive summary

No new Critical, High, or Medium production vulnerability was found. Case and
souvenir outcomes remain server-authoritative. The paired launcher bearer token
is authenticated before request parsing or inventory mutation, and the player
identity comes from that credential rather than request data. PostgreSQL scopes
and locks the player's grant and inventory rows, selects only from a generated
final-2023 catalog, consumes the container, creates one result, and records the
outcome in one transaction. Repeated completion requests return the recorded
result instead of rolling again.

The case catalog is reproducibly generated from the installed AppID 4465480
September 2023 item schema (SHA-256
`510e09b68a01d88edba2342972960025fd6484aaaa58365fcf47d8513de79623`)
and the pinned unusual-loot supplement (SHA-256
`ba667bfce221a76d7f35d410e4282dd70ac6fb5ef0c9db07580d83d52ce43ea0`).
The generated source contains 39 cases, 606 regular reward entries, and 1,798
case-specific special entries. A production audit compared every opened reward
against its originating case, item/paint tuple, rarity, loadout slot, and Valve
paint-kit wear bounds. Seven historical v1 rewards created before case-specific
pools were repaired transactionally with preserved asset IDs, seeds, floats,
and lineage. The post-repair result is 121/121 valid and zero mismatches.

## Verified controls

- Authentication and identity binding: `apps/api/src/app.ts:1108` exposes the
  launcher case-completion route; line 1114 authenticates the bearer credential
  before line 1115 parses the bounded asset-ID body. An anonymous production
  request returned HTTP 401 and `Invalid launcher credentials.`
- Owner-scoped atomic mutation: `apps/api/src/inventory-service.ts:1493` selects
  the case grant by authenticated `playerId` and locks it. Container grants and
  assets are likewise owner-scoped and locked at lines 1510 and 1546. The
  result insert and consume/complete updates occur inside the same transaction.
- Replay behavior: completed containers return their already-recorded active
  result at `apps/api/src/inventory-service.ts:1528`; they are not rerolled.
- Catalog confinement: souvenir selection resolves the exact container in the
  active generated catalog at `apps/api/src/inventory-service.ts:1555`. Normal
  cases resolve the originating case and its matching key at line 1677 before
  `chooseCaseReward` selects from that case object.
- Cryptographic randomness: reward rolls, wear, and paint seed use Node's
  `crypto.randomInt`; callers cannot submit or predict a roll through the API.
- Policy separation: `apps/api/src/inventory-service.ts:549` retains the pin
  40/30/20/10 policy, while line 556 defines souvenir Consumer/Industrial/
  Mil-Spec/Restricted/Classified/Covert weights of 38/25/15/10/7/5 percent.
- Reproducible source data: `scripts/extract-b2g-drop-catalog.mjs:383` includes
  souvenir rarities 1–6 only for packages with a Covert reward, and line 439
  emits the versioned policy. A clean regeneration matched the committed file
  byte-for-byte at SHA-256
  `8497095bd264bba8da4e9295e5968805c82dc4610746500c3793ecbd81f9d69b`.
- Catalog regression tests: `apps/api/test/drop-odds.test.ts:31` checks every
  case's regular/special boundary; line 76 checks both exact policies and every
  souvenir package's complete six-tier set; boundary rolls are covered through
  9,999 basis points.
- Production audit tooling: `scripts/generate-case-reward-audit.mjs:46` builds a
  temporary expected-reward table from the generated source. It reports any
  item/paint/rarity/weapon/slot or wear-bound mismatch and does not mutate data.
- Migration safety: `packages/db/migrations/027_souvenir_full_rarity_odds.sql:6`
  upgrades only unopened v2 containers. Opened v2 outcomes retain immutable
  historical policy/version data.
- Grant idempotency: `apps/api/src/playtest-grant.ts:163` checks the release-
  scoped audit purpose before issuing a batch. The player row is locked at line
  67, and grant rows plus their audit record are created in one transaction.

## Findings

### NPM-LOW-001 — development-only esbuild advisory

- Severity: Low
- Location: transitive `node_modules/tsup/node_modules/esbuild` 0.27.7
- Evidence: `npm audit` reports GHSA-g7r4-m6w7-qqqr, a local Windows development
  server arbitrary-file-read issue. `npm audit --omit=dev --audit-level=high`
  reports zero production vulnerabilities.
- Impact: limited to a developer running the affected development server for an
  untrusted local user. The package is absent from the pruned production image.
- Mitigation: local development servers are not exposed publicly; upgrade the
  build toolchain when a compatible patched transitive version is available.

The intentionally unsigned private-alpha launcher remains an accepted
distribution risk documented in earlier reports. This review found no path that
lets an anonymous caller open a case, select a rarity, select a case reward, or
grant an item.

## Verification performed

- Unit tests: 278 JavaScript/TypeScript tests and 46 Rust launcher tests passed.
- PostgreSQL integration: 20 files / 86 tests passed, including migration 027.
- TypeScript typecheck and complete production build: passed.
- Targeted browser regression checks for the 0.2.12 public launcher link: 2/2
  passed; these correct stale 0.2.11 assertions that failed the prior CI run.
- Catalog policy tests: 25/25 passed.
- Production dependency audit: zero vulnerabilities. Full dependency audit:
  one Low development-only advisory described above.
- Anonymous production checks: web root HTTP 200 with HSTS, CSP,
  `frame-ancestors 'none'`, `nosniff`, referrer policy, and restrictive
  permissions policy; `/ready` reported PostgreSQL, Redis, and object storage
  healthy; anonymous case opening returned HTTP 401.
- Public launcher acceptance: HTTP 200, `application/octet-stream`, 3,793,920
  bytes, SHA-256
  `77b9963d6d8dc722867a9b7897a365cb6133368d53ad075dfbfb26e125dff709`.

## Production acceptance

- Commit `c8a2c858ab5045226bf3608123243def924999e3` was pushed to `main`.
- Immutable application release `0.2.13-alpha.20260904.2323` is active at
  `/opt/aftertick/releases/0.2.13-alpha.20260904.2323`; API, web, PostgreSQL,
  Redis, and the Cloudflare connector are healthy.
- Migration `027_souvenir_full_rarity_odds` is recorded. Production contains no
  unopened v2 reward containers.
- The release-scoped administrator batch
  `0e8eeab9-41f3-4a3c-8837-d4edc5105869` contains exactly 10 persisted,
  unopened, v3 Cobblestone souvenir packages.
- The game node remains the separately verified 0.1.15 release; this change is
  API/catalog policy only and does not require another Windows node install.

This is a source/release review and authenticated production acceptance check,
not a penetration test of Steam, Cloudflare, VPSDime, or the Windows game host.
