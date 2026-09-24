-- 021_player_service_drops.sql
-- Exactly-once B2G service-level rewards. These are platform receipts, not
-- Steam inventory items, and never enter the owned-cosmetic inventory tables.

CREATE TABLE player_service_drops (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id     UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  match_id      UUID REFERENCES matches(id) ON DELETE SET NULL,
  service_level INTEGER NOT NULL CHECK (service_level BETWEEN 2 AND 40),
  reward_type   TEXT NOT NULL DEFAULT 'b2g_service_drop'
    CHECK (reward_type = 'b2g_service_drop'),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (player_id, service_level, reward_type)
);

CREATE UNIQUE INDEX idx_player_service_drops_match
  ON player_service_drops (player_id, match_id)
  WHERE match_id IS NOT NULL;

CREATE INDEX idx_player_service_drops_player
  ON player_service_drops (player_id, created_at DESC);
