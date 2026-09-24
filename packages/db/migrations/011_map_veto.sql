-- Durable map-pool evidence for captain vetoes finalized before server allocation.

ALTER TABLE matches ADD COLUMN map_pool TEXT[];
UPDATE matches SET map_pool = ARRAY[map] WHERE map_pool IS NULL;
ALTER TABLE matches ALTER COLUMN map_pool SET NOT NULL;
ALTER TABLE matches ADD CONSTRAINT matches_map_pool_nonempty
  CHECK (cardinality(map_pool) BETWEEN 1 AND 7);
ALTER TABLE matches ADD CONSTRAINT matches_selected_map_in_pool
  CHECK (map = ANY(map_pool));

CREATE OR REPLACE FUNCTION default_match_map_pool()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.map_pool IS NULL THEN
    NEW.map_pool := ARRAY[NEW.map];
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER matches_default_map_pool
  BEFORE INSERT ON matches
  FOR EACH ROW EXECUTE FUNCTION default_match_map_pool();

CREATE TABLE match_map_veto_actions (
  match_id          UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  sequence          INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 6),
  team              TEXT NOT NULL CHECK (team IN ('alpha', 'bravo')),
  captain_player_id UUID NOT NULL,
  map               TEXT NOT NULL,
  automated         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (match_id, sequence),
  UNIQUE (match_id, map),
  FOREIGN KEY (match_id, captain_player_id)
    REFERENCES rosters(match_id, player_id) ON DELETE CASCADE
);

CREATE INDEX idx_match_map_veto_actions_captain
  ON match_map_veto_actions (captain_player_id, created_at DESC);

CREATE OR REPLACE FUNCTION reject_match_map_veto_action_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'match_map_veto_actions is append-only';
END;
$$;

CREATE TRIGGER match_map_veto_actions_immutable_update
  BEFORE UPDATE ON match_map_veto_actions
  FOR EACH ROW EXECUTE FUNCTION reject_match_map_veto_action_mutation();
CREATE TRIGGER match_map_veto_actions_immutable_delete
  BEFORE DELETE ON match_map_veto_actions
  FOR EACH ROW EXECUTE FUNCTION reject_match_map_veto_action_mutation();
