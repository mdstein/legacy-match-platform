# B2G architecture

## Runtime topology

```text
Optional React account site ── HTTPS/SSE ──▶ Express modular monolith
       │                              ├─ Steam OpenID + Redis sessions
       │                              ├─ party/queue/ready-check services
       │                              ├─ deterministic matchmaker
       │                              ├─ player/moderation/read APIs
       │                              ├─ node control + result/demo ingestion
       │                              ├─ PostgreSQL durable state
       │                              ├─ Redis locks, tickets, sessions, Pub/Sub
       │                              └─ MinIO/S3 demo objects
       │
            native Windows launcher ──▶ Steam App 4465480 (App 730 legacy fallback)
                       │                       │
                       ├─ PID/SteamID-bound local GC bridge ◀──┘
                       ├─ bounded regional A2S probes
                       └─ authenticated queue + one-use signed report ──▶ API/PostgreSQL
                                                                │
                                         authenticated Steam client/SRCDS
                                                                ▼
Express control plane ◀── HTTPS ── Windows node agent ── RCON ── SRCDS
       ▲                                  │                     ├─ MetaMod
       │                                  │                     ├─ SourceMod
       ├─ signed events/results ◀─────────┤                     └─ B2G match plugin
       └─ demo upload/analysis ◀──────────┴──── GOTV .dem

API/worker telemetry ── OTLP ──▶ OpenTelemetry Collector ──▶ Tempo
API/Collector/Tempo ── scrape ──▶ Prometheus ──▶ Grafana / Alertmanager
```

The backend is intentionally one deployable modular monolith. PostgreSQL and Redis provide the cross-process boundaries needed for safe horizontal API replicas; splitting every module into a service would add coordination failure modes before traffic justifies them.

## Match state and ownership

```text
idle
  └─ queue join ─▶ searching
       ├─ cancel ─▶ idle
       └─ matchmaker claim ─▶ reserved roster + one common Panorama-selected map + ready check
            ├─ decline/expiry ─▶ reservation cancel + cooldown + idle
            └─ all accept ─▶ fenced server lease + assigned/warmup
                      ├─ roster no-show ─▶ signed violation + cooldown + cancelled/drain
                      └─ all ten admitted ─▶ live
                           ├─ disconnect ─▶ reconnect grace
                           │    ├─ returns ─▶ live
                           │    └─ expires ─▶ signed abandon + forfeit + cooldown
                           └─ completed/surrendered/forfeited
                                └─ signed result ─▶ exactly-once Elo + profile XP
                                     ├─ level-up ─▶ exactly-once B2G service-drop receipt
                                     ├─ native per-player XP/drop presentation ─▶ drain
                                     └─ GOTV upload/analyze ─▶ history/demo
```

Redis owns ephemeral coordination: parties, atomic queue tickets, ready checks, allocation finalization work, cooldowns, distributed locks, and SSE fanout. PostgreSQL owns authoritative identity, match, roster, participation-violation evidence, node, lease, event, result, rating, demo, sanction, and moderation records. The older captain-veto state machine and append-only veto evidence remain covered as a rollback path, but production native matchmaking does not require a captain or website action. S3-compatible storage owns immutable demo bytes. Dependency readiness is deadline-bounded: the API remains live but leaves load-balancer rotation while Redis, PostgreSQL, or object storage is unavailable.

Every server allocation uses a PostgreSQL lease with a monotonic fencing token. A partial unique index prevents one match or server instance from holding two active leases. The manifest is canonicalized and HMAC-signed over its match, lease, fence, expiry, server address/password, map, ruleset, roster, plugin/build versions, event-ingestion secret, and demo destination. The node rejects invalid signatures, expired manifests, wrong instances, malformed values, and stale fences.

## Trust boundaries

