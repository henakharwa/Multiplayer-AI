-- Restores the structure removed by 0005. The workspace repository list
-- comes back empty: its rows were not kept.
CREATE TABLE IF NOT EXISTS workspace_repositories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT false,
  added_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  webhook_id BIGINT,
  last_event_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_repositories_unique_idx
  ON workspace_repositories (workspace_id, lower(owner), lower(repo));
CREATE INDEX IF NOT EXISTS workspace_repositories_full_name_idx
  ON workspace_repositories (lower(owner), lower(repo));
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS run_as_kind TEXT NOT NULL DEFAULT 'user';
