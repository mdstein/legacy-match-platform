-- Moderation roles, appeals, operator kill switches, and immutable audit enforcement.

CREATE TYPE platform_role AS ENUM ('player', 'moderator', 'admin');
ALTER TABLE players
  ADD COLUMN platform_role platform_role NOT NULL DEFAULT 'player';
CREATE INDEX idx_players_platform_role ON players (platform_role)
  WHERE platform_role <> 'player';

ALTER TABLE reports
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE reports
  ADD CONSTRAINT reports_no_self_report CHECK (reporter_id <> reported_id);
CREATE UNIQUE INDEX idx_reports_one_per_match_category
  ON reports (reporter_id, reported_id, match_id, category)
  WHERE match_id IS NOT NULL;

CREATE TYPE appeal_status AS ENUM ('pending', 'upheld', 'reduced', 'overturned');
CREATE TABLE sanction_appeals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sanction_id     UUID NOT NULL REFERENCES sanctions(id),
  player_id       UUID NOT NULL REFERENCES players(id),
  statement       TEXT NOT NULL,
  status          appeal_status NOT NULL DEFAULT 'pending',
  reviewer_id     UUID REFERENCES players(id),
  resolution      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at     TIMESTAMPTZ,
  UNIQUE (sanction_id, player_id)
);
CREATE INDEX idx_sanction_appeals_pending ON sanction_appeals (created_at)
  WHERE status = 'pending';

CREATE TABLE platform_controls (
  singleton                   BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  registration_enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  queue_enabled              BOOLEAN NOT NULL DEFAULT TRUE,
  server_allocation_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  user_message               TEXT,
  version                    BIGINT NOT NULL DEFAULT 1,
  updated_by                 UUID REFERENCES players(id),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO platform_controls (singleton) VALUES (TRUE);

CREATE OR REPLACE FUNCTION reject_audit_log_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$;

CREATE TRIGGER audit_log_immutable_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_audit_log_mutation();
CREATE TRIGGER audit_log_immutable_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION reject_audit_log_mutation();
