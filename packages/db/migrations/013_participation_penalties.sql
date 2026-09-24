-- Auditable and idempotent automatic penalties for signed server-observed
-- warmup no-shows and live-match abandons.

CREATE TYPE participation_violation_type AS ENUM ('no_show', 'abandon');

CREATE TABLE match_participation_violations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id           UUID NOT NULL REFERENCES matches(id),
  player_id          UUID NOT NULL REFERENCES players(id),
  event_id           UUID NOT NULL,
  violation_type     participation_violation_type NOT NULL,
  occurred_at        TIMESTAMPTZ NOT NULL,
  absence_started_at TIMESTAMPTZ NOT NULL,
  grace_seconds      INTEGER NOT NULL CHECK (grace_seconds BETWEEN 30 AND 900),
  policy_version     INTEGER NOT NULL CHECK (policy_version = 1),
  offense_number     INTEGER NOT NULL CHECK (offense_number > 0),
  penalty_minutes    INTEGER NOT NULL CHECK (penalty_minutes > 0),
  sanction_id        UUID NOT NULL UNIQUE REFERENCES sanctions(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (match_id, player_id, violation_type),
  UNIQUE (match_id, event_id)
);

CREATE INDEX idx_participation_violations_player
  ON match_participation_violations (player_id, occurred_at DESC);
