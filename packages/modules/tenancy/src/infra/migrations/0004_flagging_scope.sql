-- The scope for sending reports is named flagging, after the service it opens (it was ingest).
-- Keys issued before keep working: their ingest scope becomes flagging. The keys are updated as
-- the owner, so their forced row-level security is lifted around it.
ALTER TABLE tenancy.api_keys DROP CONSTRAINT api_keys_scopes_check;
ALTER TABLE tenancy.api_keys NO FORCE ROW LEVEL SECURITY;
UPDATE tenancy.api_keys SET scopes = array_replace(scopes, 'ingest', 'flagging') WHERE 'ingest' = ANY (scopes);
ALTER TABLE tenancy.api_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE tenancy.api_keys ADD CONSTRAINT api_keys_scopes_check
  CHECK (cardinality(scopes) > 0 AND scopes <@ ARRAY['flagging', 'actions', 'admin']);
