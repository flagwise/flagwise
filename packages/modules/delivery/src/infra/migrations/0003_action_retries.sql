-- Retried actions: a moderator answers failed requests with new ones. A replaced request stays
-- failed and names the retry that answered it; the new requests name the retry that made them.

ALTER TABLE delivery.action_requests
  ADD COLUMN retry_id text,
  ADD COLUMN replaced_by text,
  ADD CHECK (replaced_by IS NULL OR status = 'failed');
