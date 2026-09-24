-- Durable analyzer attempts and operator-visible failure evidence.

ALTER TABLE match_demo_artifacts
  ADD COLUMN analysis_attempts INTEGER NOT NULL DEFAULT 0 CHECK (analysis_attempts >= 0),
  ADD COLUMN analysis_error TEXT;
