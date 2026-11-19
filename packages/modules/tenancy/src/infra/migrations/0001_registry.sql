-- The tenancy registry: apps and API keys. Row-level security limits the app role to the apps of
-- the current transaction. The system role may read the
-- registry, and only the registry, to resolve an API key before any tenant is known.

CREATE SCHEMA tenancy;
GRANT USAGE ON SCHEMA tenancy TO {{app}}, {{system}};

CREATE TABLE tenancy.apps (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (name <> ''),
  created_at timestamptz NOT NULL,
  deleted_at timestamptz
);

CREATE TABLE tenancy.api_keys (
  app_id text NOT NULL,
  id text NOT NULL,
  livemode boolean NOT NULL,
  -- The first 12 characters of the key body, in clear: the key is found by it, then its hash checked.
  lookup text NOT NULL UNIQUE CHECK (lookup ~ '^[0-9A-Za-z]{12}$'),
  hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  scopes text[] NOT NULL CHECK (cardinality(scopes) > 0 AND scopes <@ ARRAY['ingest', 'actions', 'admin']),
  created_at timestamptz NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (app_id, id),
  FOREIGN KEY (app_id) REFERENCES tenancy.apps (id)
);

ALTER TABLE tenancy.apps ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.apps FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON tenancy.apps TO {{app}}
  USING (id = ANY (platform.app_ids()))
  WITH CHECK (id = ANY (platform.app_ids()));

ALTER TABLE tenancy.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.api_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON tenancy.api_keys TO {{app}}
  USING (app_id = ANY (platform.app_ids()))
  WITH CHECK (app_id = ANY (platform.app_ids()));

GRANT SELECT ON tenancy.apps, tenancy.api_keys TO {{system}};
CREATE POLICY directory ON tenancy.apps FOR SELECT TO {{system}} USING (true);
CREATE POLICY directory ON tenancy.api_keys FOR SELECT TO {{system}} USING (true);
