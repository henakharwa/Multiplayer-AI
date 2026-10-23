// Agent-proposed actions awaiting approval.
import type {
  ActionTarget,
  ActionWarning,
  PendingAction,
  PendingActionStatus } from "@mai-chat/shared-types";
import { getPool } from "./pool.js";


const PENDING_ACTION_COLUMNS =
  "id, workspace_id, conversation_id, tool_name, description, preview, args, status, result, created_at, resolved_at, requested_by_user_id, requested_by_name, agent_kind, run_as_user_id, run_as_account, target, warnings, executed_as_user_id, executed_as_account";

export async function createPendingAction(input: {
  workspaceId: string;
  conversationId: string;
  toolName: string;
  description: string;
  preview?: string | null;
  args: Record<string, unknown>;
  // Whoever's chat message triggered the agent turn that proposed this --
  // see the baseline migration's comment on these columns. Omitted when unknown.
  requestedByUserId?: string | null;
  requestedByName?: string | null;
  agentKind?: PendingAction["agentKind"];
  // Whose connection it runs with when approved; defaults to the requester.
  runAsUserId?: string | null;
  runAsAccount?: string | null;
  target?: ActionTarget | null;
  warnings?: ActionWarning[];
}): Promise<PendingAction> {
  const pool = getPool();
  const result = await pool.query(
    `INSERT INTO pending_actions (workspace_id, conversation_id, tool_name, description, preview, args, requested_by_user_id, requested_by_name, agent_kind, run_as_user_id, run_as_account, target, warnings)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
      input.runAsUserId === undefined ? input.requestedByUserId ?? null : input.runAsUserId,
      input.runAsAccount ?? null,
      input.target ? JSON.stringify(input.target) : null,
      JSON.stringify(input.warnings ?? []),
    ]
  );
  return toPendingAction(result.rows[0]);
}

/**
 * Actions anywhere in the workspace that a new proposal could duplicate:
 * everything still waiting, plus actions confirmed in the last `hours`.
 */
export async function listActionsForConflictCheck(workspaceId: string, hours = 24): Promise<Array<PendingAction & { conversationTitle: string | null }>> {
  const result = await getPool().query(
    `SELECT ${PENDING_ACTION_COLUMNS.split(", ").map((column) => `a.${column}`).join(", ")}, c.title AS conversation_title
     FROM pending_actions a LEFT JOIN conversations c ON c.id = a.conversation_id
     WHERE a.workspace_id = $1 AND (a.status = 'pending' OR (a.status = 'confirmed' AND a.resolved_at >= now() - ($2::int * interval '1 hour')))
     ORDER BY a.created_at DESC LIMIT 200`,
    [workspaceId, hours]
  );
  return result.rows.map((row) => ({ ...toPendingAction(row), conversationTitle: row.conversation_title ?? null }));
}

/** Records which member (or the workspace app) an approved action actually ran as. */
export async function setActionExecutedAs(workspaceId: string, id: string, executedAsUserId: string | null, executedAsAccount: string | null): Promise<void> {
  await getPool().query(
    "UPDATE pending_actions SET executed_as_user_id = $3, executed_as_account = $4 WHERE workspace_id = $1 AND id = $2",
    [workspaceId, id, executedAsUserId, executedAsAccount]
  );
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
  run_as_user_id?: string | null;
  run_as_account?: string | null;
  target?: ActionTarget | null;
  warnings?: ActionWarning[] | null;
  executed_as_user_id?: string | null;
  executed_as_account?: string | null;
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
    runAsUserId: row.run_as_user_id ?? null,
    runAsName: row.requested_by_name ?? null,
    runAsAccount: row.run_as_account ?? null,
    target: row.target ?? null,
    warnings: Array.isArray(row.warnings) ? row.warnings : [],
    executedAsUserId: row.executed_as_user_id ?? null,
    executedAsAccount: row.executed_as_account ?? null,
  };
}

// -- Action audit trail (docs/spec.md Phase 2: "who asked for what, what
// the agent did, when") -- see the baseline migration's comment on audit_events and
// services/chat-server/src/audit.ts for where these get written from. -----
