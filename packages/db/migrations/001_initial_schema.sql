-- 001_initial_schema.sql
-- Core tables for Aftertick: players, matches, rosters, rating ledger, stats, reports, bans.

-- ─── PLAYERS ───────────────────────────────────────────────

CREATE TABLE players (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  steam_id      TEXT UNIQUE,
  display_name  TEXT NOT NULL,
  region        TEXT NOT NULL DEFAULT 'NA Central',
  rating        INTEGER NOT NULL DEFAULT 1000,
  matches_played INTEGER NOT NULL DEFAULT 0,
  wins          INTEGER NOT NULL DEFAULT 0,
  losses        INTEGER NOT NULL DEFAULT 0,
  draws         INTEGER NOT NULL DEFAULT 0,
  is_placement  BOOLEAN NOT NULL DEFAULT TRUE,
  trust_score   INTEGER NOT NULL DEFAULT 100,
  is_banned     BOOLEAN NOT NULL DEFAULT FALSE,
  ban_reason    TEXT,
  ban_expires_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_players_steam ON players (steam_id) WHERE steam_id IS NOT NULL;
CREATE INDEX idx_players_rating ON players (rating DESC);
CREATE INDEX idx_players_region ON players (region);

-- ─── SEASONS ───────────────────────────────────────────────

CREATE TABLE seasons (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  starts_at   TIMESTAMPTZ NOT NULL,
  ends_at     TIMESTAMPTZ,
  is_active   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_seasons_active ON seasons (is_active) WHERE is_active = TRUE;

-- ─── MATCHES ───────────────────────────────────────────────

CREATE TYPE match_status AS ENUM (
  'pending',
  'live',
  'completed',
  'cancelled',
  'disputed'
);

CREATE TABLE matches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id       UUID REFERENCES seasons(id),
  map             TEXT NOT NULL,
  region          TEXT NOT NULL,
  server_address  TEXT,
  status          match_status NOT NULL DEFAULT 'pending',
  alpha_rounds    INTEGER,
  bravo_rounds    INTEGER,
  ruleset_version TEXT NOT NULL DEFAULT '1.0',
  started_at      TIMESTAMPTZ,
  ended_at        TIMESTAMPTZ,
  cancelled_reason TEXT,
  demo_url        TEXT,
  demo_checksum   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_matches_status ON matches (status);
CREATE INDEX idx_matches_season ON matches (season_id);
CREATE INDEX idx_matches_created ON matches (created_at DESC);

-- ─── ROSTERS ───────────────────────────────────────────────

CREATE TABLE rosters (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id    UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id   UUID NOT NULL REFERENCES players(id),
  team        TEXT NOT NULL CHECK (team IN ('alpha', 'bravo')),
  slot        INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 5),
  rating_at_match INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (match_id, player_id),
  UNIQUE (match_id, team, slot)
);

CREATE INDEX idx_rosters_player ON rosters (player_id);
CREATE INDEX idx_rosters_match ON rosters (match_id);

-- ─── RATING LEDGER (append-only) ──────────────────────────

CREATE TABLE rating_changes (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id             UUID NOT NULL REFERENCES players(id),
  match_id              UUID NOT NULL REFERENCES matches(id),
  idempotency_key       TEXT NOT NULL UNIQUE,
  previous_rating       INTEGER NOT NULL,
  next_rating           INTEGER NOT NULL,
  delta                 INTEGER NOT NULL,
  outcome               TEXT NOT NULL CHECK (outcome IN ('win', 'loss', 'draw')),
  expected_win_prob     REAL NOT NULL,
  component_result      REAL NOT NULL,
  component_round_margin REAL NOT NULL,
  component_performance REAL NOT NULL,
  component_placement   REAL NOT NULL,
  engine_version        TEXT NOT NULL DEFAULT '1.0',
  settled_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_rating_changes_player ON rating_changes (player_id, settled_at DESC);
CREATE INDEX idx_rating_changes_match ON rating_changes (match_id);

-- ─── MATCH STATS ───────────────────────────────────────────

CREATE TABLE match_stats (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id        UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  player_id       UUID NOT NULL REFERENCES players(id),
  kills           INTEGER NOT NULL DEFAULT 0,
  deaths          INTEGER NOT NULL DEFAULT 0,
  assists         INTEGER NOT NULL DEFAULT 0,
  adr             REAL NOT NULL DEFAULT 0,
  kast            REAL NOT NULL DEFAULT 0,
  opening_kills   INTEGER NOT NULL DEFAULT 0,
  opening_deaths  INTEGER NOT NULL DEFAULT 0,
  trades          INTEGER NOT NULL DEFAULT 0,
  clutches        INTEGER NOT NULL DEFAULT 0,
  flash_assists   INTEGER NOT NULL DEFAULT 0,
  utility_damage  INTEGER NOT NULL DEFAULT 0,
  rounds_played   INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (match_id, player_id)
);

CREATE INDEX idx_match_stats_player ON match_stats (player_id);

-- ─── MATCH EVENTS (append-only) ───────────────────────────

CREATE TABLE match_events (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id    UUID NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  event_type  TEXT NOT NULL,
  round       INTEGER,
  tick        INTEGER,
  payload     JSONB NOT NULL DEFAULT '{}',
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_match_events_match ON match_events (match_id, recorded_at);

-- ─── REPORTS ───────────────────────────────────────────────

CREATE TYPE report_category AS ENUM (
  'cheating',
  'griefing',
  'toxicity',
  'smurfing',
  'platform_abuse'
);

CREATE TYPE report_status AS ENUM (
  'pending',
  'under_review',
  'resolved',
  'dismissed'
);

CREATE TABLE reports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id   UUID NOT NULL REFERENCES players(id),
  reported_id   UUID NOT NULL REFERENCES players(id),
  match_id      UUID REFERENCES matches(id),
  category      report_category NOT NULL,
  status        report_status NOT NULL DEFAULT 'pending',
  description   TEXT,
  reviewer_id   UUID REFERENCES players(id),
  resolution    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at   TIMESTAMPTZ
);

CREATE INDEX idx_reports_reported ON reports (reported_id);
CREATE INDEX idx_reports_status ON reports (status) WHERE status IN ('pending', 'under_review');

-- ─── SANCTIONS ─────────────────────────────────────────────

CREATE TYPE sanction_type AS ENUM (
  'cooldown',
  'warning',
  'temp_ban',
  'perm_ban'
);

CREATE TABLE sanctions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id     UUID NOT NULL REFERENCES players(id),
  issued_by     UUID REFERENCES players(id),
  sanction_type sanction_type NOT NULL,
  reason        TEXT NOT NULL,
  report_id     UUID REFERENCES reports(id),
  match_id      UUID REFERENCES matches(id),
  duration_minutes INTEGER,
  starts_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at       TIMESTAMPTZ,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  appealed      BOOLEAN NOT NULL DEFAULT FALSE,
  appeal_text   TEXT,
  appeal_resolved_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sanctions_player ON sanctions (player_id, is_active);

-- ─── AUDIT LOG (append-only) ──────────────────────────────

CREATE TABLE audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    UUID REFERENCES players(id),
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   UUID,
  detail      JSONB NOT NULL DEFAULT '{}',
  ip_address  INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_log_actor ON audit_log (actor_id, created_at DESC);
CREATE INDEX idx_audit_log_target ON audit_log (target_type, target_id) WHERE target_id IS NOT NULL;
