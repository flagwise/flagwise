-- Each app's action keys per mode, in the order the app lists them. A removed key keeps its row
-- (removed_at set), so past decisions and their reversal still find it.

CREATE TABLE tenancy.action_keys (
  org_id text NOT NULL,
  app_id text NOT NULL,
  livemode boolean NOT NULL,
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,63}$'),
  -- Its place in the app's list, from 0; meaningful only while the key is not removed.
  position integer NOT NULL CHECK (position >= 0),
  label_en text NOT NULL CHECK (label_en <> ''),
  label_id text CHECK (label_id <> ''),
  description text,
  reverse_key text,
  auto_allowed boolean NOT NULL,
  -- '*', global groups or global category ids.
  categories text[] NOT NULL CHECK (cardinality(categories) > 0),
  updated_at timestamptz NOT NULL,
  removed_at timestamptz,
  PRIMARY KEY (org_id, app_id, livemode, key),
  FOREIGN KEY (org_id, app_id) REFERENCES tenancy.apps (org_id, id),
  CHECK (reverse_key IS NULL OR reverse_key <> key),
  CHECK (NOT auto_allowed OR reverse_key IS NOT NULL)
);

ALTER TABLE tenancy.action_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.action_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON tenancy.action_keys TO {{app}}
  USING (org_id = platform.org_id() AND app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (org_id = platform.org_id() AND app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());
