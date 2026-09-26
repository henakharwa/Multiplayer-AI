import { randomBytes } from "node:crypto";
import type {
  AuditActorType,
  AuditEvent,
  AuditEventType,
  ChatMessage,
  Conversation,
  WorkspaceNotification,
  GithubIntegrationConfig,
  IntegrationConfig,
  MessageRole,
  PendingAction,
  PendingActionStatus,
  SlackIntegrationConfig,
  User,
  WorkspaceMember,
  WorkspaceRole,
  Workspace,
} from "@mai-chat/shared-types";
import { getPool } from "./pool.js";
import { encryptToken, decryptToken, hashSessionToken } from "./crypto.js";

export { getPool, closePool } from "./pool.js";
export { encryptToken, decryptToken, hashSessionToken } from "./crypto.js";

function generateJoinCode(): string {
  // 6 url-safe chars, e.g. "a1b2c3" -- short enough to read aloud, long
  // enough (62^6 ~= 56 billion) that guessing a live workspace is not a
  // realistic Phase 1 threat model.
  return randomBytes(6).toString("base64url").slice(0, 6);
}

export class WorkspaceNameTakenError extends Error {
  constructor() {
    super("A workspace with this name already exists.");
    this.name = "WorkspaceNameTakenError";
  }
}

export function normalizeWorkspaceName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

export async function createWorkspace(name: string, createdByUserId?: string | null): Promise<Workspace> {
  const normalizedName = normalizeWorkspaceName(name);
  if (!normalizedName) throw new Error("workspace name is required");
  const client = await getPool().connect();
  // Collisions are astronomically unlikely at this scale, but retry once
  // rather than assume -- a UNIQUE constraint violation is real and cheap
  // to recover from.
  try {
    await client.query("BEGIN");
    // A transaction lock makes the case/whitespace-insensitive lookup safe
    // even when two browser tabs submit the same name at the same time.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [normalizedName.toLowerCase()]);
    const existing = await client.query(
      `SELECT id FROM workspaces
       WHERE lower(regexp_replace(btrim(name), '\\s+', ' ', 'g')) = $1
         AND created_by IS NOT DISTINCT FROM $2
       LIMIT 1`,
      [normalizedName.toLowerCase(), createdByUserId ?? null]
    );
    if (existing.rows[0]) throw new WorkspaceNameTakenError();
    for (let attempt = 0; attempt < 3; attempt++) {
      const joinCode = generateJoinCode();
      try {
        const result = await client.query(
          `INSERT INTO workspaces (name, join_code, created_by) VALUES ($1, $2, $3)
           RETURNING id, name, join_code, created_at`,
          [normalizedName, joinCode, createdByUserId ?? null]
        );
        await client.query("COMMIT");
        return toWorkspace(result.rows[0]);
      } catch (err: unknown) {
        const isUniqueViolation = typeof err === "object" && err !== null && "code" in err && (err as { code: string }).code === "23505";
        if (!isUniqueViolation || attempt === 2) throw err;
      }
    }
    throw new Error("failed to generate a unique join code");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Records that a signed-in user has been in a workspace -- NOT an access
// gate (see schema.sql's comment on the workspace_members table); called
// once per (workspace, user) the first time they open it, whether by
// creating it or following a join-code link. Idempotent.
// Returns true the first time this (workspace, user) pair is recorded,
// false on every call after that -- callers use this to log a "member
// joined" audit event exactly once per person, not on every reconnect
// (addWorkspaceMember itself runs on every WebSocket connection).
export async function addWorkspaceMember(workspaceId: string, userId: string, role: WorkspaceRole = "admin"): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, user_id) DO NOTHING
     RETURNING workspace_id`,
    [workspaceId, userId, role]
  );
  return (result.rowCount ?? 0) > 0;
}

const WORKSPACE_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function createWorkspaceInvitation(input: { workspaceId: string; email: string; invitedByUserId: string }): Promise<{ token: string; email: string; expiresAt: string }> {
  const email = normalizedEmail(input.email);
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + WORKSPACE_INVITATION_TTL_MS);
  await getPool().query(
    `INSERT INTO workspace_invitations (token_hash, workspace_id, email, invited_by_user_id, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [hashSessionToken(token), input.workspaceId, email, input.invitedByUserId, expiresAt]
  );
  return { token, email, expiresAt: expiresAt.toISOString() };
}

export async function deleteWorkspaceInvitation(token: string): Promise<void> {
  await getPool().query("DELETE FROM workspace_invitations WHERE token_hash = $1", [hashSessionToken(token)]);
}

export type AcceptWorkspaceInvitationResult =
  | { kind: "accepted"; workspaceId: string }
  | { kind: "invalid" }
  | { kind: "email_mismatch"; email: string };

