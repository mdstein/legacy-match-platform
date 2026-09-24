# Hosting, cost, and credential plan

Updated 2026-08-29. Prices below are published starting prices before tax and any region, Windows-license, or checkout adjustment. Use month-to-month billing for the first alpha and verify the final cart before purchase.

## Recommended private-alpha stack

Buy the smallest infrastructure that can prove the hosted ten-player loop, then scale from measurements:

| Service | Initial choice | Published price | Why |
|---|---|---:|---|
| Linux application host | [OVHcloud VPS-2](https://us.ovhcloud.com/vps/) | $8.50/month | 4 vCPU, 8 GB RAM, and enough capacity for the web/API plus initially self-hosted PostgreSQL and Redis. Use Vint Hill for the default east-coast alpha so the control plane is colocated with the game node. |
| Windows game host | [OVHcloud Windows VPS-3](https://us.ovhcloud.com/vps/os/vps-windows/) | $12.32/month starting price | 6 vCPU and 12 GB RAM for one legacy SRCDS/node-agent host. Use Vint Hill as `NA East` by default and benchmark actual single-core performance and network jitter before committing. |
| Public code signing | [Azure Artifact Signing Basic](https://azure.microsoft.com/en-us/products/artifact-signing) | $9.99/month | Publicly trusted, cloud-held signing for the launcher; includes up to 5,000 signatures each month. |
| Primary demo storage | [Cloudflare R2](https://developers.cloudflare.com/r2/pricing/) | Usually $0 initially | First 10 GB-month, one million Class A operations, and ten million Class B operations are free; internet egress is free. |
| Off-provider backup | [Backblaze B2](https://www.backblaze.com/cloud-storage/pricing) | Usually $0 initially | First 10 GB is free; then $6.95/TB-month. Keep database, Redis, configuration, and demo recovery copies away from the primary provider. |
| Metrics/logs/traces | [Grafana Cloud Free](https://grafana.com/pricing/?tab=free) | $0 | Free allowance is sufficient for alpha if label cardinality and retention are controlled. |
| Paging | [PagerDuty Free](https://www.pagerduty.com/pricing/incident-management/) | $0 | Up to five users, one schedule, and one escalation path are enough for an owner-operated alpha. |
| Source/CI/registry | [GitHub Free](https://github.com/pricing) | $0 | Private repository, Actions allowance, and GHCR are adequate at current scale. |
| Domain, DNS, TLS ingress | [Cloudflare Registrar](https://www.cloudflare.com/products/registrar/), [Universal SSL](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/), and Cloudflare Tunnel | Domain-dependent | Registrar is sold at registry/ICANN cost; DNS, edge TLS, and an outbound-only application tunnel can begin on the free plan without an exposed origin HTTP port. |

Published recurring base: **$30.81/month**, plus the domain, taxes, and any Windows/region checkout adjustment. Keep a practical first-month operating budget of **$50-$90** until the final VPS carts and measured storage usage are known. The application host is initially a single failure domain, which is acceptable for a closed private alpha backed by tested off-provider restores, but not for a public beta.

### Region decision

OVHcloud's US full regions are [Vint Hill, Virginia and Hillsboro, Oregon](https://us.ovhcloud.com/about/global-infrastructure/locations/). Its [Local Zones](https://us.ovhcloud.com/public-cloud/local-zone/) include Chicago and other metros, but do **not** support Windows images. The current protected game-node installer is Windows-specific, so use one of these honest labels:

- Default: put both VPSs in Vint Hill and publish the route as `NA East`.
- West-coast cohort: put both VPSs in Hillsboro and publish the route as `NA West`.
- Do not buy a Chicago OVH VPS and call it the Windows `NA Central` node. A true central route requires either a different Windows provider or a separately implemented and host-tested Linux game-node release.

Before purchasing the Windows VPS, confirm that the selected full region offers the required Windows Server image and show the final cart for review. Start with one month. If its SRCDS p95 frame time, A2S latency, or packet loss misses the acceptance threshold, cancel or resize instead of prepaying.

## Upgrade choices

### Lower operations burden

Move state off the application VPS when uptime or operator burden matters:

- [DigitalOcean Managed PostgreSQL](https://www.digitalocean.com/pricing/managed-databases): $15.15/month for the smallest single node.
- [DigitalOcean Managed Valkey](https://www.digitalocean.com/pricing/managed-databases): $15/month for the smallest single node; it is Redis-compatible for this platform.

With the recommended OVH hosts and Azure signing, this is **$60.96/month** before domain, storage, tax, and checkout adjustments. Adding one standby for each managed datastore brings the published base to roughly **$91.11/month**. Use TLS and provider firewalls because this is a cross-provider data path.

### Predictable mainstream-cloud fallback

[AWS Lightsail](https://aws.amazon.com/lightsail/pricing/) publishes a 4 GB Linux instance at $24/month and a 16 GB, 4 vCPU Windows instance at $124/month. Together with signing, the base is **$157.99/month**. The 8 GB Windows plan lowers that to **$107.99/month**, but its two vCPUs leave less safe SRCDS headroom. Choose this only if the lower-cost VPS benchmark is poor or operational familiarity justifies the premium.

### Dedicated game-server upgrade

[OVHcloud Game dedicated servers](https://us.ovhcloud.com/bare-metal/game/) currently start at $357/month plus a $357 setup fee and include game-oriented anti-DDoS. With the Linux VPS and signing, the published recurring base is **$375.49/month** and the first month is at least **$732.49** before domain and tax. This is unnecessary for the private alpha; revisit it after real concurrency and latency measurements.

Hetzner is not the current value choice for this US alpha after its June 2026 adjustment: [US CPX prices](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/) begin at $37.49/month for 3 vCPU/4 GB and $73.49/month for 4 vCPU/8 GB, plus [$0.60/month for IPv4](https://docs.hetzner.com/general/infrastructure-and-availability/ipv4-pricing/).

## What to buy now

1. A domain whose final spelling and renewal price have been reviewed. Cloudflare currently advertises registrar pricing [starting at $7.85/year](https://www.cloudflare.com/plans/), but the exact registration and renewal price is TLD/name dependent and registration is non-refundable.
2. One month of the OVH Linux VPS-2 and Windows VPS-3 in the same full region. The default cart is Vint Hill/`NA East`; use Hillsboro/`NA West` only when the initial player cohort is predominantly western.
3. Azure Artifact Signing Basic after confirming that the owner identity is eligible for [Public Trust identity validation](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart). US and Canadian individual developers are supported; the Azure billing-account type, legal name, and address must exactly match the identity-validation type and documents.

Do not buy managed PostgreSQL/Valkey, paid Grafana, paid PagerDuty, dedicated hardware, multiple regions, or anti-cheat yet. R2, B2, GitHub, and the observability/paging free tiers can be configured before they produce a charge.

### Exact owner checkout and account sequence

The owner performs only the billing, legal identity, and irreversible registration steps; Codex can handle the technical configuration afterward.

1. Decide the public brand/domain spelling and show the registration and renewal totals before buying it.
2. Create the OVHcloud US account with MFA. Add one monthly Ubuntu 24.04 VPS-2 and one monthly Windows Server VPS-3 in Vint Hill, with no long commitment or optional paid add-ons on the first order.
3. Create or select a Cloudflare account, add the domain on the Free plan, enable R2, and create one separate private bucket for OpenTofu state. The checked-in OpenTofu stack creates and protects the Standard-class private demo bucket. Do not proxy the UDP game/GOTV record; it must resolve directly to the game node.
4. Create a Backblaze account and one private B2 backup bucket in a region different from the primary host.
5. Create an Azure pay-as-you-go subscription whose billing identity matches the intended signer. Add Artifact Signing Basic in Central US, assign the owner the Identity Verifier role, and complete the portal-only Public Trust identity validation.
6. Create free Grafana Cloud and PagerDuty accounts. Do not upgrade either plan for the private alpha.

The two VPSs and Artifact Signing are the only monthly products in the recommended base. The domain is annual. R2, B2, Grafana Cloud, PagerDuty, GitHub, DNS, and edge TLS should initially remain within published free allowances.

## Least-privilege handoff

Do not send account passwords, Steam cookies, recovery codes, master API keys, private signing keys, or unrestricted billing credentials. Enter interactive owner logins yourself; give automation only project-scoped access.

| System | Access Codex needs |
|---|---|
| GitHub | Run `gh auth login` locally with repository access. CI should use the repository-scoped `GITHUB_TOKEN`; a game host needs only a token with `read:packages` for its images. |
| OVHcloud | For initial provisioning, either an owner-supervised signed-in control-panel session or an API application key/secret plus consumer key restricted to the selected project/VPS paths. Ordinary deployments do not need billing or service-deletion access. |
| Linux VPS | Its public IP/DNS name and a dedicated `aftertick-deploy` account authenticated by an SSH public key, with narrowly scoped `sudo` for Docker/service management. |
| Windows VPS | Its public IP/DNS name and a dedicated deployment account over OpenSSH or WinRM HTTPS, restricted firewall rules, and permission to manage only the Aftertick node-agent/SRCDS services and files. |
| Cloudflare infrastructure | `CLOUDFLARE_API_TOKEN` limited to `Zone:Read`, `DNS:Edit`, account-level `Workers R2 Storage:Edit`, and `Cloudflare One Connector: cloudflared Write` for the selected zone/account. Revoke or rotate it after provisioning; never use the Global API Key. |
| Cloudflare connector | The OpenTofu-produced tunnel token, streamed directly into the Linux host's protected token file. It runs only this connector, is sensitive in remote state, and can be rotated independently. |
| Cloudflare state | S3-compatible object read/write credentials limited to the separate OpenTofu state bucket. They are backend environment variables, not provider credentials or `.tfvars`. |
| Cloudflare application storage | Independent R2 object read/write credentials limited to the demo bucket and the operations required by ingestion and retention. |
| Backblaze B2 | A bucket-restricted application key with list/read/write for the Aftertick backup bucket. Never use the B2 master key. |
| PostgreSQL | Two TLS URLs: `aftertick_migrator` as schema owner only for migration jobs, and `aftertick_app` with runtime DML rights only. Include the provider CA where applicable. |
| Redis/Valkey | A TLS URL for a dedicated database/user with only the commands used by sessions, queues, parties, rate limits, and Pub/Sub. |
| Grafana Cloud | Stack endpoints plus a write-only access-policy token for metrics/logs/traces; use a separate short-lived editor token for dashboards. |
| PagerDuty | One Events API v2 routing key for an Aftertick service. Sending the first live test page requires explicit approval. |
| Azure signing | The owner completes billing and identity validation. CI receives an OIDC-federated principal with only `Artifact Signing Certificate Profile Signer` on one certificate profile. |
| Steam | A Web API key only if enrichment needs it, and one GSLT per game server. Never provide a Steam password, browser cookie, Steam Guard code, or recovery code. |

Production secrets will be injected through the selected secret manager or untracked host environment files. The repository already separates the schema-owner migration environment from the least-privilege runtime API environment.

Do not paste the credentials above into chat or commit them. Complete interactive owner logins on this workstation and place project-scoped secrets in the approved local credential store or untracked environment files when requested. Codex can then provision, deploy, rotate application credentials, test, and operate the platform without receiving owner passwords, payment details, recovery codes, or exported signing keys.

## Installed deployment tooling

The implementation, local platform, SRCDS, browser, load, resilience, backup, and rollback toolchains are installed. OpenTofu 1.12.5, Azure CLI 2.89.1, rclone 1.75.0, cloudflared 2026.8.2, OpenSSH, and Windows SDK signing tools are also installed and verified. Run `npm run tooling:doctor` for a credential-safe readiness report.

The latest credential-safe doctor run found every local tool installed, Docker ready, GitHub authenticated, and the private remote configured. Azure is intentionally not authenticated yet. The parameterized Cloudflare tunnel/DNS/R2 stack is in `infra/opentofu/private-alpha-edge`; `npm run infra:iac:validate` performs credential-free provider-schema validation and two mocked regional plan tests. The hosted Compose validator proves the connector is digest-pinned, outbound-only, capability-free, read-only, and file-token authenticated; the Linux fixture proves stdin-only token installation and rollback. The stack does not order OVH services because `ovh_vps` apply can charge the default payment method and needs checkout-specific plan/image values. Purchases remain owner-approved, then Codex can insert the final domain/IP values, show a saved plan, and apply it only after explicit approval. Azure Artifact Signing client/profile integration still waits for the selected subscription and validated certificate profile. Identity verification, owner logins, Steam Guard/CAPTCHA, and the first transmission of a real paging event remain explicit human gates.
