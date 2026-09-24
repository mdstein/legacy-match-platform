-- Short-lived, replay-resistant launcher latency evidence for regional matchmaking.

CREATE TABLE latency_probe_challenges (
  id            UUID PRIMARY KEY,
  player_id     UUID NOT NULL REFERENCES players(id),
  token_sha256  TEXT NOT NULL UNIQUE CHECK (token_sha256 ~ '^[a-f0-9]{64}$'),
  endpoints     JSONB NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'completed', 'expired')),
  issued_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed_at   TIMESTAMPTZ,
  CHECK (expires_at > issued_at),
  CHECK (
    (status = 'pending' AND consumed_at IS NULL)
    OR (status = 'completed' AND consumed_at IS NOT NULL)
    OR status = 'expired'
  )
);

CREATE INDEX idx_latency_probe_challenges_player
  ON latency_probe_challenges (player_id, issued_at DESC);
CREATE INDEX idx_latency_probe_challenges_expiry
  ON latency_probe_challenges (expires_at)
  WHERE status = 'pending';
CREATE UNIQUE INDEX idx_latency_probe_challenges_one_pending_player
  ON latency_probe_challenges (player_id)
  WHERE status = 'pending';

CREATE TABLE player_latency_measurements (
  challenge_id        UUID NOT NULL REFERENCES latency_probe_challenges(id),
  player_id           UUID NOT NULL REFERENCES players(id),
  region              TEXT NOT NULL,
  endpoint            TEXT NOT NULL,
  requested_samples   INTEGER NOT NULL CHECK (requested_samples BETWEEN 1 AND 10),
  successful_samples  INTEGER NOT NULL CHECK (
    successful_samples BETWEEN 0 AND requested_samples
  ),
  median_ms           REAL CHECK (median_ms IS NULL OR median_ms BETWEEN 0 AND 5000),
  p95_ms              REAL CHECK (p95_ms IS NULL OR p95_ms BETWEEN 0 AND 5000),
  packet_loss_percent REAL NOT NULL CHECK (packet_loss_percent BETWEEN 0 AND 100),
  measured_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  valid_until         TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (challenge_id, region),
  CHECK (valid_until > measured_at),
  CHECK (
    (successful_samples = 0 AND median_ms IS NULL AND p95_ms IS NULL)
    OR (
      successful_samples > 0
      AND median_ms IS NOT NULL
      AND p95_ms IS NOT NULL
      AND p95_ms >= median_ms
    )
  )
);

CREATE INDEX idx_player_latency_measurements_fresh
  ON player_latency_measurements (player_id, region, valid_until DESC);
