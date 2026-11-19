-- The accounts of each report, kept with its screening from report.received, so an erasure finds
-- the classifications of an account's reports (as reported and as reporter) and drops their LLM
-- summaries (an LLM classification's summary may now be null). Null when report.received did not
-- carry them.

ALTER TABLE classify.report_screenings ADD COLUMN reported_external_id text, ADD COLUMN reporter_external_id text;

-- An LLM classification keeps its summary until its account is erased, so the summary may be null.
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'classify.classifications'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%summary IS NOT NULL%';
  EXECUTE format('ALTER TABLE classify.classifications DROP CONSTRAINT %I', c);
END $$;
ALTER TABLE classify.classifications ADD CONSTRAINT llm_answer_kept
  CHECK (classified_by = 'rules' OR (confidence IS NOT NULL AND model IS NOT NULL AND prompt_hash IS NOT NULL));
CREATE INDEX report_screenings_by_reported ON classify.report_screenings (app_id, livemode, reported_external_id);
CREATE INDEX report_screenings_by_reporter ON classify.report_screenings (app_id, livemode, reporter_external_id);

-- On an upgrade, the screenings kept so far take the accounts from intake's reports. This one-time
-- read runs as the owner, so forced row-level security is lifted around it.
DO $$
BEGIN
  IF to_regclass('intake.reports') IS NOT NULL THEN
    ALTER TABLE intake.reports NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE classify.report_screenings NO FORCE ROW LEVEL SECURITY;
    UPDATE classify.report_screenings s
       SET reported_external_id = r.reported_external_id, reporter_external_id = r.reporter_external_id
      FROM intake.reports r
     WHERE r.app_id = s.app_id AND r.livemode = s.livemode AND r.id = s.report_id;
    ALTER TABLE intake.reports FORCE ROW LEVEL SECURITY;
    ALTER TABLE classify.report_screenings FORCE ROW LEVEL SECURITY;
  END IF;
END $$;
