-- Triage's tables. Triage has no API and stores nothing of its own: only its copy of the policy.

CREATE SCHEMA triage;
GRANT USAGE ON SCHEMA triage TO {{app}};

-- Triage's copy of each app's policy per mode, kept from policy.updated: the newest version it
-- saw and the whole policy as of it. Triage reads the app's category rules (severity, SLA) and whether a
-- failed LLM falls back to rules.

CREATE TABLE triage.policy_copies (
  org_id text NOT NULL,
  app_id text NOT NULL,
  livemode boolean NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  document jsonb NOT NULL,
  PRIMARY KEY (org_id, app_id, livemode)
);

ALTER TABLE triage.policy_copies ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON triage.policy_copies TO {{app}}
  USING (org_id = platform.org_id() AND app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (org_id = platform.org_id() AND app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());

-- On an upgrade the copies start from the heads the policy service built from the config it took
-- over, since no policy.updated was published for those. This one-time read of the policy
-- service's table runs as the owner, so forced row-level security is lifted around it.
DO $$
BEGIN
  IF to_regclass('policy.heads') IS NOT NULL THEN
    ALTER TABLE policy.heads NO FORCE ROW LEVEL SECURITY;
    INSERT INTO triage.policy_copies (org_id, app_id, livemode, version, document)
      SELECT org_id, app_id, livemode, version, document FROM policy.heads;
    ALTER TABLE policy.heads FORCE ROW LEVEL SECURITY;
  END IF;
END $$;

ALTER TABLE triage.policy_copies FORCE ROW LEVEL SECURITY;
