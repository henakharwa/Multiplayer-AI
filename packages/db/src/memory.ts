// Workspace memory entries and the agent memory context.
import type {
  WorkspaceMemory,
  WorkspaceMemoryKind } from "@mai-chat/shared-types";
import { getPool } from "./pool.js";

import { getUserById } from "./users.js";

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
