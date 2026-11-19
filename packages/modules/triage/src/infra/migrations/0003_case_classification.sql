-- The classification triage triages each case on: the last one it triaged, with a moderator's
-- category once corrected. Triage triages a corrected case again from case.corrected with it.

ALTER TABLE triage.cases ADD COLUMN classification jsonb;

-- On an upgrade, the cases triage already keeps take the classification moderation holds for
-- them, its pre-rules' P0 from the case's band. This one-time read runs as the owner, so forced
-- row-level security is lifted around it.
DO $$
BEGIN
  IF to_regclass('cases.cases') IS NOT NULL THEN
    ALTER TABLE cases.cases NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE triage.cases NO FORCE ROW LEVEL SECURITY;
    UPDATE triage.cases t
       SET classification = jsonb_build_object(
             'categoryId', c.category_id,
             'customCategoryId', c.custom_category_id,
             'signals', to_jsonb(COALESCE(c.signals, '{}')),
             'injectionSuspected', COALESCE(c.injection_suspected, false),
             'preRuleP0', c.band = 'p0',
             'classifiedBy', c.classified_by)
      FROM cases.cases c
     WHERE c.app_id = t.app_id AND c.livemode = t.livemode AND c.id = t.case_id
       AND c.category_id IS NOT NULL AND c.classified_by IS NOT NULL;
    ALTER TABLE cases.cases FORCE ROW LEVEL SECURITY;
    ALTER TABLE triage.cases FORCE ROW LEVEL SECURITY;
  END IF;
END $$;
