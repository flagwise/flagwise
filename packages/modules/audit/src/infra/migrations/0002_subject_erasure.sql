-- Erasing an account also replaces its id in the column entries are searched by (not covered by
-- the chain), so the app role may now change that column too.

GRANT UPDATE (subject_external_id) ON audit.entries TO {{app}};
