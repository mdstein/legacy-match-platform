-- 026_service_graffiti_and_drop_announcements.sql
-- The third service-level reward is a real schema-backed graffiti with the
-- stock sealed -> 50-charge spray lifecycle. Authoritative container results
-- may also be relayed to an active match for the classic chat announcement.

CREATE TABLE player_b2g_direct_reward_grants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id       UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  service_drop_id UUID NOT NULL REFERENCES player_service_drops(id) ON DELETE CASCADE,
  drop_slot       SMALLINT NOT NULL CHECK (drop_slot = 3),
  reward_type     TEXT NOT NULL CHECK (reward_type = 'graffiti'),
  sealed_asset_id TEXT NOT NULL CHECK (sealed_asset_id ~ '^[0-9]{1,20}$'),
  spray_kit_id    INTEGER NOT NULL CHECK (spray_kit_id > 0),
  spray_tint_id   INTEGER NOT NULL CHECK (spray_tint_id BETWEEN 1 AND 19),
  charges         INTEGER NOT NULL CHECK (charges = 50),
  odds_version    TEXT NOT NULL CHECK (char_length(odds_version) BETWEEN 1 AND 64),
  unsealed_at     TIMESTAMPTZ,
  unsealed_asset_id TEXT CHECK (unsealed_asset_id IS NULL OR unsealed_asset_id ~ '^[0-9]{1,20}$'),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (service_drop_id, drop_slot),
  UNIQUE (player_id, sealed_asset_id),
  UNIQUE (player_id, unsealed_asset_id),
  CHECK ((unsealed_at IS NULL AND unsealed_asset_id IS NULL)
    OR (unsealed_at IS NOT NULL AND unsealed_asset_id IS NOT NULL))
);

ALTER TABLE player_b2g_inventory_items
  ADD COLUMN direct_reward_grant_id UUID
    REFERENCES player_b2g_direct_reward_grants(id) ON DELETE CASCADE,
  ADD COLUMN spray_kit_id INTEGER CHECK (spray_kit_id IS NULL OR spray_kit_id > 0),
  ADD COLUMN spray_tint_id INTEGER CHECK (spray_tint_id IS NULL OR spray_tint_id BETWEEN 1 AND 19),
  ADD COLUMN sprays_remaining INTEGER CHECK (sprays_remaining IS NULL OR sprays_remaining BETWEEN 0 AND 50);

ALTER TABLE player_b2g_inventory_items
  DROP CONSTRAINT player_b2g_inventory_items_one_grant,
  ADD CONSTRAINT player_b2g_inventory_items_one_grant
    CHECK (num_nonnulls(case_grant_id, container_grant_id, direct_reward_grant_id) <= 1),
  ADD CONSTRAINT player_b2g_inventory_spray_shape CHECK (
    (definition_index = 1348 AND item_kind = 'cosmetic' AND weapon_key = 'graffiti'
      AND loadout_slot = 56 AND spray_kit_id IS NOT NULL
      AND spray_tint_id IS NOT NULL AND sprays_remaining IS NULL)
    OR
    (definition_index = 1349 AND item_kind = 'cosmetic' AND weapon_key = 'graffiti'
      AND loadout_slot = 56 AND spray_kit_id IS NOT NULL
      AND spray_tint_id IS NOT NULL
      AND ((state = 'active' AND sprays_remaining BETWEEN 1 AND 50)
        OR (state = 'consumed' AND sprays_remaining = 0)))
    OR
    (definition_index NOT IN (1348, 1349) AND spray_kit_id IS NULL
      AND spray_tint_id IS NULL AND sprays_remaining IS NULL)
  );

CREATE UNIQUE INDEX idx_player_b2g_direct_reward_item_stage
  ON player_b2g_inventory_items (direct_reward_grant_id, definition_index)
  WHERE direct_reward_grant_id IS NOT NULL;

-- Container color is an item-schema presentation property, not the rarity of
-- the best possible reward inside it. Existing and future B2G cases therefore
-- use the white/consumer-grade inventory tier.
UPDATE player_b2g_inventory_items
SET rarity = 1
WHERE item_kind = 'case' AND rarity <> 1;

ALTER TABLE player_b2g_inventory_items
  ADD CONSTRAINT player_b2g_inventory_case_rarity
    CHECK (item_kind <> 'case' OR rarity = 1);

ALTER TABLE node_commands
  DROP CONSTRAINT IF EXISTS node_commands_command_type_check;

ALTER TABLE node_commands
  ADD CONSTRAINT node_commands_command_type_check CHECK (command_type IN (
    'start', 'stop', 'prepare', 'sync-roster', 'announce-drop',
    'drain', 'quarantine', 'unquarantine'
  ));

COMMENT ON TABLE player_b2g_direct_reward_grants IS
  'Exactly-once service-level graffiti grants and their sealed-to-active lineage.';
