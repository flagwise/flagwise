-- Notifications: one per key (its type and what it is about), as the services raised and cleared
-- them. raised_at is null for a clear that came before its raise.

CREATE SCHEMA notifications;
GRANT USAGE ON SCHEMA notifications TO {{app}};

CREATE TABLE notifications.notifications (
  app_id text NOT NULL,
  livemode boolean NOT NULL,
  key text NOT NULL CHECK (key <> ''),
  id text NOT NULL,
  type text NOT NULL CHECK (type <> ''),
  "values" jsonb NOT NULL DEFAULT '{}',
  state text NOT NULL CHECK (state IN ('open', 'acknowledged', 'resolved')),
  raised_at timestamptz,
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  resolved_by text,
  PRIMARY KEY (app_id, livemode, key),
  UNIQUE (app_id, livemode, id),
  CHECK ((state = 'resolved') = (resolved_at IS NOT NULL) AND (resolved_at IS NULL) = (resolved_by IS NULL)),
  CHECK (state = 'resolved' OR raised_at IS NOT NULL)
);
CREATE INDEX notifications_by_state ON notifications.notifications (app_id, livemode, state, raised_at DESC);

REVOKE DELETE ON notifications.notifications FROM {{app}};
ALTER TABLE notifications.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications.notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY app ON notifications.notifications TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());
