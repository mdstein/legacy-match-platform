-- Stable identity is independent of current ownership. Historical grant owners
-- and crafting receipts must not be rewritten when an item changes hands.
ALTER TABLE player_b2g_inventory_items
  ADD CONSTRAINT player_b2g_inventory_asset_identity UNIQUE (asset_id),
  ADD COLUMN original_player_id UUID,
  ADD COLUMN ownership_generation BIGINT NOT NULL DEFAULT 0 CHECK (ownership_generation >= 0),
  ADD COLUMN ownership_changed_at TIMESTAMPTZ;
UPDATE player_b2g_inventory_items SET original_player_id = player_id,
  ownership_changed_at = acquired_at;
ALTER TABLE player_b2g_inventory_items
  ALTER COLUMN original_player_id SET NOT NULL,
  ALTER COLUMN ownership_changed_at SET NOT NULL;

ALTER TABLE player_b2g_trade_ups DROP CONSTRAINT player_b2g_trade_ups_player_id_result_asset_id_fkey;
ALTER TABLE player_b2g_trade_ups ADD CONSTRAINT player_b2g_trade_ups_result_identity
  FOREIGN KEY (result_asset_id) REFERENCES player_b2g_inventory_items(asset_id);

-- Deleting an original grant/account must not cascade through a transferred
-- item belonging to somebody else. Retain referenced provenance instead.
ALTER TABLE player_b2g_inventory_items
  DROP CONSTRAINT player_b2g_inventory_items_case_grant_id_fkey,
  ADD CONSTRAINT player_b2g_inventory_items_case_grant_id_fkey
    FOREIGN KEY (case_grant_id) REFERENCES player_b2g_case_grants(id) ON DELETE RESTRICT,
  DROP CONSTRAINT player_b2g_inventory_items_container_grant_id_fkey,
  ADD CONSTRAINT player_b2g_inventory_items_container_grant_id_fkey
    FOREIGN KEY (container_grant_id) REFERENCES player_b2g_container_grants(id) ON DELETE RESTRICT,
  DROP CONSTRAINT player_b2g_inventory_items_direct_reward_grant_id_fkey,
  ADD CONSTRAINT player_b2g_inventory_items_direct_reward_grant_id_fkey
    FOREIGN KEY (direct_reward_grant_id) REFERENCES player_b2g_direct_reward_grants(id) ON DELETE RESTRICT;

-- player_id continues to mean original grant recipient. owner_id controls
-- opening/unsealing; it moves with an unopened container or sealed graffiti.
ALTER TABLE player_b2g_case_grants ADD COLUMN owner_id UUID REFERENCES players(id);
ALTER TABLE player_b2g_container_grants ADD COLUMN owner_id UUID REFERENCES players(id);
ALTER TABLE player_b2g_direct_reward_grants ADD COLUMN owner_id UUID REFERENCES players(id);
UPDATE player_b2g_case_grants SET owner_id = player_id;
UPDATE player_b2g_container_grants SET owner_id = player_id;
UPDATE player_b2g_direct_reward_grants SET owner_id = player_id;
ALTER TABLE player_b2g_case_grants ALTER COLUMN owner_id SET NOT NULL;
ALTER TABLE player_b2g_container_grants ALTER COLUMN owner_id SET NOT NULL;
ALTER TABLE player_b2g_direct_reward_grants ALTER COLUMN owner_id SET NOT NULL;
CREATE INDEX idx_b2g_case_current_owner ON player_b2g_case_grants(owner_id, case_asset_id);
CREATE INDEX idx_b2g_container_current_owner ON player_b2g_container_grants(owner_id, container_asset_id);
CREATE INDEX idx_b2g_direct_current_owner ON player_b2g_direct_reward_grants(owner_id, sealed_asset_id);

CREATE FUNCTION initialize_b2g_grant_owner() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.owner_id := COALESCE(NEW.owner_id, NEW.player_id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER b2g_case_grant_owner BEFORE INSERT ON player_b2g_case_grants
  FOR EACH ROW EXECUTE FUNCTION initialize_b2g_grant_owner();
CREATE TRIGGER b2g_container_grant_owner BEFORE INSERT ON player_b2g_container_grants
  FOR EACH ROW EXECUTE FUNCTION initialize_b2g_grant_owner();
CREATE TRIGGER b2g_direct_grant_owner BEFORE INSERT ON player_b2g_direct_reward_grants
  FOR EACH ROW EXECUTE FUNCTION initialize_b2g_grant_owner();

CREATE FUNCTION enforce_b2g_item_ownership() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.original_player_id := NEW.player_id;
    NEW.ownership_generation := 0;
    NEW.ownership_changed_at := NEW.acquired_at;
  ELSE
    IF NEW.asset_id <> OLD.asset_id THEN
      RAISE EXCEPTION 'B2G item identity is immutable' USING ERRCODE = 'check_violation';
    END IF;
    NEW.original_player_id := OLD.original_player_id;
    NEW.ownership_generation := OLD.ownership_generation;
    NEW.ownership_changed_at := OLD.ownership_changed_at;
    IF NEW.player_id <> OLD.player_id THEN
      IF OLD.state <> 'active' OR NEW.state <> 'active' OR OLD.weapon_key = 'service_medal'
         OR OLD.definition_index IN (1200, 1349) THEN
        RAISE EXCEPTION 'This B2G item cannot change owners' USING ERRCODE = 'check_violation';
      END IF;
      NEW.ownership_generation := OLD.ownership_generation + 1;
      NEW.ownership_changed_at := clock_timestamp();
      NEW.acquired_at := NEW.ownership_changed_at;
      NEW.kill_eater_value := CASE WHEN OLD.kill_eater_value IS NULL THEN NULL ELSE 0 END;
      -- CS:GO UnacknowledgedTraded (3), with the unacknowledged bit.
      NEW.inventory_position := 1073741827;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER b2g_item_ownership BEFORE INSERT OR UPDATE ON player_b2g_inventory_items
  FOR EACH ROW EXECUTE FUNCTION enforce_b2g_item_ownership();

CREATE OR REPLACE FUNCTION advance_b2g_inventory_revision()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target_player_id UUID;
BEGIN
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'inventory_position') =
    (to_jsonb(OLD) - 'inventory_position') THEN RETURN NEW; END IF;
  -- Inventory writers acquire player locks in UUID order before item locks.
  FOR target_player_id IN
    SELECT DISTINCT id FROM unnest(ARRAY[
      CASE WHEN TG_OP <> 'INSERT' THEN OLD.player_id END,
      CASE WHEN TG_OP <> 'DELETE' THEN NEW.player_id END
    ]) AS ids(id) WHERE id IS NOT NULL ORDER BY id
  LOOP
    UPDATE players SET b2g_inventory_revision = b2g_inventory_revision + 1
      WHERE id = target_player_id;
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER b2g_transferred_item_remove_loadout
  AFTER UPDATE OF player_id ON player_b2g_inventory_items FOR EACH ROW
  WHEN (OLD.player_id <> NEW.player_id) EXECUTE FUNCTION remove_unowned_cosmetic_loadout();

