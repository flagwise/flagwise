-- Auth: API keys, and its copy of the install's apps (kept from the apps service's facts).
-- Row-level security limits the app role to the apps of the current transaction. The system role
-- may read both tables, to resolve an API key before any app is known.

CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO {{app}}, {{system}};

CREATE TABLE auth.apps (
  id text PRIMARY KEY,
  deleted_at timestamptz
);

CREATE TABLE auth.api_keys (
  app_id text NOT NULL,
  id text NOT NULL,
  livemode boolean NOT NULL,
  -- The first 12 characters of the key body, in clear: the key is found by it, then its hash checked.
  lookup text NOT NULL UNIQUE CHECK (lookup ~ '^[0-9A-Za-z]{12}$'),
  hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  scopes text[] NOT NULL CHECK (cardinality(scopes) > 0 AND scopes <@ ARRAY['flagging', 'actions', 'admin']),
  created_at timestamptz NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (app_id, id),
  FOREIGN KEY (app_id) REFERENCES auth.apps (id)
);

ALTER TABLE auth.apps ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.apps FORCE ROW LEVEL SECURITY;
CREATE POLICY app ON auth.apps TO {{app}}
  USING (id = ANY (platform.app_ids()))
  WITH CHECK (id = ANY (platform.app_ids()));

ALTER TABLE auth.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.api_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY app ON auth.api_keys TO {{app}}
  USING (app_id = ANY (platform.app_ids()))
  WITH CHECK (app_id = ANY (platform.app_ids()));

GRANT SELECT ON auth.apps, auth.api_keys TO {{system}};
CREATE POLICY directory ON auth.apps FOR SELECT TO {{system}} USING (true);
CREATE POLICY directory ON auth.api_keys FOR SELECT TO {{system}} USING (true);
