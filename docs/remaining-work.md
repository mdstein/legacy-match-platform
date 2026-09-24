# Remaining implementation and verification

**Current release, 2026-09-08:** [launcher/API/web 0.2.38 is deployed](playtest-0.2.38.md).
The alternate-account Play failure is fixed: stock/B2G play no longer requires a
public Steam inventory, while imported Steam skins retain ownership checks.
Launch Help now exposes startup blockers and gives direct FACEIT exit guidance.
The installed update successfully started CS:GO with the user's newly connected
account and authenticated its in-game bridge. All 97 database and 131 launcher
tests pass; public release checks pass. Physical gameplay and other outstanding
acceptance checks in the reports below remain open.

**Previous release, 2026-09-08:** [launcher/web 0.2.37 is deployed](playtest-0.2.37.md).
The [fresh validation report](playtest-validation-2026-09-08.md) supersedes the
historical test counts and pending checks below. Testing found and fixed an
uninstall bug that restored obsolete B2G backups. Actual B2G-only uninstall,
reinstall, 104-file preservation and game startup/172-item inventory publication
now pass. Unit, database, Redis, native GC, browser, real local SRCDS lifecycle,
load, recovery, backup/restore, retention and deployment-rollback checks passed.
The updated launcher is installed locally. Physical gameplay/launcher acceptance,
the long unboxing frame-time soak, a truly absent-game Steam install and separate
account signup, human multiplayer and the remaining production operational
checks are explicitly unverified in that report. No human 5v5 result is claimed.

**Previous release, 2026-09-08:** [launcher/web 0.2.34 is deployed](playtest-0.2.34.md).
The client wrapper now loads CS:GO's own ICU DLLs before Steam/Source startup,
fixing the entry-point errors exposed by a clean installation. Real local
startup, DLL paths, owned inventory and the authenticated bridge were verified.
Ten native suites, 125 Rust/executable tests and public release checks pass.
The API and game node were not redeployed; remaining gameplay/Friends acceptance
checks below still apply.

**Previous release, 2026-09-08:** [launcher/API/web 0.2.33 is
deployed](playtest-0.2.33.md); game node remains 0.1.28. The user's icon/profile
picture branch is preserved. Native Friends adds search, request lifecycle and
FACEIT-inspired profiles with ELO, Steam links and separate Competitive/DM stats.
Database, native interaction/recovery, accessibility-name, size/DPI and public
release checks pass. Two-account requests/profile privacy and physical display
acceptance remain. Existing local launcher/game installations were left intact.

**Previous release, 2026-09-07:** [launcher/API/web 0.2.32 is
deployed](playtest-0.2.32.md); game node remains 0.1.28. The native launcher now
tracks the supplied ZIP/live template more closely, including hover and real
loading effects, guided Steam installation and native name/region signup.
Native interaction fixtures, browser pairing/retry/accessibility, production
builds and public artifact/readiness checks pass. Full Steam download and
alternate-account first-time approval remain owner acceptance tests. The local
game/launcher reset is complete, with 205 preserved files hash-verified and
local device authorization removed. The actual reset also exposed and fixed
CS2-only discovery guidance and incorrect CS:GO progress before installation.

**Previous release, 2026-09-07 20:44 UTC:** [launcher/API/web 0.2.30 and game
node 0.1.28 are deployed](playtest-0.2.30.md). Settings and Match History are native
tabs; the console is hidden with an optional debug viewer; Trading updates
quietly; icons are refined; levels require 1,000 XP with all existing XP retained.
Database conversion, native/account/demo tests, public download and fresh game
node readiness pass. Real display/gameplay acceptance checks remain in the
release notes. The [player trading goal](player-trading-goal.md) was completed
and deployed in 0.2.29; Trading is enabled. No 5v5 result is claimed.

**Previous release, 2026-09-07 07:44 UTC:** [launcher 0.2.28 and matching API/web
are deployed](playtest-0.2.28.md); game-node remains 0.1.26. Unlock followed by
Escape now explicitly cleans up case animation timers and event handlers,
including late callbacks, while the authoritative reward continues to save.
390 quick-close cycles and normal-opening/race cases pass using the real
Panorama scripts in a mocked host. Native archive validation, eight CTests,
launcher tests and public download/version/checksum/readiness pass. A real
extended unboxing/Deathmatch soak without a client restart is still required
to establish that the reported stutter is eliminated; no native engine memory
leak or measured FPS improvement is claimed. Account state was not changed.

