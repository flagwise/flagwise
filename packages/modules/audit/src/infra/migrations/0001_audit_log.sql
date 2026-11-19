-- The audit log: one hash chain per app and mode. The app role appends entries and reads its own
-- app's; it can change only an entry's personal data (pii, pii_salt), which erasure clears, and
-- never delete one. The chain covers seq, at, actor, action, target, facts and pii_digest.

CREATE SCHEMA audit;
GRANT USAGE ON SCHEMA audit TO {{app}};

CREATE TABLE audit.entries (
  app_id text NOT NULL,
  livemode boolean NOT NULL,
  seq bigint NOT NULL CHECK (seq >= 1),
  at timestamptz NOT NULL,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  action text NOT NULL CHECK (action <> ''),
  target_type text NOT NULL,
  target_id text NOT NULL,
  facts jsonb NOT NULL,
  pii jsonb,
  pii_salt text,
  pii_digest text,
  prev_hash text NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  -- Not covered by the chain: the event the entry came from (so a redelivery is not recorded
  -- twice), and the ids it is searched by.
  source_event_id text NOT NULL,
  case_id text,
  subject_external_id text,
  PRIMARY KEY (app_id, livemode, seq),
  UNIQUE (app_id, livemode, source_event_id)
);
CREATE INDEX entries_by_case ON audit.entries (app_id, livemode, case_id, seq) WHERE case_id IS NOT NULL;
CREATE INDEX entries_by_subject ON audit.entries (app_id, livemode, subject_external_id, seq) WHERE subject_external_id IS NOT NULL;
CREATE INDEX entries_by_actor ON audit.entries (app_id, livemode, actor_id, seq);
CREATE INDEX entries_by_time ON audit.entries (app_id, livemode, at);

-- The last purged entry of each chain, once retention purges any: verification starts after it.
CREATE TABLE audit.checkpoints (
  app_id text NOT NULL,
  livemode boolean NOT NULL,
  seq bigint NOT NULL CHECK (seq >= 1),
  hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  purged_at timestamptz NOT NULL,
  PRIMARY KEY (app_id, livemode)
);

REVOKE UPDATE, DELETE ON audit.entries FROM {{app}};
GRANT UPDATE (pii, pii_salt) ON audit.entries TO {{app}};
REVOKE INSERT, UPDATE, DELETE ON audit.checkpoints FROM {{app}};

ALTER TABLE audit.entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.entries FORCE ROW LEVEL SECURITY;
CREATE POLICY app ON audit.entries TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());
ALTER TABLE audit.checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.checkpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY app ON audit.checkpoints TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());
