-- Team GitHub: a shared repository list per workspace, attribution of what
-- the agent read or changed, approval run-as rules, duplicate warnings,
-- and verified GitHub webhook events.

-- The repositories a workspace works on. Every member's agent targets
-- these through that member's own GitHub account.
CREATE TABLE IF NOT EXISTS workspace_repositories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  added_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Set when Nexus created the repository webhook itself.
  webhook_id BIGINT,
  last_event_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_repositories_unique_idx
  ON workspace_repositories (workspace_id, lower(owner), lower(repo));
CREATE INDEX IF NOT EXISTS workspace_repositories_full_name_idx
  ON workspace_repositories (lower(owner), lower(repo));

-- Existing workspaces keep working: every repository a member had chosen
-- becomes a workspace repository. The earliest connection's repository is
-- the default.
INSERT INTO workspace_repositories (workspace_id, owner, repo, is_default, added_by_user_id)
SELECT DISTINCT ON (i.workspace_id, lower(i.owner), lower(i.repo))
  i.workspace_id, i.owner, i.repo, false, i.owner_user_id
FROM integrations i
WHERE i.type = 'github' AND i.owner IS NOT NULL AND i.repo IS NOT NULL
ORDER BY i.workspace_id, lower(i.owner), lower(i.repo), i.connected_at ASC
ON CONFLICT DO NOTHING;

UPDATE workspace_repositories r SET is_default = true
WHERE r.id = (
  SELECT r2.id FROM workspace_repositories r2
  WHERE r2.workspace_id = r.workspace_id
  ORDER BY r2.created_at ASC, r2.id ASC LIMIT 1
)
AND NOT EXISTS (
  SELECT 1 FROM workspace_repositories r3 WHERE r3.workspace_id = r.workspace_id AND r3.is_default
);

-- One webhook secret per workspace, for repository webhooks pointed at
-- /webhooks/github/workspaces/<workspace id>.
CREATE TABLE IF NOT EXISTS workspace_github_webhooks (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  encrypted_secret TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_delivery_at TIMESTAMPTZ,
  last_event TEXT
);

-- GitHub retries deliveries, and a workspace may receive the same event
-- from both a repository webhook and the GitHub App. Each delivery runs once.
CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
  delivery_id TEXT NOT NULL,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, delivery_id)
);
CREATE INDEX IF NOT EXISTS github_webhook_deliveries_received_idx ON github_webhook_deliveries (received_at);

-- The GitHub username behind each personal connection, for "Read as @login".
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS account_login TEXT;

-- Which account and repositories an agent reply used.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS provenance JSONB;

-- Approval cards: who the action runs as, what it targets, warnings found
-- when it was proposed, and who it actually ran as.
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS run_as_kind TEXT NOT NULL DEFAULT 'user';
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS run_as_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS run_as_account TEXT;
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS target JSONB;
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS warnings JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS executed_as_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS executed_as_account TEXT;
CREATE INDEX IF NOT EXISTS pending_actions_workspace_status_idx ON pending_actions (workspace_id, status, created_at DESC);

UPDATE pending_actions SET run_as_user_id = requested_by_user_id WHERE run_as_user_id IS NULL AND requested_by_user_id IS NOT NULL;
