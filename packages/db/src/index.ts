import { randomBytes, randomUUID } from "node:crypto";
import type {
  AuditActorType,
  AuditEvent,
  AuditEventType,
  ChatMessage,
  Conversation,
  WorkspaceInvitation,
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
  WorkspacePermissionPolicy,
  WorkspacePermissions,
  WorkspaceAgent,
  WorkspaceAgentVersion,
  WorkspaceWorkflow,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowTrigger,
  WorkspaceTask,
  WorkspaceTaskStatus,
  WorkspaceMemory,
  WorkspaceMemoryKind,
  WorkspaceArtifact,
  WorkspaceArtifactComment,
  WorkspaceArtifactStatus,
  WorkspaceArtifactType,
  WorkspaceArtifactVersion,
  WorkspaceArtifactDashboard,
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
  workspace: Workspace;
  constructor(workspace: Workspace) {
    super("A workspace with this name already exists.");
    this.name = "WorkspaceNameTakenError";
    this.workspace = workspace;
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
      `SELECT id, name, join_code, created_at FROM workspaces
       WHERE lower(regexp_replace(btrim(name), '\\s+', ' ', 'g')) = $1
         AND created_by IS NOT DISTINCT FROM $2
       LIMIT 1`,
      [normalizedName.toLowerCase(), createdByUserId ?? null]
    );
    if (existing.rows[0]) throw new WorkspaceNameTakenError(toWorkspace(existing.rows[0]));
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

export async function isWorkspaceMemberEmail(workspaceId: string, email: string): Promise<boolean> {
  const result = await getPool().query(
    `SELECT 1 FROM workspace_members wm JOIN user_email_identities ei ON ei.user_id = wm.user_id
     WHERE wm.workspace_id = $1 AND ei.email = $2 LIMIT 1`,
    [workspaceId, normalizedEmail(email)]
  );
  return Boolean(result.rows[0]);
}

export async function createWorkspaceInvitation(input: { workspaceId: string; email: string; invitedByUserId: string; role: WorkspaceRole }): Promise<{ token: string; email: string; role: WorkspaceRole; expiresAt: string }> {
  const email = normalizedEmail(input.email);
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + WORKSPACE_INVITATION_TTL_MS);
  await getPool().query(
    `INSERT INTO workspace_invitations (token_hash, workspace_id, email, invited_by_user_id, role, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [hashSessionToken(token), input.workspaceId, email, input.invitedByUserId, input.role, expiresAt]
  );
  return { token, email, role: input.role, expiresAt: expiresAt.toISOString() };
}

export async function deleteWorkspaceInvitation(token: string): Promise<void> {
  await getPool().query("DELETE FROM workspace_invitations WHERE token_hash = $1", [hashSessionToken(token)]);
}

export async function listWorkspaceInvitations(workspaceId: string): Promise<WorkspaceInvitation[]> {
  const result = await getPool().query(
    `SELECT token_hash, email, role, created_at, expires_at FROM workspace_invitations
     WHERE workspace_id = $1 AND accepted_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
    [workspaceId]
  );
  return result.rows.map((row) => ({ id: row.token_hash, email: row.email, role: row.role as WorkspaceRole, createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString() }));
}

