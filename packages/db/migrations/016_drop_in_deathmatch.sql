-- 016_drop_in_deathmatch.sql
-- Signed append-only roster synchronization for live bot-filled Deathmatch sessions.

ALTER TABLE node_commands
  DROP CONSTRAINT IF EXISTS node_commands_command_type_check;

ALTER TABLE node_commands
  ADD CONSTRAINT node_commands_command_type_check CHECK (command_type IN (
    'start', 'stop', 'prepare', 'sync-roster', 'drain', 'quarantine', 'unquarantine'
  ));

CREATE INDEX idx_matches_open_deathmatch
  ON matches (region, created_at)
  WHERE mode = 'deathmatch' AND status IN ('pending', 'live');

CREATE TABLE match_player_presence (
  match_id       UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id      UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  connected      BOOLEAN NOT NULL DEFAULT FALSE,
  connected_at   TIMESTAMPTZ,
  disconnected_at TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (match_id, player_id)
);

CREATE INDEX idx_match_player_presence_connected
  ON match_player_presence (match_id, connected)
  WHERE connected = TRUE;
