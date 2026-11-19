-- One classification per case: the LLM's answer (or the rules' result), with what it cost. The
-- summary is derived from evidence, so it lives here and never goes into events. App-scoped:
-- row-level security limits the app role to the apps and mode of the current transaction.

CREATE SCHEMA classify;
GRANT USAGE ON SCHEMA classify TO {{app}};

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
  CHECK (classified_by = 'rules' OR (confidence IS NOT NULL AND summary IS NOT NULL AND model IS NOT NULL AND prompt_hash IS NOT NULL))
);

-- The month's LLM-classified cases per app and mode, for the escalation cap.
CREATE INDEX classifications_month ON classify.classifications (app_id, livemode, classified_at) WHERE classified_by = 'llm';

ALTER TABLE classify.classifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE classify.classifications FORCE ROW LEVEL SECURITY;
CREATE POLICY app ON classify.classifications TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());
