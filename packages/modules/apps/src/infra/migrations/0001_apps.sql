-- The install's apps. Row-level security limits the app role to the apps of the current
-- transaction.

CREATE SCHEMA apps;
GRANT USAGE ON SCHEMA apps TO {{app}};

CREATE TABLE apps.apps (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (name <> ''),
  created_at timestamptz NOT NULL,
  deleted_at timestamptz
);

ALTER TABLE apps.apps ENABLE ROW LEVEL SECURITY;
ALTER TABLE apps.apps FORCE ROW LEVEL SECURITY;
CREATE POLICY app ON apps.apps TO {{app}}
  USING (id = ANY (platform.app_ids()))
  WITH CHECK (id = ANY (platform.app_ids()));
