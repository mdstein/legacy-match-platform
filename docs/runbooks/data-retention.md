# Data retention

The application is the source of truth for canonical GOTV deletion. Do not configure an object-store lifecycle that can delete `matches/*/gotv.dem` before the application job; doing so would bypass evidence holds and the deletion audit.

Default private-alpha policy:

- analyzed or invalid GOTV objects: 90 days;
- disputed matches, pending/under-review reports, and pending sanction appeals: held indefinitely until the hold closes;
- demo checksums, byte counts, analyzer metadata, deletion timestamps, and immutable audit entries: retained indefinitely;
- audit log: retained indefinitely and database-enforced append-only;
- Prometheus samples: 30 days;
- Tempo traces: 24 hours;
- Alertmanager silences/notification state: 120 hours;
- local/off-provider backup sets: 30 days with at least three valid checksum-manifested sets retained.

Before every policy change or first production run:

1. Take and verify a backup.
2. Set `AFTERTICK_DEMO_RETENTION_DAYS` and `AFTERTICK_RETENTION_BATCH_SIZE` in the runtime/retention-job environment.
3. Run `npm run deploy:retention:dry-run`. Review every candidate match ID, upload date, status, and object key. A dry run performs no database or object mutation.
4. Confirm no candidate is disputed or covered by an active report/appeal. These holds are also enforced by the query, but the operator review remains mandatory.
5. Run `npm run deploy:retention:apply`. The job claims each artifact, deletes the object, marks metadata `deleted`, clears the public demo URL, preserves checksum/size, and appends `demo.retention.deleted` to `audit_log`.
6. If object deletion fails, the job restores the artifact’s prior `analyzed`/`invalid` status, records the error, and safely retries on the next run. A process crash while `deleting` is reclaimed after 15 minutes.
7. Schedule the apply job daily with a single-instance scheduler. Concurrent runs remain safe through row locks and status claims.

For local or filesystem backup sets, preview with `npm run backup:prune:local` and apply with `npm run backup:prune:local:apply`. The pruner refuses paths outside `.artifacts`, ignores malformed sets, preserves the configured minimum, and is idempotent. Set `AFTERTICK_BACKUP_RETENTION_DAYS` and `AFTERTICK_BACKUP_KEEP_MINIMUM` before scheduling it.

Provider-native database/object version retention and the off-provider copy must be configured and exercised after the production stores are selected. Record the provider policy IDs, first dry-run output, first applied deletion audit ID, and restore evidence in the deployment log.