export async function acceptWorkspaceInvitation(token: string, userId: string): Promise<AcceptWorkspaceInvitationResult> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const invite = await client.query(
      `SELECT workspace_id, email FROM workspace_invitations
       WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now() FOR UPDATE`,
      [hashSessionToken(token)]
    );
    if (!invite.rows[0]) { await client.query("COMMIT"); return { kind: "invalid" }; }
    const identity = await client.query(
      "SELECT email FROM user_email_identities WHERE user_id = $1 ORDER BY verified_at DESC LIMIT 1",
      [userId]
    );
    const invitedEmail = invite.rows[0].email as string;
    if (!identity.rows[0] || identity.rows[0].email !== invitedEmail) {
      await client.query("COMMIT");
      return { kind: "email_mismatch", email: invitedEmail };
    }
    const workspaceId = invite.rows[0].workspace_id as string;
    await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'editor')
       ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [workspaceId, userId]
    );
    await client.query("UPDATE workspace_invitations SET accepted_at = now() WHERE token_hash = $1", [hashSessionToken(token)]);
    await client.query("COMMIT");
    return { kind: "accepted", workspaceId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export async function getWorkspaceById(id: string): Promise<Workspace | null> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, name, join_code, created_at FROM workspaces WHERE id = $1`,
    [id]
  );
  return result.rows[0] ? toWorkspace(result.rows[0]) : null;
}

export async function getWorkspaceByJoinCode(joinCode: string): Promise<Workspace | null> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, name, join_code, created_at FROM workspaces WHERE join_code = $1`,
    [joinCode]
  );
  return result.rows[0] ? toWorkspace(result.rows[0]) : null;
}

function toWorkspace(row: {
  id: string;
  name: string;
  join_code: string;
  created_at: Date;
}): Workspace {
  return {
    id: row.id,
    name: row.name,
    joinCode: row.join_code,
    createdAt: row.created_at.toISOString(),
  };
}

const MESSAGE_COLUMNS = "id, workspace_id, conversation_id, role, author_name, user_id, content, created_at, mentions_agent, mentioned_user_ids";

const CONVERSATION_COLUMNS = "id, workspace_id, title, created_by_user_id, created_at, updated_at";

/** A deliberately small database readiness probe for the deployment health endpoint. */
export async function checkDatabaseHealth(): Promise<void> {
  await getPool().query("SELECT 1");
}

export async function createConversation(input: { workspaceId: string; title?: string; createdByUserId?: string | null }): Promise<Conversation> {
  const result = await getPool().query(
    `INSERT INTO conversations (workspace_id, title, created_by_user_id) VALUES ($1, $2, $3)
     RETURNING ${CONVERSATION_COLUMNS}`,
    [input.workspaceId, input.title?.trim().slice(0, 100) || "New conversation", input.createdByUserId ?? null]
  );
  return toConversation(result.rows[0]);
}

export async function listConversations(workspaceId: string): Promise<Conversation[]> {
  const result = await getPool().query(
    `SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE workspace_id = $1 ORDER BY updated_at DESC, created_at DESC`,
    [workspaceId]
  );
  return result.rows.map(toConversation);
}

export async function getConversation(workspaceId: string, id: string): Promise<Conversation | null> {
  const result = await getPool().query(
    `SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE workspace_id = $1 AND id = $2`, [workspaceId, id]
  );
  return result.rows[0] ? toConversation(result.rows[0]) : null;
}

export async function deleteConversation(workspaceId: string, id: string): Promise<boolean> {
  const result = await getPool().query(
    `DELETE FROM conversations WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, id]
  );
  return result.rowCount === 1;
}

function toConversation(row: { id: string; workspace_id: string; title: string; created_by_user_id: string | null; created_at: Date; updated_at: Date }): Conversation {
  return { id: row.id, workspaceId: row.workspace_id, title: row.title, createdByUserId: row.created_by_user_id, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}

export async function insertMessage(input: {
  workspaceId: string;
  conversationId: string;
  role: MessageRole;
  authorName: string;
  content: string;
  // Set for role='user' messages from a signed-in author; left unset for
  // 'agent'/'system' messages (which have no user behind them) -- see
  // schema.sql's comment on messages.user_id for why this exists
  // alongside author_name rather than replacing it.
  userId?: string;
  // @-mention / handoff mechanics -- see mentions_agent's schema.sql
  // comment and services/chat-server/src/mentions.ts, which computes
  // both of these for a 'user' message before calling this. Left at
  // their defaults (mentionsAgent true, no mentioned users) for
  // 'agent'/'system' messages, which never parse mentions.
  mentionsAgent?: boolean;
  mentionedUserIds?: string[];
}): Promise<ChatMessage> {
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO messages (workspace_id, conversation_id, role, author_name, content, user_id, mentions_agent, mentioned_user_ids)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${MESSAGE_COLUMNS}`,
    [
      input.workspaceId,
      input.conversationId,
      input.role,
      input.authorName,
      input.content,
      input.userId ?? null,
      input.mentionsAgent ?? true,
      input.mentionedUserIds ?? [],
    ]
  );
  await pool.query(
    `UPDATE conversations SET updated_at = now(), title = CASE WHEN title = 'New conversation' AND $2 = 'user' THEN left($3, 80) ELSE title END WHERE id = $1`,
    [input.conversationId, input.role, input.content]
  );
  return toMessage(result.rows[0]);
}

