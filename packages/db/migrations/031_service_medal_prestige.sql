-- B2G medals are persistent local-client cosmetics, never Steam grants.
ALTER TABLE players ADD COLUMN service_prestige INTEGER NOT NULL DEFAULT 0
  CHECK (service_prestige BETWEEN 0 AND 51);

CREATE TABLE player_service_medals (
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  medal_year INTEGER NOT NULL CHECK (medal_year BETWEEN 2015 AND 2023),
  medal_tier INTEGER NOT NULL CHECK (medal_tier BETWEEN 1 AND 7),
  asset_id TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (player_id, medal_year),
  UNIQUE (player_id, asset_id),
  FOREIGN KEY (player_id, asset_id)
    REFERENCES player_b2g_inventory_items(player_id, asset_id)
);

CREATE TABLE player_service_medal_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  prestige INTEGER NOT NULL CHECK (prestige BETWEEN 1 AND 51),
  medal_year INTEGER NOT NULL CHECK (medal_year BETWEEN 2015 AND 2023),
  medal_tier INTEGER NOT NULL CHECK (medal_tier BETWEEN 1 AND 7),
  definition_index INTEGER NOT NULL CHECK (definition_index BETWEEN 1 AND 65535),
  asset_id TEXT NOT NULL,
  previous_xp INTEGER NOT NULL CHECK (previous_xp BETWEEN 0 AND 4999),
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (player_id, prestige),
  UNIQUE (player_id, definition_index),
  FOREIGN KEY (player_id, asset_id)
    REFERENCES player_b2g_inventory_items(player_id, asset_id)
);

-- A new prestige earns level-up drops again, with exactly-once grants within
-- that prestige. Historical drops belong to prestige zero.
ALTER TABLE player_service_drops ADD COLUMN service_prestige INTEGER NOT NULL DEFAULT 0
  CHECK (service_prestige BETWEEN 0 AND 51);
ALTER TABLE player_service_drops
  DROP CONSTRAINT player_service_drops_player_id_service_level_reward_type_key;
ALTER TABLE player_service_drops ADD CONSTRAINT player_service_drops_prestige_level_unique
  UNIQUE (player_id, service_prestige, service_level, reward_type);
