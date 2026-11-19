-- Action requests: one per action key of a decision, settled by the tenant. App-scoped:
-- row-level security limits the app role to the apps and mode of the current transaction.

CREATE SCHEMA delivery;
GRANT USAGE ON SCHEMA delivery TO {{app}};

CREATE TABLE delivery.action_requests (
  app_id text NOT NULL,
  livemode boolean NOT NULL,
  id text NOT NULL,
  case_id text NOT NULL,
  decision_id text NOT NULL,
  -- Order within the decision, from 0.
  position integer NOT NULL CHECK (position >= 0),
  action_key text NOT NULL CHECK (action_key <> ''),
  status text NOT NULL CHECK (status IN ('pending', 'confirmed', 'failed')),
  fail_reason text,
  PRIMARY KEY (app_id, id),
  UNIQUE (app_id, decision_id, position),
  CHECK ((status = 'failed') = (fail_reason IS NOT NULL))
);

ALTER TABLE delivery.action_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery.action_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY app ON delivery.action_requests TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());
