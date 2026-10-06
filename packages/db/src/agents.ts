// Workspace agents and their published versions.
import type {
  WorkspaceAgent,
  WorkspaceAgentVersion } from "@mai-chat/shared-types";
import { getPool } from "./pool.js";


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