**Previous release, 2026-09-07 05:58 UTC:** [launcher 0.2.27 and matching API/web
are deployed](playtest-0.2.27.md); game-node remains 0.1.26. The native launcher
now follows the supplied reference grid, type, image treatment, compact profile
and launch bar, with functional native controls and full scrolling details.
The independent reviewer scored all five final fixes resolved. 83 Rust tests,
the version CLI, bootstrap contract, full size/DPI render matrix, native-window
regression, public checksum/version and ready-node checks pass. Final package
cost is +1.59%; performance measurements and their limits are in the release
notes. Human checks remain for physical display transitions, live Play/session
behavior and appearance acceptance; no new multiplayer or 5v5 result is claimed.
The medal/drop/chat fixes below remain unchanged. No owner progress was reset.


**Previous release, 2026-09-07 04:57 UTC:** [launcher 0.2.26, API/web 0.2.26 and
game-node 0.1.26 are deployed](playtest-0.2.26.md). The medal action is hidden
below level 40; two level-up containers now roll 93% case, 5% souvenir and 2% pin,
plus the existing graffiti. Old packages remain usable. Drop chat uses the
verified legacy item-rarity palette, including darker purple. Public download,
checksums, API readiness, node/plugin readiness and 62 database tests passed.
Human checks remain for the changed banner visibility and purple chat rendering.
The [native launcher reference polish goal](launcher-reference-polish-goal.md)
was subsequently implemented in 0.2.27; see the current release above.

**Previous release, 2026-09-07 04:22 UTC:** [launcher 0.2.25, API/web 0.2.25 and
game-node 0.1.25 are deployed](playtest-0.2.25.md). Persistent native service
medals now cycle 2015–2023 by tier, skip unavailable tiers, preserve equipped
upgrades, and reset levels atomically. The owner subsequently confirmed successful
redemption. Remaining [medal checks](service-medals.md) cover upgrade/equipment
persistence and recovery; automated coverage includes all 51 tiers.
The practice/StatTrak presentation and controlled profiling checks below remain.

**Previous release, 2026-09-07 03:17 UTC:** [launcher 0.2.24, API/web 0.2.24 and
game-node 0.1.24 are deployed](playtest-0.2.24.md). The public download checksum,
fresh node readiness, RCON/plugins and actual Normal SRCDS priority are verified.
The [responsiveness implementation plan](responsiveness-implementation-plan.md)
records the shipped practice-skin fix, full Steam ID delivery fix, independent
event ingestion and signed committed-counter path. Human practice rendering,
kill-to-visible-counter timing, persistence/presentation checks and controlled
performance profiling remain; no new human 5v5 result is claimed.

The owner confirmed that the earlier [node 0.1.23 update](game-node-0.1.23-deployment.md)
fixed the old unboxing message and missing StatTrak increments. The remaining
1–2 second delay prompted the responsiveness work above.

**Previous checkpoint: [launcher startup fix 0.2.23](playtest-0.2.23.md).**
Human startup testing exposed a native redraw deadlock in 0.2.22; that candidate
and its website image are withdrawn. The new checkpoint records the fix and
native-window regression coverage.

The [0.2.22 engineering checkpoint](playtest-0.2.22.md) is historical evidence.
That checkpoint records the controllable readiness goal, current checks, exact
launcher/node artifacts, setup remedies, and the external gameplay checklist.
Its installed-version observations are historical. The currently running local
game was deliberately left alone during the 0.2.24 deployment; close it and
press GO in launcher 0.2.24 to install/load the new client GC before testing.

Everything below is the historical 2026-09-05 baseline. Its counts, deployed
versions and map descriptions must not be presented as acceptance of 0.2.22.

Updated 2026-09-05. “Passing” below means executable evidence exists; client-visible presentation remains unverified until a human observes it in the final 2023 build.

The API is deployed as **0.2.18-alpha.20260905.2110** with live-inventory migration
030 applied. The website still advertises launcher **0.2.16**, the local installed
launcher remains **0.2.18**, and the last confirmed installed game node is
**0.1.16**. A read-only production check at 22:09 UTC found a healthy node heartbeat
without the live-inventory capability and zero active leases.

