-- When a report's account was erased: its evidence snapshot is deleted and the erased account's id
-- is replaced by a tombstone, so the evidence answers 410 from then on.

ALTER TABLE intake.reports ADD COLUMN erased_at timestamptz;
CREATE INDEX reports_by_reporter ON intake.reports (app_id, livemode, reporter_external_id);
CREATE INDEX reports_by_reported ON intake.reports (app_id, livemode, reported_external_id);
