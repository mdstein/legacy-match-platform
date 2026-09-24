-- 014_product_accounts_and_modes.sql
-- B2G onboarding, player preferences, and multi-mode matches.

ALTER TABLE players
  ADD COLUMN ingame_name_set_at TIMESTAMPTZ,
  ADD COLUMN preferred_mode TEXT NOT NULL DEFAULT 'competitive'
    CHECK (preferred_mode IN ('competitive', 'deathmatch')),
  ADD COLUMN profile_visibility TEXT NOT NULL DEFAULT 'public'
    CHECK (profile_visibility IN ('public', 'players', 'private')),
  ADD COLUMN allow_party_invites BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN match_notifications BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN product_updates BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN reduced_motion BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX idx_players_ingame_name_unique
  ON players (LOWER(display_name))
  WHERE ingame_name_set_at IS NOT NULL;

ALTER TABLE matches
  ADD COLUMN mode TEXT NOT NULL DEFAULT 'competitive'
    CHECK (mode IN ('competitive', 'deathmatch')),
  ADD COLUMN frag_limit INTEGER,
  ADD COLUMN time_limit_seconds INTEGER,
  ADD CONSTRAINT matches_mode_rules CHECK (
    (mode = 'competitive' AND frag_limit IS NULL AND time_limit_seconds IS NULL)
    OR
    (mode = 'deathmatch' AND frag_limit = 40 AND time_limit_seconds = 600)
  );

ALTER TABLE rosters DROP CONSTRAINT IF EXISTS rosters_team_check;
ALTER TABLE rosters DROP CONSTRAINT IF EXISTS rosters_slot_check;
ALTER TABLE rosters ADD CONSTRAINT rosters_team_check
  CHECK (team IN ('alpha', 'bravo', 'ffa'));
ALTER TABLE rosters ADD CONSTRAINT rosters_slot_check
  CHECK (slot BETWEEN 1 AND 14);

