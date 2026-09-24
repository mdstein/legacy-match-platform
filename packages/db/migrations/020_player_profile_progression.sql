-- 020_player_profile_progression.sql
-- Authoritative profile-rank state consumed by the launcher and legacy client.

ALTER TABLE players
  ADD COLUMN profile_level INTEGER NOT NULL DEFAULT 3
    CHECK (profile_level BETWEEN 1 AND 40),
  ADD COLUMN profile_xp INTEGER NOT NULL DEFAULT 0
    CHECK (profile_xp BETWEEN 0 AND 4999),
  ADD COLUMN lifetime_xp BIGINT NOT NULL DEFAULT 0
    CHECK (lifetime_xp >= 0);

CREATE TABLE player_xp_ledger (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id      UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  match_id       UUID REFERENCES matches(id) ON DELETE SET NULL,
  delta          INTEGER NOT NULL CHECK (delta <> 0),
  reason         TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 64),
  previous_level INTEGER NOT NULL CHECK (previous_level BETWEEN 1 AND 40),
  previous_xp    INTEGER NOT NULL CHECK (previous_xp BETWEEN 0 AND 4999),
  next_level     INTEGER NOT NULL CHECK (next_level BETWEEN 1 AND 40),
  next_xp        INTEGER NOT NULL CHECK (next_xp BETWEEN 0 AND 4999),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_player_xp_ledger_match
  ON player_xp_ledger (player_id, match_id)
  WHERE match_id IS NOT NULL;

CREATE INDEX idx_player_xp_ledger_player
  ON player_xp_ledger (player_id, created_at DESC);
