# Host provisioning and acceptance

Updated 2026-08-29. These procedures contain no provider credentials and make the Linux application host and Windows game node repeatable before a provider is selected. They have local syntax, package-integrity, installer-validation, activation, rollback, HTTP, and A2S fixtures; the real-host run remains an external gate.

## Build the secret-free release artifacts

```powershell
npm run deploy:host:config
npm run test:cloudflared:image
npm run deploy:host:release
npm run deploy:host:release:verify
npm run game:node:release
npm run game:node:release:verify
npm run test:game-node:installer
```

The application ZIP contains exactly `compose.hosted.yml`, `release-manifest.json`, and `SHA256SUMS`. The game-node ZIP contains the bundled Node agent, compiled SourceMod plugin, pinned-toolchain installer, service runner, and static server configuration. Neither archive contains an environment file or credential. CI rebuilds, verifies, and uploads both bundles.

## Provision the Cloudflare edge and demo bucket

The parameterized stack at `infra/opentofu/private-alpha-edge` manages an outbound-only application tunnel, its proxied DNS record, the direct game/GOTV DNS record, and the private R2 demo bucket. Validate it without credentials or remote state:

```powershell
npm run infra:iac:validate
```

After the domain and fixed game-node IP exist, follow the stack README to configure the separate R2 state backend and scoped environment credentials. Save and inspect `private-alpha-edge.tfplan`; applying it changes external tunnel/DNS/storage resources and requires explicit owner approval. The protected demo bucket is not public, the application CNAME routes only through the tunnel, and the UDP game record is deliberately not proxied. No origin certificate or inbound application firewall rule is required.

## Linux application host

Use Debian 12+ or Ubuntu 24.04+ on a standard data-center VPS, not a Linux-only local-zone product if the selected topology needs provider features unavailable there.

1. Transfer `deploy/hosts/linux/bootstrap.sh`, `deploy/hosts/linux/deploy-release.sh`, and `deploy/hosts/linux/install-tunnel-token.sh` together.
2. Run `bootstrap.sh` once as root. It installs Docker from Docker's signed apt repository, creates the locked `aftertick-deploy` account, installs the release and stdin-only tunnel-token commands, and creates—but does not enable—the application and retention systemd units.
3. Render these root-owned files with mode `0640` and group `aftertick-deploy`:
   - `/etc/aftertick/runtime.env` from `deploy/.env.production.example` using the runtime database role;
   - `/etc/aftertick/migration.env` from `deploy/.env.migration.example` using the schema-owner role;
   - `/etc/aftertick/release.env` from `deploy/release.env.example`, replacing the API and web images with immutable registry digests and preserving the reviewed cloudflared 2026.8.2 digest unless intentionally upgrading it.
4. From the initialized OpenTofu stack directory, stream the sensitive connector token over SSH without printing or placing it in an argument:

```powershell
tofu output -raw cloudflared_tunnel_token |
  ssh aftertick-deploy@APP_HOST 'sudo /usr/local/bin/aftertick-install-tunnel-token'
```

5. Extract the verified app-host ZIP into a new staging directory and run as `aftertick-deploy`:

```bash
/usr/local/bin/aftertick-deploy-release /path/to/extracted-release 0.1.0-build-id
sudo systemctl enable aftertick-app.service
```

The release command rechecks `SHA256SUMS`, rejects extra files and mutable image tags, validates Compose, pulls the exact API/web/connector digests, runs the advisory-locked migration, atomically changes `/opt/aftertick/current`, and requires container readiness. A failed start restores the prior release pointer and attempts to bring the prior images back.

After reviewing the first retention dry run, enable the scheduled apply job:

```bash
sudo systemctl start aftertick-retention.service
sudo systemctl enable --now aftertick-retention.timer
```

The web container remains bound to host loopback while the digest-pinned cloudflared container reads `/etc/aftertick/cloudflared.token` through a read-only bind and reaches `http://web:8080` on the private Compose network. It has a read-only filesystem, drops all capabilities, and cannot gain privileges. Its `/ready` and Prometheus metrics bind only to host loopback port `20241`; Docker health requires real edge connections. Keep inbound TCP 80/443 closed. Allow outbound TCP and UDP 7844 to Cloudflare tunnel endpoints; TCP 443 is useful for the management pre-check. Do not expose PostgreSQL, Redis, object-storage credentials, API port 8787, tunnel metrics beyond loopback, or the Docker socket.

