-- 002_server_control_plane.sql
-- Durable regional node inventory, warm server state, fenced leases, and command delivery.

CREATE TYPE game_node_status AS ENUM (
  'active',
  'draining',
  'quarantined',
  'offline'
);

CREATE TYPE server_instance_state AS ENUM (
  'starting',
  'ready',
  'leased',
  'draining',
  'quarantined',
  'offline'
);

CREATE TYPE server_lease_status AS ENUM (
  'active',
  'released',
  'expired'
);

CREATE TYPE node_command_status AS ENUM (
  'pending',
  'claimed',
  'completed',
  'failed'
);

CREATE SEQUENCE server_lease_fencing_seq AS BIGINT;

CREATE TABLE game_nodes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL UNIQUE,
  region            TEXT NOT NULL,
  public_endpoint   TEXT,
  token_sha256      TEXT NOT NULL UNIQUE CHECK (token_sha256 ~ '^[a-f0-9]{64}$'),
  status            game_node_status NOT NULL DEFAULT 'offline',
  capacity_total    INTEGER NOT NULL DEFAULT 0 CHECK (capacity_total >= 0),
  agent_version     TEXT,
  last_heartbeat_at TIMESTAMPTZ,
  metadata          JSONB NOT NULL DEFAULT '{}',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_game_nodes_region_status ON game_nodes (region, status);
CREATE INDEX idx_game_nodes_heartbeat ON game_nodes (last_heartbeat_at);

CREATE TABLE server_instances (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id             UUID NOT NULL REFERENCES game_nodes(id) ON DELETE CASCADE,
  instance_key        TEXT NOT NULL,
  state               server_instance_state NOT NULL DEFAULT 'starting',
  address             TEXT NOT NULL,
  game_port           INTEGER NOT NULL CHECK (game_port BETWEEN 1 AND 65535),
  gotv_port           INTEGER CHECK (gotv_port BETWEEN 1 AND 65535),
  process_id          INTEGER,
  server_build_id     TEXT,
  plugin_version      TEXT,
  active_lease_id     UUID,
  last_heartbeat_at   TIMESTAMPTZ,
  quarantine_reason   TEXT,
  metadata            JSONB NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (node_id, instance_key),
  UNIQUE (node_id, game_port)
);

CREATE INDEX idx_server_instances_allocatable
  ON server_instances (node_id, state, updated_at)
  WHERE state = 'ready';

CREATE TABLE server_leases (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id            UUID NOT NULL REFERENCES matches(id),
  server_instance_id  UUID NOT NULL REFERENCES server_instances(id),
  fencing_token       BIGINT NOT NULL UNIQUE DEFAULT nextval('server_lease_fencing_seq'),
  status              server_lease_status NOT NULL DEFAULT 'active',
  manifest_version    INTEGER NOT NULL DEFAULT 1,
  manifest            JSONB NOT NULL,
  manifest_signature  TEXT NOT NULL,
  leased_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ NOT NULL,
  released_at         TIMESTAMPTZ,
  release_reason      TEXT,
  CHECK (expires_at > leased_at)
);

CREATE UNIQUE INDEX idx_server_leases_match_active
  ON server_leases (match_id)
  WHERE status = 'active';
CREATE UNIQUE INDEX idx_server_leases_instance_active
  ON server_leases (server_instance_id)
  WHERE status = 'active';
CREATE INDEX idx_server_leases_expiry
  ON server_leases (expires_at)
  WHERE status = 'active';

ALTER TABLE server_instances
  ADD CONSTRAINT fk_server_instances_active_lease
  FOREIGN KEY (active_lease_id) REFERENCES server_leases(id);

CREATE TABLE node_commands (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id         UUID NOT NULL REFERENCES game_nodes(id) ON DELETE CASCADE,
  command_type    TEXT NOT NULL CHECK (command_type IN (
    'start', 'stop', 'prepare', 'drain', 'quarantine', 'unquarantine'
  )),
  payload         JSONB NOT NULL DEFAULT '{}',
  status          node_command_status NOT NULL DEFAULT 'pending',
  claim_token     UUID,
  claimed_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  result          JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_node_commands_delivery
  ON node_commands (node_id, status, created_at)
  WHERE status IN ('pending', 'claimed');
