-- Each app's categories per mode, in the order its report screen lists them, and its LLM settings.
-- A removed category keeps its row (removed_at set), so past cases still find its label.

CREATE TABLE tenancy.categories (
  app_id text NOT NULL,
  livemode boolean NOT NULL,
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,63}$'),
  -- Its place in the app's list, from 0; meaningful only while the category is not removed.
  position integer NOT NULL CHECK (position >= 0),
  label_en text NOT NULL CHECK (label_en <> ''),
  label_id text CHECK (label_id <> ''),
  -- Global groups or global category ids; empty when unmapped.
  maps_to text[] NOT NULL,
  severity text CHECK (severity IN ('P0', 'P1', 'P2')),
  sla_hours integer CHECK (sla_hours BETWEEN 1 AND 720),
  enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL,
  removed_at timestamptz,
  PRIMARY KEY (app_id, livemode, key),
  FOREIGN KEY (app_id) REFERENCES tenancy.apps (id),
  -- A custom category (own severity or SLA) has at most one global category.
  CHECK ((severity IS NULL AND sla_hours IS NULL) OR cardinality(maps_to) <= 1)
);

CREATE TABLE tenancy.llm_settings (
  app_id text NOT NULL,
  livemode boolean NOT NULL,
  rules_only boolean NOT NULL,
  fallback_to_rules boolean NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (app_id, livemode),
  FOREIGN KEY (app_id) REFERENCES tenancy.apps (id)
);

ALTER TABLE tenancy.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.categories FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON tenancy.categories TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());

ALTER TABLE tenancy.llm_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenancy.llm_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON tenancy.llm_settings TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());
