-- The classification facts the queue filters and shows, copied from case.classified at triage. No
-- summary or evidence: those stay with classify and intake.

ALTER TABLE cases.cases
  ADD COLUMN category_id text,
  ADD COLUMN signals text[],
  ADD COLUMN injection_suspected boolean,
  ADD COLUMN classified_by text CHECK (classified_by IN ('llm', 'rules')),
  ADD CHECK ((category_id IS NULL) = (signals IS NULL) AND (signals IS NULL) = (injection_suspected IS NULL)
     AND (injection_suspected IS NULL) = (classified_by IS NULL));

CREATE INDEX cases_queue ON cases.cases (app_id, livemode, state);