- The browser never receives node credentials, ingestion secrets, RCON passwords, or object-storage credentials.
- Session cookies are HTTP-only and production-secure; all mutating player routes require a session-bound CSRF token.
- Steam OpenID state is one-time and the session ID rotates after verified login.
- Node bearer tokens are stored only as SHA-256 digests. Claimed commands use one-time claim tokens, bounded retries, and terminal quarantine.
- The per-match game password is random, short-lived, signed into the manifest, and available only after all ten players accept.
- Hosted SRCDS mode is explicit rather than inherited from the local fixture. RCON and idle passwords live in a protected generated config; the Windows firewall exposes only UDP game/GOTV ports, and the local node agent runs as `LOCAL SERVICE`.
- SRCDS performs ordinary Steam game authentication; the SourceMod plugin admits only the signed SteamID64 roster.
- Event, result, and demo metadata submissions require the authenticated node, active/recent fenced lease, and an HMAC derived from the match manifest.
- Duplicate identical events/results are idempotent. Conflicting payloads are preserved in conflict tables and block canonical settlement.
- Ratings, profile XP, and B2G service drops settle inside the result transaction and append-only idempotency ledgers.
- A browser session or paired launcher credential can issue one short-lived latency challenge per player. PostgreSQL stores only its SHA-256 token digest. The launcher measures exactly the issued A2S targets, HMAC-signs a canonical report with the one-use token, and submits through a cookie-free endpoint. Expiry, replay, tampering, endpoint rotation, insufficient replies, and excessive packet loss fail closed. Release launchers resolve once and refuse private or non-routable probe targets. This is routing evidence, not anti-cheat attestation.
- The local matchmaking pipe rejects remote clients, authenticates the connecting process as the exact discovered CS:GO binary, then verifies the in-game SteamID against the paired account. Only bounded queue intent, ready-check acceptance, and non-secret presentation state cross it; launcher credentials remain in Windows Credential Manager. Native ready state is enabled only for the exact pinned final-2023 `client.dll` timestamp, image size, and function-byte signatures. For a native party, the compatibility GC obtains the owner and bounded five-member roster from Valve's `ISteamMatchmaking` lobby interface; the API additionally requires every resolved B2G account to have a recently active paired launcher. Every player must still explicitly accept the ready check.
- The launcher does not invoke a shell. It validates endpoint/password syntax and starts Steam directly. The unsigned alpha installs per user and uses manual releases. A future public-trust build additionally requires valid Authenticode and a pinned publisher for installation and automatic updates.

## Matchmaking

The matchmaker runs under a Redis distributed lock and evaluates deterministic candidates over:

- team-average Elo and uncertainty;
- fresh launcher-measured regional p95 latency, packet-loss penalty, and intra-lobby ping spread in production;
- party/stack shapes, preferring equivalent shapes;
- moderation bands;
- common map and region choices;
- widening thresholds based on the oldest ticket.

Five-stacks are held away from solo-heavy candidates until the configured widening threshold. Production native matchmaking intersects the maps selected by all players in Panorama, chooses one eligible map before ready check, and reserves that immutable one-map plan with the roster. After all ten players accept, retryable Redis finalization creates the regional server lease, signed manifest, and one-match credentials without a captain-veto or website step. No lease exists before the tenth acceptance. The older alternating captain-veto implementation, deterministic timeout bans, and append-only PostgreSQL evidence remain tested as a rollback path.

Production queue entry requires a current acceptable measurement for every selected region and every party member. Matchmaking never invents production pings when the probe service is configured. The isolated demo/development service retains deterministic modeled values so the original offline prototype remains usable without regional infrastructure.

## Game lifecycle and recovery

The SourceMod plugin enforces exactly five roster members per team, rejects non-roster Steam identities, and auto-starts when all ten arrive. A missing warmup player produces a signed `roster.no_show` record before cancellation. During live play each roster slot has a five-minute reconnect grace; returning clears the pending timer, while expiry produces one signed `roster.abandoned` record and a `match.forfeited` result favoring the other team. The plugin also supports operator pause/resume and surrender, emits round/damage/death events, and writes one terminal result with ten stat lines.

The API accepts participation evidence only from the authenticated, lease-bound ingestion channel. It validates policy version, SteamID64, roster team, match state, absence timestamp, and grace duration before locking the player row. A unique match/player/type record makes retries harmless. Policy v1 counts all no-shows and abandons in a rolling 30-day window and assigns the current violation's escalating cooldown ladder; the sanction and an immutable system audit are created in the same PostgreSQL transaction. Active cooldowns are enforced by both queue-entry authorization and matchmaker player loading. No-shows cancel without rating; an abandon produces a canonical `forfeit` result that uses the ordinary exactly-once rating path.

The node agent persists its event cursor, manifest, sequence number, pending result, and authoritative progression receipt atomically beside the server. After an agent/API restart it resumes idempotent upload; an HTTP 202 keeps the identical canonical result pending rather than discarding it. Once settlement succeeds, the node validates each roster-bound XP transition and any level-bound service-drop receipt, then asks the SourceMod plugin to send CS:GO's native `XpUpdate` and `SendPlayerItemDrops` protobufs before claiming terminal drain. The plugin independently verifies match state, Steam account identity, category, bounds, progression math, and the exact one-level reward transition; separate presentation flags make retries harmless. A player who has already disconnected is recorded as absent so the terminal server can still drain. The agent recognizes completed, surrendered, and forfeited terminal events, and treats a plugin-originated abort as already terminal rather than requesting an impossible second abort. It finalizes GOTV before draining and restores the warm-server password/config. A stale or expired lease is fenced out and quarantined. An expiry before live cancels the pending match; an expiry with an already accepted canonical result defers to settlement; any other live expiry moves the match to `disputed`, captures non-secret lease evidence, opens one immutable-audited recovery incident, and alerts operators.

