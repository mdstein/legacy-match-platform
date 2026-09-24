# Observability

Aftertick ships a locally reproducible metrics, logs, traces, dashboard, and alerting stack:

- API Prometheus metrics at `GET /metrics`;
- one structured JSON record per completed HTTP request;
- W3C `traceparent` propagation and OpenTelemetry Node auto-instrumentation;
- OpenTelemetry Collector 0.159.0;
- Tempo 2.10.7 with 24-hour local trace retention;
- Prometheus 3.14.0, Grafana 13.1.0, and Alertmanager 0.33.1.

The Compose file pins container images by digest. Production must set `METRICS_BEARER_TOKEN`; Prometheus reads the same token from a mounted credentials file. Do not put credentials in scrape URLs or Git.

## Start and prove the stack

```powershell
npm run infra:observability:up
npm run test:observability
npm run infra:observability:status
```

Local endpoints:

- Grafana: `http://127.0.0.1:3000`
- Prometheus: `http://127.0.0.1:9090`
- Alertmanager: `http://127.0.0.1:9093`
- Tempo query API: `http://127.0.0.1:3200`
- Collector OTLP/HTTP: `http://127.0.0.1:4318`
- Collector health: `http://127.0.0.1:13133`

`test:observability` builds the production artifacts, starts the API through its instrumentation wrapper, sends a request with a known trace ID, polls Tempo until the multi-span trace is stored, checks the API/Collector/Tempo Prometheus targets, and verifies Grafana can query the provisioned Tempo datasource.

The API starts normally when no OTLP endpoint is configured in development. Production configuration requires `OTEL_EXPORTER_OTLP_ENDPOINT`; the default service name is `aftertick-api`, and the sampler is configurable with `OTEL_TRACES_SAMPLER`.

## Signals

The provisioned “Aftertick Platform Overview” dashboard covers:

- HTTP request rate, error status, and latency percentiles;
- queue depth and active matches;
- healthy game nodes;
- pending moderation reports/appeals;
- invalid demo artifacts;
- open/resolving live-match recovery incidents;
- process uptime and dependency target health.

Prometheus alert rules are in `ops/prometheus/alerts.yml`. Promtool validates the config and eight rules, including a page for unresolved live-match recovery. Alertmanager intentionally has no real receiver secret in source control; the production deployment must add a paging target and exercise one acknowledged test page.

Local defaults retain Prometheus samples for 30 days, Tempo blocks for 24 hours, and Alertmanager state for 120 hours. The Compose values are configurable through `AFTERTICK_PROMETHEUS_RETENTION`, `AFTERTICK_TEMPO_RETENTION`, and `AFTERTICK_ALERT_RETENTION`; production values must follow `docs/runbooks/data-retention.md`.

Every API response includes `X-Request-Id` and `traceparent`. Logs include the same request/trace identifiers, method, bounded route label, status, and duration. Unmatched URLs use the constant route label `unmatched` to prevent cardinality growth.

Never log session cookies, Steam credentials/tickets, game passwords, node bearer tokens, manifest/event secrets, RCON credentials, signing material, or object-store secrets.

## Launch checklist

1. `/health` is live and `/ready` proves PostgreSQL, Redis, and object storage.
2. An unauthenticated production `/metrics` request returns 401.
3. Prometheus targets `aftertick-api`, `otel-collector`, and `tempo` are up.
4. Grafana’s Prometheus and Tempo datasource health checks return OK.
5. A synthetic request is discoverable by trace ID and contains HTTP plus dependency spans.
6. Alert rules load with no evaluation errors.
7. A real receiver test page is acknowledged and attached to an incident timeline.
8. Operator actions that change platform state are present in `audit_log`.
