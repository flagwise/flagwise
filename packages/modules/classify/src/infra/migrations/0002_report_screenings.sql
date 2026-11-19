-- What flagging's pre-rules found in each report, kept from report.received, so classify never
-- runs the pre-rules itself. Signal names and a flag only, no personal data. Tenant-scoped like
-- the classifications.

CREATE TABLE classify.report_screenings (
  org_id text NOT NULL,
  app_id text NOT NULL,
  livemode boolean NOT NULL,
  report_id text NOT NULL CHECK (report_id <> ''),
  p0_signals text[] NOT NULL,
  injection_suspected boolean NOT NULL,
  PRIMARY KEY (org_id, app_id, livemode, report_id)
);

ALTER TABLE classify.report_screenings ENABLE ROW LEVEL SECURITY;
ALTER TABLE classify.report_screenings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON classify.report_screenings TO {{app}}
  USING (org_id = platform.org_id() AND app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (org_id = platform.org_id() AND app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());
