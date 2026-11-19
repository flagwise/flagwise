-- Reports as received. The evidence itself is in object storage under snapshot_key; this row keeps
-- what intake needs to find a report, answer for it and replay an idempotent request. Tenant-scoped:
-- row-level security limits the app role to the org, apps and mode of the current transaction.

CREATE SCHEMA intake;
GRANT USAGE ON SCHEMA intake TO {{app}};

CREATE TABLE intake.reports (
  org_id text NOT NULL,
  app_id text NOT NULL,
  livemode boolean NOT NULL,
  id text NOT NULL,
  reporter_external_id text NOT NULL CHECK (reporter_external_id <> ''),
  reported_external_id text NOT NULL CHECK (reported_external_id <> ''),
  category text NOT NULL CHECK (category <> ''),
  snapshot_key text NOT NULL,
  -- Held for 24 hours; a later report with the same key takes it over.
  idempotency_key text,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  received_at timestamptz NOT NULL,
  case_id text,
  joined_existing_case boolean,
  PRIMARY KEY (org_id, app_id, id),
  UNIQUE (org_id, app_id, livemode, idempotency_key),
  CHECK ((case_id IS NULL) = (joined_existing_case IS NULL))
);

ALTER TABLE intake.reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE intake.reports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON intake.reports TO {{app}}
  USING (org_id = platform.org_id() AND app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (org_id = platform.org_id() AND app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());
