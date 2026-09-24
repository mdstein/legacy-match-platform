# Deployment and rollback

Aftertick’s hosted deployment unit is a Linux API image, a static Nginx web image, and a digest-pinned outbound cloudflared connector. PostgreSQL, Redis, S3-compatible object storage, OpenTelemetry, and the Windows SRCDS node are external dependencies. Cloudflare terminates TLS while the web container and connector metrics bind only to loopback; no application port is publicly reachable. The host receives only the three-file checksum-backed `deploy/compose.hosted.yml` bundle, never build context or a workspace secret.

Fresh-host bootstrap, immutable application/game-node bundles, Windows service isolation, firewall boundaries, and the hosted DNS/TLS/HTTP/A2S acceptance probe are documented in `docs/host-provisioning.md`.

## Prepare

1. Copy `deploy/.env.production.example` and `deploy/.env.migration.example` to separate untracked secret files, or render both from the production secret manager. The API file must contain the least-privilege runtime database user; the migration file contains the schema owner and is mounted only into short-lived migration/seed jobs.
2. Replace every example endpoint and secret. `AFTERTICK_PUBLIC_URL` must be the canonical HTTPS URL. Configure `AFTERTICK_LATENCY_PROBE_ENDPOINTS` only for externally reachable regional A2S routes using the documented `Region=host:port;Region=host:port` format; use the node's always-on latency-probe port rather than its on-demand SRCDS port. Production startup rejects a missing mapping.
   Keep `HOST=0.0.0.0` inside the API container; the host firewall and ingress remain the external access boundary.
3. Set immutable registry image references through `AFTERTICK_API_IMAGE`, `AFTERTICK_WEB_IMAGE`, and `AFTERTICK_CLOUDFLARED_IMAGE` after reviewing/publishing them.
4. Set `AFTERTICK_DEPLOY_ENV_FILE` to the generated environment-file path.
   Set `AFTERTICK_MIGRATION_ENV_FILE` to the separately generated migration environment-file path.
   Set `AFTERTICK_TUNNEL_TOKEN_FILE` to the protected file written by the stdin-only host installer.
5. Confirm the selected host can reach PostgreSQL, Redis, object storage, the OTLP collector, and the node-control route.
6. Set and review the retention windows in the deployment environment. The canonical demo job must own `matches/*/gotv.dem` deletion; see `docs/runbooks/data-retention.md` before enabling any provider lifecycle policy.
7. Build and verify the minimal host bundle with `npm run deploy:host:release` and `npm run deploy:host:release:verify`. Hosted `release.env` accepts only registry images pinned by `@sha256:` digest.

```powershell
$env:AFTERTICK_DEPLOY_ENV_FILE = 'deploy/.env.production'
$env:AFTERTICK_MIGRATION_ENV_FILE = 'deploy/.env.migration'
npm run deploy:config
npm run deploy:build
npm run backup:local # replace with the production backup job on the real host
npm run deploy:migrate
npm run deploy:seed
npm run deploy:retention:dry-run
node scripts/docker-compose.mjs -f compose.deploy.yml up -d --wait api web
```

The seed command creates only the Founders Season unless the explicitly test-only seed flag is supplied. Never enable development/test identity variables in production; configuration validation rejects them.

## Release verification

- `GET /health` returns 200 through the ingress.
- `GET /ready` returns 200 and reports PostgreSQL, Redis, and object storage as `ok`.
- `http://127.0.0.1:20241/ready` returns 200 and `cloudflared_tunnel_ha_connections` reports active edge connections; this endpoint remains loopback-only.
- Unauthenticated `GET /metrics` returns 401; the Prometheus credential succeeds.
- Steam login returns to the canonical HTTPS origin and rotates the session.
- A synthetic request appears in Tempo by trace ID.
- Queue and server-allocation kill switches are enabled only after a healthy game node is visible.
- The launcher download matches the published SHA-256. Public-trust builds additionally match the intended Authenticode publisher and update manifest.
- A test player can queue, recover across a page reload, and receive the launcher handoff.
- Every party member can complete the launcher route check, and only fresh p95 measurements from configured regional endpoints reach matchmaking.
- Requests with distinct Cloudflare visitor IPs receive independent API rate-limit buckets; Nginx discards client-supplied forwarded chains before the one-hop Express trust boundary.
- The demo-retention dry run has been reviewed, telemetry retention flags match policy, and the off-provider backup can be restored.

## Rolling update

1. Build, scan, and publish immutable API/web image digests; preserve the reviewed cloudflared digest unless intentionally upgrading it.
2. Take a verified backup and review migrations. Migrations are forward-only and must remain compatible with both the old and new API during the rollout.
3. Run the migration job once; its advisory lock makes concurrent invocations safe.
4. Replace API replicas one at a time and require `/ready` before sending traffic.
5. Replace the static web image after the API compatibility window is live.
6. Observe error rate, latency, queue depth, sessions, traces, and node heartbeats for the agreed bake window.
7. Re-enable allocation only if it was deliberately paused for the change.

Game nodes roll independently: set the node to draining, allow active leases to finish, update the agent/plugin/server config, smoke the warm instance, then unquarantine it. Never restart a leased SRCDS merely to accelerate deployment.

## Rollback

1. Pause new server allocations with the audited admin control if match integrity is at risk.
2. Point `AFTERTICK_API_IMAGE`, `AFTERTICK_WEB_IMAGE`, and—if it changed—`AFTERTICK_CLOUDFLARED_IMAGE` back to the last known-good immutable digests.
3. Run `docker compose -f compose.deploy.yml up -d --wait api web` and repeat the release verification checks.
4. Do not reverse an applied database migration in place. The prior application release must remain schema-compatible. Use a restore only for confirmed data corruption and follow the isolated restore runbook first.
5. Preserve failed image digests, request/trace IDs, node commands, match events, demo checksums, and audit entries in the incident record.

The local rollback gate exercises the real production images and migration entrypoint against PostgreSQL, Redis, and S3-compatible storage. It deploys a known-good release, replaces only the API with a distinct intentionally crashing image, observes the ingress failure, restores the exact known-good image ID, and re-verifies readiness, metrics protection, security headers, and Nginx recovery without replacing the proxy:

```powershell
npm run test:deployment:rollback
```

Machine-readable evidence is written to `.artifacts/deployment-rollback/latest.json`. A real rolling deployment on the selected host and registry remains blocked until the host, registry, domain/TLS route, and production credentials are supplied.
