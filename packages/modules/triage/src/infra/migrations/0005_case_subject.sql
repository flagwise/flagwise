-- The case's reported account, kept from case.opened, so an erasure finds the account's cases and
-- drops what triage keeps about it (its account age, and its id where it reported).

ALTER TABLE triage.cases ADD COLUMN subject_external_id text;
CREATE INDEX cases_by_subject ON triage.cases (app_id, livemode, subject_external_id);

-- On an upgrade, the cases triage keeps take the account from moderation's cases. This one-time
-- read runs as the owner, so forced row-level security is lifted around it.
DO $$
BEGIN
  IF to_regclass('cases.cases') IS NOT NULL THEN
    ALTER TABLE cases.cases NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE triage.cases NO FORCE ROW LEVEL SECURITY;
    UPDATE triage.cases t SET subject_external_id = c.subject_external_id
      FROM cases.cases c
     WHERE c.app_id = t.app_id AND c.livemode = t.livemode AND c.id = t.case_id;
    ALTER TABLE cases.cases FORCE ROW LEVEL SECURITY;
    ALTER TABLE triage.cases FORCE ROW LEVEL SECURITY;
  END IF;
END $$;