export async function listMessages(workspaceId: string, conversationId: string, limit = 200): Promise<ChatMessage[]> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT ${MESSAGE_COLUMNS}
     FROM messages
     WHERE workspace_id = $1 AND conversation_id = $2
     ORDER BY created_at ASC
     LIMIT $3`,
    [workspaceId, conversationId, limit]
  );
  return result.rows.map(toMessage);
}

function toMessage(row: {
  id: string;
  workspace_id: string;
  conversation_id: string;
  role: MessageRole;
  author_name: string;
  user_id: string | null;
  content: string;
  created_at: Date;
  mentions_agent: boolean;
  mentioned_user_ids: string[];
}): ChatMessage {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    role: row.role,
    authorName: row.author_name,
    ...(row.user_id ? { authorUserId: row.user_id } : {}),
    content: row.content,
    createdAt: row.created_at.toISOString(),
    mentionsAgent: row.mentions_agent,
    mentionedUserIds: row.mentioned_user_ids ?? [],
  };
}

// Real workspace membership (packages/db's workspace_members table),
// unlike RoomRegistry.participants() in services/chat-server/src/
// rooms.ts, which only lists who's currently connected. @-mention
// matching needs this broader list -- handing a task to a teammate who's
// not online right now should still resolve their @mention correctly, so
// they see it directed at them once they're back. Ordered by join time,
// most senior member first, since there's no other ordering that means
// anything here yet.
export async function listWorkspaceMembers(workspaceId: string): Promise<User[]> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT u.id, u.github_id, u.username, u.display_name, u.avatar_url, u.created_at,
            pc.email, pc.email_verified_at
     FROM workspace_members wm
     JOIN users u ON u.id = wm.user_id
     LEFT JOIN password_credentials pc ON pc.user_id = u.id
     WHERE wm.workspace_id = $1
     ORDER BY wm.joined_at ASC`,
    [workspaceId]
  );
  return result.rows.map(toUser);
}

export async function listWorkspaceMembersWithRoles(workspaceId: string): Promise<WorkspaceMember[]> {
  const result = await getPool().query(
    `SELECT u.id, u.github_id, u.username, u.display_name, u.avatar_url, u.created_at, pc.email, pc.email_verified_at, wm.role, wm.joined_at
     FROM workspace_members wm JOIN users u ON u.id = wm.user_id LEFT JOIN password_credentials pc ON pc.user_id = u.id
     WHERE wm.workspace_id = $1 ORDER BY wm.joined_at ASC`, [workspaceId]
  );
  return result.rows.map((row) => ({ ...toUser(row), role: row.role as WorkspaceRole, joinedAt: row.joined_at.toISOString() }));
}

