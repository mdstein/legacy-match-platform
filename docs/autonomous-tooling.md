# Autonomous tooling and control boundary

Updated 2026-08-29.

## Available and verified

- Node.js 22/npm workspaces, TypeScript, Vitest, Playwright Chromium, and interactive Chrome/browser control.
- Docker Desktop/Compose with PostgreSQL 17, authenticated Redis 7, MinIO, Prometheus, Grafana, Alertmanager, Tempo, and OpenTelemetry Collector.
- Real migration, session, queue, node-control, ingestion, moderation, backup, and restore-drill harnesses.
- k6 2.2.0 and a thresholded API load runner.
- Go 1.27 and the pinned legacy-CS:GO `demoinfocs-golang/v3` analyzer.
- Rust 1.93.1 and native Windows launcher build/test/release scripts.
- Valve SteamCMD, legacy CS:GO dedicated-server AppID 740, MetaMod:Source 1.12.0-git1225, SourceMod 1.12.0-git7251, SourcePawn compilation, RCON probing, and GOTV.
- GitHub Actions definitions for Ubuntu platform verification, Windows launcher/publisher-identity verification, and OIDC-backed production Artifact Signing.
- GitHub CLI, OpenSSH, Windows SDK `signtool.exe`, OpenTofu 1.12.5, Azure CLI 2.89.1, rclone 1.75.0, and cloudflared 2026.8.2 for hosted provisioning, deployment, signing integration, backup transfer, and outbound-only application ingress.
- A pinned Cloudflare 5.24.0 OpenTofu stack for outbound-only application ingress, application/game DNS, and a private R2 demo bucket, with an S3-compatible remote-state template and credential-free mocked plan tests.
- Web research for current primary documentation and public upstream repositories.

Local caches and Valve assets are ignored under `.tools/` and `.cache/`. Test and release evidence is ignored under `.artifacts/`.

Run `npm run tooling:doctor` after reopening a console or before a deployment session. It resolves both `PATH` commands and the installed Windows locations, checks the Docker daemon, and reports GitHub/Azure login and Git-remote readiness without printing tokens, account identifiers, subscription identifiers, or remote URLs.

Run `npm run infra:iac:validate` after changing hosted infrastructure. It formats-checks, initializes without the remote backend, validates the pinned provider schema, and runs East/West mocked plan assertions without cloud credentials or external changes.

Run `npm run deploy:host:config` and `npm run test:cloudflared:image` after changing hosted ingress. The first asserts loopback-only web/metrics, trusted Cloudflare visitor-IP restoration, a protected token-file mount, and a hardened edge health check. The second executes the exact pinned cloudflared 2026.8.2 digest with a read-only filesystem, no Linux capabilities, and no privilege escalation, then verifies its version, token-file support, and metrics-backed readiness command.

## What Codex can do without intervention

Within the workspace and the existing scoped approvals, Codex can:

- inspect, edit, build, typecheck, and test the complete repository;
- install or update project dependencies and approved developer tools;
- start/stop local Docker services and hidden API/web/SRCDS processes;
- migrate/seed disposable databases and exercise checksum-backed restore drills;
- drive isolated Playwright browsers and the user’s signed-in browser for read-only or explicitly authorized Steam flows;
- compile and exercise the SourceMod plugin, Go analyzer, and Rust launcher;
- run real local node-agent/SRCDS/platform tests and collect logs, metrics, traces, screenshots, and artifacts;
- audit dependencies, inspect upstream projects, update CI, and write runbooks.

Broad administrator access is not required. The useful model is durable workspace access plus narrow command approvals for package installation, Docker, developer toolchains, local service processes, browsers, and eventually a named deployment target. This preserves autonomy without granting unrelated machine-wide control.

## Access needed for hosted end-to-end work

Once a hosting choice is made, full deployment automation needs:

1. A Git remote and permission to push a branch or open a PR.
2. Cloud/VPS credentials scoped to the platform project, including one Windows game node.
3. DNS-zone access for the chosen domain and permission to obtain/renew TLS certificates.
4. Production PostgreSQL, Redis, object-storage, and secret-manager access.
5. Firewall/load-balancer rights for the documented HTTP, game, GOTV, and telemetry paths.
6. An Azure Artifact Signing Public Trust certificate profile, a GitHub OIDC federation, and the certificate-profile signer role scoped to the release identity. No signing private key is exported to CI.
7. An Alertmanager receiver credential and permission to send a test incident.
8. Authorized Steam accounts/clients for the final ten-human match.

Prefer short-lived, least-privilege credentials and environment/secret-manager injection. Never place passwords, Steam credentials, signing keys, node bearer tokens, or HMAC secrets in Git or chat.

As of 2026-08-29, all required local executables are installed, Docker is reachable, GitHub CLI is authenticated, and the workspace tracks the private `mdstein/legacy-match-platform` repository on `main`. Azure is intentionally unauthenticated until the owner selects the subscription and completes signing identity validation. The remaining constraints are account/project-authorization gates, not missing workstation tools.

## Human or consequential gates

Codex must pause for:

- purchases, budget/region/provider choices, production deploy authorization, or destructive data operations;
- Steam Guard, CAPTCHA, identity verification, and account-bound tokens;
- installing standalone CS:GO App 4465480 or selecting App 730's `csgo_legacy` branch when it triggers a large download or disrupts an installed game;
- issuance and custody of the organization code-signing certificate;
- sending a real page/message to people;
- Valve/legal decisions and policy acceptance;
- ten real humans unless ten authorized accounts and sessions are supplied;
- any anti-cheat purchase or vendor decision.

Closing the Codex console does not erase repository changes or the durable goal. Reopening the workspace and resuming the same goal/thread is sufficient; background local processes may need their normal health check or restart.
