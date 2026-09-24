# B2G — Back2CSGO

B2G is a deployable private-alpha foundation for community-run competitive legacy CS:GO. It implements the loop from Steam sign-in through parties, native Competitive and Deathmatch queues, fair matchmaking, ready checks, client-selected maps, fenced real SRCDS assignments, signed match results, Elo settlement, demos, statistics, profiles, moderation, and operations.

## Implemented platform loop

- Steam OpenID sign-in, rotated Redis sessions, CSRF, distributed rate limits, and fail-closed production configuration.
- PostgreSQL player, profile-XP, season, match, roster, result, rating-ledger, demo, participation-violation, sanction, appeal, and immutable audit records.
- Redis parties, expiring invites, leadership/readiness, atomic queue tickets, multi-tab protection, Pub/Sub events, durable ready checks, automatic finalization from native map selections, cooldowns, and recovery after API restarts. The earlier captain-veto state machine remains tested as a rollback path.
- Deterministic 5v5 matchmaking over Elo, uncertainty, party shape, moderation band, map overlap, fresh measured regional latency in production, and wait-time widening.
- Authenticated regional node control with heartbeats, command retries, warm-server states, monotonic fenced leases, and HMAC-signed manifests.
- Audited live-server failure incidents with evidence-preserving quarantine, no-rating voids, idempotent fresh-server remakes, zero-capacity resume, and Redis player reassignment.
- A real legacy CS:GO AppID 740 server path with pinned MetaMod/SourceMod, roster gating, warmup no-show enforcement, live reconnect grace and abandon forfeits, pause/surrender/end events, GOTV, and signed idempotent result ingestion.
- Exactly-once rating, profile-XP, and B2G service-drop settlement; retry-safe native end-of-match XP/drop presentation before server drain; MinIO demo storage with SHA-256 validation; and independent legacy-demo analysis using `demoinfocs-golang/v3` pinned for CS:GO.
- Responsive player, leaderboard, profile, match-detail, demo-download, reporting, sanctions/appeals, moderator, admin-control, and audit surfaces.
- A Tauri Windows launcher with Play, Trading, Match History, Friends and Settings, in-launcher profile setup, and a Rust-owned game session. Its PID-verified local bridge lets the final Panorama client queue Competitive or Deathmatch—including authenticated Steam-lobby parties—retain its native map choices, use the original audible ten-player accept popup, see authoritative rank/profile XP and population, reveal clearly labeled B2G service drops, retain exact owned inventory, and receive assignments without using the website. It prefers standalone App 4465480, supports App 730's `csgo_legacy` fallback, connects without shell interpolation, and keeps automatic updates fail-closed behind SHA-256 plus pinned Authenticode identity.
- Pinned server-side SMAC evidence modules with automatic punishment disabled, GOTV correlation, moderator review, and native player occlusion.
- Prometheus metrics, structured request logs, OpenTelemetry traces, Tempo, Grafana, Alertmanager rules, dashboards, and incident runbooks.
- Hold-aware two-phase demo deletion, bounded telemetry/backup retention, dry-run/apply jobs, and append-only deletion evidence.

The default browser demo remains isolated and deterministic: one local identity queues with nine simulated players. Production mode uses PostgreSQL, Redis, MinIO, the real matchmaker, and the node control plane.

## Local start

Requirements are Node.js 22+, npm 10+, Docker Desktop, Go 1.27, and Rust 1.93.1. The real game-server tests additionally require the provisioned Valve toolchain described below.

```powershell
npm install
Copy-Item .env.example .env
npm run infra:up
npm run db:migrate
npm run db:seed
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). PostgreSQL, authenticated Redis, and S3-compatible MinIO bind only to loopback in the local Compose stack. Set `AFTERTICK_SEED_TEST_PLAYERS=true` before seeding to create the deterministic ten-player integration roster.

Production requires a canonical HTTPS `AFTERTICK_PUBLIC_URL`, configured regional A2S latency endpoints, strong separate session and manifest secrets, PostgreSQL, Redis, object storage, an OpenTelemetry endpoint, and a protected metrics token. Keep the least-privilege API database environment separate from the short-lived schema-owner migration environment. `STEAM_API_KEY` is optional for OpenID verification and required only for real display names and avatars.

## Verification

```powershell
npm test
npm run typecheck
npm run build
npm run audit:production
npm run test:integration:db
npm run test:integration:redis
npm run test:integration:api
npm run test:resilience
npm run test:e2e
npm run test:observability
npm run test:load:smoke
npm run test:load:queue
npm run test:integration:node-agent
npm run test:integration:platform
npm run backup:local
npm run backup:prune:local
npm run retention:dry-run
npm run restore:drill:local
npm run deploy:config
npm run deploy:build
npm run test:deployment:rollback
npm run deploy:host:config
npm run deploy:host:release
npm run deploy:host:release:verify
npm run game:node:release
npm run game:node:release:verify
npm run test:game-node:installer
npm run test:linux-host-release
npm run test:hosted:preflight
powershell -ExecutionPolicy Bypass -File .\scripts\test-launcher-signing.ps1
```

`test:integration:platform` is the highest-fidelity local gate. It first provisions the current SourceMod build into the isolated server, creates a disposable migrated PostgreSQL schema and ten independent authenticated sessions, then verifies profiles, Redis tickets, a shared Panorama map, ten individual acceptances with zero early allocation, direct post-accept server allocation without a captain/web veto, a fenced lease and signed manifest, real SRCDS/SourceMod warmup, node-agent crash/restart continuity, live surrender, signed terminal results, exactly-once Elo and profile XP, GOTV upload, independent demo analysis, and safe server drain. A second real lease exercises SourceMod's no-show timer, ten signed roster violations, ten idempotent audited cooldowns, zero rating changes, and plugin-originated terminal drain. A third live lease forcibly terminates SRCDS and proves thresholded pre-TTL fencing into one audited operator-recovery incident without altering the completed match.

`test:observability` starts an instrumented production build, sends an explicit W3C trace, proves the trace is stored in Tempo, checks all Prometheus targets, and queries the provisioned Grafana Tempo datasource. Playwright runs on isolated ports and never reuses the interactive Steam session.

For a deliberate real-Steam OpenID smoke without any deterministic identity override, run `npm run steam:smoke:serve` and open `http://127.0.0.1:5173` in the connected browser. This uses the durable local PostgreSQL and Redis services and never reads or enters Steam credentials. The real consent/callback, player loading, authenticated API reads, and full-reload session persistence have passed in connected Chrome.