export async function getWorkspaceRole(workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
  const result = await getPool().query(`SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, userId]);
  return (result.rows[0]?.role as WorkspaceRole | undefined) ?? null;
}

export async function setWorkspaceMemberRole(workspaceId: string, userId: string, role: WorkspaceRole): Promise<void> {
  await getPool().query(`UPDATE workspace_members SET role = $3 WHERE workspace_id = $1 AND user_id = $2`, [workspaceId, userId, role]);
}

export async function notifyWorkspaceMembers(input: { workspaceId: string; conversationId?: string | null; kind: WorkspaceNotification["kind"]; text: string; excludeUserIds?: string[] }): Promise<void> {
  const pool = getPool();
  await pool.query(
    `INSERT INTO workspace_notifications (workspace_id, conversation_id, user_id, kind, text)
     SELECT $1, $2, wm.user_id, $3, $4 FROM workspace_members wm
     WHERE wm.workspace_id = $1 AND NOT (wm.user_id = ANY($5::uuid[]))`,
    [input.workspaceId, input.conversationId ?? null, input.kind, input.text, input.excludeUserIds ?? []]
  );
}

export async function listNotifications(userId: string, limit = 30): Promise<WorkspaceNotification[]> {
  const result = await getPool().query(
    `SELECT id, workspace_id, conversation_id, kind, text, created_at, read_at FROM workspace_notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return result.rows.map((row) => ({ id: row.id, workspaceId: row.workspace_id, conversationId: row.conversation_id, kind: row.kind, text: row.text, createdAt: row.created_at.toISOString(), readAt: row.read_at ? row.read_at.toISOString() : null }));
}

export async function markNotificationsRead(userId: string, workspaceId: string): Promise<void> {
  await getPool().query(`UPDATE workspace_notifications SET read_at = now() WHERE user_id = $1 AND workspace_id = $2 AND read_at IS NULL`, [userId, workspaceId]);
}

export async function upsertGithubIntegration(input: {
  workspaceId: string;
  owner: string;
  repo: string;
  token: string;
}): Promise<GithubIntegrationConfig> {
  const pool = getPool();
  const encrypted = encryptToken(input.token);
  const result = await pool.query(
    `INSERT INTO integrations (workspace_id, type, owner, repo, encrypted_token)
     VALUES ($1, 'github', $2, $3, $4)
     ON CONFLICT (workspace_id, type)
     DO UPDATE SET owner = $2, repo = $3, encrypted_token = $4, connected_at = now()
     RETURNING workspace_id, connected_at`,
    [input.workspaceId, input.owner, input.repo, encrypted]
  );
  return {
    type: "github",
    workspaceId: result.rows[0].workspace_id,
    owner: input.owner,
    repo: input.repo,
    connected: true,
    connectedAt: result.rows[0].connected_at.toISOString(),
  };
}

// GitHub OAuth login (services/chat-server/src/github-oauth.ts) lands here
// first, before any repo is chosen -- owner/repo are left as whatever they
// already were (NULL on a first-ever connect), never overwritten with a
// guess. Distinct from upsertGithubIntegration, which is the pasted-token
// flow and always sets owner+repo+token together in one step.
export async function saveGithubOAuthToken(input: { workspaceId: string; token: string }): Promise<void> {
  const pool = getPool();
  const encrypted = encryptToken(input.token);
  await pool.query(
    `INSERT INTO integrations (workspace_id, type, encrypted_token)
     VALUES ($1, 'github', $2)
     ON CONFLICT (workspace_id, type)
     DO UPDATE SET encrypted_token = $2, connected_at = now()`,
    [input.workspaceId, encrypted]
  );
}

// Attaches/changes which repo a workspace's already-connected GitHub token
// should be used against (the repo-picker step after OAuth login, or
// "change repository" later). Returns null if there's no GitHub
// integration row yet for this workspace -- the caller must have already
// connected a token (OAuth or pasted) before a repo can be chosen.
export async function setGithubRepo(input: { workspaceId: string; owner: string; repo: string }): Promise<GithubIntegrationConfig | null> {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE integrations SET owner = $2, repo = $3
     WHERE workspace_id = $1 AND type = 'github'
     RETURNING workspace_id, owner, repo, connected_at`,
    [input.workspaceId, input.owner, input.repo]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    type: "github",
    workspaceId: row.workspace_id,
    owner: row.owner,
    repo: row.repo,
    connected: true,
    connectedAt: row.connected_at.toISOString(),
  };
}

export async function upsertSlackIntegration(input: {
  workspaceId: string;
  teamName: string;
  token: string;
}): Promise<SlackIntegrationConfig> {
  const pool = getPool();
  const encrypted = encryptToken(input.token);
  const result = await pool.query(
    `INSERT INTO integrations (workspace_id, type, team_name, encrypted_token)
     VALUES ($1, 'slack', $2, $3)
     ON CONFLICT (workspace_id, type)
     DO UPDATE SET team_name = $2, encrypted_token = $3, connected_at = now()
     RETURNING workspace_id, connected_at`,
    [input.workspaceId, input.teamName, encrypted]
  );
  return {
    type: "slack",
    workspaceId: result.rows[0].workspace_id,
    teamName: input.teamName,
    connected: true,
    connectedAt: result.rows[0].connected_at.toISOString(),
  };
}

export async function upsertRemoteMcpIntegration(input: { workspaceId: string; type: "linear" | "notion" | "figma"; endpoint: string; token: string; accountName?: string }): Promise<import("@mai-chat/shared-types").RemoteMcpIntegrationConfig> {
  const result = await getPool().query(
    `INSERT INTO integrations (workspace_id, type, owner, team_name, encrypted_token) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (workspace_id, type) DO UPDATE SET owner = $3, team_name = $4, encrypted_token = $5, connected_at = now()
     RETURNING workspace_id, type, owner, team_name, connected_at`,
    [input.workspaceId, input.type, input.endpoint, input.accountName ?? null, encryptToken(input.token)]
  );
  const row = result.rows[0];
  return { type: row.type, workspaceId: row.workspace_id, endpoint: row.owner, accountName: row.team_name ?? undefined, connected: true, connectedAt: row.connected_at.toISOString() };
}

// Client-safe listing -- never includes the decrypted token.
export async function listIntegrations(workspaceId: string): Promise<IntegrationConfig[]> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT type, owner, repo, team_name, connected_at
     FROM integrations WHERE workspace_id = $1`,
    [workspaceId]
  );
  return result.rows.map((row): IntegrationConfig => {
    if (row.type === "github") {
      return {
        type: "github",
        workspaceId,
        owner: row.owner ?? undefined,
        repo: row.repo ?? undefined,
        connected: true,
        connectedAt: row.connected_at.toISOString(),
      };
    }
    if (row.type === "slack") return {
      type: "slack",
      workspaceId,
      teamName: row.team_name,
      connected: true,
      connectedAt: row.connected_at.toISOString(),
    };
    return {
      type: row.type,
      workspaceId,
      endpoint: row.owner,
      accountName: row.team_name ?? undefined,
      connected: true,
      connectedAt: row.connected_at.toISOString(),
    };
  });
}

