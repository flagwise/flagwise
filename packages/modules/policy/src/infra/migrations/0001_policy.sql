-- The policy service's tables. An app's categories, action keys and LLM settings move here from
-- tenancy as they are, rows, row-level security and grants included. Each app's policy gets a head
-- per mode: the newest version, counting from 1, and the whole policy as of it, as policy.updated
-- carries it. An app that set anything before this release starts at version 1 with what it set.

CREATE SCHEMA policy;
GRANT USAGE ON SCHEMA policy TO {{app}};

ALTER TABLE tenancy.action_keys SET SCHEMA policy;
ALTER TABLE tenancy.categories SET SCHEMA policy;
ALTER TABLE tenancy.llm_settings SET SCHEMA policy;

CREATE TABLE policy.heads (
  app_id text NOT NULL,
  livemode boolean NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  -- The whole policy: { categories, actionKeys, llm }, as in policy.updated.
  document jsonb NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (app_id, livemode),
  FOREIGN KEY (app_id) REFERENCES tenancy.apps (id)
);

ALTER TABLE policy.heads ENABLE ROW LEVEL SECURITY;
CREATE POLICY app ON policy.heads TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());

-- Forced row-level security hides every row from the owner running this migration, so it is lifted
-- while the heads are built.
ALTER TABLE policy.action_keys NO FORCE ROW LEVEL SECURITY;
ALTER TABLE policy.categories NO FORCE ROW LEVEL SECURITY;
ALTER TABLE policy.llm_settings NO FORCE ROW LEVEL SECURITY;

WITH set_up AS (
  SELECT app_id, livemode FROM policy.categories WHERE removed_at IS NULL
  UNION SELECT app_id, livemode FROM policy.action_keys WHERE removed_at IS NULL
  UNION SELECT app_id, livemode FROM policy.llm_settings
)
INSERT INTO policy.heads (app_id, livemode, version, document, updated_at)
SELECT a.app_id, a.livemode, 1,
  jsonb_build_object(
    'categories', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
          'key', c.key, 'label', jsonb_build_object('en', c.label_en, 'id', c.label_id), 'mapsTo', to_jsonb(c.maps_to),
          'severity', c.severity, 'slaHours', c.sla_hours, 'enabled', c.enabled) ORDER BY c.position)
        FROM policy.categories c
       WHERE c.app_id = a.app_id AND c.livemode = a.livemode AND c.removed_at IS NULL), '[]'::jsonb),
    'actionKeys', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
          'key', k.key, 'label', jsonb_build_object('en', k.label_en, 'id', k.label_id), 'description', k.description,
          'reverseKey', k.reverse_key, 'autoAllowed', k.auto_allowed, 'categories', to_jsonb(k.categories)) ORDER BY k.position)
        FROM policy.action_keys k
       WHERE k.app_id = a.app_id AND k.livemode = a.livemode AND k.removed_at IS NULL), '[]'::jsonb),
    'llm', COALESCE((
      SELECT jsonb_build_object('rulesOnly', s.rules_only, 'fallbackToRules', s.fallback_to_rules)
        FROM policy.llm_settings s
       WHERE s.app_id = a.app_id AND s.livemode = a.livemode), '{"rulesOnly": false, "fallbackToRules": true}'::jsonb)
  ),
  now()
FROM set_up a;

ALTER TABLE policy.action_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE policy.categories FORCE ROW LEVEL SECURITY;
ALTER TABLE policy.llm_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE policy.heads FORCE ROW LEVEL SECURITY;
