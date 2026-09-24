# API unavailable or elevated 5xx

1. Declare an incident, record its start time, and post: “Matchmaking is degraded; existing game servers remain online while we investigate.”
2. Check `/ready`, Prometheus target health, API structured logs, and the latest deployment identifier. Correlate failures with `traceId` and `requestId`.
3. If writes are unsafe, use the admin console to disable new queue entries and server allocations. Do not terminate live servers unless their state is corrupt.
4. Check PostgreSQL, Redis, and object-storage readiness independently. Restore only the failed dependency.
5. If the failure began with a deployment, roll back to the last verified artifact and run readiness plus one deterministic login/queue smoke.
6. Re-enable allocation first, then queue entry. Confirm error rate and p95 latency remain normal for 15 minutes.
7. Post recovery time, player impact, match IDs needing reconciliation, and the follow-up owner.
