-- 025_service_reward_containers.sql
-- Two independently rolled, authoritative rewards are attached to one earned
-- service-level receipt. Pin and souvenir containers use the same local-GC
-- opening bridge as weapon cases but have no key entitlement.

ALTER TABLE player_b2g_case_grants
  DROP CONSTRAINT player_b2g_case_grants_service_drop_id_key;

ALTER TABLE player_b2g_case_grants
  ADD COLUMN drop_slot SMALLINT
    CHECK (drop_slot IS NULL OR drop_slot BETWEEN 1 AND 2);

UPDATE player_b2g_case_grants
SET drop_slot = 1
WHERE grant_type = 'service_level';

ALTER TABLE player_b2g_case_grants
  ADD CONSTRAINT player_b2g_case_grants_service_drop_slot_unique
  UNIQUE (service_drop_id, drop_slot);

ALTER TABLE player_b2g_case_grants
  ADD CONSTRAINT player_b2g_case_grants_drop_slot_shape
  CHECK (
    (grant_type = 'service_level' AND drop_slot IS NOT NULL)
    OR (grant_type = 'admin' AND drop_slot IS NULL)
  );

CREATE TABLE player_b2g_container_grants (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id                  UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  service_drop_id            UUID REFERENCES player_service_drops(id) ON DELETE CASCADE,
  batch_id                   UUID,
  grant_type                 TEXT NOT NULL DEFAULT 'service_level'
    CHECK (grant_type IN ('service_level', 'admin')),
  drop_slot                  SMALLINT CHECK (drop_slot IS NULL OR drop_slot BETWEEN 1 AND 2),
  container_type             TEXT NOT NULL CHECK (container_type IN ('pin_package', 'souvenir_package')),
  container_definition_index INTEGER NOT NULL CHECK (container_definition_index BETWEEN 1 AND 65535),
  container_asset_id         TEXT NOT NULL CHECK (container_asset_id ~ '^[0-9]{1,20}$'),
  odds_version               TEXT NOT NULL CHECK (char_length(odds_version) BETWEEN 1 AND 64),
  opened_at                  TIMESTAMPTZ,
  result_asset_id            TEXT CHECK (result_asset_id IS NULL OR result_asset_id ~ '^[0-9]{1,20}$'),
  result_roll                INTEGER CHECK (result_roll IS NULL OR result_roll BETWEEN 0 AND 9999),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (service_drop_id, drop_slot),
  UNIQUE (player_id, container_asset_id),
  CHECK (
    (grant_type = 'service_level' AND service_drop_id IS NOT NULL
      AND batch_id IS NULL AND drop_slot IS NOT NULL)
    OR
    (grant_type = 'admin' AND service_drop_id IS NULL
      AND batch_id IS NOT NULL AND drop_slot IS NULL)
  ),
  CHECK (
    (opened_at IS NULL AND result_asset_id IS NULL AND result_roll IS NULL)
    OR (opened_at IS NOT NULL AND result_asset_id IS NOT NULL AND result_roll IS NOT NULL)
  )
);

CREATE INDEX idx_player_b2g_container_grants_player
  ON player_b2g_container_grants (player_id, created_at DESC);

CREATE INDEX idx_player_b2g_container_grants_batch
  ON player_b2g_container_grants (batch_id)
  WHERE batch_id IS NOT NULL;

ALTER TABLE player_b2g_inventory_items
  ADD COLUMN container_grant_id UUID
    REFERENCES player_b2g_container_grants(id) ON DELETE CASCADE;

ALTER TABLE player_b2g_inventory_items
  ADD CONSTRAINT player_b2g_inventory_items_one_grant
  CHECK (num_nonnulls(case_grant_id, container_grant_id) <= 1);

CREATE UNIQUE INDEX idx_player_b2g_free_name_tag
  ON player_b2g_inventory_items (player_id, definition_index)
  WHERE source = 'b2g' AND state = 'active' AND definition_index = 1200;

COMMENT ON TABLE player_b2g_container_grants IS
  'Authoritative keyless B2G pin and souvenir package outcomes; never Steam ownership.';
