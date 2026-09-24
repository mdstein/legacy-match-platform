# B2G security best-practices report

## Executive summary

The AppID 4465480 owned-inventory release has no open Critical, High, or Medium findings in the reviewed application, launcher-handoff, node-manifest, or native server-enforcement paths. The one remotely relevant dependency advisory found during review (`qs`) was remediated. `npm audit --omit=dev` reports zero production vulnerabilities.

One Low development-only advisory remains in `tsup`'s private `esbuild` dependency. It affects a Windows development server, is absent from the production dependency audit, and is not used by the deployed API or web containers. The current `tsup` release constrains that dependency to the affected minor line, so this report records the risk instead of forcing an unsupported major override.

The JavaScript/TypeScript Express and React surfaces were reviewed against the security-best-practices guidance. The Rust launcher and C++ local-GC fork are outside that guidance's language-specific coverage and were reviewed manually at their trust boundaries.

## Open findings

### B2G-SEC-001 — Development-only esbuild advisory

- Rule ID: EXPRESS-DEPS-001 / REACT-SUPPLY-001
- Severity: Low
- Location: `package-lock.json:8112` (`node_modules/tsup/node_modules/esbuild`)
- Evidence: The locked `tsup` dependency is `esbuild` 0.27.7. `npm audit` reports GHSA-g7r4-m6w7-qqqr, a local Windows development-server arbitrary-file-read issue. `npm audit --omit=dev` reports zero vulnerabilities.
- Impact: A local attacker who can reach and influence the affected development server on Windows may be able to read files exposed by that server. The package is not present in the deployed runtime path.
- Fix: Upgrade when `tsup` publishes a compatible dependency range containing a patched `esbuild` release, then rerun the build and audit suites.
- Mitigation: Development servers bind to loopback; production uses compiled artifacts and immutable containers; do not expose `npm run dev` to an untrusted network.
- False-positive notes: This is a valid advisory, but it does not affect the production images or the public application route.

## Remediated findings

### B2G-SEC-002 — qs denial-of-service advisories

- Rule ID: EXPRESS-DEPS-001
- Severity: Medium (remediated)
- Location: `package-lock.json:6747`
- Evidence: The dependency scan initially found GHSA-x5fp-wj9c-mxmx and GHSA-4mjr-xmp4-gh2g in `qs` 6.15.3. The lockfile now pins 6.16.0.
- Impact: Crafted query structures could have caused excess resource consumption or exceptions in a public Express request path.
- Fix: Applied the compatible transitive update to `qs` 6.16.0.
- Mitigation: Express JSON bodies are capped at 32 KiB and Nginx limits ordinary requests; route inputs are schema-validated.
- False-positive notes: None; the affected package was in the production tree and was upgraded.

## Security controls verified

- Inventory import uses a fixed Steam Community origin, rejects redirects, applies a 10-second timeout and 20 MiB response cap, validates inspect data against the pinned legacy Econ catalog, and accepts at most 512 items (`apps/api/src/inventory-service.ts:11`, `:510`).
- Launcher grants use random UUIDs plus 256-bit random bearer tokens; only token hashes are stored; comparison is timing-safe; grants are lease-bound, time-bound, rate-limited globally, and capped at 64 redemptions (`apps/api/src/inventory-service.ts:207`, `:730`, `:766`, `:769`).
- The public launcher endpoint validates UUID and bearer formats, is read-only, bypasses cookie authentication/CSRF deliberately, and returns `no-store` plus `nosniff` (`apps/api/src/app.ts:210`, `:671`).
- The launcher accepts strict schemas with unknown-field rejection, HTTPS-only inventory endpoints, no HTTP redirects, an 8 MiB response cap, embedded binary hashes, and atomic policy writes (`apps/launcher/src/lib.rs:26`, `:122`, `:1242`, `:1254`, `:2049`).
- Match manifests are HMAC-signed and verified before the node writes the owned-inventory policy atomically with restrictive permissions (`apps/node-agent/src/manifest.ts:71`, `apps/node-agent/src/agent.ts:158`, `:481`).
- The dedicated server is the trust boundary: owned-only mode rejects item creation/destruction, compares updates against exact immutable owned protobufs, and permits only valid loadout-slot changes (`vendor/csgo-gc/csgo_gc/gc_server.cpp:400`, `vendor/csgo-gc/csgo_gc/owned_inventory.cpp:208`).
- The browser application uses cookie sessions with HttpOnly/Secure/SameSite controls, Redis storage in production, synchronizer CSRF tokens, explicit body limits, schema validation, and global/auth rate limits (`apps/api/src/auth/session.ts:24`, `apps/api/src/security.ts:12`, `apps/api/src/app.ts:418`).
- Nginx supplies CSP, frame protection, content-type sniffing protection, referrer and permissions policies, HSTS, and collapses Cloudflare visitor identity to one trusted proxy hop (`deploy/nginx.conf:34`, `:38`, `:45`).
- RCON for the local GC is disabled, native binaries are hash-pinned, and installers preserve the original Valve executables before replacement (`infra/game-server/gc/config.txt:8`, `scripts/install-b2g-server-gc.ps1:16`).

## Verification evidence

- 101 unit tests passed, including 15 launcher tests.
- 33 PostgreSQL integration tests passed, including migration 018 and exact-once rating settlement.
- 14 Redis integration tests passed, including immediate drop-in Deathmatch assignment and human-only occupancy.
- API readiness, CSRF, Redis-session persistence, and restart recovery passed.
- Six native local-GC test suites passed, including exact immutable-item rejection.
- Type checks, full production builds, hosted Compose validation, launcher checksum validation, and unsigned Authenticode-state validation passed.

## Residual operational risks

- The launcher and local-GC binaries are intentionally unsigned. Hash pinning and recoverable backups protect integrity within B2G's distribution/install path, but Windows will still show an unknown-publisher warning.
- The local GC restores compatibility for a title whose official AppID 4465480 GC is absent. The remaining Escape-menu behavior must be confirmed on the user's installed game build; `console.log` and `csgo_gc/gc_log.txt` are enabled for that test.
- A clean review and passing tests reduce risk but do not prove the absence of every vulnerability. Production logs, rate-limit metrics, node authentication failures, and dependency advisories should continue to be monitored.
