-- 017_owned_cosmetic_loadouts.sql
-- Public-inventory ownership cache and player-selected, ownership-bound loadouts.

CREATE TABLE player_inventory_snapshots (
  player_id        UUID PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'unavailable'
    CHECK (status IN ('public', 'private', 'unavailable')),
  item_count       INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  refreshed_at     TIMESTAMPTZ,
  last_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  next_refresh_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error_code  TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE player_inventory_items (
  player_id         UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  asset_id          TEXT NOT NULL CHECK (asset_id ~ '^[0-9]{1,20}$'),
  class_id          TEXT NOT NULL CHECK (class_id ~ '^[0-9]{1,20}$'),
  instance_id       TEXT NOT NULL CHECK (instance_id ~ '^[0-9]{1,20}$'),
  definition_index  INTEGER NOT NULL CHECK (definition_index BETWEEN 1 AND 65535),
  weapon_key        TEXT NOT NULL CHECK (weapon_key ~ '^[a-z0-9_]{2,32}$'),
  display_name      TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 160),
  market_hash_name  TEXT NOT NULL CHECK (char_length(market_hash_name) BETWEEN 1 AND 200),
  icon_path         TEXT CHECK (icon_path IS NULL OR char_length(icon_path) <= 512),
  tradable          BOOLEAN NOT NULL DEFAULT FALSE,
  marketable        BOOLEAN NOT NULL DEFAULT FALSE,
  imported_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (player_id, asset_id)
);

CREATE INDEX idx_player_inventory_items_weapon
  ON player_inventory_items (player_id, weapon_key, display_name);

CREATE TABLE player_cosmetic_loadouts (
  player_id   UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  weapon_key  TEXT NOT NULL CHECK (weapon_key ~ '^[a-z0-9_]{2,32}$'),
  asset_id    TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (player_id, weapon_key),
  FOREIGN KEY (player_id, asset_id)
    REFERENCES player_inventory_items(player_id, asset_id) ON DELETE CASCADE
);

