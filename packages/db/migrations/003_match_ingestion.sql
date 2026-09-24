-- Durable, idempotent game-server event and terminal-result ingestion.

ALTER TABLE match_events ADD COLUMN event_id UUID;
ALTER TABLE match_events ADD COLUMN sequence BIGINT;
ALTER TABLE match_events ADD COLUMN occurred_at TIMESTAMPTZ;
ALTER TABLE match_events ADD COLUMN lease_id UUID REFERENCES server_leases(id);
ALTER TABLE match_events ADD COLUMN payload_checksum TEXT;

UPDATE match_events SET event_id = id WHERE event_id IS NULL;
WITH ordered AS (
  SELECT id, row_number() OVER (PARTITION BY match_id ORDER BY recorded_at, id) AS value
  FROM match_events
)
UPDATE match_events event
SET sequence = ordered.value
FROM ordered
WHERE event.id = ordered.id AND event.sequence IS NULL;
UPDATE match_events SET occurred_at = recorded_at WHERE occurred_at IS NULL;
UPDATE match_events SET payload_checksum = repeat('0', 64) WHERE payload_checksum IS NULL;

ALTER TABLE match_events ALTER COLUMN event_id SET NOT NULL;
ALTER TABLE match_events ALTER COLUMN sequence SET NOT NULL;
ALTER TABLE match_events ALTER COLUMN occurred_at SET NOT NULL;
ALTER TABLE match_events ALTER COLUMN payload_checksum SET NOT NULL;
ALTER TABLE match_events ADD CONSTRAINT match_events_sequence_positive CHECK (sequence > 0);
ALTER TABLE match_events ADD CONSTRAINT match_events_checksum_format
  CHECK (payload_checksum ~ '^[a-f0-9]{64}$');
CREATE UNIQUE INDEX idx_match_events_event_id ON match_events (match_id, event_id);
CREATE UNIQUE INDEX idx_match_events_sequence ON match_events (match_id, sequence);

CREATE TABLE match_event_conflicts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id           UUID NOT NULL REFERENCES matches(id),
  lease_id           UUID NOT NULL REFERENCES server_leases(id),
  event_id           UUID NOT NULL,
  sequence           BIGINT NOT NULL,
  payload_checksum   TEXT NOT NULL CHECK (payload_checksum ~ '^[a-f0-9]{64}$'),
  canonical_checksum TEXT NOT NULL CHECK (canonical_checksum ~ '^[a-f0-9]{64}$'),
  payload            JSONB NOT NULL,
  received_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (match_id, event_id, payload_checksum)
);

CREATE INDEX idx_match_event_conflicts_match
  ON match_event_conflicts (match_id, received_at);

CREATE TYPE match_result_status AS ENUM ('pending', 'settled', 'conflicting');

CREATE TABLE match_results (
  id                 UUID PRIMARY KEY,
  match_id           UUID NOT NULL UNIQUE REFERENCES matches(id),
  lease_id           UUID NOT NULL REFERENCES server_leases(id),
  result_version     INTEGER NOT NULL CHECK (result_version = 1),
  idempotency_key    UUID NOT NULL UNIQUE,
  payload_checksum   TEXT NOT NULL CHECK (payload_checksum ~ '^[a-f0-9]{64}$'),
  alpha_rounds       INTEGER NOT NULL CHECK (alpha_rounds BETWEEN 0 AND 60),
  bravo_rounds       INTEGER NOT NULL CHECK (bravo_rounds BETWEEN 0 AND 60),
  reason             TEXT NOT NULL CHECK (reason IN ('completed', 'surrender', 'forfeit')),
  completed_at       TIMESTAMPTZ NOT NULL,
  payload            JSONB NOT NULL,
  status             match_result_status NOT NULL DEFAULT 'pending',
  received_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at         TIMESTAMPTZ
);

CREATE INDEX idx_match_results_pending
  ON match_results (received_at, match_id) WHERE status = 'pending';

CREATE TABLE match_result_conflicts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id           UUID NOT NULL REFERENCES matches(id),
  lease_id           UUID NOT NULL REFERENCES server_leases(id),
  idempotency_key    UUID NOT NULL,
  payload_checksum   TEXT NOT NULL CHECK (payload_checksum ~ '^[a-f0-9]{64}$'),
  canonical_checksum TEXT NOT NULL CHECK (canonical_checksum ~ '^[a-f0-9]{64}$'),
  payload            JSONB NOT NULL,
  received_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (match_id, payload_checksum)
);

CREATE INDEX idx_match_result_conflicts_match
  ON match_result_conflicts (match_id, received_at);