// Server-side only (the agent's tool implementations) -- decrypts the real
// token. Never called from an HTTP route that returns straight to a client.
export async function getIntegrationCredential(
  workspaceId: string,
  type: "github" | "slack" | "linear" | "notion" | "figma"
): Promise<{ token: string; owner?: string; repo?: string; teamName?: string } | null> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT owner, repo, team_name, encrypted_token
     FROM integrations WHERE workspace_id = $1 AND type = $2`,
    [workspaceId, type]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    token: decryptToken(row.encrypted_token),
    owner: row.owner ?? undefined,
    repo: row.repo ?? undefined,
    teamName: row.team_name ?? undefined,
  };
}

export async function deleteIntegration(workspaceId: string, type: "github" | "slack" | "linear" | "notion" | "figma"): Promise<boolean> {
  const result = await getPool().query(`DELETE FROM integrations WHERE workspace_id = $1 AND type = $2`, [workspaceId, type]);
  return (result.rowCount ?? 0) > 0;
}


// -- Pending GitHub write-action confirmation -------------------------
// See packages/shared-types PendingAction doc comment and
// services/chat-server/src/actions.ts for the full flow this backs.

const PENDING_ACTION_COLUMNS =
  "id, workspace_id, conversation_id, tool_name, description, preview, args, status, result, created_at, resolved_at, requested_by_user_id, requested_by_name, agent_kind";

export async function createPendingAction(input: {
  workspaceId: string;
  conversationId: string;
  toolName: string;
  description: string;
  preview?: string | null;
  args: Record<string, unknown>;
  // Whoever's chat message triggered the agent turn that proposed this --
  // see schema.sql's comment on these columns. Omitted when unknown.
  requestedByUserId?: string | null;
  requestedByName?: string | null;
  agentKind?: PendingAction["agentKind"];
}): Promise<PendingAction> {
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO pending_actions (workspace_id, conversation_id, tool_name, description, preview, args, requested_by_user_id, requested_by_name, agent_kind)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${PENDING_ACTION_COLUMNS}`,
    [
      input.workspaceId,
      input.conversationId,
      input.toolName,
      input.description,
      input.preview ?? null,
      JSON.stringify(input.args),
      input.requestedByUserId ?? null,
      input.requestedByName ?? null,
      input.agentKind ?? null,
    ]
  );
  return toPendingAction(result.rows[0]);
}

export async function getPendingAction(workspaceId: string, id: string): Promise<PendingAction | null> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT ${PENDING_ACTION_COLUMNS} FROM pending_actions WHERE workspace_id = $1 AND id = $2`,
    [workspaceId, id]
  );
  return result.rows[0] ? toPendingAction(result.rows[0]) : null;
}

// onlyPending=true (the default the UI uses on load) hides the
// already-resolved history so a returning visitor only sees actions that
// still need a decision.
export async function listPendingActions(workspaceId: string, conversationId: string, onlyPending = false): Promise<PendingAction[]> {
  const pool = getPool();
  const result = await pool.query(
    onlyPending
      ? `SELECT ${PENDING_ACTION_COLUMNS} FROM pending_actions WHERE workspace_id = $1 AND conversation_id = $2 AND status = 'pending' ORDER BY created_at ASC`
      : `SELECT ${PENDING_ACTION_COLUMNS} FROM pending_actions WHERE workspace_id = $1 AND conversation_id = $2 ORDER BY created_at ASC`,
    [workspaceId, conversationId]
  );
  return result.rows.map(toPendingAction);
}

export async function resolvePendingAction(input: {
  workspaceId: string;
  id: string;
  status: Exclude<PendingActionStatus, "pending">;
  result?: string;
}): Promise<PendingAction | null> {
  const pool = getPool();
  const result = await pool.query(
    `UPDATE pending_actions SET status = $3, result = $4, resolved_at = now()
     WHERE workspace_id = $1 AND id = $2
     RETURNING ${PENDING_ACTION_COLUMNS}`,
    [input.workspaceId, input.id, input.status, input.result ?? null]
  );
  return result.rows[0] ? toPendingAction(result.rows[0]) : null;
}

function toPendingAction(row: {
  id: string;
  workspace_id: string;
  conversation_id: string;
  tool_name: string;
  description: string;
  preview: string | null;
  args: Record<string, unknown>;
  status: PendingActionStatus;
  result: string | null;
  created_at: Date;
  resolved_at: Date | null;
  requested_by_user_id: string | null;
  requested_by_name: string | null;
  agent_kind: PendingAction["agentKind"];
}): PendingAction {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    toolName: row.tool_name,
    description: row.description,
    preview: row.preview ?? null,
    args: row.args,
    status: row.status,
    result: row.result ?? null,
    createdAt: row.created_at.toISOString(),
    resolvedAt: row.resolved_at ? row.resolved_at.toISOString() : null,
    requestedByUserId: row.requested_by_user_id ?? null,
    requestedByName: row.requested_by_name ?? null,
    agentKind: row.agent_kind ?? null,
  };
}

// -- Action audit trail (docs/spec.md Phase 2: "who asked for what, what
// the agent did, when") -- see schema.sql's comment on audit_events and
// services/chat-server/src/audit.ts for where these get written from. -----

export async function recordAuditEvent(input: {
  workspaceId: string;
  eventType: AuditEventType;
  actorType: AuditActorType;
  actorUserId?: string | null;
  actorName: string;
  summary: string;
  metadata?: Record<string, unknown>;
}): Promise<AuditEvent> {
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO audit_events (workspace_id, event_type, actor_type, actor_user_id, actor_name, summary, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, workspace_id, event_type, actor_type, actor_user_id, actor_name, summary, metadata, created_at`,
    [
      input.workspaceId,
      input.eventType,
      input.actorType,
      input.actorUserId ?? null,
      input.actorName,
      input.summary,
      JSON.stringify(input.metadata ?? {}),
    ]
  );
  return toAuditEvent(result.rows[0]);
}

