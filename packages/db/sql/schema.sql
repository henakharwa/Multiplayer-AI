-- Idempotent schema, applied via `npm run migrate --workspace=packages/db`
-- (src/migrate.ts). gen_random_uuid() is built into Postgres core since 13,
-- no extension needed (confirmed live against the real local Postgres this
-- project uses before relying on it).

-- A real account -- "Sign in with GitHub" (services/chat-server/src/auth.ts)
-- is the only way to get a row here. github_id is GitHub's own numeric
-- user id, the actual stable identity key (a username can change; this
-- doesn't) -- username/display_name/avatar_url are just what GitHub
-- reported at last login and get overwritten on every subsequent one.
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  github_id TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Each sign-in method has its own stable identity; never link accounts by
-- matching an unverified email address. Existing GitHub users are preserved.
ALTER TABLE users ALTER COLUMN github_id DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT UNIQUE;
CREATE TABLE IF NOT EXISTS password_credentials (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A provider may attest the same email as an existing password account. This
-- is the canonical verified email-to-user mapping used to link sign-in methods.
CREATE TABLE IF NOT EXISTS user_email_identities (
  email TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS user_email_identities_user_idx ON user_email_identities (user_id);


-- token_hash is SHA-256(raw session token) (see src/crypto.ts's
-- hashSessionToken) -- the raw token itself lives only in the browser's
-- httpOnly cookie, never stored here, so a read of this table alone can't
-- be turned into a working session.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  join_code TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Nullable: a workspace created before accounts existed has no creator on
-- record. ON DELETE SET NULL rather than CASCADE -- a user's account
-- going away shouldn't take their workspace (and everyone else in it)
-- down with it.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;

-- Who's been in a workspace -- written (INSERT ... ON CONFLICT DO
-- NOTHING) the moment a signed-in user first opens it, whether by
-- creating it or by following a join-code link. NOT currently an access
-- gate: possession of a valid session + the workspace id/join-code is
-- still what actually gets someone in, same trust model this project has
-- always used, just now behind a real sign-in instead of a typed display
-- name (see docs/spec.md's Phase 2 note). This table exists for
-- provenance/roster purposes today; turning it into real per-workspace
-- access control is a bigger, deliberately-deferred change.
CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'admin'
  CHECK (role IN ('admin', 'editor', 'viewer'));
-- The product now has only Admin and Editor roles. Existing read-only
-- memberships become Admins, matching the new default rather than leaving
-- anyone with an obsolete role that cannot be managed in the UI.
UPDATE workspace_members SET role = 'admin' WHERE role = 'viewer';
ALTER TABLE workspace_members DROP CONSTRAINT IF EXISTS workspace_members_role_check;
ALTER TABLE workspace_members ADD CONSTRAINT workspace_members_role_check CHECK (role IN ('admin', 'editor'));
ALTER TABLE workspace_members ALTER COLUMN role SET DEFAULT 'admin';
-- Preserve control for existing workspaces that have a recorded creator.
UPDATE workspace_members wm SET role = 'admin'
FROM workspaces w WHERE w.id = wm.workspace_id AND w.created_by = wm.user_id;

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'agent', 'system')),
  author_name TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A workspace can contain many independent conversations. Messages and
-- proposed actions belong to one conversation so selecting another chat
-- never mixes its history or approvals into the current view.
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New conversation',
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_workspace_updated_idx
  ON conversations (workspace_id, updated_at DESC);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE;

-- Keep pre-conversation installations usable by placing their existing
-- messages in one General conversation before requiring the new key.
INSERT INTO conversations (workspace_id, title, created_at, updated_at)
SELECT m.workspace_id, 'General', MIN(m.created_at), MAX(m.created_at)
FROM messages m
WHERE m.conversation_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM conversations c WHERE c.workspace_id = m.workspace_id)
GROUP BY m.workspace_id;
UPDATE messages m SET conversation_id = c.id
FROM conversations c
WHERE m.conversation_id IS NULL AND c.workspace_id = m.workspace_id;
ALTER TABLE messages ALTER COLUMN conversation_id SET NOT NULL;

-- Nullable -- only role='user' messages have a real author (an 'agent' or
-- 'system' message has none); author_name stays the source of truth for
-- display (unchanged code path), this is provenance/integrity on top of
-- it -- a real foreign key instead of trusting whatever string arrived.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL;

