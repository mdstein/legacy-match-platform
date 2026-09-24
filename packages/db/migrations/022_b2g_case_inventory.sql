-- 022_b2g_case_inventory.sql
-- Persistent, non-Steam B2G rewards used by the local GC. Every level-up drop
-- owns one real legacy case definition and one compatible zero-cost virtual key.

CREATE SEQUENCE b2g_inventory_asset_id_seq
  AS BIGINT
  START WITH 8000000000000000000
  MINVALUE 8000000000000000000
  MAXVALUE 8999999999999999999
  NO CYCLE;

ALTER TABLE players
  ADD COLUMN b2g_inventory_revision BIGINT NOT NULL DEFAULT 0
    CHECK (b2g_inventory_revision >= 0);

DROP INDEX idx_player_service_drops_match;

CREATE UNIQUE INDEX idx_player_service_drops_match_level
  ON player_service_drops (player_id, match_id, service_level)
  WHERE match_id IS NOT NULL;

-- One authoritative record backs every openable B2G case, whether it came
-- from normal service progression or an explicitly audited playtest batch.
CREATE TABLE player_b2g_case_grants (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id             UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  service_drop_id       UUID UNIQUE REFERENCES player_service_drops(id) ON DELETE CASCADE,
  grant_type            TEXT NOT NULL CHECK (grant_type IN ('service_level', 'admin')),
  batch_id              UUID,
  case_definition_index INTEGER NOT NULL CHECK (case_definition_index BETWEEN 1 AND 65535),
  key_definition_index  INTEGER NOT NULL CHECK (key_definition_index BETWEEN 1 AND 65535),
  case_asset_id         TEXT NOT NULL CHECK (case_asset_id ~ '^[0-9]{1,20}$'),
  key_asset_id          TEXT NOT NULL CHECK (key_asset_id ~ '^[0-9]{1,20}$'),
  odds_version          TEXT NOT NULL CHECK (char_length(odds_version) BETWEEN 1 AND 64),
  opened_at             TIMESTAMPTZ,
  opened_key_asset_id   TEXT CHECK (opened_key_asset_id IS NULL OR opened_key_asset_id ~ '^[0-9]{1,20}$'),
  result_asset_id       TEXT CHECK (result_asset_id IS NULL OR result_asset_id ~ '^[0-9]{1,20}$'),
  result_roll           INTEGER CHECK (result_roll IS NULL OR result_roll BETWEEN 0 AND 9999),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (player_id, case_asset_id),
  UNIQUE (player_id, key_asset_id),
  CHECK (
    (grant_type = 'service_level' AND service_drop_id IS NOT NULL AND batch_id IS NULL)
    OR (grant_type = 'admin' AND service_drop_id IS NULL AND batch_id IS NOT NULL)
  ),
  CHECK (
    (opened_at IS NULL AND opened_key_asset_id IS NULL AND result_asset_id IS NULL AND result_roll IS NULL)
    OR (opened_at IS NOT NULL AND opened_key_asset_id IS NOT NULL
      AND result_asset_id IS NOT NULL AND result_roll IS NOT NULL)
  )
);

CREATE INDEX idx_player_b2g_case_grants_player
  ON player_b2g_case_grants (player_id, created_at DESC);

CREATE INDEX idx_player_b2g_case_grants_batch
  ON player_b2g_case_grants (player_id, batch_id)
  WHERE batch_id IS NOT NULL;

CREATE TABLE player_b2g_inventory_items (
  player_id             UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  asset_id              TEXT NOT NULL CHECK (asset_id ~ '^[0-9]{1,20}$'),
  case_grant_id         UUID REFERENCES player_b2g_case_grants(id) ON DELETE CASCADE,
  source                TEXT NOT NULL DEFAULT 'b2g' CHECK (source = 'b2g'),
  item_kind             TEXT NOT NULL CHECK (item_kind IN ('case', 'key', 'cosmetic')),
  state                 TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'consumed')),
  definition_index      INTEGER NOT NULL CHECK (definition_index BETWEEN 1 AND 65535),
  weapon_key            TEXT NOT NULL CHECK (weapon_key ~ '^[a-z0-9_]{2,32}$'),
  display_name          TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 160),
  icon_path             TEXT CHECK (icon_path IS NULL OR char_length(icon_path) <= 512),
  inventory_position    BIGINT NOT NULL CHECK (inventory_position BETWEEN 0 AND 4294967295),
  paint_index           INTEGER CHECK (paint_index IS NULL OR paint_index >= 0),
  paint_wear            DOUBLE PRECISION CHECK (paint_wear IS NULL OR paint_wear BETWEEN 0 AND 1),
  paint_seed            INTEGER CHECK (paint_seed IS NULL OR paint_seed >= 0),
  quality               INTEGER NOT NULL CHECK (quality >= 0),
  rarity                INTEGER NOT NULL CHECK (rarity >= 0),
  origin                INTEGER NOT NULL CHECK (origin >= 0),
  kill_eater_score_type BIGINT CHECK (kill_eater_score_type IS NULL OR kill_eater_score_type BETWEEN 0 AND 4294967295),
  kill_eater_value      BIGINT CHECK (kill_eater_value IS NULL OR kill_eater_value BETWEEN 0 AND 4294967295),
  custom_name           TEXT CHECK (custom_name IS NULL OR char_length(custom_name) BETWEEN 1 AND 100),
  stickers              JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(stickers) = 'array' AND jsonb_array_length(stickers) <= 6),
  loadout_slot          INTEGER NOT NULL CHECK (loadout_slot BETWEEN 0 AND 63),
  acquired_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consumed_at           TIMESTAMPTZ,
  PRIMARY KEY (player_id, asset_id),
  CHECK ((state = 'active' AND consumed_at IS NULL) OR (state = 'consumed' AND consumed_at IS NOT NULL)),
  CHECK (item_kind = 'cosmetic' OR (paint_index IS NULL AND paint_wear IS NULL AND paint_seed IS NULL))
);

