-- Erasures: one per request to erase an account, with the consumer groups the request reached
-- (null until the bus says) and each group's answer. A subject has at most one in progress.

CREATE SCHEMA privacy;
GRANT USAGE ON SCHEMA privacy TO {{app}};

CREATE TABLE privacy.erasures (
  app_id text NOT NULL,
  livemode boolean NOT NULL,
  id text NOT NULL,
  subject_external_id text NOT NULL CHECK (subject_external_id <> ''),
  requested_at timestamptz NOT NULL,
  deadline_at timestamptz NOT NULL,
  expected text[],
  groups jsonb NOT NULL DEFAULT '{}',
  completed_at timestamptz,
  held_items integer NOT NULL DEFAULT 0 CHECK (held_items >= 0),
  PRIMARY KEY (app_id, livemode, id)
);
CREATE UNIQUE INDEX erasures_active ON privacy.erasures (app_id, livemode, subject_external_id) WHERE completed_at IS NULL;

REVOKE DELETE ON privacy.erasures FROM {{app}};
ALTER TABLE privacy.erasures ENABLE ROW LEVEL SECURITY;
ALTER TABLE privacy.erasures FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON privacy.erasures TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());
