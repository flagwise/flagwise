-- Delivery's tables. App-scoped: row-level security limits the app role to the apps and mode of
-- the current transaction.

CREATE SCHEMA delivery;
GRANT USAGE ON SCHEMA delivery TO {{app}};

-- Action requests: one per action key of a decision, settled by the tenant. A moderator can answer
-- failed requests with new ones: a replaced request stays failed and names the retry that
-- answered it (replaced_by); the new requests name the retry that made them (retry_id).
CREATE TABLE delivery.action_requests (
  app_id text NOT NULL,
  livemode boolean NOT NULL,
  id text NOT NULL,
  case_id text NOT NULL,
  decision_id text NOT NULL,
  -- Order within the decision, from 0.
  position integer NOT NULL CHECK (position >= 0),
  action_key text NOT NULL CHECK (action_key <> ''),
  status text NOT NULL CHECK (status IN ('pending', 'confirmed', 'failed')),
  fail_reason text,
  retry_id text,
  replaced_by text,
  PRIMARY KEY (app_id, id),
  UNIQUE (app_id, decision_id, position),
  CHECK ((status = 'failed') = (fail_reason IS NOT NULL)),
  CHECK (replaced_by IS NULL OR status = 'failed')
);

ALTER TABLE delivery.action_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery.action_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY app ON delivery.action_requests TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());

-- Tenant webhooks: each app's signing secrets and endpoints per mode, the webhook events, one
-- delivery of each event per endpoint, and every attempt. The
-- system role finds and leases due deliveries across apps (the sender) and reseals secrets when
-- the master key rotates; it never sees an endpoint or an event body.

CREATE TABLE delivery.webhook_secrets (
  app_id text NOT NULL,
  livemode boolean NOT NULL,
  -- 1 for the first secret, then one more for each roll.
  version integer NOT NULL CHECK (version >= 1),
  -- The secret sealed with the master key (platform seal()).
  sealed text NOT NULL,
  created_at timestamptz NOT NULL,
  -- Null for the current secret; a rolled-over secret still signs until then.
  expires_at timestamptz,
  PRIMARY KEY (app_id, livemode, version)
);

CREATE TABLE delivery.webhook_endpoints (
  app_id text NOT NULL,
  livemode boolean NOT NULL,
  id text NOT NULL,
  url text NOT NULL CHECK (url <> ''),
  -- Null: every event type.
  event_types text[],
  created_at timestamptz NOT NULL,
  PRIMARY KEY (app_id, id)
);

CREATE TABLE delivery.webhook_events (
  app_id text NOT NULL,
  livemode boolean NOT NULL,
  -- The `evt_` id tenants see, the same for every endpoint and every retry.
  id text NOT NULL,
  -- The internal event it came from, so a redelivered one becomes no second webhook.
  source_id text NOT NULL,
  type text NOT NULL,
  -- The exact JSON that is signed and sent.
  body text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (app_id, id),
  UNIQUE (app_id, livemode, source_id)
);

CREATE TABLE delivery.webhook_deliveries (
  app_id text NOT NULL,
  livemode boolean NOT NULL,
  event_id text NOT NULL,
  endpoint_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
  -- Attempts made so far.
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- When the next attempt is due; null once delivered or failed.
  next_attempt_at timestamptz,
  -- A sender is working on it until then.
  leased_until timestamptz,
  created_at timestamptz NOT NULL,
  finished_at timestamptz,
  PRIMARY KEY (app_id, event_id, endpoint_id),
  FOREIGN KEY (app_id, event_id) REFERENCES delivery.webhook_events (app_id, id) ON DELETE CASCADE,
  CHECK ((status = 'pending') = (next_attempt_at IS NOT NULL))
);

CREATE INDEX webhook_deliveries_due ON delivery.webhook_deliveries (next_attempt_at) WHERE status = 'pending';

CREATE TABLE delivery.webhook_attempts (
  app_id text NOT NULL,
  livemode boolean NOT NULL,
  event_id text NOT NULL,
  endpoint_id text NOT NULL,
  number integer NOT NULL CHECK (number >= 1),
  at timestamptz NOT NULL,
  -- The response status; null when no response arrived.
  status integer,
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  delivered boolean NOT NULL,
  -- Why it failed without a response (timeout, connection refused, ...).
  error text,
  PRIMARY KEY (app_id, event_id, endpoint_id, number),
  FOREIGN KEY (app_id, event_id, endpoint_id) REFERENCES delivery.webhook_deliveries (app_id, event_id, endpoint_id) ON DELETE CASCADE
);

ALTER TABLE delivery.webhook_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery.webhook_secrets FORCE ROW LEVEL SECURITY;
ALTER TABLE delivery.webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery.webhook_endpoints FORCE ROW LEVEL SECURITY;
ALTER TABLE delivery.webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery.webhook_events FORCE ROW LEVEL SECURITY;
ALTER TABLE delivery.webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery.webhook_deliveries FORCE ROW LEVEL SECURITY;
ALTER TABLE delivery.webhook_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery.webhook_attempts FORCE ROW LEVEL SECURITY;

CREATE POLICY app ON delivery.webhook_secrets TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());
CREATE POLICY app ON delivery.webhook_endpoints TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());
CREATE POLICY app ON delivery.webhook_events TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());
CREATE POLICY app ON delivery.webhook_deliveries TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());
CREATE POLICY app ON delivery.webhook_attempts TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());

GRANT USAGE ON SCHEMA delivery TO {{system}};

-- The sender: finds due deliveries and leases them.
GRANT SELECT, UPDATE (leased_until) ON delivery.webhook_deliveries TO {{system}};
CREATE POLICY sender ON delivery.webhook_deliveries FOR SELECT TO {{system}} USING (true);
CREATE POLICY sender_lease ON delivery.webhook_deliveries FOR UPDATE TO {{system}} USING (true) WITH CHECK (true);

-- Resealing every secret under a new master key.
GRANT SELECT, UPDATE (sealed) ON delivery.webhook_secrets TO {{system}};
CREATE POLICY reseal ON delivery.webhook_secrets FOR SELECT TO {{system}} USING (true);
CREATE POLICY reseal_update ON delivery.webhook_secrets FOR UPDATE TO {{system}} USING (true) WITH CHECK (true);