[Launcher 0.2.20 with game-node 0.1.20](playtest-0.2.20.md) is the latest locally
built test candidate, not an installed or published release. It includes live
owned-B2G StatTrak count synchronization, original container-found chat wording
and rarity colors, and incremental periodic inventory refreshes. That checkpoint
records exact hashes, tests, installer instructions and remaining in-game checks.

The owner has confirmed DM connection works; live counters, chat colors,
quick-open/New persistence, profile stability and requeue still need observation
on the coordinated build. Ten-human native accept and a complete competitive
match also remain unverified. No Computer Use or unattended Windows deployment
channel is authorized/established for those steps.

The implementation summary and verification rows below are historical evidence,
not current acceptance results; old map/drop policies and version references in
those rows are superseded by later playtest checkpoints and the current source.

## Current private-alpha status

The complete local platform loop is implemented:

- Steam OpenID, durable Redis sessions, CSRF, distributed rate limiting, production config validation, liveness/readiness, and graceful shutdown.
- PostgreSQL migrations/seeds and durable player, match, roster, rating, result, event, demo, moderation, control-plane, and audit state.
- Redis parties, invites, leadership/readiness, queue fencing, Pub/Sub, ready-check recovery, production allocation from native map selections, legacy captain-veto rollback coverage, cooldowns, and concurrent/multi-tab protection.
- Deterministic matchmaking using Elo/uncertainty, party shape, moderation band, shared maps, fresh signed regional latency evidence in production, and wait-time widening.
- Authenticated node agents, heartbeats, retried command claims, warm-pool states, monotonic leases, signed manifests, drain, quarantine, and expiry sweeps.
- Real legacy-CS:GO SRCDS with pinned MetaMod/SourceMod, SteamID64 roster enforcement, per-match server password, warmup no-show cancellation, live reconnect grace, abandon forfeits, pause/resume, surrender, terminal results, and GOTV.
- Lease-signed append-only event/result upload, conflict capture, exactly-once settlement, checksum-backed MinIO storage, and independent CS:GO demo parsing.
- Player profiles, leaderboard, match history/details, demo downloads, reports, sanctions, appeals, moderator queues, admin controls, and immutable audit UI/API.
- Native Windows launcher with a launcher-first dashboard, paired account status, health/update state, release notes/news, one GO action, legacy-client diagnosis, validated deep links, bounded Source A2S route measurement, one-use signed report submission, direct Steam launch, per-user protocol installation, and fail-closed signed updates.
- Structured logs, bounded-cardinality Prometheus metrics, OpenTelemetry auto-instrumentation, Tempo, Grafana, Alertmanager, dashboards, and runbooks.
- Hold-aware demo/backup/telemetry retention plus audited live-match void/remake recovery with durable zero-capacity resume and Redis reassignment.
- Selectable Competitive and 14-player Deathmatch queues; Deathmatch uses a server-random full-pool map, ten-minute/40-frag SourceMod rules, signed FFA results, and no Competitive Elo mutation.
- Pinned server-side SMAC detections with automatic punishment disabled, signed per-match evidence, moderator signal review, GOTV correlation, GPL source/license packaging, and native CS:GO player occlusion.
- Native final-client service drops: every XP level-up grants one uniformly selected legacy case with an included hidden opening entitlement; Panorama uses its stock keyless decode and reveal flow, the server-authoritative reward retains a disclosed 5% knife rate and distributes non-knife results as 51% blue / 25% purple / 16% pink / 8% red, and persistent B2G cosmetics merge with verified Steam-owned inventory without claiming Steam ownership.
- Native final-client Trade Up Contracts: exactly ten compatible B2G-earned blue, purple, or pink cosmetics of one rarity and StatTrak class are consumed atomically for a collection-weighted next-tier B2G reward. Verified Steam-owned items remain visible but are never consumable by B2G.

## Verification evidence