`test:resilience` deliberately stops the API, Redis, and PostgreSQL in turn, verifies bounded liveness/readiness behavior, and proves session/AOF/database recovery. The full-platform gate also kills and restarts the node agent while the leased SRCDS process remains live, then separately kills a leased SRCDS process while the node agent stays online and verifies immediate recoverable failure handling.

Backups are checksum-manifested. The restore drill uses disposable PostgreSQL, Redis, and MinIO targets and cannot overwrite the live local stores.

`test:deployment:rollback` runs the real production API and Nginx images, replaces the API with an intentionally crashing candidate, observes the ingress failure, restores the exact known-good image, and proves readiness and proxy recovery without replacing Nginx. Evidence is written to `.artifacts/deployment-rollback/latest.json`.

## Legacy CS:GO server

Valve binaries are never committed. On Windows, the following command downloads SteamCMD, validates AppID 740, installs checksum-pinned MetaMod/SourceMod, compiles the tracked SourcePawn plugin, and provisions ignored `.tools/csgo-server` storage:

```powershell
npm run game:toolchain:install
npm run game:node:register
npm run game:node:local
npm run game:server:smoke
```

The Valve payload is approximately 14.7 GB downloaded and 34.7 GB installed. The launcher doctor prefers the standalone Steam App 4465480 installation and falls back to App 730 only when `BetaKey=csgo_legacy` and the legacy `csgo.exe` are present.

## Windows launcher release

```powershell
npm run launcher:test
powershell -ExecutionPolicy Bypass -File .\scripts\build-launcher.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\sign-launcher.ps1 -CertificateThumbprint <thumbprint>
powershell -ExecutionPolicy Bypass -File .\scripts\create-launcher-release.ps1 -DownloadUrl <https-url>
```

Release builds must set `AFTERTICK_UPDATE_PUBLISHER_IDENTITY_EKU` to the profile-specific Azure Artifact Signing durable identity EKU. The production workflow discovers that identity from a signed probe, rebuilds with the identity embedded, signs again, and independently verifies the release. The unsigned alpha supports per-user installation and manual downloads from the production site while continuing to fail closed for automatic updates. See [docs/launcher.md](docs/launcher.md).

## Workspace map

```text
apps/api/                 Express modular monolith and workers
apps/web/                 React/Vite player and operations client
apps/node-agent/          Authenticated Windows SRCDS agent
apps/launcher/            Native Rust Windows launcher
packages/contracts/       Shared HTTP/event contracts
packages/db/              Migrations, repositories, seeds, settlement
packages/rating/          Pure CS:GO-rank and Elo engine
infra/game-server/        Tracked config and SourceMod plugin
services/demo-analyzer/   Go legacy-demo parser
ops/                      Prometheus, Alertmanager, Grafana, Tempo, OTel
scripts/                  Repeatable build, test, backup, and drill entrypoints
```

Current capabilities and external launch gates are tracked in [docs/remaining-work.md](docs/remaining-work.md). The repository contains no anti-cheat driver, Valve assets, cosmetic minting, or unrestricted skin changer. It imports a player's public Steam App 730 weapon inventory, exposes compatible owned assets in App 4465480's native Inventory/Loadout, and binds selected asset IDs into the signed server manifest. B2G service drops are non-tradable platform receipts displayed through the generic final-2023 reward panel; they never enter Steam inventory or impersonate Valve items.

Provider-neutral container deployment and rollback instructions are in [docs/deployment.md](docs/deployment.md). The current private-alpha buying recommendation, price tiers, and least-privilege credential handoff are in [docs/hosting-plan.md](docs/hosting-plan.md).

Fresh Linux/Windows host bootstrap, secret-free release bundles, firewall/service isolation, and the real hosted acceptance command are in [docs/host-provisioning.md](docs/host-provisioning.md).

The review of FACEIT's public repositories and the adopt/defer decisions are in [docs/faceit-upstream-review.md](docs/faceit-upstream-review.md).
