-- The policy service's tables: each app's categories, action keys and LLM settings per mode, and
-- the head of its policy per mode: the newest version, counting from 1, and the whole policy as of
-- it, as policy.updated carries it. App-scoped: row-level security limits the app role to the apps
-- and mode of the current transaction.

CREATE SCHEMA policy;
GRANT USAGE ON SCHEMA policy TO {{app}};

-- Each app's action keys per mode, in the order the app lists them. A removed key keeps its row
-- (removed_at set), so past decisions and their reversal still find it.

CREATE TABLE policy.action_keys (
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
  PRIMARY KEY (app_id, livemode, key),
  CHECK (reverse_key IS NULL OR reverse_key <> key),
  CHECK (NOT auto_allowed OR reverse_key IS NOT NULL)
);

ALTER TABLE policy.action_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy.action_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY app ON policy.action_keys TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());

-- Each app's categories per mode, in the order its report screen lists them, and its LLM settings.
-- A removed category keeps its row (removed_at set), so past cases still find its label.

CREATE TABLE policy.categories (
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
  -- A custom category (own severity or SLA) has at most one global category.
  CHECK ((severity IS NULL AND sla_hours IS NULL) OR cardinality(maps_to) <= 1)
);

CREATE TABLE policy.llm_settings (
  app_id text NOT NULL,
  livemode boolean NOT NULL,
  rules_only boolean NOT NULL,
  fallback_to_rules boolean NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (app_id, livemode)
);

ALTER TABLE policy.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy.categories FORCE ROW LEVEL SECURITY;
CREATE POLICY app ON policy.categories TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());

ALTER TABLE policy.llm_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy.llm_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY app ON policy.llm_settings TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());

CREATE TABLE policy.heads (
  app_id text NOT NULL,
  livemode boolean NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  -- The whole policy: { categories, actionKeys, llm }, as in policy.updated.
  document jsonb NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (app_id, livemode)
);

ALTER TABLE policy.heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy.heads FORCE ROW LEVEL SECURITY;
CREATE POLICY app ON policy.heads TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());
