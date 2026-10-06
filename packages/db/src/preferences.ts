// Small per-member settings stored per workspace.
import { getPool } from "./pool.js";


/** Reads one of a member's small per-workspace settings, or null if unset. */
export async function getUserWorkspacePreference(workspaceId: string, userId: string, key: string): Promise<unknown | null> {
  const result = await getPool().query("SELECT value FROM user_workspace_preferences WHERE workspace_id=$1 AND user_id=$2 AND key=$3", [workspaceId, userId, key]);
  return result.rows[0] ? result.rows[0].value : null;
}

/** Saves one of a member's small per-workspace settings. */
export async function setUserWorkspacePreference(workspaceId: string, userId: string, key: string, value: unknown): Promise<void> {
  await getPool().query(
    "INSERT INTO user_workspace_preferences (workspace_id,user_id,key,value,updated_at) VALUES ($1,$2,$3,$4::jsonb,now()) ON CONFLICT (workspace_id,user_id,key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()",
    [workspaceId, userId, key, JSON.stringify(value)]
  );
}
