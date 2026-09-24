-- 018_owned_native_inventory.sql
-- Exact legacy-compatible Econ attributes plus short-lived launcher grants.

ALTER TABLE player_inventory_items
  ADD COLUMN inventory_position BIGINT,
  ADD COLUMN paint_index INTEGER,
  ADD COLUMN paint_wear DOUBLE PRECISION,
  ADD COLUMN paint_seed INTEGER,
  ADD COLUMN quality INTEGER,
  ADD COLUMN rarity INTEGER,
  ADD COLUMN origin INTEGER,
  ADD COLUMN kill_eater_score_type BIGINT,
  ADD COLUMN kill_eater_value BIGINT,
  ADD COLUMN custom_name TEXT,
  ADD COLUMN stickers JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN loadout_slot INTEGER,
  ADD COLUMN legacy_compatible BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE player_inventory_items
  ADD CONSTRAINT player_inventory_position_uint32
    CHECK (inventory_position IS NULL OR inventory_position BETWEEN 0 AND 4294967295),
  ADD CONSTRAINT player_inventory_paint_index_uint32
    CHECK (paint_index IS NULL OR paint_index >= 0),
  ADD CONSTRAINT player_inventory_paint_wear_range
    CHECK (paint_wear IS NULL OR paint_wear BETWEEN 0 AND 1),
  ADD CONSTRAINT player_inventory_paint_seed_uint32
    CHECK (paint_seed IS NULL OR paint_seed >= 0),
  ADD CONSTRAINT player_inventory_quality_uint32
    CHECK (quality IS NULL OR quality >= 0),
  ADD CONSTRAINT player_inventory_rarity_uint32
    CHECK (rarity IS NULL OR rarity >= 0),
  ADD CONSTRAINT player_inventory_origin_uint32
    CHECK (origin IS NULL OR origin >= 0),
  ADD CONSTRAINT player_inventory_kill_eater_score_type_uint32
    CHECK (kill_eater_score_type IS NULL OR kill_eater_score_type BETWEEN 0 AND 4294967295),
  ADD CONSTRAINT player_inventory_kill_eater_value_uint32
    CHECK (kill_eater_value IS NULL OR kill_eater_value BETWEEN 0 AND 4294967295),
  ADD CONSTRAINT player_inventory_custom_name_length
    CHECK (custom_name IS NULL OR char_length(custom_name) BETWEEN 1 AND 100),
  ADD CONSTRAINT player_inventory_stickers_shape
    CHECK (jsonb_typeof(stickers) = 'array' AND jsonb_array_length(stickers) <= 6),
  ADD CONSTRAINT player_inventory_loadout_slot_range
    CHECK (loadout_slot IS NULL OR loadout_slot BETWEEN 0 AND 63),
  ADD CONSTRAINT player_inventory_compatible_metadata
    CHECK (
      legacy_compatible = FALSE OR (
        inventory_position IS NOT NULL AND paint_index IS NOT NULL
        AND paint_seed IS NOT NULL AND quality IS NOT NULL
        AND rarity IS NOT NULL AND origin IS NOT NULL
        AND loadout_slot IS NOT NULL
      )
    );

CREATE TABLE launcher_inventory_grants (
  id                UUID PRIMARY KEY,
  match_id          UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  token_sha256      TEXT NOT NULL CHECK (token_sha256 ~ '^[a-f0-9]{64}$'),
  expires_at        TIMESTAMPTZ NOT NULL,
  redemption_count  INTEGER NOT NULL DEFAULT 0 CHECK (redemption_count BETWEEN 0 AND 64),
  last_redeemed_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_launcher_inventory_grants_expiry
  ON launcher_inventory_grants (expires_at);
