-- Cases, the reports attached to them, and decisions. Every table is tenant-scoped: row-level
-- security limits the app role to the apps and mode of the current transaction.

CREATE SCHEMA cases;
GRANT USAGE ON SCHEMA cases TO {{app}};

CREATE TABLE cases.cases (
  app_id text NOT NULL,
  livemode boolean NOT NULL,
  id text NOT NULL,
  subject_external_id text NOT NULL,
  band text NOT NULL CHECK (band IN ('p0', 'standard')),
  state text NOT NULL CHECK (state IN ('classifying', 'untriaged', 'open', 'claimed', 'decided', 'action_failed', 'actioned', 'appealed', 'closed')),
  opened_at timestamptz NOT NULL,
  claim_member_id text,
  claimed_at timestamptz,
  claim_last_activity_at timestamptz,
  triage_severity text CHECK (triage_severity IN ('P0', 'P1', 'P2')),
  triage_priority integer,
  triage_sla_due_at timestamptz,
  triage_suggested_action_keys text[],
  decision_id text,
  PRIMARY KEY (app_id, id),
  CHECK ((claim_member_id IS NULL) = (claimed_at IS NULL) AND (claimed_at IS NULL) = (claim_last_activity_at IS NULL)),
  CHECK ((triage_severity IS NULL) = (triage_priority IS NULL) AND (triage_priority IS NULL) = (triage_sla_due_at IS NULL)
     AND (triage_sla_due_at IS NULL) = (triage_suggested_action_keys IS NULL))
);
CREATE INDEX cases_by_subject ON cases.cases (app_id, livemode, subject_external_id);

CREATE TABLE cases.case_reports (
  app_id text NOT NULL,
  livemode boolean NOT NULL,
  report_id text NOT NULL,
  case_id text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY (app_id, report_id),
  UNIQUE (app_id, case_id, position),
  FOREIGN KEY (app_id, case_id) REFERENCES cases.cases (app_id, id) ON DELETE CASCADE
);

CREATE TABLE cases.decisions (
  app_id text NOT NULL,
  livemode boolean NOT NULL,
  id text NOT NULL,
  case_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('violation', 'no_violation')),
  category_id text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('P0', 'P1', 'P2')),
  action_keys text[] NOT NULL,
  decided_by text NOT NULL,
  decided_at timestamptz NOT NULL,
  public_reason text,
  internal_note text,
  PRIMARY KEY (app_id, id),
  FOREIGN KEY (app_id, case_id) REFERENCES cases.cases (app_id, id) ON DELETE CASCADE
);
CREATE INDEX decisions_by_case ON cases.decisions (app_id, case_id);

ALTER TABLE cases.cases ADD FOREIGN KEY (app_id, decision_id) REFERENCES cases.decisions (app_id, id) DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE cases.cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases.cases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON cases.cases TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());

ALTER TABLE cases.case_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases.case_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON cases.case_reports TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());

ALTER TABLE cases.decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases.decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON cases.decisions TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());
