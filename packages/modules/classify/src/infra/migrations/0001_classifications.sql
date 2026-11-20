-- Classify's tables. App-scoped: row-level security limits the app role to the apps and mode of the
-- current transaction.

CREATE SCHEMA classify;
GRANT USAGE ON SCHEMA classify TO {{app}};

-- One classification per case: the LLM's answer (or the rules' result), with what it cost. The
-- summary is derived from evidence, so it lives here and never goes into events; an LLM
-- classification keeps it until its account is erased, so it may be null.
CREATE TABLE classify.classifications (
  app_id text NOT NULL,
  livemode boolean NOT NULL,
  case_id text NOT NULL,
  report_id text NOT NULL,
  category_id text NOT NULL CHECK (category_id <> ''),
  custom_category_id text,
  confidence double precision CHECK (confidence BETWEEN 0 AND 1),
  signals jsonb NOT NULL,
  summary text CHECK (char_length(summary) <= 400),
  injection_suspected boolean NOT NULL,
  pre_rule_p0 boolean NOT NULL,
  classified_by text NOT NULL CHECK (classified_by IN ('llm', 'rules')),
  rules_reason text CHECK (rules_reason IN ('rules_only', 'llm_failed')),
  model text,
  prompt_hash text,
  escalated boolean NOT NULL,
  escalation_capped boolean NOT NULL,
  low_confidence boolean NOT NULL,
  input_tokens integer NOT NULL CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL CHECK (output_tokens >= 0),
  cached_tokens integer NOT NULL CHECK (cached_tokens >= 0),
  classified_at timestamptz NOT NULL,
  PRIMARY KEY (app_id, case_id),
  CHECK ((classified_by = 'llm') = (rules_reason IS NULL)),
  CONSTRAINT llm_answer_kept CHECK (classified_by = 'rules' OR (confidence IS NOT NULL AND model IS NOT NULL AND prompt_hash IS NOT NULL))
);
-- The month's LLM-classified cases per app and mode, for the escalation cap.
CREATE INDEX classifications_month ON classify.classifications (app_id, livemode, classified_at) WHERE classified_by = 'llm';

-- What flagging's pre-rules found in each report, kept from report.received, so classify never
-- runs the pre-rules itself: signal names and a flag, the report's accounts (so an erasure finds
-- the classifications of an account's reports, as reported and as reporter; null when
-- report.received did not carry them) and where its evidence snapshot is, as flagging gave it, so
-- classify reads it without knowing how flagging lays out its storage.
CREATE TABLE classify.report_screenings (
  app_id text NOT NULL,
  livemode boolean NOT NULL,
  report_id text NOT NULL CHECK (report_id <> ''),
  p0_signals text[] NOT NULL,
  injection_suspected boolean NOT NULL,
  reported_external_id text,
  reporter_external_id text,
  evidence_ref text NOT NULL CHECK (evidence_ref <> ''),
  PRIMARY KEY (app_id, livemode, report_id)
);
CREATE INDEX report_screenings_by_reported ON classify.report_screenings (app_id, livemode, reported_external_id);
CREATE INDEX report_screenings_by_reporter ON classify.report_screenings (app_id, livemode, reporter_external_id);

-- Classify's copy of each app's policy per mode, kept from policy.updated: the newest version it
-- saw and the whole policy as of it. Classify reads the app's categories (what a reporter's pick
-- names) and whether the app runs rules only.
CREATE TABLE classify.policy_copies (
  app_id text NOT NULL,
  livemode boolean NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  document jsonb NOT NULL,
  PRIMARY KEY (app_id, livemode)
);

ALTER TABLE classify.classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE classify.classifications FORCE ROW LEVEL SECURITY;
CREATE POLICY app ON classify.classifications TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());
ALTER TABLE classify.report_screenings ENABLE ROW LEVEL SECURITY;
ALTER TABLE classify.report_screenings FORCE ROW LEVEL SECURITY;
CREATE POLICY app ON classify.report_screenings TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());
ALTER TABLE classify.policy_copies ENABLE ROW LEVEL SECURITY;
ALTER TABLE classify.policy_copies FORCE ROW LEVEL SECURITY;
CREATE POLICY app ON classify.policy_copies TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());
