-- Each member works in one repository at a time: the one chosen for their own
-- GitHub connection. The workspace repository list and the workspace GitHub
-- App are removed.

-- Members who relied on the workspace list without choosing a repository of
-- their own keep working: they get the workspace's default repository (or its
-- oldest one when none was marked default).
UPDATE integrations i
SET owner = r.owner, repo = r.repo
FROM (
  SELECT DISTINCT ON (workspace_id) workspace_id, owner, repo
  FROM workspace_repositories
  ORDER BY workspace_id, is_default DESC, created_at ASC, id ASC
) r
WHERE i.workspace_id = r.workspace_id
  AND i.type = 'github'
  AND (i.owner IS NULL OR i.repo IS NULL);

-- Approvals that were going to run as the GitHub App run with the
-- requester's own connection instead (the approver can still choose
-- "Run as me").
UPDATE pending_actions
SET run_as_user_id = requested_by_user_id
WHERE run_as_kind = 'app' AND status = 'pending';

ALTER TABLE pending_actions DROP COLUMN IF EXISTS run_as_kind;
DROP TABLE IF EXISTS workspace_repositories;