| Gate | Current evidence |
|---|---|
| Unit/component | 251 Vitest checks pass; the native Rust launcher suite passes all 46 tests, including the real PID-authenticated pipe exchange and exact Trade Up wire layout |
| PostgreSQL | 20 files / 86 migration, inventory/case/trade-up, signed-latency, settlement, control-plane, ingestion, participation-penalty/forfeit, demo-retention, moderation, lease-expiry/result-race, thresholded SRCDS-failure, map-veto allocation/evidence, operator-recovery, idempotency, endpoint-rotation, and zero-capacity integration tests pass |
| Native latency boundary | A real debug launcher performs three UDP A2S queries, canonical HMAC signing, cookie-free HTTP submission, one-use consumption, replay rejection, and PostgreSQL persistence against isolated loopback fixtures; a release build additionally refuses private/non-routable targets |
| Redis | 12 session, party, queue, fanout, ready-check, manual/timeout veto, expiry, cooldown, and atomic remake-reassignment integration tests pass |
| Browser | 14 Playwright desktop/mobile/player/admin journeys pass, including the acting-captain veto, allocation/reload recovery, signed-route queue gating, launcher recovery, and automated WCAG 2.2 A/AA scans of core player and operations states; real database role enforcement is covered separately |
| Real Steam auth | Real Steam OpenID consent and the state-bound localhost callback pass in connected Chrome without a development identity override; player creation/loading, `/api/auth/me`, bootstrap, party/invite reads, and authenticated full-reload persistence were verified |
| Built API | Readiness, CSRF, Redis session persistence, and restart recovery pass |
| Observability | A real W3C trace is stored in Tempo; API, Collector, and Tempo scrape targets are up; Grafana’s Tempo datasource returns OK |
| Load baseline | k6 2.2.0: 10 VUs, 10,361 iterations / 31,083 requests in 10 seconds, 0 failures, 4.97 ms p95 |
| Queue burst | 200 players, 200 unique tickets, 20 simultaneous ready checks, 20 terminal assignments, and 200 recovered assignments; accept p95 34.3 ms |
| Real node | Authenticated start/heartbeat/prepare/drain/stop against local AppID 740 SRCDS passes |
| Full platform | A disposable migrated schema and ten sessions complete queue → matchmaker → six captain bans → post-veto lease → real SourceMod → live node-agent crash/restart → surrender/result → Elo → GOTV/MinIO → analyzer → drain; a second real lease exercises the SourceMod no-show timer, ten signed/audited cooldowns, zero ratings, and terminal drain; a third live lease survives neither a forced real SRCDS kill nor stale reuse and reaches one audited recovery incident before TTL expiry |
| Recovery | API loss recovers in 679 ms, Redis in 3.82 s, and PostgreSQL in 3.73 s; expired live leases quarantine and open an incident; void/remake, no-rating enforcement, CSRF/admin authorization, retry idempotency, Redis reassignment, and zero-capacity resume pass |
| Retention | Real PostgreSQL/MinIO 90-day dry run, held-evidence exclusions, two-phase delete/retry, checksum/audit preservation, and safe idempotent backup pruning pass |
| Data recovery | Checksum-manifested PostgreSQL, Redis, and MinIO backup plus disposable restore drill |
| Deployment | Real API/web images, isolated migration schema, container networking, dependency readiness, ingress security headers, an injected crashing image, exact-image rollback, and deterministic cleanup pass; the exact cloudflared 2026.8.2 digest runs under read-only/no-capability restrictions, exposes file-token authentication, and supports metrics-backed edge readiness; Cloudflare visitor IPs produce independent API rate-limit buckets while spoofed forwarded chains are discarded; minimal app/game bundles are manifest/checksum verified without credentials; immutable Linux activation, protected stdin-only tunnel-token installation, readiness failure, and prior-pointer restoration pass |
| Host acceptance | Real `play.back2go.net` DNS/TLS, Cloudflare ingress, security headers, API readiness, PostgreSQL, Redis, object storage, native launcher authentication, public unsigned-launcher delivery/checksum, and a signed NA Central launcher measurement pass. The user has confirmed native Competitive queue, authoritative rank/XP, and native keyless case reveals. Release 0.2.11 is deployed with the scoped Deathmatch/Practice repair, authoritative Trade Up flow, new rarity policy, and an audited 100-Glove-Case playtest batch; fresh human observation remains pending. |
| Hosting plan | Current primary-source price tiers, a $30.81/month published-base private-alpha recommendation, the OVH Windows/full-region constraint, exact owner checkout sequence, upgrade paths, and a least-privilege credential handoff are recorded in `docs/hosting-plan.md` |
| Infrastructure as code | Cloudflare provider 5.24.0 is locked; a remotely managed application tunnel, app/game DNS, catch-all rejection, and a private protected R2 demo bucket have two credential-free mocked regional plan tests; an ignored S3-compatible R2 state backend template keeps credentials out of source |
| Autonomous tooling | Git/GitHub CLI, Docker, OpenSSH, Node, Go, Rust, k6, SteamCMD, OpenTofu, Azure CLI, rclone, cloudflared, and Windows signing tools are installed; `npm run tooling:doctor` checks executables and external-login readiness without exposing credential values |
| Repository | Private `mdstein/legacy-match-platform` repository; local `main` tracks the remote default branch |
| CI | Ubuntu verification, deployment-image build, Windows Authenticode identity verification, and a rotation-safe OIDC/Azure Artifact Signing production release job are defined |

