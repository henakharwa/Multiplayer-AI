// Conversations and chat messages.
import type {
  ChatMessage,
  Conversation,
  MessageRole } from "@mai-chat/shared-types";
import { getPool } from "./pool.js";


const MESSAGE_COLUMNS = "id, workspace_id, conversation_id, role, author_name, user_id, content, created_at, mentions_agent, mentioned_user_ids";

const CONVERSATION_COLUMNS = "id, workspace_id, title, created_by_user_id, created_at, updated_at, pinned_at, archived_at";

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
  // the baseline migration's comment on messages.user_id for why this exists
  // alongside author_name rather than replacing it.
  userId?: string;
  // @-mention / handoff mechanics -- see mentions_agent's sql/migrations/0001_baseline.sql
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
