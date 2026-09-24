# Private-alpha Cloudflare edge

This OpenTofu stack manages the first hosted alpha's remotely managed Cloudflare Tunnel, DNS records, and private R2 demo bucket. It deliberately does not order VPSs because provisioning charges the provider account and depends on checkout-specific plan/image values. Buy the reviewed monthly hosts first, then provide the game node's fixed IPv4 address here.

The application `CNAME` targets an outbound-only tunnel. Cloudflare terminates public TLS and the app host opens no inbound HTTP ports; the connector routes only the configured hostname to `http://web:8080` and returns 404 for every unmatched route. The game `A` record is always DNS-only because the tunnel and Cloudflare's normal HTTP proxy do not carry legacy CS:GO game or GOTV UDP traffic. The R2 bucket stays private and has `prevent_destroy`; authenticated demo downloads continue through the API.

The production zone also has a dashboard-managed, proxied apex `CNAME` and Single Redirect named `Redirect apex to play`. It permanently redirects `back2go.net` to `https://play.back2go.net` while preserving the path and query string. Keep that rule active when applying this stack; it is intentionally outside this state because Cloudflare manages all zone Single Redirects as one shared ruleset.

## Credential boundary

Use three independent credential domains and never put any credential in `.tfvars`, backend files, Git, or chat:

1. `CLOUDFLARE_API_TOKEN`: account `Workers R2 Storage:Edit` and `Cloudflare One Connector: cloudflared Write` plus zone `DNS:Edit` and `Zone:Read`, limited to this account and zone.
2. `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`: object read/write credentials limited to the separate state bucket for the S3-compatible backend.
3. Application `S3_ACCESS_KEY` and `S3_SECRET_KEY`: object read/write credentials limited to the demo bucket. Inject these only into the application host secret environment.

The state bucket must exist before backend initialization because a stack cannot store its own state in a bucket it has not created yet. Create a separate private bucket named for infrastructure state through the owner-supervised Cloudflare account or scoped API. Copy `backend.r2.hcl.example` to ignored `backend.r2.hcl`, replace only the bucket and account endpoint, and keep credentials in the process environment. Cloudflare documents [R2 as an S3-compatible remote backend](https://developers.cloudflare.com/terraform/advanced-topics/remote-backend/); this configuration also enables OpenTofu's S3 lockfile.

The sensitive `cloudflared_tunnel_token` is a single-purpose connector credential returned after apply and protected in remote state. Anyone who obtains it can run a connector for this tunnel, so state-bucket access must remain restricted. The token can run the tunnel but cannot reconfigure the Cloudflare account; rotate it after suspected exposure using Cloudflare's [tunnel-token procedure](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/remote-tunnel-permissions/).

## Validate without credentials

From the repository root:

```powershell
npm run infra:iac:validate
```

CI formats, initializes with `-backend=false`, validates provider schemas, and executes mocked plan assertions. It never contacts a Cloudflare account.

## Owner-approved plan and apply

After the domain, fixed game-host IP, state bucket, and scoped tokens exist:

```powershell
Copy-Item terraform.tfvars.example terraform.tfvars
Copy-Item backend.r2.hcl.example backend.r2.hcl
$env:CLOUDFLARE_API_TOKEN = '<scoped DNS/R2/tunnel management token>'
$env:AWS_ACCESS_KEY_ID = '<state-bucket access key>'
$env:AWS_SECRET_ACCESS_KEY = '<state-bucket secret key>'

tofu init -backend-config=backend.r2.hcl
tofu plan -out=private-alpha-edge.tfplan
tofu show private-alpha-edge.tfplan
```

Stop after review. `tofu apply private-alpha-edge.tfplan` creates external tunnel/DNS/storage resources and is run only after the owner explicitly approves that saved plan. Keep the saved plan protected and delete it after apply.

Bootstrap the Linux host with all three scripts in `deploy/hosts/linux`, then stream the connector token directly from protected state into its stdin-only installer:

```powershell
tofu output -raw cloudflared_tunnel_token |
  ssh aftertick-deploy@APP_HOST 'sudo /usr/local/bin/aftertick-install-tunnel-token'
```

The token does not appear in the SSH command line, release archive, or repository. The release template pins Cloudflare's `cloudflared:2026.8.2` multi-architecture image to digest `sha256:0aa26e284f05e6c77ae375b8c9c11d9eb6a448fb7bcd8d40f31cb6176189eb38`; the hosted Compose contract rejects a mutable connector and requires its edge-backed readiness endpoint. Allow outbound TCP and UDP port `7844` to Cloudflare, keep inbound application ports closed, and keep connector readiness/metrics on loopback port `20241`. Inject the emitted non-secret application environment plus separately scoped R2 credentials, then run the hosted DNS/HTTP/A2S acceptance probe.
