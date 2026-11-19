-- The app's own category of a case, beside its global category: the reporter's pick, when it fits.

ALTER TABLE cases.cases
  ADD COLUMN custom_category_id text,
  ADD CHECK (custom_category_id IS NULL OR category_id IS NOT NULL);
