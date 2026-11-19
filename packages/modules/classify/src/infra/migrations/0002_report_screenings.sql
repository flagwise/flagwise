-- What flagging's pre-rules found in each report, kept from report.received, so classify never
-- runs the pre-rules itself. Signal names and a flag only, no personal data. App-scoped like
-- the classifications.

CREATE TABLE classify.report_screenings (
  app_id text NOT NULL,
  livemode boolean NOT NULL,
  report_id text NOT NULL CHECK (report_id <> ''),
  p0_signals text[] NOT NULL,
  injection_suspected boolean NOT NULL,
  PRIMARY KEY (app_id, livemode, report_id)
);

ALTER TABLE classify.report_screenings ENABLE ROW LEVEL SECURITY;
ALTER TABLE classify.report_screenings FORCE ROW LEVEL SECURITY;
CREATE POLICY app ON classify.report_screenings TO {{app}}
  USING (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode())
  WITH CHECK (app_id = ANY (platform.app_ids()) AND livemode = platform.livemode());