ALTER TABLE platform_controls ADD COLUMN trading_enabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE b2g_trading_profiles (
  player_id UUID PRIMARY KEY REFERENCES players(id),
  trade_code TEXT NOT NULL UNIQUE DEFAULT upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 16))
    CHECK (trade_code ~ '^[0-9A-F]{16}$'),
  allow_offers BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen_event_id BIGINT NOT NULL DEFAULT 0 CHECK (last_seen_event_id >= 0)
);

CREATE TABLE b2g_trade_offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  participant_a UUID NOT NULL REFERENCES players(id),
  participant_b UUID NOT NULL REFERENCES players(id),
  sender_id UUID NOT NULL REFERENCES players(id),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision BETWEEN 1 AND 100),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled', 'expired', 'invalidated')),
  status_reason TEXT CHECK (char_length(status_reason) <= 240),
  last_event_id BIGINT NOT NULL DEFAULT 0 CHECK (last_event_id >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT now() + interval '7 days',
  completed_at TIMESTAMPTZ,
  CHECK (participant_a < participant_b),
  CHECK (sender_id IN (participant_a, participant_b)),
  CHECK ((status = 'pending') = (completed_at IS NULL)),
  CHECK (expires_at > created_at)
);
CREATE INDEX idx_b2g_trades_a ON b2g_trade_offers(participant_a, last_event_id DESC);
CREATE INDEX idx_b2g_trades_b ON b2g_trade_offers(participant_b, last_event_id DESC);
CREATE INDEX idx_b2g_trades_expiry ON b2g_trade_offers(expires_at) WHERE status = 'pending';

CREATE TABLE b2g_trade_versions (
  offer_id UUID NOT NULL REFERENCES b2g_trade_offers(id),
  revision INTEGER NOT NULL,
  sender_id UUID NOT NULL REFERENCES players(id),
  message TEXT NOT NULL DEFAULT '' CHECK (char_length(message) <= 240),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (offer_id, revision)
);
CREATE TABLE b2g_trade_items (
  offer_id UUID NOT NULL,
  revision INTEGER NOT NULL,
  owner_id UUID NOT NULL REFERENCES players(id),
  asset_id TEXT NOT NULL REFERENCES player_b2g_inventory_items(asset_id),
  ownership_generation BIGINT NOT NULL CHECK (ownership_generation >= 0),
  fingerprint CHAR(64) NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  PRIMARY KEY (offer_id, revision, asset_id),
  FOREIGN KEY (offer_id, revision) REFERENCES b2g_trade_versions(offer_id, revision)
);
CREATE INDEX idx_b2g_trade_item_asset ON b2g_trade_items(asset_id, offer_id);

-- Durable event journal doubles as the notification outbox. Readers advance
-- their cursor only after seeing committed events; disconnects lose no state.
CREATE TABLE b2g_trade_events (
  id BIGSERIAL PRIMARY KEY,
  offer_id UUID NOT NULL REFERENCES b2g_trade_offers(id),
  revision INTEGER NOT NULL,
  actor_id UUID REFERENCES players(id),
  kind TEXT NOT NULL CHECK (kind IN ('sent','countered','accepted','declined','cancelled','expired','invalidated')),
  detail JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (offer_id, revision) REFERENCES b2g_trade_versions(offer_id, revision)
);
CREATE INDEX idx_b2g_trade_events_offer ON b2g_trade_events(offer_id, id);

CREATE TABLE b2g_trade_requests (
  actor_id UUID NOT NULL REFERENCES players(id),
  request_id UUID NOT NULL,
  fingerprint CHAR(64) NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  response JSONB NOT NULL CHECK (jsonb_typeof(response) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (actor_id, request_id)
);

COMMENT ON COLUMN player_b2g_inventory_items.original_player_id IS
  'Immutable historical recipient identifier; current possession is player_id.';
COMMENT ON COLUMN player_b2g_inventory_items.ownership_generation IS
  'Increments on every transfer, including a return to a previous owner; fences late mutation receipts.';
COMMENT ON TABLE b2g_trade_events IS
  'Committed trade outcomes and immutable acceptance item snapshots; also a recoverable notification journal.';
