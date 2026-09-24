-- 023_b2g_trade_ups.sql
-- Persist stock-client trade-up contracts for B2G-only cosmetics. Valve-owned
-- assets stay outside this mutation boundary because B2G cannot consume them.

ALTER TABLE player_b2g_inventory_items
  ADD COLUMN collection_definition_index INTEGER
    CHECK (collection_definition_index IS NULL
      OR collection_definition_index BETWEEN 1 AND 65535);

UPDATE player_b2g_inventory_items item
SET collection_definition_index = case_grant.case_definition_index
FROM player_b2g_case_grants case_grant
WHERE item.case_grant_id = case_grant.id
  AND item.item_kind = 'cosmetic';

ALTER TABLE player_b2g_inventory_items
  ADD CONSTRAINT player_b2g_inventory_collection_cosmetic
  CHECK (collection_definition_index IS NULL OR item_kind = 'cosmetic');

CREATE TABLE player_b2g_trade_ups (
  id                                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id                            UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  input_fingerprint                    CHAR(64) NOT NULL
    CHECK (input_fingerprint ~ '^[a-f0-9]{64}$'),
  input_asset_ids                      TEXT[] NOT NULL
    CHECK (cardinality(input_asset_ids) = 10),
  input_rarity                         INTEGER NOT NULL CHECK (input_rarity BETWEEN 3 AND 5),
  output_rarity                        INTEGER NOT NULL CHECK (output_rarity = input_rarity + 1),
  stattrak                             BOOLEAN NOT NULL,
  selected_collection_definition_index INTEGER NOT NULL
    CHECK (selected_collection_definition_index BETWEEN 1 AND 65535),
  collection_roll                      INTEGER NOT NULL CHECK (collection_roll BETWEEN 0 AND 9),
  candidate_roll                       INTEGER NOT NULL CHECK (candidate_roll >= 0),
  recipe_index                         INTEGER NOT NULL CHECK (recipe_index BETWEEN 0 AND 15),
  result_asset_id                      TEXT NOT NULL CHECK (result_asset_id ~ '^[0-9]{1,20}$'),
  created_at                           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (player_id, input_fingerprint),
  UNIQUE (player_id, result_asset_id),
  FOREIGN KEY (player_id, result_asset_id)
    REFERENCES player_b2g_inventory_items(player_id, asset_id)
);

CREATE INDEX idx_player_b2g_trade_ups_player
  ON player_b2g_trade_ups (player_id, created_at DESC);

-- Unopened cases adopt the newly disclosed rarity distribution. Completed
-- outcomes keep their original policy label for immutable historical replay.
UPDATE player_b2g_case_grants
SET odds_version = 'b2g-cases-v2'
WHERE opened_at IS NULL AND odds_version = 'b2g-cases-v1';

COMMENT ON TABLE player_b2g_trade_ups IS
  'Authoritative, idempotent B2G-only trade-up contracts; never Valve inventory mutation.';
