-- Audited operator recovery for unrecoverable live game-server failures.

CREATE TYPE match_recovery_status AS ENUM ('open', 'resolving', 'resolved');
CREATE TYPE match_recovery_action AS ENUM ('remake', 'void');

CREATE TABLE match_recovery_incidents (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id                 UUID NOT NULL UNIQUE REFERENCES matches(id),
  lease_id                 UUID NOT NULL REFERENCES server_leases(id),
  reason                   TEXT NOT NULL CHECK (reason IN ('server_lease_expired')),
  status                   match_recovery_status NOT NULL DEFAULT 'open',
  evidence                 JSONB NOT NULL DEFAULT '{}',
  detected_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolution_action        match_recovery_action,
  resolution_note          TEXT,
  resolved_by              UUID REFERENCES players(id),
  resolved_at              TIMESTAMPTZ,
  replacement_match_id     UUID UNIQUE REFERENCES matches(id),
  queue_reassigned_players INTEGER NOT NULL DEFAULT 0 CHECK (queue_reassigned_players >= 0),
  queue_delivery_error     TEXT,
  resolution_error         TEXT,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (status = 'open'
      AND resolution_action IS NULL
      AND resolution_note IS NULL
      AND resolved_by IS NULL
      AND resolved_at IS NULL
      AND replacement_match_id IS NULL)
    OR (status = 'resolving'
      AND resolution_action = 'remake'
      AND resolution_note IS NOT NULL
      AND resolved_by IS NOT NULL
      AND resolved_at IS NULL
      AND replacement_match_id IS NOT NULL)
    OR (status = 'resolved'
      AND resolution_action IS NOT NULL
      AND resolution_note IS NOT NULL
      AND resolved_by IS NOT NULL
      AND resolved_at IS NOT NULL
      AND (
        (resolution_action = 'void' AND replacement_match_id IS NULL)
        OR (resolution_action = 'remake' AND replacement_match_id IS NOT NULL)
      ))
  )
);

CREATE INDEX idx_match_recovery_incidents_status
  ON match_recovery_incidents (status, detected_at);
