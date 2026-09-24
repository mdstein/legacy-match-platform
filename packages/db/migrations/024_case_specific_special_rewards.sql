-- 024_case_specific_special_rewards.sql
-- Unopened cases move to the schema-driven case-specific gold pool. Completed
-- outcomes retain their original policy label as immutable audit history.

UPDATE player_b2g_case_grants
SET odds_version = 'b2g-cases-v3'
WHERE opened_at IS NULL
  AND odds_version IN ('b2g-cases-v1', 'b2g-cases-v2');
