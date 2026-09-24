-- Bounded retry and terminal-failure metadata for durable node commands.

ALTER TABLE node_commands
  ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
  ADD COLUMN next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN last_error TEXT;

DROP INDEX idx_node_commands_delivery;
CREATE INDEX idx_node_commands_delivery
  ON node_commands (node_id, status, next_attempt_at, created_at)
  WHERE status IN ('pending', 'claimed');
