// Workspace activity (audit) log.
import type {
  AuditActorType,
  AuditEvent,
  AuditEventType } from "@mai-chat/shared-types";
import { getPool } from "./pool.js";


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
  const limit = Math.min(Math.max(Math.floor(options.limit ?? 50), 1), 200);
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