The latest full-platform run produced one completed match for ten deterministic players, six durable veto actions, zero leases before veto completion, a 476,075-byte finalized demo, one canonical rating settlement, live SRCDS continuity across an abrupt node-agent restart, and the expected warnings from analyzing a synthetic no-human-round fixture. It then let the real SourceMod no-show timer expire on a second lease, producing ten signed violations, ten policy-v1 15-minute cooldowns, ten immutable audits, cancellation with zero ratings, and a successful plugin-originated drain. A third real live lease was forcibly killed and fenced/quarantined into exactly one disputed recovery incident in 1.663 seconds while the ten-minute lease was still valid; the completed match remained completed.

## Code work still required before inviting external players

These items do not need an anti-cheat vendor, but they do need either more implementation or deployment evidence:

- [x] Add bounded native Source A2S launcher probes with median/p95 latency, challenge handling, and packet-loss reporting.
- [x] Replace provisional production matchmaking latency with short-lived, one-use signed probe submission, current-endpoint validation, per-party queue gating, and measured p95/loss routing. Deterministic modeled values remain only when the service is intentionally disabled for demo/development mode.
- [x] Exercise a one-use signed launcher measurement against the selected real NA Central route and accept native in-game Competitive matchmaking using that evidence. A fresh 0.2.11 Deathmatch visual check remains pending.
- [x] Add a versioned `provider=none` integrity-policy field to the signed launcher/server manifest; the node fails closed on unsupported providers, and settlement remains independent.
- [x] Run a 200-player Redis queue/duplicate/ready-check/accept/recovery burst with explicit one-second p95 limits.
- [x] Exercise API-loss, Redis-loss, PostgreSQL-loss, live node-agent loss, expired-lease quarantine, and zero/regional-capacity behavior with recorded recovery evidence.
- [x] Add browser coverage for player profiles/history/match evidence/reporting and the administrator report/appeal/control/audit workflow; real database authorization remains in integration tests.
- [x] Add automated WCAG 2.2 A/AA scans across desktop/mobile player and administrator states, keyboard skip-link focus, accessible progress semantics, and verified text contrast.
- [x] Add provider-neutral API/web images, migration/seed jobs, reverse proxy, security headers, production environment contract, and deployment/rollback runbook.
- [x] Add repeatable Debian/Ubuntu bootstrap, systemd application/retention units, immutable digest/checksum release activation with automatic pointer rollback, a secret-free Windows node bundle, protected `LOCAL SERVICE` installer, public-mode/RCON firewall contract, and hosted acceptance probe.
- [x] Add pinned, parameterized Cloudflare tunnel/DNS/R2 OpenTofu with protected remote-state guidance, secret-free examples, provider-schema validation, mocked `NA East`/`NA West` plan assertions, an outbound-only connector, and stdin-only host token installation. Applying a real plan remains an explicit external-change gate.
- [x] Exercise a provider-neutral failed release locally with a distinct crashing API image, observe ingress failure, restore the exact known-good image, and prove Nginx recovers without replacement.
- [ ] Exercise the rolling deploy/rollback procedure on the chosen host and registry.
- [x] Implement and exercise provider-neutral retention/deletion policies for demos, telemetry, indefinite audits, and checksum-manifested local/off-provider backup sets, including holds, dry-run/apply, retries, and immutable evidence.
- [ ] Apply and exercise those policies in the selected production PostgreSQL/object/telemetry/backup stores once credentials exist.
- [x] Implement and exercise the safe private-alpha SRCDS crash policy: after three authenticated consecutive RCON failures for the active lease, preserve redacted health evidence, fence/quarantine before TTL expiry, page an operator, then support audited no-rating void or idempotent fresh-server remake with Redis reassignment. A forced real-process drill reaches one incident without changing an already settled match. Exact score/economy restoration remains intentionally deferred.
- [x] Add a durable dynamic map-veto room with rating-selected captains, alternating turns, deterministic timeout bans, reload/SSE recovery, post-veto fenced allocation, append-only PostgreSQL evidence, and real ten-session/browser coverage. Retain it as a rollback path while production native matchmaking selects one map from the players' shared Panorama choices and allocates automatically after all ten accept.
- [x] Convert real warmup no-shows and live disconnects beyond a five-minute reconnect grace into signed, roster-validated participation violations; apply idempotent rolling-30-day cooldown ladders with immutable audits, cancel no-shows without rating, and settle abandons through a canonical forfeit result. The real SourceMod no-show timer and terminal drain pass locally; live abandon timer expiry is covered by compiled plugin logic plus signed event/result and PostgreSQL integration because independent legacy clients remain externally blocked.