Membership in the Docker group is effectively administrative access on this dedicated host. Keep `aftertick-deploy` key-only, restrict its source addresses where practical, and do not reuse it for unrelated workloads.

## Windows game node

Install Node.js 22+ and enable Windows OpenSSH or WinRM HTTPS for the dedicated deployment account. Build and verify the game-node ZIP on the trusted workstation or in CI.

Create one Steam Game Server Login Token for base AppID `4465480` at `https://steamcommunity.com/dev/managegameservers`. Register a production node from the Windows workspace while `DATABASE_URL`, `MANIFEST_SIGNING_SECRET`, and `AFTERTICK_SRCDS_GSLT` are injected into the process environment. Secrets are deliberately not command-line arguments:

```powershell
npm run game:node:register -- `
  --production `
  --name na-east-01 `
  --region "NA East" `
  --api-url https://play.aftertick.example `
  --public-endpoint game-na-east.aftertick.example `
  --server-root C:\ProgramData\Aftertick\tools\csgo-server `
  --launcher-script C:\ProgramData\Aftertick\service\start-srcds-hidden.ps1 `
  --server-address game-na-east.aftertick.example:27115 `
  --srcds-host 0.0.0.0 `
  --game-port 27115 `
  --latency-probe-port 27125 `
  --gotv-port 27120 `
  --lan 0 `
  --output .artifacts\nodes\na-east-01.env
```

Production registration requires HTTPS/public mode, generates independent random RCON and idle passwords, stores only the node-token digest in PostgreSQL, and writes the one-time plaintext credentials below ignored `.artifacts/nodes` without printing them.

Transfer the verified ZIP and credential file over the protected deployment channel, extract the ZIP, and run the bundled installer from an elevated PowerShell session:

```powershell
.\deploy\hosts\windows\Install-AftertickGameNode.ps1 `
  -Version 0.1.0 `
  -ReleaseRoot C:\AftertickUpload\aftertick-game-node-0.1.0 `
  -CredentialsFile C:\AftertickUpload\na-east-01.env
```

The installer downloads/validates the final Source 1 server payload through dedicated-server AppID 740, then reapplies standalone AppID `4465480` to `steam_appid.txt` and `csgo/steam.inf`. It checksum-pins MetaMod/SourceMod, the final-build NoLobbyReservation source/gamedata, and the AppID-4465480 Steam-ticket compatibility extension. It compiles the direct-connect patch locally, installs the archived-client engine patch, renders the local RCON/idle secret config, locks the credential ACL, grants only the required release/game/log permissions to `LOCAL SERVICE`, installs a restart-supervised startup task, and opens only UDP game/GOTV ports. It never opens RCON TCP to the network. The agent connects to RCON locally while advertising the separate public game address; public SRCDS starts without `-insecure` and logs in with the protected AppID-4465480 GSLT.

The node is fail-closed: hosted installation requires `AFTERTICK_SRCDS_LAN=0`, `0.0.0.0` listen mode, an externally routable address, HTTPS control plane, an AppID-4465480 GSLT, safe random RCON/idle credentials, and a bundled plugin/agent release. Re-running with a new immutable version updates the release pointer while preserving the large Steam/toolchain data root.

## Hosted acceptance

After DNS/TLS and both hosts are live:

```powershell
$env:METRICS_BEARER_TOKEN = '<injected locally; do not put it on the command line>'
npm run hosted:preflight -- `
  --public-url https://play.aftertick.example `
  --game-host game-na-east.aftertick.example `
  --game-port 27115 `
  --latency-probe-port 27125 `
  --gotv-port 27120 `
  --samples 10 `
  --max-game-p95-ms 80 `
  --max-loss-percent 0
```

The probe validates DNS, the trusted TLS chain and 14-day expiry margin, `/health`, every `/ready` dependency, browser security headers, rejected unauthenticated metrics, authorized metrics when the token is present, and bounded A2S identity/latency/loss for the game and GOTV endpoints. Evidence is written to `.artifacts/hosted-preflight/latest.json` without the metrics token.

Continue with the Steam browser smoke, queue/reload test, node heartbeat, hosted rolling update/rollback, retention dry run/apply, off-provider restore, live paging test, and finally the ten-human match. Do not enable allocation until the node, backup, and operator-recovery checks pass.
