-- The tenancy registry: orgs, apps and API keys. Row-level security limits the app role to the
-- org (and, for apps and keys, the apps) of the current transaction. The system role may read the
-- registry, and only the registry, to resolve an API key before any tenant is known.

CREATE SCHEMA tenancy;
GRANT USAGE ON SCHEMA tenancy TO {{app}}, {{system}};

CREATE TABLE tenancy.orgs (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (name <> ''),
  plan text NOT NULL CHECK (plan IN ('free', 'pro')),
  created_at timestamptz NOT NULL,
  deleted_at timestamptz
);

CREATE TABLE tenancy.apps (
  org_id text NOT NULL REFERENCES tenancy.orgs (id),
  id text NOT NULL,
  name text NOT NULL CHECK (name <> ''),
  created_at timestamptz NOT NULL,
  deleted_at timestamptz,
  PRIMARY KEY (org_id, id),
  UNIQUE (id)
);

CREATE TABLE tenancy.api_keys (
  org_id text NOT NULL,
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
  PRIMARY KEY (org_id, app_id, id),
  FOREIGN KEY (org_id, app_id) REFERENCES tenancy.apps (org_id, id)
);

ALTER TABLE tenancy.orgs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.orgs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON tenancy.orgs TO {{app}} USING (id = platform.org_id()) WITH CHECK (id = platform.org_id());

ALTER TABLE tenancy.apps ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.apps FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON tenancy.apps TO {{app}}
  USING (org_id = platform.org_id() AND id = ANY (platform.app_ids()))
  WITH CHECK (org_id = platform.org_id() AND id = ANY (platform.app_ids()));

ALTER TABLE tenancy.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.api_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON tenancy.api_keys TO {{app}}
  USING (org_id = platform.org_id() AND app_id = ANY (platform.app_ids()))
  WITH CHECK (org_id = platform.org_id() AND app_id = ANY (platform.app_ids()));

GRANT SELECT ON tenancy.orgs, tenancy.apps, tenancy.api_keys TO {{system}};
CREATE POLICY directory ON tenancy.orgs FOR SELECT TO {{system}} USING (true);
CREATE POLICY directory ON tenancy.apps FOR SELECT TO {{system}} USING (true);
CREATE POLICY directory ON tenancy.api_keys FOR SELECT TO {{system}} USING (true);