export async function revokeWorkspaceInvitation(workspaceId: string, invitationId: string): Promise<boolean> {
  const result = await getPool().query(
    "DELETE FROM workspace_invitations WHERE workspace_id = $1 AND token_hash = $2 AND accepted_at IS NULL",
    [workspaceId, invitationId]
  );
  return result.rowCount === 1;
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
      `SELECT workspace_id, email, role FROM workspace_invitations
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
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [workspaceId, userId, invite.rows[0].role]
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

// A user's home screen only needs workspaces they are already a recorded
// member of; it must not become a directory of every workspace in the app.
export async function listWorkspacesForUser(userId: string): Promise<Workspace[]> {
  const result = await getPool().query(
    `SELECT w.id, w.name, w.join_code, w.created_at
     FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
     WHERE wm.user_id = $1 ORDER BY w.created_at DESC`,
    [userId]
  );
  return result.rows.map(toWorkspace);
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

const CONVERSATION_COLUMNS = "id, workspace_id, title, created_by_user_id, created_at, updated_at, pinned_at, archived_at";

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
    `SELECT ${CONVERSATION_COLUMNS} FROM conversations WHERE workspace_id = $1 ORDER BY archived_at NULLS FIRST, pinned_at DESC NULLS LAST, updated_at DESC, created_at DESC`,
    [workspaceId]
  );
  return result.rows.map(toConversation);
}

export async function renameConversation(workspaceId: string, id: string, title: string): Promise<Conversation | null> {
  const result = await getPool().query(
    `UPDATE conversations SET title = $3, updated_at = now() WHERE workspace_id = $1 AND id = $2 RETURNING ${CONVERSATION_COLUMNS}`,
    [workspaceId, id, title.trim().slice(0, 100)]
  );
  return result.rows[0] ? toConversation(result.rows[0]) : null;
}

export async function setConversationPinned(workspaceId: string, id: string, pinned: boolean): Promise<Conversation | null> {
  const result = await getPool().query(
    `UPDATE conversations SET pinned_at = CASE WHEN $3 THEN now() ELSE NULL END WHERE workspace_id = $1 AND id = $2 RETURNING ${CONVERSATION_COLUMNS}`,
    [workspaceId, id, pinned]
  );
  return result.rows[0] ? toConversation(result.rows[0]) : null;
}

export async function setConversationArchived(workspaceId: string, id: string, archived: boolean): Promise<Conversation | null> {
  const result = await getPool().query(
    `UPDATE conversations SET archived_at = CASE WHEN $3 THEN now() ELSE NULL END WHERE workspace_id = $1 AND id = $2 RETURNING ${CONVERSATION_COLUMNS}`,
    [workspaceId, id, archived]
  );
  return result.rows[0] ? toConversation(result.rows[0]) : null;
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

function toConversation(row: { id: string; workspace_id: string; title: string; created_by_user_id: string | null; created_at: Date; updated_at: Date; pinned_at: Date | null; archived_at: Date | null }): Conversation {
  return { id: row.id, workspaceId: row.workspace_id, title: row.title, createdByUserId: row.created_by_user_id, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), pinnedAt: row.pinned_at ? row.pinned_at.toISOString() : null, archivedAt: row.archived_at ? row.archived_at.toISOString() : null };
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

export async function removeWorkspaceMember(workspaceId: string, userId: string): Promise<boolean> {
  const result = await getPool().query("DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [workspaceId, userId]);
  return result.rowCount === 1;
}

// A personal integration is valid only while its owner belongs to this
// workspace. Removing a member must remove those credentials as part of the
// same transaction so a later invitation starts with no retained tools.
export async function removeWorkspaceMemberAndPersonalIntegrations(workspaceId: string, userId: string): Promise<boolean> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const membership = await client.query(
      "DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, userId]
    );
    if (membership.rowCount !== 1) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      "DELETE FROM integrations WHERE workspace_id = $1 AND owner_user_id = $2 AND connection_scope = 'personal'",
      [workspaceId, userId]
    );
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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

export async function getNotificationPreferences(workspaceId: string, userId: string): Promise<import("@mai-chat/shared-types").WorkspaceNotificationPreferences> {
  const result = await getPool().query("SELECT workspace_id,user_id,browser_enabled,email_enabled,slack_enabled,escalation_minutes,daily_summary_enabled,updated_at FROM workspace_notification_preferences WHERE workspace_id=$1 AND user_id=$2", [workspaceId, userId]);
  const row = result.rows[0];
  return { workspaceId, browserEnabled: row?.browser_enabled ?? true, emailEnabled: row?.email_enabled ?? false, slackEnabled: row?.slack_enabled ?? false, escalationMinutes: row?.escalation_minutes ?? 60, dailySummaryEnabled: row?.daily_summary_enabled ?? true, updatedAt: row?.updated_at ? row.updated_at.toISOString() : null };
}

export async function updateNotificationPreferences(workspaceId: string, userId: string, input: Partial<import("@mai-chat/shared-types").WorkspaceNotificationPreferences>): Promise<import("@mai-chat/shared-types").WorkspaceNotificationPreferences> {
  const current = await getNotificationPreferences(workspaceId, userId);
  const escalationMinutes = [15, 30, 60, 240, 1440].includes(input.escalationMinutes ?? current.escalationMinutes) ? input.escalationMinutes ?? current.escalationMinutes : current.escalationMinutes;
  const result = await getPool().query(`INSERT INTO workspace_notification_preferences (workspace_id,user_id,browser_enabled,email_enabled,slack_enabled,escalation_minutes,daily_summary_enabled)
    VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (workspace_id,user_id) DO UPDATE SET browser_enabled=EXCLUDED.browser_enabled,email_enabled=EXCLUDED.email_enabled,slack_enabled=EXCLUDED.slack_enabled,escalation_minutes=EXCLUDED.escalation_minutes,daily_summary_enabled=EXCLUDED.daily_summary_enabled,updated_at=now() RETURNING *`,
    [workspaceId, userId, input.browserEnabled ?? current.browserEnabled, input.emailEnabled ?? current.emailEnabled, input.slackEnabled ?? current.slackEnabled, escalationMinutes, input.dailySummaryEnabled ?? current.dailySummaryEnabled]);
  const row = result.rows[0];
  return { workspaceId, browserEnabled: row.browser_enabled, emailEnabled: row.email_enabled, slackEnabled: row.slack_enabled, escalationMinutes: row.escalation_minutes, dailySummaryEnabled: row.daily_summary_enabled, updatedAt: row.updated_at.toISOString() };
}

const DEFAULT_ADMIN_PERMISSIONS: WorkspacePermissions = { connectTools: true, createAgents: true, publishAgents: true, approveActions: true, github: true, slack: true, linear: true, notion: true, figma: true };
const DEFAULT_EDITOR_PERMISSIONS: WorkspacePermissions = { connectTools: true, createAgents: false, publishAgents: false, approveActions: false, github: true, slack: true, linear: true, notion: true, figma: true };

function sanitizePermissions(value: unknown, fallback: WorkspacePermissions): WorkspacePermissions {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return Object.fromEntries(Object.keys(fallback).map((key) => [key, typeof source[key] === "boolean" ? source[key] : fallback[key as keyof WorkspacePermissions]])) as unknown as WorkspacePermissions;
}

export async function getWorkspacePermissionPolicy(workspaceId: string): Promise<WorkspacePermissionPolicy> {
  const result = await getPool().query(`SELECT admin_permissions, editor_permissions FROM workspace_permission_policies WHERE workspace_id = $1`, [workspaceId]);
  const row = result.rows[0];
  return { admin: sanitizePermissions(row?.admin_permissions, DEFAULT_ADMIN_PERMISSIONS), editor: sanitizePermissions(row?.editor_permissions, DEFAULT_EDITOR_PERMISSIONS) };
}

export async function setWorkspacePermissionPolicy(workspaceId: string, policy: WorkspacePermissionPolicy): Promise<WorkspacePermissionPolicy> {
  const admin = sanitizePermissions(policy.admin, DEFAULT_ADMIN_PERMISSIONS);
  const editor = sanitizePermissions(policy.editor, DEFAULT_EDITOR_PERMISSIONS);
  await getPool().query(
    `INSERT INTO workspace_permission_policies (workspace_id, admin_permissions, editor_permissions, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (workspace_id) DO UPDATE SET admin_permissions = $2, editor_permissions = $3, updated_at = now()`,
    [workspaceId, JSON.stringify(admin), JSON.stringify(editor)]
  );
  return { admin, editor };
}

export async function hasWorkspacePermission(workspaceId: string, role: WorkspaceRole, permission: keyof WorkspacePermissions): Promise<boolean> {
  if (role === "admin") return true;
  const policy = await getWorkspacePermissionPolicy(workspaceId);
  return policy[role][permission];
}
export async function createPermissionRequest(workspaceId: string, userId: string, permission: keyof WorkspacePermissions, reason: string) {
  const r = await getPool().query(
    `INSERT INTO workspace_permission_requests (workspace_id,user_id,permission,reason) VALUES ($1,$2,$3,$4)
     RETURNING id,permission,reason,status,created_at`,
    [workspaceId, userId, permission, reason]
  );
  return r.rows[0];
}
export async function listPermissionRequests(workspaceId: string) {
  const r = await getPool().query(
    `SELECT r.id,r.user_id,r.permission,r.reason,r.status,r.created_at,u.display_name,u.username
     FROM workspace_permission_requests r JOIN users u ON u.id=r.user_id
     WHERE r.workspace_id=$1 AND r.status='pending' ORDER BY r.created_at DESC`,
    [workspaceId]
  );
  return r.rows;
}
export async function resolvePermissionRequest(workspaceId: string, id: string, status: "approved" | "denied") {
  const r = await getPool().query(
    `UPDATE workspace_permission_requests SET status=$3,resolved_at=now()
     WHERE workspace_id=$1 AND id=$2 AND status='pending'
     RETURNING user_id,permission,reason`,
    [workspaceId, id, status]
  );
  return r.rows[0] as { user_id: string; permission: keyof WorkspacePermissions; reason: string } | undefined;
}

export async function notifyWorkspaceUser(input: { workspaceId: string; userId: string; kind: WorkspaceNotification["kind"]; text: string }): Promise<void> {
  await getPool().query(
    `INSERT INTO workspace_notifications (workspace_id, user_id, kind, text) VALUES ($1,$2,$3,$4)`,
    [input.workspaceId, input.userId, input.kind, input.text]
  );
}

function toWorkspaceAgent(row: Record<string, unknown>): WorkspaceAgent {
  return { id: String(row.id), workspaceId: String(row.workspace_id), name: String(row.name), slug: String(row.slug), baseAgent: row.base_agent as WorkspaceAgent["baseAgent"], instructions: String(row.instructions), knowledge: String(row.knowledge), approvedProviders: (row.approved_providers ?? []) as WorkspaceAgent["approvedProviders"], model: String(row.model), status: row.status as WorkspaceAgent["status"], ownerUserId: row.owner_user_id ? String(row.owner_user_id) : null, publishedVersion: row.published_version === null ? null : Number(row.published_version), createdAt: (row.created_at as Date).toISOString(), updatedAt: (row.updated_at as Date).toISOString() };
}

export async function listWorkspaceAgents(workspaceId: string): Promise<WorkspaceAgent[]> {
  const result = await getPool().query(`SELECT * FROM workspace_agents WHERE workspace_id = $1 ORDER BY updated_at DESC`, [workspaceId]);
  return result.rows.map(toWorkspaceAgent);
}

export async function getWorkspaceAgent(workspaceId: string, agentId: string): Promise<WorkspaceAgent | null> {
  const result = await getPool().query(`SELECT * FROM workspace_agents WHERE workspace_id = $1 AND id = $2`, [workspaceId, agentId]);
  return result.rows[0] ? toWorkspaceAgent(result.rows[0]) : null;
}

export async function getPublishedWorkspaceAgent(workspaceId: string, agentId: string): Promise<WorkspaceAgent | null> {
  const result = await getPool().query(`SELECT *, published_name AS name, published_base_agent AS base_agent, published_instructions AS instructions, published_knowledge AS knowledge, published_approved_providers AS approved_providers, published_model AS model FROM workspace_agents WHERE workspace_id = $1 AND id = $2 AND published_version IS NOT NULL`, [workspaceId, agentId]);
  return result.rows[0] ? toWorkspaceAgent(result.rows[0]) : null;
}

export async function createWorkspaceAgent(input: { workspaceId: string; name: string; baseAgent: WorkspaceAgent["baseAgent"]; instructions?: string; knowledge?: string; approvedProviders?: WorkspaceAgent["approvedProviders"]; model?: string; ownerUserId: string }): Promise<WorkspaceAgent> {
  const name = input.name.trim();
  if (!name) throw new Error("agent name is required");
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
  const result = await getPool().query(`INSERT INTO workspace_agents (workspace_id, name, slug, base_agent, instructions, knowledge, approved_providers, model, owner_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [input.workspaceId, name, slug, input.baseAgent, input.instructions ?? "", input.knowledge ?? "", input.approvedProviders ?? [], input.model ?? "workspace-default", input.ownerUserId]);
  return toWorkspaceAgent(result.rows[0]);
}

export async function updateWorkspaceAgent(workspaceId: string, agentId: string, input: Partial<Pick<WorkspaceAgent, "name" | "baseAgent" | "instructions" | "knowledge" | "approvedProviders" | "model">>): Promise<WorkspaceAgent | null> {
  const result = await getPool().query(`UPDATE workspace_agents SET name = COALESCE($3,name), base_agent = COALESCE($4,base_agent), instructions = COALESCE($5,instructions), knowledge = COALESCE($6,knowledge), approved_providers = COALESCE($7,approved_providers), model = COALESCE($8,model), updated_at = now() WHERE workspace_id = $1 AND id = $2 RETURNING *`, [workspaceId, agentId, input.name?.trim() || null, input.baseAgent ?? null, input.instructions ?? null, input.knowledge ?? null, input.approvedProviders ?? null, input.model ?? null]);
  return result.rows[0] ? toWorkspaceAgent(result.rows[0]) : null;
}

export async function publishWorkspaceAgent(workspaceId: string, agentId: string, userId: string): Promise<WorkspaceAgent | null> {
  const client = await getPool().connect();
  try { await client.query("BEGIN"); const found = await client.query(`SELECT * FROM workspace_agents WHERE workspace_id = $1 AND id = $2 FOR UPDATE`, [workspaceId, agentId]); if (!found.rows[0]) { await client.query("ROLLBACK"); return null; } const row = found.rows[0]; const version = Number(row.published_version ?? 0) + 1; await client.query(`INSERT INTO workspace_agent_versions (agent_id, version, instructions, knowledge, approved_providers, model, published_by_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [agentId, version, row.instructions, row.knowledge, row.approved_providers, row.model, userId]); const updated = await client.query(`UPDATE workspace_agents SET status = 'published', published_version = $3, published_name = name, published_base_agent = base_agent, published_instructions = instructions, published_knowledge = knowledge, published_approved_providers = approved_providers, published_model = model, updated_at = now() WHERE workspace_id = $1 AND id = $2 RETURNING *`, [workspaceId, agentId, version]); await client.query("COMMIT"); return toWorkspaceAgent(updated.rows[0]); } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function listWorkspaceAgentVersions(workspaceId: string, agentId: string): Promise<WorkspaceAgentVersion[]> {
  const result = await getPool().query(`SELECT v.* FROM workspace_agent_versions v JOIN workspace_agents a ON a.id = v.agent_id WHERE a.workspace_id = $1 AND v.agent_id = $2 ORDER BY v.version DESC`, [workspaceId, agentId]);
  return result.rows.map((row) => ({ id: row.id, agentId: row.agent_id, version: Number(row.version), instructions: row.instructions, knowledge: row.knowledge, approvedProviders: row.approved_providers ?? [], model: row.model, publishedByUserId: row.published_by_user_id, createdAt: row.created_at.toISOString() }));
}

export async function deleteWorkspaceAgent(workspaceId: string, agentId: string): Promise<WorkspaceAgent | null> {
  const result = await getPool().query(`DELETE FROM workspace_agents WHERE workspace_id = $1 AND id = $2 RETURNING *`, [workspaceId, agentId]);
  return result.rows[0] ? toWorkspaceAgent(result.rows[0]) : null;
}

type WorkflowInput = Pick<WorkspaceWorkflow, "name" | "description" | "instructions" | "agentKind" | "workspaceAgentId" | "conversationId" | "trigger" | "scheduleMinutes" | "enabled">;

function toWorkflow(row: Record<string, unknown>): WorkspaceWorkflow {
  return {
    id: String(row.id), workspaceId: String(row.workspace_id), name: String(row.name), description: String(row.description ?? ""), instructions: String(row.instructions ?? ""),
    agentKind: row.agent_kind as WorkspaceWorkflow["agentKind"], workspaceAgentId: row.workspace_agent_id ? String(row.workspace_agent_id) : null,
    conversationId: row.conversation_id ? String(row.conversation_id) : null, trigger: row.trigger as WorkflowTrigger,
    scheduleMinutes: row.schedule_minutes === null ? null : Number(row.schedule_minutes), enabled: Boolean(row.enabled), ownerUserId: row.owner_user_id ? String(row.owner_user_id) : null,
    nextRunAt: row.next_run_at ? (row.next_run_at as Date).toISOString() : null, lastRunAt: row.last_run_at ? (row.last_run_at as Date).toISOString() : null,
    lastRunStatus: row.last_run_status as WorkflowRunStatus | null, lastRunError: row.last_run_error ? String(row.last_run_error) : null,
    createdAt: (row.created_at as Date).toISOString(), updatedAt: (row.updated_at as Date).toISOString(),
  };
}

function workflowScheduleDate(trigger: WorkflowTrigger, scheduleMinutes: number | null): Date | null {
  return trigger === "schedule" && scheduleMinutes ? new Date(Date.now() + scheduleMinutes * 60_000) : null;
}

export async function listWorkspaceWorkflows(workspaceId: string): Promise<WorkspaceWorkflow[]> {
  const result = await getPool().query("SELECT * FROM workspace_workflows WHERE workspace_id = $1 ORDER BY updated_at DESC", [workspaceId]);
  return result.rows.map(toWorkflow);
}

export async function getWorkspaceWorkflow(workspaceId: string, workflowId: string): Promise<WorkspaceWorkflow | null> {
  const result = await getPool().query("SELECT * FROM workspace_workflows WHERE workspace_id = $1 AND id = $2", [workspaceId, workflowId]);
  return result.rows[0] ? toWorkflow(result.rows[0]) : null;
}

export async function createWorkspaceWorkflow(workspaceId: string, ownerUserId: string, input: WorkflowInput): Promise<WorkspaceWorkflow> {
  const scheduleMinutes = input.trigger === "schedule" ? input.scheduleMinutes : null;
  const result = await getPool().query(
    `INSERT INTO workspace_workflows (workspace_id,name,description,instructions,agent_kind,workspace_agent_id,conversation_id,trigger,schedule_minutes,enabled,owner_user_id,next_run_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [workspaceId, input.name.trim(), input.description.trim(), input.instructions.trim(), input.agentKind, input.workspaceAgentId, input.conversationId, input.trigger, scheduleMinutes, input.enabled, ownerUserId, workflowScheduleDate(input.trigger, scheduleMinutes)]
  );
  return toWorkflow(result.rows[0]);
}

export async function updateWorkspaceWorkflow(workspaceId: string, workflowId: string, input: Partial<WorkflowInput>): Promise<WorkspaceWorkflow | null> {
  const current = await getWorkspaceWorkflow(workspaceId, workflowId);
  if (!current) return null;
  const merged = { ...current, ...input, name: input.name?.trim() || current.name, description: input.description?.trim() ?? current.description, instructions: input.instructions?.trim() ?? current.instructions };
  const scheduleMinutes = merged.trigger === "schedule" ? merged.scheduleMinutes : null;
  const nextRun = !merged.enabled ? null : workflowScheduleDate(merged.trigger, scheduleMinutes);
  const result = await getPool().query(
    `UPDATE workspace_workflows SET name=$3,description=$4,instructions=$5,agent_kind=$6,workspace_agent_id=$7,conversation_id=$8,trigger=$9,schedule_minutes=$10,enabled=$11,next_run_at=$12,updated_at=now()
     WHERE workspace_id=$1 AND id=$2 RETURNING *`,
    [workspaceId, workflowId, merged.name, merged.description, merged.instructions, merged.agentKind, merged.workspaceAgentId, merged.conversationId, merged.trigger, scheduleMinutes, merged.enabled, nextRun]
  );
  return result.rows[0] ? toWorkflow(result.rows[0]) : null;
}

export async function deleteWorkspaceWorkflow(workspaceId: string, workflowId: string): Promise<WorkspaceWorkflow | null> {
  const result = await getPool().query("DELETE FROM workspace_workflows WHERE workspace_id=$1 AND id=$2 RETURNING *", [workspaceId, workflowId]);
  return result.rows[0] ? toWorkflow(result.rows[0]) : null;
}

function toWorkspaceTask(row: Record<string, unknown>): WorkspaceTask {
  return {
    id: String(row.id), workspaceId: String(row.workspace_id), title: String(row.title), description: String(row.description ?? ""), status: row.status as WorkspaceTaskStatus,
    ownerUserId: row.owner_user_id ? String(row.owner_user_id) : null, ownerName: row.owner_name ? String(row.owner_name) : null,
    dueDate: row.due_date ? String(row.due_date).slice(0, 10) : null, sourceConversationId: row.source_conversation_id ? String(row.source_conversation_id) : null,
    createdByUserId: row.created_by_user_id ? String(row.created_by_user_id) : null, createdByName: row.created_by_name ? String(row.created_by_name) : null,
    createdAt: (row.created_at as Date).toISOString(), updatedAt: (row.updated_at as Date).toISOString(),
  };
}

export async function listWorkspaceTasks(workspaceId: string): Promise<WorkspaceTask[]> {
  const result = await getPool().query(`SELECT t.*, owner.display_name AS owner_name, creator.display_name AS created_by_name
    FROM workspace_tasks t LEFT JOIN users owner ON owner.id=t.owner_user_id LEFT JOIN users creator ON creator.id=t.created_by_user_id
    WHERE t.workspace_id=$1 ORDER BY CASE t.status WHEN 'done' THEN 1 ELSE 0 END, t.due_date NULLS LAST, t.updated_at DESC`, [workspaceId]);
  return result.rows.map(toWorkspaceTask);
}

export async function createWorkspaceTask(input: { workspaceId: string; title: string; description?: string; ownerUserId?: string | null; dueDate?: string | null; sourceConversationId?: string | null; createdByUserId: string }): Promise<WorkspaceTask> {
  const result = await getPool().query(`INSERT INTO workspace_tasks (workspace_id,title,description,owner_user_id,due_date,source_conversation_id,created_by_user_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [input.workspaceId, input.title.trim(), input.description?.trim() ?? "", input.ownerUserId ?? null, input.dueDate ?? null, input.sourceConversationId ?? null, input.createdByUserId]);
  const row = result.rows[0];
  return toWorkspaceTask({ ...row, owner_name: null, created_by_name: null });
}

export async function updateWorkspaceTask(workspaceId: string, taskId: string, input: Partial<Pick<WorkspaceTask, "title" | "description" | "status" | "ownerUserId" | "dueDate" | "sourceConversationId">>): Promise<WorkspaceTask | null> {
  const current = (await getPool().query("SELECT * FROM workspace_tasks WHERE workspace_id=$1 AND id=$2", [workspaceId, taskId])).rows[0];
  if (!current) return null;
  const merged = { title: input.title?.trim() || current.title, description: input.description?.trim() ?? current.description, status: input.status ?? current.status, ownerUserId: input.ownerUserId ?? current.owner_user_id, dueDate: input.dueDate ?? current.due_date, sourceConversationId: input.sourceConversationId ?? current.source_conversation_id };
  const result = await getPool().query(`UPDATE workspace_tasks SET title=$3,description=$4,status=$5,owner_user_id=$6,due_date=$7,source_conversation_id=$8,updated_at=now()
    WHERE workspace_id=$1 AND id=$2 RETURNING *`, [workspaceId, taskId, merged.title, merged.description, merged.status, merged.ownerUserId, merged.dueDate, merged.sourceConversationId]);
  return result.rows[0] ? toWorkspaceTask({ ...result.rows[0], owner_name: null, created_by_name: null }) : null;
}

export async function deleteWorkspaceTask(workspaceId: string, taskId: string): Promise<WorkspaceTask | null> {
  const result = await getPool().query("DELETE FROM workspace_tasks WHERE workspace_id=$1 AND id=$2 RETURNING *", [workspaceId, taskId]);
  return result.rows[0] ? toWorkspaceTask({ ...result.rows[0], owner_name: null, created_by_name: null }) : null;
}

export async function setWorkflowConversation(workflowId: string, conversationId: string): Promise<void> {
  await getPool().query("UPDATE workspace_workflows SET conversation_id=$2, updated_at=now() WHERE id=$1", [workflowId, conversationId]);
}

function toWorkspaceMemory(row: Record<string, unknown>): WorkspaceMemory {
  return {
    id: String(row.id), workspaceId: String(row.workspace_id), kind: row.kind as WorkspaceMemoryKind, title: String(row.title), content: String(row.content),
    sourceTitle: row.source_title ? String(row.source_title) : null, sourceUrl: row.source_url ? String(row.source_url) : null,
    freshUntil: row.fresh_until ? (row.fresh_until as Date).toISOString() : null, createdByUserId: row.created_by_user_id ? String(row.created_by_user_id) : null,
    createdByName: row.created_by_name ? String(row.created_by_name) : null, createdAt: (row.created_at as Date).toISOString(), updatedAt: (row.updated_at as Date).toISOString(),
  };
}

export async function listWorkspaceMemory(workspaceId: string): Promise<WorkspaceMemory[]> {
  const result = await getPool().query(
    `SELECT m.*, u.display_name AS created_by_name FROM workspace_memory m LEFT JOIN users u ON u.id=m.created_by_user_id
     WHERE m.workspace_id=$1 ORDER BY m.updated_at DESC`, [workspaceId]
  );
  return result.rows.map(toWorkspaceMemory);
}

export async function createWorkspaceMemory(input: { workspaceId: string; kind: WorkspaceMemoryKind; title: string; content: string; sourceTitle?: string | null; sourceUrl?: string | null; freshUntil?: string | null; createdByUserId: string }): Promise<WorkspaceMemory> {
  const result = await getPool().query(
    `INSERT INTO workspace_memory (workspace_id,kind,title,content,source_title,source_url,fresh_until,created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [input.workspaceId, input.kind, input.title.trim(), input.content.trim(), input.sourceTitle?.trim() || null, input.sourceUrl?.trim() || null, input.freshUntil || null, input.createdByUserId]
  );
  const memory = toWorkspaceMemory(result.rows[0]);
  const user = await getUserById(input.createdByUserId);
  return { ...memory, createdByName: user?.displayName ?? null };
}

export async function updateWorkspaceMemory(workspaceId: string, memoryId: string, input: { kind: WorkspaceMemoryKind; title: string; content: string; sourceTitle?: string | null; sourceUrl?: string | null; freshUntil?: string | null }): Promise<WorkspaceMemory | null> {
  const result = await getPool().query(
    `UPDATE workspace_memory SET kind=$3,title=$4,content=$5,source_title=$6,source_url=$7,fresh_until=$8,updated_at=now()
     WHERE workspace_id=$1 AND id=$2 RETURNING *`,
    [workspaceId, memoryId, input.kind, input.title.trim(), input.content.trim(), input.sourceTitle?.trim() || null, input.sourceUrl?.trim() || null, input.freshUntil || null]
  );
  if (!result.rows[0]) return null;
  const memory = toWorkspaceMemory(result.rows[0]);
  const user = memory.createdByUserId ? await getUserById(memory.createdByUserId) : null;
  return { ...memory, createdByName: user?.displayName ?? null };
}

export async function getWorkspaceMemory(workspaceId: string, memoryId: string): Promise<WorkspaceMemory | null> {
  const result = await getPool().query("SELECT * FROM workspace_memory WHERE workspace_id=$1 AND id=$2", [workspaceId, memoryId]);
  return result.rows[0] ? toWorkspaceMemory(result.rows[0]) : null;
}

export async function deleteWorkspaceMemory(workspaceId: string, memoryId: string): Promise<WorkspaceMemory | null> {
  const result = await getPool().query("DELETE FROM workspace_memory WHERE workspace_id=$1 AND id=$2 RETURNING *", [workspaceId, memoryId]);
  return result.rows[0] ? toWorkspaceMemory(result.rows[0]) : null;
}

export async function workspaceMemoryContext(workspaceId: string, limit = 12): Promise<string> {
  return formatWorkspaceMemoryContext(await listWorkspaceMemory(workspaceId), limit);
}

type ArtifactInput = { type: WorkspaceArtifactType; status: WorkspaceArtifactStatus; title: string; summary: string; content: string; ownerUserId: string | null; dashboardData?: WorkspaceArtifactDashboard | null; releaseVersion?: string | null };

function toWorkspaceArtifact(row: Record<string, unknown>): WorkspaceArtifact {
  return {
    id: String(row.id), workspaceId: String(row.workspace_id), type: row.type as WorkspaceArtifactType, status: row.status as WorkspaceArtifactStatus,
    title: String(row.title), summary: String(row.summary ?? ""), content: String(row.content), dashboardData: row.dashboard_data && typeof row.dashboard_data === "object" ? row.dashboard_data as WorkspaceArtifactDashboard : null, shareToken: row.share_token ? String(row.share_token) : null, releaseVersion: row.release_version ? String(row.release_version) : null, ownerUserId: row.owner_user_id ? String(row.owner_user_id) : null,
    ownerName: row.owner_name ? String(row.owner_name) : null, createdByUserId: row.created_by_user_id ? String(row.created_by_user_id) : null,
    createdByName: row.created_by_name ? String(row.created_by_name) : null, createdAt: (row.created_at as Date).toISOString(), updatedAt: (row.updated_at as Date).toISOString(),
  };
}
function toWorkspaceArtifactComment(row: Record<string, unknown>): WorkspaceArtifactComment {
  return { id: String(row.id), artifactId: String(row.artifact_id), workspaceId: String(row.workspace_id), content: String(row.content), authorUserId: row.author_user_id ? String(row.author_user_id) : null, authorName: row.author_name ? String(row.author_name) : null, createdAt: (row.created_at as Date).toISOString(), updatedAt: (row.updated_at as Date).toISOString() };
}
const artifactSelect = `SELECT a.*, owner.display_name AS owner_name, creator.display_name AS created_by_name FROM workspace_artifacts a LEFT JOIN users owner ON owner.id=a.owner_user_id LEFT JOIN users creator ON creator.id=a.created_by_user_id`;
export async function listWorkspaceArtifacts(workspaceId: string): Promise<WorkspaceArtifact[]> {
  const result = await getPool().query(`${artifactSelect} WHERE a.workspace_id=$1 ORDER BY a.updated_at DESC`, [workspaceId]);
  return result.rows.map(toWorkspaceArtifact);
}
export async function getWorkspaceArtifact(workspaceId: string, artifactId: string): Promise<WorkspaceArtifact | null> {
  const result = await getPool().query(`${artifactSelect} WHERE a.workspace_id=$1 AND a.id=$2`, [workspaceId, artifactId]);
  return result.rows[0] ? toWorkspaceArtifact(result.rows[0]) : null;
}
export async function createWorkspaceArtifact(workspaceId: string, createdByUserId: string, input: ArtifactInput): Promise<WorkspaceArtifact> {
  const result = await getPool().query(`INSERT INTO workspace_artifacts (workspace_id,type,status,title,summary,content,dashboard_data,owner_user_id,created_by_user_id,release_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [workspaceId,input.type,input.status,input.title.trim(),input.summary.trim(),input.content.trim(),input.dashboardData ?? null,input.ownerUserId,createdByUserId,input.releaseVersion ?? null]);
  const artifact = (await getWorkspaceArtifact(workspaceId, String(result.rows[0].id)))!;
  await saveWorkspaceArtifactVersion(artifact, createdByUserId);
  return artifact;
}
export async function updateWorkspaceArtifact(workspaceId: string, artifactId: string, input: ArtifactInput, savedByUserId?: string): Promise<WorkspaceArtifact | null> {
  const result = await getPool().query(`UPDATE workspace_artifacts SET type=$3,status=$4,title=$5,summary=$6,content=$7,dashboard_data=$8,owner_user_id=$9,release_version=$10,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING id`, [workspaceId,artifactId,input.type,input.status,input.title.trim(),input.summary.trim(),input.content.trim(),input.dashboardData ?? null,input.ownerUserId,input.releaseVersion ?? null]);
  const artifact = result.rows[0] ? await getWorkspaceArtifact(workspaceId, artifactId) : null;
  if (artifact) await saveWorkspaceArtifactVersion(artifact, savedByUserId ?? null);
  return artifact;
}
export async function deleteWorkspaceArtifact(workspaceId: string, artifactId: string): Promise<WorkspaceArtifact | null> {
  const current = await getWorkspaceArtifact(workspaceId, artifactId); if (!current) return null;
  await getPool().query("DELETE FROM workspace_artifacts WHERE workspace_id=$1 AND id=$2", [workspaceId, artifactId]); return current;
}

// Generates (token === undefined) or revokes (token === null) a public
// read-only share link for a dashboard artifact. Generation happens here
// rather than in server.ts so the random token is a single round trip.
export async function setArtifactShareToken(workspaceId: string, artifactId: string, revoke: boolean): Promise<WorkspaceArtifact | null> {
  const token = revoke ? null : randomUUID();
  const result = await getPool().query("UPDATE workspace_artifacts SET share_token=$3 WHERE workspace_id=$1 AND id=$2 RETURNING id", [workspaceId, artifactId, token]);
  return result.rows[0] ? getWorkspaceArtifact(workspaceId, artifactId) : null;
}

// Unauthenticated lookup for the public dashboard link -- deliberately
// returns only the safe subset (see PublicDashboardView), never the full
// WorkspaceArtifact, and only for a still-published dashboard (an
// artifact reverted to draft, archived, or deleted stops resolving even
// if someone still has the old link).
export async function getPublicDashboardByShareToken(token: string): Promise<import("@mai-chat/shared-types").PublicDashboardView | null> {
  const result = await getPool().query(
    `SELECT a.title, a.summary, a.dashboard_data, a.updated_at, w.name AS workspace_name
     FROM workspace_artifacts a JOIN workspaces w ON w.id = a.workspace_id
     WHERE a.share_token = $1 AND a.type = 'dashboard' AND a.status = 'published'`,
    [token]
  );
  const row = result.rows[0];
  if (!row || !row.dashboard_data) return null;
  return { title: String(row.title), summary: String(row.summary ?? ""), workspaceName: String(row.workspace_name), dashboardData: row.dashboard_data, updatedAt: (row.updated_at as Date).toISOString() };
}

// Same idea as getPublicDashboardByShareToken above, for a published
// Release Notes artifact's share link.
export async function getPublicReleaseNotesByShareToken(token: string): Promise<import("@mai-chat/shared-types").PublicReleaseNotesView | null> {
  const result = await getPool().query(
    `SELECT a.title, a.summary, a.content, a.release_version, a.updated_at, w.name AS workspace_name
     FROM workspace_artifacts a JOIN workspaces w ON w.id = a.workspace_id
     WHERE a.share_token = $1 AND a.type = 'release_notes' AND a.status = 'published'`,
    [token]
  );
  const row = result.rows[0];
  if (!row) return null;
  return { title: String(row.title), summary: String(row.summary ?? ""), workspaceName: String(row.workspace_name), content: String(row.content), releaseVersion: row.release_version ? String(row.release_version) : null, updatedAt: (row.updated_at as Date).toISOString() };
}

// Same idea, generalized to Plan / Report / Task list -- see
// PublicArtifactView's comment for why these three share one function
// while Dashboard and Release Notes keep their own.
export async function getPublicArtifactByShareToken(token: string): Promise<import("@mai-chat/shared-types").PublicArtifactView | null> {
  const result = await getPool().query(
    `SELECT a.type, a.title, a.summary, a.content, a.updated_at, w.name AS workspace_name
     FROM workspace_artifacts a JOIN workspaces w ON w.id = a.workspace_id
     WHERE a.share_token = $1 AND a.type IN ('plan', 'report', 'task_list') AND a.status = 'published'`,
    [token]
  );
  const row = result.rows[0];
  if (!row) return null;
  return { type: row.type, title: String(row.title), summary: String(row.summary ?? ""), workspaceName: String(row.workspace_name), content: String(row.content), updatedAt: (row.updated_at as Date).toISOString() };
}
export async function listWorkspaceArtifactComments(workspaceId: string, artifactId: string): Promise<WorkspaceArtifactComment[]> {
  const result = await getPool().query("SELECT c.*, u.display_name AS author_name FROM workspace_artifact_comments c LEFT JOIN users u ON u.id=c.author_user_id WHERE c.workspace_id=$1 AND c.artifact_id=$2 ORDER BY c.created_at ASC", [workspaceId,artifactId]); return result.rows.map(toWorkspaceArtifactComment);
}
export async function createWorkspaceArtifactComment(workspaceId: string, artifactId: string, authorUserId: string, content: string): Promise<WorkspaceArtifactComment> {
  const result = await getPool().query("INSERT INTO workspace_artifact_comments (workspace_id,artifact_id,author_user_id,content) VALUES ($1,$2,$3,$4) RETURNING *", [workspaceId,artifactId,authorUserId,content.trim()]);
  const comment = result.rows[0]; const user = await getUserById(authorUserId); return { ...toWorkspaceArtifactComment(comment), authorName: user?.displayName ?? null };
}

function toWorkspaceArtifactVersion(row: Record<string, unknown>): WorkspaceArtifactVersion {
  return { id: String(row.id), artifactId: String(row.artifact_id), workspaceId: String(row.workspace_id), version: Number(row.version), title: String(row.title), summary: String(row.summary ?? ""), content: String(row.content), dashboardData: row.dashboard_data && typeof row.dashboard_data === "object" ? row.dashboard_data as WorkspaceArtifactDashboard : null, status: row.status as WorkspaceArtifactStatus, savedByUserId: row.saved_by_user_id ? String(row.saved_by_user_id) : null, savedByName: row.saved_by_name ? String(row.saved_by_name) : null, createdAt: (row.created_at as Date).toISOString() };
}
async function saveWorkspaceArtifactVersion(artifact: WorkspaceArtifact, savedByUserId: string | null): Promise<void> {
  const result = await getPool().query("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM workspace_artifact_versions WHERE artifact_id=$1", [artifact.id]);
  await getPool().query("INSERT INTO workspace_artifact_versions (artifact_id,workspace_id,version,title,summary,content,dashboard_data,status,saved_by_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [artifact.id,artifact.workspaceId,Number(result.rows[0].version),artifact.title,artifact.summary,artifact.content,artifact.dashboardData ?? null,artifact.status,savedByUserId]);
}
export async function listWorkspaceArtifactVersions(workspaceId: string, artifactId: string): Promise<WorkspaceArtifactVersion[]> {
  const result = await getPool().query("SELECT v.*, u.display_name AS saved_by_name FROM workspace_artifact_versions v LEFT JOIN users u ON u.id=v.saved_by_user_id WHERE v.workspace_id=$1 AND v.artifact_id=$2 ORDER BY v.version DESC", [workspaceId,artifactId]); return result.rows.map(toWorkspaceArtifactVersion);
}
export async function restoreWorkspaceArtifactVersion(workspaceId: string, artifactId: string, versionId: string, savedByUserId: string): Promise<WorkspaceArtifact | null> {
  const result = await getPool().query("SELECT * FROM workspace_artifact_versions WHERE workspace_id=$1 AND artifact_id=$2 AND id=$3", [workspaceId,artifactId,versionId]);
  if (!result.rows[0]) return null;
  const version = toWorkspaceArtifactVersion(result.rows[0]); const current = await getWorkspaceArtifact(workspaceId, artifactId); if (!current) return null;
  return updateWorkspaceArtifact(workspaceId, artifactId, { type: current.type, status: version.status, title: version.title, summary: version.summary, content: version.content, dashboardData: current.dashboardData, ownerUserId: current.ownerUserId, releaseVersion: current.releaseVersion }, savedByUserId);
}

/** Formats durable memories for an agent turn without reading another workspace. */
export function formatWorkspaceMemoryContext(memories: WorkspaceMemory[], limit = 12): string {
  const selected = memories.slice(0, limit);
  if (!selected.length) return "";
  return selected.map((memory) => {
    const stale = memory.freshUntil && new Date(memory.freshUntil).getTime() < Date.now() ? "STALE — verify before relying on it" : memory.freshUntil ? `current through ${memory.freshUntil.slice(0, 10)}` : "no freshness date";
    const source = memory.sourceTitle ? ` Source: ${memory.sourceTitle}${memory.sourceUrl ? ` (${memory.sourceUrl})` : ""}.` : "";
    return `[Memory: ${memory.title}] (${memory.kind}; ${stale})\n${memory.content}${source}`;
  }).join("\n\n").slice(0, 12_000);
}

export async function createWorkflowRun(workflow: WorkspaceWorkflow, trigger: WorkflowTrigger): Promise<WorkflowRun> {
  const result = await getPool().query(
    `INSERT INTO workspace_workflow_runs (workflow_id,workspace_id,trigger) VALUES ($1,$2,$3) RETURNING *`, [workflow.id, workflow.workspaceId, trigger]
  );
  await getPool().query("UPDATE workspace_workflows SET last_run_at=now(),last_run_status='running',last_run_error=NULL,updated_at=now() WHERE id=$1", [workflow.id]);
  return toWorkflowRun(result.rows[0]);
}

function toWorkflowRun(row: Record<string, unknown>): WorkflowRun {
  return { id: String(row.id), workflowId: String(row.workflow_id), workspaceId: String(row.workspace_id), trigger: row.trigger as WorkflowTrigger, status: row.status as WorkflowRunStatus, detail: row.detail ? String(row.detail) : null, startedAt: (row.started_at as Date).toISOString(), completedAt: row.completed_at ? (row.completed_at as Date).toISOString() : null };
}

export async function finishWorkflowRun(workflowId: string, runId: string, status: Exclude<WorkflowRunStatus, "running">, detail?: string): Promise<void> {
  await getPool().query("UPDATE workspace_workflow_runs SET status=$3,detail=$4,completed_at=now() WHERE id=$1 AND workflow_id=$2", [runId, workflowId, status, detail ?? null]);
  await getPool().query("UPDATE workspace_workflows SET last_run_status=$2,last_run_error=$3,updated_at=now() WHERE id=$1", [workflowId, status, status === "failed" ? detail ?? "Workflow failed." : null]);
}

export async function listWorkflowRuns(workspaceId: string, workflowId: string): Promise<WorkflowRun[]> {
  const result = await getPool().query("SELECT r.* FROM workspace_workflow_runs r WHERE r.workspace_id=$1 AND r.workflow_id=$2 ORDER BY r.started_at DESC LIMIT 30", [workspaceId, workflowId]);
  return result.rows.map(toWorkflowRun);
}

// Claim due schedules atomically before execution. Updating next_run_at here
// prevents overlapping scheduler ticks from starting the same workflow twice.
export async function claimDueWorkflows(): Promise<WorkspaceWorkflow[]> {
  const result = await getPool().query(
    `WITH due AS (SELECT id FROM workspace_workflows WHERE enabled AND trigger='schedule' AND next_run_at <= now() FOR UPDATE SKIP LOCKED)
     UPDATE workspace_workflows w SET next_run_at=now() + (w.schedule_minutes * interval '1 minute'), updated_at=now()
     FROM due WHERE w.id=due.id RETURNING w.*`
  );
  return result.rows.map(toWorkflow);
}

export async function upsertGithubIntegration(input: {
  workspaceId: string;
  owner: string;
  repo: string;
  token: string;
  connectionName?: string;
  connectionScope?: "shared" | "personal";
  ownerUserId?: string;
}): Promise<GithubIntegrationConfig> {
  const pool = getPool();
  const encrypted = encryptToken(input.token);
  const connectionName = input.connectionName?.trim() || "Shared connection";
  const connectionScope = input.connectionScope ?? "shared";
  const accountKey = connectionScope === "personal" ? `personal:${input.ownerUserId}:${connectionName}` : connectionName === "Shared connection" ? "shared" : `shared:${connectionName}`;
  const result = await pool.query(
    `INSERT INTO integrations (workspace_id, type, owner, repo, encrypted_token, connection_name, connection_scope, owner_user_id, account_key)
     VALUES ($1, 'github', $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (workspace_id, type, account_key)
     DO UPDATE SET owner = $2, repo = $3, encrypted_token = $4, connection_name = $5, connected_at = now()
     RETURNING id, workspace_id, connection_name, connection_scope, owner_user_id, connected_at`,
    [input.workspaceId, input.owner, input.repo, encrypted, connectionName, connectionScope, input.ownerUserId ?? null, accountKey]
  );
  return {
    id: result.rows[0].id,
    type: "github",
    workspaceId: result.rows[0].workspace_id,
    connectionName: result.rows[0].connection_name,
    connectionScope: result.rows[0].connection_scope,
    ownerUserId: result.rows[0].owner_user_id ?? undefined,
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
export async function saveGithubOAuthToken(input: { workspaceId: string; token: string; ownerUserId?: string }): Promise<void> {
  const pool = getPool();
  const encrypted = encryptToken(input.token);
  const accountKey = input.ownerUserId ? `personal:${input.ownerUserId}:github` : "shared";
  const connectionScope = input.ownerUserId ? "personal" : "shared";
  await pool.query(
    `INSERT INTO integrations (workspace_id, type, encrypted_token, connection_scope, owner_user_id, account_key)
     VALUES ($1, 'github', $2, $3, $4, $5)
     ON CONFLICT (workspace_id, type, account_key)
     DO UPDATE SET encrypted_token = $2, connection_scope = $3, owner_user_id = $4, connected_at = now()`,
    [input.workspaceId, encrypted, connectionScope, input.ownerUserId ?? null, accountKey]
  );
}

// Attaches/changes which repo a workspace's already-connected GitHub token
// should be used against (the repo-picker step after OAuth login, or
// "change repository" later). Returns null if there's no GitHub
// integration row yet for this workspace -- the caller must have already
// connected a token (OAuth or pasted) before a repo can be chosen.
export async function setGithubRepo(input: { workspaceId: string; owner: string; repo: string; ownerUserId?: string }): Promise<GithubIntegrationConfig | null> {
  const pool = getPool();
  const accountKey = input.ownerUserId ? `personal:${input.ownerUserId}:github` : "shared";
  const result = await pool.query(
    `UPDATE integrations SET owner = $2, repo = $3
     WHERE workspace_id = $1 AND type = 'github' AND account_key = $4
     RETURNING id, workspace_id, connection_name, connection_scope, owner_user_id, owner, repo, connected_at`,
    [input.workspaceId, input.owner, input.repo, accountKey]
  );
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    id: row.id,
    type: "github",
    workspaceId: row.workspace_id,
    connectionName: row.connection_name,
    connectionScope: row.connection_scope,
    ownerUserId: row.owner_user_id ?? undefined,
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
  ownerUserId?: string;
}): Promise<SlackIntegrationConfig> {
  const pool = getPool();
  const encrypted = encryptToken(input.token);
  // A Slack OAuth grant is a user token, so it must remain attributable to
  // the member who authorized it. This also gives each member an independent
  // Slack connection within the same workspace.
  const accountKey = input.ownerUserId ? `personal:${input.ownerUserId}:slack` : "shared";
  const connectionScope = input.ownerUserId ? "personal" : "shared";
  const result = await pool.query(
    `INSERT INTO integrations (workspace_id, type, team_name, encrypted_token, connection_scope, owner_user_id, account_key)
     VALUES ($1, 'slack', $2, $3, $4, $5, $6)
     ON CONFLICT (workspace_id, type, account_key)
     DO UPDATE SET team_name = $2, encrypted_token = $3, connection_scope = $4, owner_user_id = $5, connected_at = now()
     RETURNING id, workspace_id, connection_name, connection_scope, owner_user_id, connected_at`,
    [input.workspaceId, input.teamName, encrypted, connectionScope, input.ownerUserId ?? null, accountKey]
  );
  return {
    id: result.rows[0].id,
    type: "slack",
    workspaceId: result.rows[0].workspace_id,
    connectionName: result.rows[0].connection_name,
    connectionScope: result.rows[0].connection_scope,
    ownerUserId: result.rows[0].owner_user_id ?? undefined,
    teamName: input.teamName,
    connected: true,
    connectedAt: result.rows[0].connected_at.toISOString(),
  };
}

export async function upsertRemoteMcpIntegration(input: { workspaceId: string; type: "linear" | "notion" | "figma"; endpoint: string; token: string; accountName?: string }): Promise<import("@mai-chat/shared-types").RemoteMcpIntegrationConfig> {
  const result = await getPool().query(
    `INSERT INTO integrations (workspace_id, type, owner, team_name, encrypted_token, account_key) VALUES ($1, $2, $3, $4, $5, 'shared')
     ON CONFLICT (workspace_id, type, account_key) DO UPDATE SET owner = $3, team_name = $4, encrypted_token = $5, connected_at = now()
     RETURNING id, workspace_id, type, connection_name, connection_scope, owner_user_id, owner, team_name, connected_at`,
    [input.workspaceId, input.type, input.endpoint, input.accountName ?? null, encryptToken(input.token)]
  );
  const row = result.rows[0];
  return { id: row.id, type: row.type, workspaceId: row.workspace_id, connectionName: row.connection_name, connectionScope: row.connection_scope, ownerUserId: row.owner_user_id ?? undefined, endpoint: row.owner, accountName: row.team_name ?? undefined, connected: true, connectedAt: row.connected_at.toISOString() };
}

// Client-safe listing -- never includes the decrypted token.
export async function listIntegrations(workspaceId: string): Promise<IntegrationConfig[]> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT i.id, i.type, i.owner, i.repo, i.team_name, i.connection_name, i.connection_scope, i.owner_user_id, i.connected_at, u.display_name AS connected_by_name
     FROM integrations i LEFT JOIN users u ON u.id = i.owner_user_id WHERE i.workspace_id = $1`,
    [workspaceId]
  );
  return result.rows.map((row): IntegrationConfig => {
    if (row.type === "github") {
      return {
        id: row.id,
        type: "github",
        workspaceId,
        connectionName: row.connection_name,
        connectionScope: row.connection_scope,
        ownerUserId: row.owner_user_id ?? undefined,
        connectedByName: row.connected_by_name ?? undefined,
        owner: row.owner ?? undefined,
        repo: row.repo ?? undefined,
        connected: true,
        connectedAt: row.connected_at.toISOString(),
      };
    }
    if (row.type === "slack") return {
      id: row.id,
      type: "slack",
      workspaceId,
      connectionName: row.connection_name,
      connectionScope: row.connection_scope,
      ownerUserId: row.owner_user_id ?? undefined,
      connectedByName: row.connected_by_name ?? undefined,
      teamName: row.team_name,
      connected: true,
      connectedAt: row.connected_at.toISOString(),
    };
    return {
      id: row.id,
      type: row.type,
      workspaceId,
      connectionName: row.connection_name,
      connectionScope: row.connection_scope,
      ownerUserId: row.owner_user_id ?? undefined,
      connectedByName: row.connected_by_name ?? undefined,
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
  type: "github" | "slack" | "linear" | "notion" | "figma",
  connectionId?: string
): Promise<{ token: string; owner?: string; repo?: string; teamName?: string } | null> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT owner, repo, team_name, encrypted_token
     FROM integrations WHERE workspace_id = $1 AND type = $2 AND ($3::uuid IS NULL OR id = $3) ORDER BY (connection_scope = 'shared') DESC, connected_at DESC LIMIT 1`,
    [workspaceId, type, connectionId ?? null]
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

export async function deleteIntegrationForOwner(
  workspaceId: string,
  type: "github" | "slack" | "linear" | "notion" | "figma",
  integrationId: string,
  ownerUserId: string
): Promise<boolean> {
  const result = await getPool().query(
    `DELETE FROM integrations WHERE workspace_id = $1 AND type = $2 AND id = $3 AND owner_user_id = $4`,
    [workspaceId, type, integrationId, ownerUserId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function deletePersonalIntegrationsForUser(userId: string): Promise<void> {
  await getPool().query(`DELETE FROM integrations WHERE owner_user_id = $1 AND connection_scope = 'personal'`, [userId]);
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
