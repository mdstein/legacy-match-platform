# Matchmaking backlog

1. Compare queue depth, wait percentiles, ready-check expiry rate, regional capacity, and matchmaker error logs.
2. If server capacity is unavailable, disable allocation and communicate the affected region. Do not widen latency beyond configured fairness limits merely to empty the queue.
3. If the matchmaker is stalled, verify the Redis lock TTL, ticket schema, and cancellation journal. Restart one matchmaker worker only after confirming the lock can expire safely.
4. Run the deterministic fairness simulator before changing rating, party, ping, or map widening parameters.
5. Re-enable service gradually and confirm tickets decline without duplicate matches, stale ready checks, or elevated declines.
