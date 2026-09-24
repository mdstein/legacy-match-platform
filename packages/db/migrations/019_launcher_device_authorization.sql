-- 019_launcher_device_authorization.sql
-- One-time browser pairing and revocable launcher credentials.

CREATE TABLE launcher_device_authorizations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_code_sha256  TEXT NOT NULL UNIQUE
    CHECK (device_code_sha256 ~ '^[a-f0-9]{64}$'),
  user_code           TEXT NOT NULL UNIQUE
    CHECK (user_code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  player_id           UUID REFERENCES players(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'consumed', 'expired')),
  expires_at          TIMESTAMPTZ NOT NULL,
  approved_at         TIMESTAMPTZ,
  consumed_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (status = 'pending' AND player_id IS NULL AND approved_at IS NULL AND consumed_at IS NULL)
    OR (status = 'approved' AND player_id IS NOT NULL AND approved_at IS NOT NULL AND consumed_at IS NULL)
    OR (status = 'consumed' AND player_id IS NOT NULL AND approved_at IS NOT NULL AND consumed_at IS NOT NULL)
    OR (status = 'expired' AND consumed_at IS NULL)
  )
);

CREATE INDEX idx_launcher_device_authorizations_expiry
  ON launcher_device_authorizations (expires_at)
  WHERE status IN ('pending', 'approved');

CREATE TABLE launcher_credentials (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id      UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  token_sha256   TEXT NOT NULL UNIQUE
    CHECK (token_sha256 ~ '^[a-f0-9]{64}$'),
  device_name    TEXT NOT NULL DEFAULT 'B2G Launcher'
    CHECK (char_length(device_name) BETWEEN 1 AND 80),
  expires_at     TIMESTAMPTZ NOT NULL,
  last_used_at   TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_launcher_credentials_player
  ON launcher_credentials (player_id, created_at DESC);

CREATE INDEX idx_launcher_credentials_expiry
  ON launcher_credentials (expires_at)
  WHERE revoked_at IS NULL;
