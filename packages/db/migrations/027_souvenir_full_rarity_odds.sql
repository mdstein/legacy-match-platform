-- 027_souvenir_full_rarity_odds.sql
-- Unopened souvenir packages move to the disclosed six-tier v3 policy.
-- Completed v2 outcomes keep their original version as immutable history.

UPDATE player_b2g_container_grants
SET odds_version = 'b2g-service-drops-v3'
WHERE opened_at IS NULL
  AND odds_version = 'b2g-service-drops-v2';