The node agent includes a protocol-versioned, secret-free SRCDS health record in its authenticated heartbeat. It binds only the active match/lease identifiers to consecutive RCON success/failure timestamps. One-off failures are tolerated; three consecutive failures for the database-owned active lease atomically expire its fence with `srcds_unreachable`, quarantine the instance, preserve evidence, dispute a live match, and open exactly one recovery incident before the longer lease TTL. Claimed results still win the existing result-race reconciliation path.

An administrator can void the failed match without rating or stage an idempotent remake. Remakes copy the original season, map, region, ruleset, roster and teams into exactly one new match, allocate a fresh fence/manifest/password/demo key, and replace each surviving Redis assignment before publishing `match.assigned`. Zero capacity leaves the incident durably `resolving`, and a retry resumes the same replacement rather than creating another. Missing Redis tickets are surfaced as a manual-handoff error. Exact live score/economy reconstruction after an SRCDS process crash is deliberately not automated for the private alpha.

Demo retention is a two-phase database/object-store workflow. Only analyzed or invalid terminal-match artifacts older than the configured cutoff are eligible; disputes and active report/appeal evidence apply holds. Successful deletion preserves checksum, size and analyzer metadata plus an append-only audit record. Failed or interrupted deletions restore/reclaim their prior state. Audit metadata is indefinite; telemetry and backup windows are bounded separately in the data-retention runbook.

The independent Go analyzer parses legacy CS:GO demos with `demoinfocs-golang/v3`, calculates round/player statistics, and records quality warnings. Demo metadata contains the lease, object key, byte length, and SHA-256; the API verifies the object before marking it valid.

## Rating

The visible base result is:

```text
50 × (actual score − expected score)
```

An even match starts at approximately +25/-25. Round margin contributes at most ±3, contextual impact at most ±7, and early placements use a bounded convergence multiplier. Context is centered across the lobby to stay zero-sum. A win always gains and a loss always loses. Each ledger entry preserves the result, round, performance, and placement components for audit and UI explanation.

## Development and CI isolation

`compose.yml` provides loopback PostgreSQL 17, authenticated Redis 7, and MinIO. `compose.observability.yml` adds pinned Prometheus, Grafana, Alertmanager, Tempo, and OpenTelemetry Collector images. Migrations run under a PostgreSQL advisory transaction lock and store SHA-256 checksums.

Playwright uses dedicated ports and a test-only identity secret. The full-platform runner creates and destroys a uniquely named PostgreSQL schema and registers a one-run node token, leaving the developer database and credential file untouched. The local Valve payload lives under ignored `.tools/`; generated evidence lives under ignored `.artifacts/`. CI performs production dependency audit, Go/Rust builds, service provisioning, migrations, unit/integration/type/build checks, a native Rust-launcher → UDP A2S → HTTP API → PostgreSQL routing test, telemetry smoke, browser E2E, immutable Linux activation/rollback, checksum-backed secret-free host bundles, hosted acceptance-probe fixtures, and a Windows Authenticode-pinning fixture.

## Deliberate boundaries

No anti-cheat verdict, client scanner, kernel component, cosmetic minting system, or unrestricted skin changer exists. The API imports only a player's public Steam App 730 weapon inventory and stores exact ownership-bound asset IDs. The pinned local GC exposes those verified items to native App 4465480 Inventory/Loadout screens while the server applies only the signed ownership policy; it never creates a Valve item or grants an unowned skin. Profile XP is authoritative. Each actual service-level increase creates one auditable B2G-only, non-tradable reward receipt and uses the final client's generic end-of-match reveal path with an explicit `B2G Service Drop` label; it does not create a cosmetic or Steam inventory object. Native queue, Steam-lobby party tickets, map selection, ready-check presentation, and assignment are implemented; the pre-Panorama shell remains a later milestone. The future integrity-provider attachment belongs in the already-signed launcher/server manifest and must remain separate from match settlement. Remote hosting, DNS/TLS, production secret management, code-signing identity, paging, and Valve/legal approval are deployment inputs rather than local code.
