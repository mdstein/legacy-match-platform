-- 012_srcds_failure_recovery.sql
-- Distinguish an authenticated, thresholded SRCDS health failure from TTL expiry.

ALTER TABLE match_recovery_incidents
  DROP CONSTRAINT match_recovery_incidents_reason_check;

ALTER TABLE match_recovery_incidents
  ADD CONSTRAINT match_recovery_incidents_reason_check
  CHECK (reason IN ('server_lease_expired', 'srcds_unreachable'));
