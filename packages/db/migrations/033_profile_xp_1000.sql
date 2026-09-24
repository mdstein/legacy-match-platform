-- Preserve current levels and every current XP point. The migration runner
-- converts the recorded XP and grants the ordinary rewards in this transaction.
-- Points beyond level 40 are held for the next service-medal redemption.
ALTER TABLE players ADD COLUMN profile_xp_reserve INTEGER NOT NULL DEFAULT 0
  CHECK (profile_xp_reserve >= 0);

CREATE TABLE player_xp_conversion_1000 (
  player_id UUID PRIMARY KEY REFERENCES players(id),
  previous_level INTEGER NOT NULL,
  previous_xp INTEGER NOT NULL,
  next_level INTEGER NOT NULL,
  next_xp INTEGER NOT NULL,
  reserved_xp INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
