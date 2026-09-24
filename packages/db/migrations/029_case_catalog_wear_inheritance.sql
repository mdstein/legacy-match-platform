-- The final CS:GO schema lets paint kits omit wear bounds and inherit them
-- from paint kit 0 (0.06 through 0.80). The v3 extractor incorrectly treated
-- omitted values as 0 through 1. Move only unopened cases to the corrected
-- catalog; historical outcomes keep their original policy label.

UPDATE player_b2g_case_grants
SET odds_version = 'b2g-cases-v4'
WHERE opened_at IS NULL
  AND odds_version = 'b2g-cases-v3';