// Keyset-paginated (before=createdAt of the oldest row already shown)
// rather than offset -- cheap on an indexed, append-only, DESC-ordered
// table, and stable under concurrent inserts the way an OFFSET isn't.
// eventType/search are optional filters: eventType is an exact match
// against the same union the frontend's dropdown offers, search is a
// case-insensitive substring match against actor_name and summary (a
// plain ILIKE is plenty at this project's scale -- see the same
// "deliberately simple for Phase 1/2" reasoning used elsewhere here).
export async function listAuditEvents(
  workspaceId: string,
  options: { eventType?: AuditEventType; search?: string; before?: string; limit?: number } = {}
): Promise<AuditEvent[]> {
  const pool = getPool();
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const conditions = ["workspace_id = $1"];
  const params: unknown[] = [workspaceId];
  if (options.eventType) {
    params.push(options.eventType);
    conditions.push(`event_type = $${params.length}`);
  }
  if (options.search) {
    params.push(`%${options.search}%`);
    conditions.push(`(actor_name ILIKE $${params.length} OR summary ILIKE $${params.length})`);
  }
  if (options.before) {
    params.push(options.before);
    conditions.push(`created_at < $${params.length}`);
  }
  params.push(limit);
  const result = await pool.query(
    `SELECT id, workspace_id, event_type, actor_type, actor_user_id, actor_name, summary, metadata, created_at
     FROM audit_events WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC LIMIT $${params.length}`,
    params
  );
  return result.rows.map(toAuditEvent);
}

function toAuditEvent(row: {
  id: string;
  workspace_id: string;
  event_type: AuditEventType;
  actor_type: AuditActorType;
  actor_user_id: string | null;
  actor_name: string;
  summary: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}): AuditEvent {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    eventType: row.event_type,
    actorType: row.actor_type,
    actorUserId: row.actor_user_id ?? null,
    actorName: row.actor_name,
    summary: row.summary,
    metadata: row.metadata ?? {},
    createdAt: row.created_at.toISOString(),
  };
}

// -- User accounts + sessions ("Sign in with GitHub", see
// services/chat-server/src/auth.ts) -----------------------------------

function toUser(row: {
  id: string;
  github_id: string | null;
  username: string;
  display_name: string;
  avatar_url: string | null;
  created_at: Date;
  // Only present on queries that LEFT JOIN password_credentials -- undefined
  // (not null) means "this query didn't ask", null means "asked, no
  // password_credentials row" (a GitHub/Google account).
  email?: string | null;
  email_verified_at?: Date | null;
}): User {
  return {
    id: row.id,
    githubId: row.github_id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    createdAt: row.created_at.toISOString(),
    ...(row.email != null ? { email: row.email, emailVerified: row.email_verified_at != null } : {}),
  };
}

// A verified provider email is the shared account key. The provider's stable
// subject remains the credential key; this mapping only tells us which user
// should receive a newly-seen provider credential.
function normalizedEmail(email: string): string { return email.trim().toLowerCase(); }

