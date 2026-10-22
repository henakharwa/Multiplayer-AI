-- Clean up the runaway reminder chains created before reminders were
-- excluded from escalation. A reminder used to be escalated again, so one
-- unanswered decision produced "Reminder: Reminder: ..." notifications that
-- kept multiplying. Keep only the first reminder for each decision.
DELETE FROM workspace_notifications
WHERE text LIKE 'Reminder: Reminder: %';

-- Outcome messages ("... approved your request ...") are not decisions and
-- should never have been reminded about.
DELETE FROM workspace_notifications
WHERE kind = 'decision_needed'
  AND text LIKE 'Reminder: %'
  AND (text LIKE '% approved your request for %' OR text LIKE '% declined your request for %');

-- The remaining first-level reminders must never be escalated again.
UPDATE workspace_notifications
SET escalated_at = COALESCE(escalated_at, now())
WHERE text LIKE 'Reminder: %';

-- Reminders for decisions that are no longer waiting are already handled.
UPDATE workspace_notifications n
SET read_at = COALESCE(n.read_at, now())
WHERE n.text LIKE 'Reminder: Decision needed: %'
  AND n.read_at IS NULL
  AND n.resource_type = 'action'
  AND NOT EXISTS (SELECT 1 FROM pending_actions a WHERE a.id::text = n.resource_id AND a.status = 'pending');