## Remaining external or human-observation gates

The core host, production data services, DNS/TLS, and Windows game node now exist. The remaining gates are:

- [x] Human-observe the final-client Competitive queue plus authoritative profile rank and XP/service presentation.
- [x] Human-observe the 0.2.10 in-game keyless case inventory, native unlock/reveal animation, and persistent reward. Equip/use remains covered by the already verified merged-inventory path.
- [ ] Human-observe the 0.2.11 official Deathmatch page, native request, immediate assignment, secure connection, bot backfill, and terminal server shutdown/requeue behavior.
- [ ] Human-observe the 0.2.11 Practice With Bots stock local map/GO flow.
- [ ] Human-observe a 0.2.11 native Trade Up Contract using ten compatible B2G-earned cosmetics, including the stock reveal and persistent signed reward refresh.
- [ ] Keep the accepted unsigned-alpha distribution policy or, only if the owner later chooses production signing, complete Azure Artifact Signing identity/OIDC setup. Signing is no longer a blocker for the current private alpha.
- [ ] Ten authorized Steam accounts/legacy clients for a real ten-human match. The current machine has Valve's standalone App 4465480 at build `1.38.8.1` / client version `1575`; additional player machines must install that app or App 730's `csgo_legacy` fallback.
- [ ] Steam Guard/CAPTCHA steps for additional test accounts and any account-bound Steam keys or tokens required by hosted game nodes.
- [ ] A PagerDuty/Opsgenie/Slack-compatible Alertmanager receiver and permission to send a test page.
- [ ] Valve/legal review, Terms, Privacy Policy, competitive rules, sanction/appeal policy, and demo/voice retention decisions.

## Public-beta work

- Multiple hosted measured regions, capacity forecasting, warm-pool autoscaling, maintenance drains, and cross-region failover.
- Rating uncertainty/placements, inactivity, seasons, regional ladders, anti-boosting, and published quality metrics.
- Friends, blocks, recent teammates, notifications, party history, privacy controls, localization, and broader accessibility/device coverage.
- Richer round analytics and evidence timelines, community demo review, trust/risk signals, and calibrated human review.
- Exact live-match crash restoration only if testing proves it safer than automatic remake/void.
- Hubs, leagues, tournaments, teams, brackets, spectators, and organizer tooling.

## Explicitly out of scope

No client anti-cheat, kernel driver, automatic cheat-verdict engine, identity/KYC requirement, vendor procurement, cosmetic minting, unrestricted skin changer, or marketplace is part of this infrastructure goal. The platform imports public Steam App 730 inventory, restricts native loadout choices to freshly verified owned assets, and binds them into the signed match manifest. The client and game-node GC components independently reject fabricated ownership, altered item attributes, and unsupported mutations. The launcher inventory synchronizer restores only compatible cosmetics the signed-in Steam account already owns, so Valve remains the ownership authority. B2G service drops are separately labeled, non-tradable progression receipts rather than Steam items. Server-side signals are probabilistic evidence for human review, not proof or an automatic sanction. Ordinary Steam/SRCDS authentication, signed server configuration, roster enforcement, demos, reports, sanctions, appeals, and audits remain in scope.
