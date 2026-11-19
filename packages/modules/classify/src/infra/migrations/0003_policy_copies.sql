-- Classify's copy of each app's policy per mode, kept from policy.updated: the newest version it
-- saw and the whole policy as of it. Classify reads the app's categories (what a reporter's pick names) and
-- whether the app runs rules only.

CREATE TABLE classify.policy_copies (
  app_id text NOT NULL,
  livemode boolean NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  document jsonb NOT NULL,
  PRIMARY KEY (app_id, livemode)
);

ALTER TABLE classify.policy_copies ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant ON classify.policy_copies TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());

-- On an upgrade the copies start from the heads the policy service built from the config it took
-- over, since no policy.updated was published for those. This one-time read of the policy
-- service's table runs as the owner, so forced row-level security is lifted around it.
DO $$
BEGIN
  IF to_regclass('policy.heads') IS NOT NULL THEN
    ALTER TABLE policy.heads NO FORCE ROW LEVEL SECURITY;
    INSERT INTO classify.policy_copies (app_id, livemode, version, document)
      SELECT app_id, livemode, version, document FROM policy.heads;
    ALTER TABLE policy.heads FORCE ROW LEVEL SECURITY;
  END IF;
END $$;

ALTER TABLE classify.policy_copies FORCE ROW LEVEL SECURITY;
