-- The failed action requests of each case that moderation has heard of (action.failed), and
-- whether a moderator's retry has answered them, so moderation never reads delivery's requests: a
-- failure no retry answered moves a decided case to action_failed; a retry names the ones it
-- answers, and delivery replaces exactly those.

CREATE TABLE cases.action_failures (
  app_id text NOT NULL,
  livemode boolean NOT NULL,
  case_id text NOT NULL,
  action_request_id text NOT NULL,
  failed_at timestamptz NOT NULL,
  answered boolean NOT NULL DEFAULT false,
  PRIMARY KEY (app_id, livemode, action_request_id)
);
CREATE INDEX action_failures_by_case ON cases.action_failures (app_id, livemode, case_id);

ALTER TABLE cases.action_failures ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases.action_failures FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON cases.action_failures TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());