CREATE UNIQUE INDEX idx_player_b2g_inventory_grant_kind
  ON player_b2g_inventory_items (case_grant_id, item_kind)
  WHERE case_grant_id IS NOT NULL;

CREATE INDEX idx_player_b2g_inventory_active
  ON player_b2g_inventory_items (player_id, state, acquired_at DESC);

CREATE FUNCTION advance_b2g_inventory_revision()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_player_id UUID;
BEGIN
  target_player_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.player_id ELSE NEW.player_id END;
  UPDATE players
  SET b2g_inventory_revision = b2g_inventory_revision + 1
  WHERE id = target_player_id;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER player_b2g_inventory_items_revision
  AFTER INSERT OR UPDATE OR DELETE ON player_b2g_inventory_items
  FOR EACH ROW EXECUTE FUNCTION advance_b2g_inventory_revision();

ALTER TABLE player_cosmetic_loadouts
  DROP CONSTRAINT player_cosmetic_loadouts_player_id_asset_id_fkey;

-- A loadout may now reference either the public Steam ownership cache or the
-- B2G-only inventory. Keep that union enforced in PostgreSQL instead of
-- relying solely on the API validation path.
CREATE FUNCTION enforce_owned_cosmetic_loadout()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM player_inventory_items item
    WHERE item.player_id = NEW.player_id
      AND item.asset_id = NEW.asset_id
      AND item.weapon_key = NEW.weapon_key
      AND item.legacy_compatible = TRUE
  ) OR EXISTS (
    SELECT 1
    FROM player_b2g_inventory_items item
    WHERE item.player_id = NEW.player_id
      AND item.asset_id = NEW.asset_id
      AND item.weapon_key = NEW.weapon_key
      AND item.item_kind = 'cosmetic'
      AND item.state = 'active'
  ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'loadout asset is not an active owned cosmetic'
    USING ERRCODE = 'foreign_key_violation';
END;
$$;

CREATE CONSTRAINT TRIGGER player_cosmetic_loadouts_owned_asset
  AFTER INSERT OR UPDATE ON player_cosmetic_loadouts
  DEFERRABLE INITIALLY IMMEDIATE
  FOR EACH ROW EXECUTE FUNCTION enforce_owned_cosmetic_loadout();

CREATE FUNCTION remove_unowned_cosmetic_loadout()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM player_cosmetic_loadouts
  WHERE player_id = OLD.player_id AND asset_id = OLD.asset_id;
  RETURN OLD;
END;
$$;

CREATE TRIGGER player_inventory_items_remove_loadout
  AFTER DELETE ON player_inventory_items
  FOR EACH ROW EXECUTE FUNCTION remove_unowned_cosmetic_loadout();

CREATE TRIGGER player_b2g_inventory_items_delete_loadout
  AFTER DELETE ON player_b2g_inventory_items
  FOR EACH ROW
  WHEN (OLD.state = 'active')
  EXECUTE FUNCTION remove_unowned_cosmetic_loadout();

CREATE TRIGGER player_b2g_inventory_items_consume_loadout
  AFTER UPDATE OF state ON player_b2g_inventory_items
  FOR EACH ROW
  WHEN (OLD.state = 'active' AND NEW.state <> 'active')
  EXECUTE FUNCTION remove_unowned_cosmetic_loadout();

COMMENT ON TABLE player_b2g_inventory_items IS
  'B2G-only virtual inventory. Rows never represent or transfer Steam ownership.';

COMMENT ON TABLE player_b2g_case_grants IS
  'Authoritative B2G case/key pair and immutable opening outcome; never Steam ownership.';
