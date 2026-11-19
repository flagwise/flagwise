-- The reports a decision was made on: the ones shown to the moderator. Decisions made before this
-- was recorded keep an empty list.

ALTER TABLE cases.decisions ADD COLUMN report_ids text[] NOT NULL DEFAULT '{}';
ALTER TABLE cases.decisions ALTER COLUMN report_ids DROP DEFAULT;
