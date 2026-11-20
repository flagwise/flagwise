-- Cases, the reports attached to them, decisions, the failed actions moderation has heard of, and
-- its copy of the policy. Every table is app-scoped: row-level security limits the app role to the
-- apps and mode of the current transaction.

CREATE SCHEMA cases;
GRANT USAGE ON SCHEMA cases TO {{app}};

-- A case keeps triage's result (and the rules and flags triage applied, so it shows why it got its
-- priority) and the classification facts the queue filters and shows, copied from case.classified
-- at triage: no summary or evidence, which stay with classify and flagging. custom_category_id is
-- the app's own category beside the global one: the reporter's pick, when it fits.
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
  category_id text,
  signals text[],
  injection_suspected boolean,
  classified_by text CHECK (classified_by IN ('llm', 'rules')),
  custom_category_id text,
  triage_applied text[],
  triage_flags text[],
  PRIMARY KEY (app_id, id),
  CHECK ((claim_member_id IS NULL) = (claimed_at IS NULL) AND (claimed_at IS NULL) = (claim_last_activity_at IS NULL)),
  CHECK ((triage_severity IS NULL) = (triage_priority IS NULL) AND (triage_priority IS NULL) = (triage_sla_due_at IS NULL)
     AND (triage_sla_due_at IS NULL) = (triage_suggested_action_keys IS NULL)),
  CHECK ((category_id IS NULL) = (signals IS NULL) AND (signals IS NULL) = (injection_suspected IS NULL)
     AND (injection_suspected IS NULL) = (classified_by IS NULL)),
  CHECK (custom_category_id IS NULL OR category_id IS NOT NULL),
  CHECK ((triage_applied IS NULL) = (triage_flags IS NULL))
);
CREATE INDEX cases_queue ON cases.cases (app_id, livemode, state);
-- An account's cases, latest first.
CREATE INDEX cases_by_subject_recent ON cases.cases (app_id, livemode, subject_external_id, opened_at DESC, id DESC);

-- The reports of each case, in the order they joined it.
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

-- A decision, with the reports it was made on: the ones shown to the moderator.
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
  report_ids text[] NOT NULL,
  PRIMARY KEY (app_id, id),
  FOREIGN KEY (app_id, case_id) REFERENCES cases.cases (app_id, id) ON DELETE CASCADE
);
CREATE INDEX decisions_by_case ON cases.decisions (app_id, case_id);

ALTER TABLE cases.cases ADD FOREIGN KEY (app_id, decision_id) REFERENCES cases.decisions (app_id, id) DEFERRABLE INITIALLY DEFERRED;

-- The failed action requests of each case that moderation has heard of (action.failed), and
-- whether a moderator's retry has answered them, so moderation never reads delivery's requests: a
-- failure no retry answered moves a decided case to action_failed; a retry names the ones it
-- answers, and delivery replaces exactly those.
CREATE TABLE cases.action_failures (
  app_id text NOT NULL,
  livemode boolean NOT NULL,
  case_id text NOT NULL,
  action_request_id text NOT NULL,
  failed_at timestamptz NOT NULL,
  answered boolean NOT NULL DEFAULT false,
  PRIMARY KEY (app_id, livemode, action_request_id)
);
CREATE INDEX action_failures_by_case ON cases.action_failures (app_id, livemode, case_id);

-- Moderation's copy of each app's policy per mode, kept from policy.updated: the newest version it
-- saw and the whole policy as of it. Moderation reads the action keys a decision may carry.
CREATE TABLE cases.policy_copies (
  app_id text NOT NULL,
  livemode boolean NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  document jsonb NOT NULL,
  PRIMARY KEY (app_id, livemode)
);

ALTER TABLE cases.cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases.cases FORCE ROW LEVEL SECURITY;
CREATE POLICY app ON cases.cases TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());

ALTER TABLE cases.case_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases.case_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY app ON cases.case_reports TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());

ALTER TABLE cases.decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases.decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY app ON cases.decisions TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());

ALTER TABLE cases.action_failures ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases.action_failures FORCE ROW LEVEL SECURITY;
CREATE POLICY app ON cases.action_failures TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());

ALTER TABLE cases.policy_copies ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases.policy_copies FORCE ROW LEVEL SECURITY;
CREATE POLICY app ON cases.policy_copies TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());
