-- Canonical GOTV artifacts and immutable evidence for conflicting uploads.

CREATE TABLE match_demo_artifacts (
  match_id          UUID PRIMARY KEY REFERENCES matches(id),
  lease_id          UUID NOT NULL REFERENCES server_leases(id),
  object_key        TEXT NOT NULL UNIQUE CHECK (object_key ~ '^matches/[a-f0-9-]{36}/gotv\.dem$'),
  sha256            TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes        BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 2147483648),
  content_type      TEXT NOT NULL DEFAULT 'application/octet-stream',
  status            TEXT NOT NULL DEFAULT 'uploaded'
                    CHECK (status IN ('uploaded', 'analyzed', 'invalid')),
  analyzer_version  TEXT,
  analysis_sha256   TEXT CHECK (analysis_sha256 IS NULL OR analysis_sha256 ~ '^[a-f0-9]{64}$'),
  analysis          JSONB,
  uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  analyzed_at       TIMESTAMPTZ,
  CHECK (
    (status = 'uploaded' AND analyzed_at IS NULL)
    OR (status IN ('analyzed', 'invalid') AND analyzed_at IS NOT NULL)
  )
);

CREATE INDEX idx_match_demo_artifacts_status
  ON match_demo_artifacts (status, uploaded_at);

CREATE TABLE match_demo_conflicts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id           UUID NOT NULL REFERENCES matches(id),
  lease_id           UUID NOT NULL REFERENCES server_leases(id),
  object_key         TEXT NOT NULL,
  claimed_sha256     TEXT NOT NULL CHECK (claimed_sha256 ~ '^[a-f0-9]{64}$'),
  observed_sha256    TEXT CHECK (observed_sha256 IS NULL OR observed_sha256 ~ '^[a-f0-9]{64}$'),
  size_bytes         BIGINT NOT NULL CHECK (size_bytes >= 0),
  reason             TEXT NOT NULL CHECK (reason IN ('canonical_conflict', 'checksum_mismatch')),
  recorded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_match_demo_conflicts_match
  ON match_demo_conflicts (match_id, recorded_at);