async function findOrCreateUserForVerifiedEmail(input: {
  providerColumn: "github_id" | "google_id";
  providerId: string;
  email: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
}): Promise<User> {
  const client = await getPool().connect();
  const email = normalizedEmail(input.email);
  try {
    await client.query("BEGIN");
    // Serialize first-time linking for one email so two OAuth callbacks
    // cannot create separate accounts before either records its identity.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [email]);
    const existingProvider = await client.query(
      `SELECT id FROM users WHERE ${input.providerColumn} = $1`, [input.providerId]
    );
    const existingEmail = existingProvider.rows[0]
      ? null
      : await client.query(`SELECT user_id FROM user_email_identities WHERE email = $1`, [email]);
    const userId = existingProvider.rows[0]?.id ?? existingEmail?.rows[0]?.user_id;
    let result;
    if (userId) {
      result = await client.query(
        `UPDATE users SET ${input.providerColumn} = $2, username = $3, display_name = $4, avatar_url = $5
         WHERE id = $1 RETURNING id, github_id, username, display_name, avatar_url, created_at`,
        [userId, input.providerId, input.username, input.displayName, input.avatarUrl ?? null]
      );
    } else {
      result = await client.query(
        `INSERT INTO users (${input.providerColumn}, username, display_name, avatar_url) VALUES ($1, $2, $3, $4)
         RETURNING id, github_id, username, display_name, avatar_url, created_at`,
        [input.providerId, input.username, input.displayName, input.avatarUrl ?? null]
      );
    }
    await client.query(
      `INSERT INTO user_email_identities (email, user_id) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET user_id = EXCLUDED.user_id`,
      [email, result.rows[0].id]
    );
    await client.query("COMMIT");
    return { ...toUser(result.rows[0]), email, emailVerified: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export async function upsertUserFromGithub(input: {
  githubId: string;
  email?: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
}): Promise<User> {
  // Compatibility for existing test fixtures and legacy callers. Production
  // OAuth always supplies a GitHub-verified email and takes the linking path.
  if (!input.email) {
    const result = await getPool().query(
      `INSERT INTO users (github_id, username, display_name, avatar_url) VALUES ($1, $2, $3, $4)
       ON CONFLICT (github_id) DO UPDATE SET username = $2, display_name = $3, avatar_url = $4
       RETURNING id, github_id, username, display_name, avatar_url, created_at`,
      [input.githubId, input.username, input.displayName, input.avatarUrl ?? null]
    );
    return toUser(result.rows[0]);
  }
  return findOrCreateUserForVerifiedEmail({ providerColumn: "github_id", providerId: input.githubId, email: input.email, username: input.username, displayName: input.displayName, avatarUrl: input.avatarUrl });
}

export async function getUserById(id: string): Promise<User | null> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT u.id, u.github_id, u.username, u.display_name, u.avatar_url, u.created_at,
            pc.email, pc.email_verified_at
     FROM users u LEFT JOIN password_credentials pc ON pc.user_id = u.id
     WHERE u.id = $1`,
    [id]
  );
  return result.rows[0] ? toUser(result.rows[0]) : null;
}

export async function createPasswordUser(input: { email: string; displayName: string; passwordHash: string; emailVerified?: boolean }): Promise<User> {
  const client = await getPool().connect();
  const email = normalizedEmail(input.email);
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [email]);
    const existing = await client.query(`SELECT user_id FROM user_email_identities WHERE email = $1`, [email]);
    const result = existing.rows[0]
      ? await client.query(
        `SELECT id, github_id, username, display_name, avatar_url, created_at FROM users WHERE id = $1`,
        [existing.rows[0].user_id]
      )
      : await client.query(
        `INSERT INTO users (username, display_name) VALUES ($1, $2)
         RETURNING id, github_id, username, display_name, avatar_url, created_at`,
        [email, input.displayName]
      );
    await client.query(
      `INSERT INTO password_credentials (user_id, email, password_hash, email_verified_at)
       VALUES ($1, $2, $3, CASE WHEN $4 THEN now() ELSE NULL END)`,
      [result.rows[0].id, email, input.passwordHash, input.emailVerified ?? false]
    );
    if (input.emailVerified) await client.query(
      `INSERT INTO user_email_identities (email, user_id) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET user_id = EXCLUDED.user_id`,
      [email, result.rows[0].id]
    );
    await client.query("COMMIT");
    return { ...toUser(result.rows[0]), email, emailVerified: input.emailVerified ?? false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export async function getPasswordCredential(email: string): Promise<{ userId: string; passwordHash: string } | null> {
  const result = await getPool().query(`SELECT user_id, password_hash FROM password_credentials WHERE email = $1`, [normalizedEmail(email)]);
  const row = result.rows[0];
  return row ? { userId: row.user_id, passwordHash: row.password_hash } : null;
}

export async function upsertUserFromGoogle(input: { googleId: string; email: string; displayName: string; avatarUrl?: string }): Promise<User> {
  return findOrCreateUserForVerifiedEmail({ providerColumn: "google_id", providerId: input.googleId, email: input.email, username: input.email, displayName: input.displayName, avatarUrl: input.avatarUrl });
}

// Mints a new session for a just-authenticated user and returns the RAW
// token -- this is the only place the raw value ever exists outside the
// browser's own cookie; only its hash (hashSessionToken, src/crypto.ts)
// is written to the sessions table.
export async function createSession(userId: string, ttlMs: number): Promise<{ token: string; expiresAt: string }> {
  const pool = getPool();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlMs);
  await pool.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
    [hashSessionToken(token), userId, expiresAt]
  );
  return { token, expiresAt: expiresAt.toISOString() };
}

// Looks up who a raw session-cookie token belongs to, or null if it
// doesn't match a live (unexpired) session -- an expired row is treated
// as absent rather than actively deleted here, since a request handler
// has no business doing cleanup writes on the hot path; nothing currently
// prunes expired rows, which is fine at this project's scale (see the
// same "deliberately simple for Phase 1/2" reasoning used elsewhere in
// this package) but would be worth a periodic sweep at real scale.
export async function getUserBySessionToken(token: string): Promise<User | null> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT u.id, u.github_id, u.username, u.display_name, u.avatar_url, u.created_at,
            pc.email, pc.email_verified_at
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN password_credentials pc ON pc.user_id = u.id
     WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashSessionToken(token)]
  );
  return result.rows[0] ? toUser(result.rows[0]) : null;
}

// Sign-out -- deletes the one session this token names, not every session
// for the user (a sign-out on one device/browser shouldn't kill sessions
// elsewhere).
export async function deleteSession(token: string): Promise<void> {
  const pool = getPool();
  await pool.query(`DELETE FROM sessions WHERE token_hash = $1`, [hashSessionToken(token)]);
}

// -- Email verification -------------------------------------------------
// Only meaningful for an email+password account -- see schema.sql's
// comment on password_credentials.email_verified_at.

const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24h -- just an email click, generous is fine.

export async function createEmailVerificationToken(userId: string, email: string): Promise<string> {
  const pool = getPool();
  const token = randomBytes(32).toString("base64url");
  await pool.query(
    `INSERT INTO email_verification_tokens (token_hash, user_id, email, expires_at) VALUES ($1, $2, $3, $4)`,
    [hashSessionToken(token), userId, email.toLowerCase().trim(), new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS)]
  );
  return token;
}

// Single-use: the token row is deleted whether or not it turns out to be
// valid. Returns the now-verified user, or null if the token is
// unknown/expired.
export async function verifyEmailToken(rawToken: string): Promise<User | null> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(
      `DELETE FROM email_verification_tokens WHERE token_hash = $1 AND expires_at > now() RETURNING user_id, email`,
      [hashSessionToken(rawToken)]
    );
    if (found.rows.length === 0) {
      await client.query("ROLLBACK");
      return null;
    }
    const { user_id: userId, email } = found.rows[0] as { user_id: string; email: string };
    // Only marks it verified if the account's current email still
    // matches what this token was issued for -- there's no "change
    // email" feature yet so this can't currently diverge, but keeps the
    // invariant honest if that ever changes.
    await client.query(
      `UPDATE password_credentials SET email_verified_at = now() WHERE user_id = $1 AND email = $2`,
      [userId, email]
    );
    await client.query("COMMIT");
    return getUserById(userId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getPasswordCredentialByUserId(userId: string): Promise<{ email: string; verified: boolean } | null> {
  const result = await getPool().query(
    `SELECT email, email_verified_at FROM password_credentials WHERE user_id = $1`,
    [userId]
  );
  const row = result.rows[0];
  return row ? { email: row.email, verified: row.email_verified_at !== null } : null;
}

// -- Password reset -------------------------------------------------------

const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1h -- tighter than email verification, since this changes a credential.

// Always safe to call for an unknown email -- returns null rather than
// throwing, so the route layer can give the same generic response either
// way (see password-reset.ts's account-enumeration-safety comment).
export async function createPasswordResetToken(email: string): Promise<{ token: string; userId: string } | null> {
  const credential = await getPasswordCredential(email);
  if (!credential) return null;
  const token = randomBytes(32).toString("base64url");
  await getPool().query(
    `INSERT INTO password_reset_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, $3)`,
    [hashSessionToken(token), credential.userId, new Date(Date.now() + PASSWORD_RESET_TTL_MS)]
  );
  return { token, userId: credential.userId };
}

// Single-use: a valid, unexpired, not-yet-used token is marked used (not
// deleted -- used_at is what makes a replay of the same link fail
// closed) and its user id returned; anything else returns null.
export async function consumePasswordResetToken(rawToken: string): Promise<string | null> {
  const result = await getPool().query(
    `UPDATE password_reset_tokens SET used_at = now()
     WHERE token_hash = $1 AND expires_at > now() AND used_at IS NULL
     RETURNING user_id`,
    [hashSessionToken(rawToken)]
  );
  return result.rows[0]?.user_id ?? null;
}

export async function updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
  await getPool().query(`UPDATE password_credentials SET password_hash = $1 WHERE user_id = $2`, [passwordHash, userId]);
}

// Signs the account out everywhere -- called right after a successful
// password reset so a session an attacker already had open (e.g. from
// the leaked old password) doesn't ride out its remaining 30-day expiry.
export async function deleteSessionsForUser(userId: string): Promise<void> {
  await getPool().query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
}
