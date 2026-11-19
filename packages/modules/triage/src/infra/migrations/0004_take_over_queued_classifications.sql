-- On an upgrade from a release where moderation triaged cases itself: a case.classified still
-- queued for moderation's group 'cases.triage' is queued for triage's group too, so its case is
-- triaged instead of staying classifying (moderation's group now only keeps the classification).
-- Triage's group is stored here, before the new release subscribes, so it also gets every event
-- not yet fanned out; the server sets its types and attempts again when it subscribes. A fresh
-- install, or one where triage's group exists already, has nothing to take over. The event log is
-- read as the owner, so its forced row-level security is lifted around it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM platform.consumer_groups WHERE name = 'cases.triage')
     AND NOT EXISTS (SELECT 1 FROM platform.consumer_groups WHERE name = 'triage') THEN
    ALTER TABLE platform.events NO FORCE ROW LEVEL SECURITY;
    INSERT INTO platform.consumer_groups (name, types, max_attempts, since_seq)
    SELECT 'triage',
           ARRAY['case.opened.v1', 'case.report_attached.v1', 'case.classified.v1', 'case.reclassified.v1', 'case.claimed.v1',
                 'case.released.v1', 'case.corrected.v1', 'case.corrected.v2', 'case.decided.v1'],
           5,
           COALESCE(min(seq) FILTER (WHERE NOT fanned_out) - 1, max(seq), 0)
      FROM platform.events;
    INSERT INTO platform.deliveries (group_name, seq, key)
    SELECT 'triage', d.seq, d.key
      FROM platform.deliveries d JOIN platform.events e ON e.seq = d.seq
     WHERE d.group_name = 'cases.triage' AND e.type = 'case.classified.v1'
     ORDER BY d.queued;
    ALTER TABLE platform.events FORCE ROW LEVEL SECURITY;
  END IF;
END $$;
