-- What each report said about the accounts, which triage weighs, and the rules and flags triage
-- applied, so a case shows why it got its priority. Rows from before stay NULL: unknown.

ALTER TABLE cases.case_reports
  ADD COLUMN reporter_external_id text,
  ADD COLUMN reporter_account_created_at timestamptz,
  ADD COLUMN reported_account_created_at timestamptz,
  ADD CHECK (reporter_external_id IS NOT NULL OR (reporter_account_created_at IS NULL AND reported_account_created_at IS NULL));

ALTER TABLE cases.cases
  ADD COLUMN triage_applied text[],
  ADD COLUMN triage_flags text[],
  ADD CHECK ((triage_applied IS NULL) = (triage_flags IS NULL));

-- An account's cases, latest first; it also serves every lookup the old subject index did.
DROP INDEX cases.cases_by_subject;
CREATE INDEX cases_by_subject_recent ON cases.cases (org_id, app_id, livemode, subject_external_id, opened_at DESC, id DESC);