-- @-mention / handoff mechanics (docs/spec.md Phase 2: "members can
-- direct a message at the agent or hand a task to a teammate within the
-- thread"). Computed once, server-side, at insert time (see
-- services/chat-server/src/mentions.ts) against that moment's real
-- workspace membership -- not re-derived from the raw text on every
-- read, so a later rename doesn't retroactively change who a past
-- message was "directed at". mentions_agent defaults true so a message
-- with no @-mention at all (the overwhelmingly common case, and every
-- message before this column existed) still reaches the agent the same
-- way it always has -- @-mentioning ONLY a teammate (never @agent) is
-- what opts a message OUT of triggering a turn; see server.ts's
-- WebSocket handler.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS mentions_agent BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS mentioned_user_ids UUID[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS messages_workspace_created_idx
  ON messages (workspace_id, created_at);

-- One row per (workspace, integration type). encrypted_token is
-- AES-256-GCM ciphertext ("iv:authTag:ciphertext", each base64), never the
-- raw token -- see src/crypto.ts. owner/repo are only meaningful for
-- type='github'; team_name only for type='slack'.
CREATE TABLE IF NOT EXISTS integrations (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('github', 'slack')),
  owner TEXT,
  repo TEXT,
  team_name TEXT,
  encrypted_token TEXT NOT NULL,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, type)
);

ALTER TABLE integrations DROP CONSTRAINT IF EXISTS integrations_type_check;
ALTER TABLE integrations ADD CONSTRAINT integrations_type_check CHECK (type IN ('github', 'slack', 'linear', 'notion', 'figma'));

-- Queued repo-changing GitHub actions the agent has proposed but not yet
-- run. args is the exact JSON the tool would be called with; result is a
-- short human-readable summary of what happened once confirmed/failed.
-- Never auto-transitions out of 'pending' -- only a human confirm/cancel
-- (or a failed execution attempt) resolves one.
CREATE TABLE IF NOT EXISTS pending_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  description TEXT NOT NULL,
  args JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled', 'failed')),
  result TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE;
UPDATE pending_actions a SET conversation_id = c.id
FROM conversations c
WHERE a.conversation_id IS NULL AND c.workspace_id = a.workspace_id;
ALTER TABLE pending_actions ALTER COLUMN conversation_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS pending_actions_conversation_idx
  ON pending_actions (conversation_id, created_at);

-- Per-member alerts survive a browser refresh and are intentionally separate
-- from chat messages: an agent may finish while a teammate is elsewhere.
CREATE TABLE IF NOT EXISTS workspace_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('agent_completed', 'decision_needed', 'action_completed')),
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS workspace_notifications_user_idx
  ON workspace_notifications (user_id, read_at, created_at DESC);

-- Added after the first version of this table shipped -- IF NOT EXISTS
-- keeps re-running this idempotent schema safe for anyone who already has
-- the table without this column.
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS preview TEXT;

CREATE INDEX IF NOT EXISTS pending_actions_workspace_idx
  ON pending_actions (workspace_id, created_at);

-- Email verification -- only meaningful for an email+password account.
-- A GitHub/Google login already proved a real, provider-authenticated
-- email (or GitHub identity) before this app ever saw it; only signup
-- via email+password hands us an address nobody has confirmed yet.
ALTER TABLE password_credentials ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

-- Existing duplicate accounts remain separate; new sign-ins reuse the first
-- verified identity rather than silently moving workspaces or messages.
INSERT INTO user_email_identities (email, user_id, verified_at)
SELECT lower(email), user_id, COALESCE(email_verified_at, now()) FROM password_credentials
ON CONFLICT (email) DO NOTHING;
INSERT INTO user_email_identities (email, user_id)
SELECT lower(username), id FROM users WHERE google_id IS NOT NULL AND username LIKE '%@%'
ON CONFLICT (email) DO NOTHING;

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS email_verification_tokens_user_idx ON email_verification_tokens (user_id);

-- Password reset -- single-use, short-lived tokens. used_at (rather than
-- deleting on use) distinguishes "never existed" from "already spent",
-- so a reused old link fails closed instead of silently working again.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx ON password_reset_tokens (user_id);

-- Attributes a proposed action to whoever's chat message triggered the
-- agent turn that produced it -- lets the audit trail below answer "who
-- asked for what", not just "what did the agent do". Nullable: a turn
-- could in principle run without a preceding user message, and rows
-- written before this column existed have neither.
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS requested_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS requested_by_name TEXT;

-- Action audit trail (docs/spec.md Phase 2: "who asked for what, what the
-- agent did, when"). One append-only row per notable workspace event --
-- a member joining, an integration being connected, the agent proposing a
-- write action, a human confirming/cancelling/failing one. Deliberately
-- denormalized (actor_name/summary are plain text captured at write time,
-- not joined from users/workspaces at read time) so the log still reads
-- correctly even if the user or workspace it names is later renamed or
-- removed -- same reasoning as messages.author_name above. metadata holds
-- whatever event-specific detail is worth keeping (tool name, integration
-- type, action id) without needing a column per event type.
CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_name TEXT NOT NULL,
  summary TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_events_workspace_created_idx
  ON audit_events (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_workspace_type_idx
  ON audit_events (workspace_id, event_type);
