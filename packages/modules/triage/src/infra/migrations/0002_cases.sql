-- Triage's own record of each case, built from the cases' events: when it opened, its reports and
-- what they said about the accounts, whether triage has triaged it, and whether a moderator has
-- worked on it. Triage reads nothing of moderation's.

CREATE TABLE triage.cases (
  app_id text NOT NULL,
  livemode boolean NOT NULL,
  case_id text NOT NULL,
  opened_at timestamptz NOT NULL,
  report_ids text[] NOT NULL,
  -- [{reportId, reporterExternalId, reporterAccountCreatedAt, reportedAccountCreatedAt}], in report order.
  reports jsonb NOT NULL DEFAULT '[]',
  state text NOT NULL CHECK (state IN ('classifying', 'triaged', 'untriaged')),
  claimed boolean NOT NULL DEFAULT false,
  ever_claimed boolean NOT NULL DEFAULT false,
  corrected boolean NOT NULL DEFAULT false,
  decided boolean NOT NULL DEFAULT false,
  PRIMARY KEY (app_id, livemode, case_id)
);

ALTER TABLE triage.cases ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON triage.cases TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());

-- On an upgrade, the cases moderation already holds that triage may still triage (classifying,
-- untriaged, open or claimed) start from moderation's tables, since triage saw none of their
-- events. This one-time read runs as the owner, so forced row-level security is lifted around it.
DO $$
BEGIN
  IF to_regclass('cases.cases') IS NOT NULL THEN
    ALTER TABLE cases.cases NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE cases.case_reports NO FORCE ROW LEVEL SECURITY;
    INSERT INTO triage.cases (app_id, livemode, case_id, opened_at, report_ids, reports, state, claimed, ever_claimed)
      SELECT c.app_id, c.livemode, c.id, c.opened_at,
             COALESCE((SELECT array_agg(r.report_id ORDER BY r.position) FROM cases.case_reports r
                        WHERE r.app_id = c.app_id AND r.livemode = c.livemode AND r.case_id = c.id), '{}'),
             COALESCE((SELECT jsonb_agg(jsonb_build_object(
                                'reportId', r.report_id,
                                'reporterExternalId', r.reporter_external_id,
                                'reporterAccountCreatedAt', r.reporter_account_created_at,
                                'reportedAccountCreatedAt', r.reported_account_created_at) ORDER BY r.position)
                         FROM cases.case_reports r
                        WHERE r.app_id = c.app_id AND r.livemode = c.livemode AND r.case_id = c.id
                          AND r.reporter_external_id IS NOT NULL), '[]'),
             CASE WHEN c.state = 'classifying' THEN 'classifying' WHEN c.triage_severity IS NULL THEN 'untriaged' ELSE 'triaged' END,
             c.state = 'claimed', c.state = 'claimed'
        FROM cases.cases c
       WHERE c.state IN ('classifying', 'untriaged', 'open', 'claimed');
    ALTER TABLE cases.cases FORCE ROW LEVEL SECURITY;
    ALTER TABLE cases.case_reports FORCE ROW LEVEL SECURITY;
  END IF;
END $$;

ALTER TABLE triage.cases FORCE ROW LEVEL SECURITY;
