-- Where each report's evidence snapshot is, as flagging gives it in report.received (since 1.2.0),
-- so classify reads it without knowing how flagging lays out its storage. The screenings kept so
-- far take the place flagging wrote every snapshot to before 1.2.0.
ALTER TABLE classify.report_screenings ADD COLUMN evidence_ref text;
ALTER TABLE classify.report_screenings NO FORCE ROW LEVEL SECURITY;
UPDATE classify.report_screenings SET evidence_ref = 'apps/' || app_id || '/' || report_id;
ALTER TABLE classify.report_screenings FORCE ROW LEVEL SECURITY;
ALTER TABLE classify.report_screenings ALTER COLUMN evidence_ref SET NOT NULL;
ALTER TABLE classify.report_screenings ADD CONSTRAINT report_screenings_evidence_ref_check CHECK (evidence_ref <> '');
