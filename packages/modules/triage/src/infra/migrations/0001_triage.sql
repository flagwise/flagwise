-- Triage's tables: its copy of the policy and its own record of each case. Triage has no API.
-- App-scoped: row-level security limits the app role to the apps and mode of the current
-- transaction.

CREATE SCHEMA triage;
GRANT USAGE ON SCHEMA triage TO {{app}};

-- Triage's copy of each app's policy per mode, kept from policy.updated: the newest version it
-- saw and the whole policy as of it. Triage reads the app's category rules (severity, SLA) and
-- whether a failed LLM falls back to rules.
CREATE TABLE triage.policy_copies (
  app_id text NOT NULL,
  livemode boolean NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  document jsonb NOT NULL,
  PRIMARY KEY (app_id, livemode)
);

-- Triage's own record of each case, built from the cases' events: when it opened, its reports and
-- what they said about the accounts, whether triage has triaged it, whether a moderator has worked
-- on it, and the classification triage triages it on (the last one it triaged, with a moderator's
-- category once corrected). The reported account is kept so an erasure finds the account's cases
-- and drops what triage keeps about it. Triage reads nothing of moderation's.
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
  classification jsonb,
  subject_external_id text,
  PRIMARY KEY (app_id, livemode, case_id)
);
CREATE INDEX cases_by_subject ON triage.cases (app_id, livemode, subject_external_id);

ALTER TABLE triage.policy_copies ENABLE ROW LEVEL SECURITY;
ALTER TABLE triage.policy_copies FORCE ROW LEVEL SECURITY;
CREATE POLICY app ON triage.policy_copies TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());
ALTER TABLE triage.cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE triage.cases FORCE ROW LEVEL SECURITY;
CREATE POLICY app ON triage.cases TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());
