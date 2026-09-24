-- Crash-recoverable demo retention while preserving checksums and audit evidence.

ALTER TABLE match_demo_artifacts
  DROP CONSTRAINT match_demo_artifacts_status_check,
  DROP CONSTRAINT match_demo_artifacts_check;

ALTER TABLE match_demo_artifacts
  ADD COLUMN retention_previous_status TEXT,
  ADD COLUMN deletion_started_at TIMESTAMPTZ,
  ADD COLUMN deleted_at TIMESTAMPTZ,
  ADD COLUMN deletion_error TEXT,
  ADD COLUMN retention_policy_version TEXT,
  ADD CONSTRAINT match_demo_artifacts_status_check
    CHECK (status IN ('uploaded', 'analyzed', 'invalid', 'deleting', 'deleted')),
  ADD CONSTRAINT match_demo_artifacts_retention_previous_status_check
    CHECK (
      retention_previous_status IS NULL
      OR retention_previous_status IN ('analyzed', 'invalid')
    ),
  ADD CONSTRAINT match_demo_artifacts_lifecycle_check
    CHECK (
      (status = 'uploaded' AND analyzed_at IS NULL AND deleted_at IS NULL)
      OR (status IN ('analyzed', 'invalid') AND analyzed_at IS NOT NULL AND deleted_at IS NULL)
      OR (
        status = 'deleting'
        AND analyzed_at IS NOT NULL
        AND retention_previous_status IS NOT NULL
        AND deletion_started_at IS NOT NULL
        AND deleted_at IS NULL
      )
      OR (
        status = 'deleted'
        AND analyzed_at IS NOT NULL
        AND retention_previous_status IS NOT NULL
        AND deletion_started_at IS NOT NULL
        AND deleted_at IS NOT NULL
        AND retention_policy_version IS NOT NULL
      )
    );

CREATE INDEX idx_match_demo_artifacts_retention
  ON match_demo_artifacts (uploaded_at, match_id)
  WHERE status IN ('analyzed', 'invalid', 'deleting');
