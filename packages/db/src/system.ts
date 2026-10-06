// Database utilities: advisory locks, OAuth state, rate limits and health checks.
import { getPool } from "./pool.js";


/**
 * Runs a maintenance task only when this server instance owns its database
 * advisory lock. It keeps in-process timers safe when the service scales to
 * more than one instance without adding a separate queue dependency.
 */
export async function runWithAdvisoryLock<T>(key: string, task: () => Promise<T>): Promise<T | undefined> {
  const pool = getPool();
  const acquired = await pool.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [key]);
  if (!acquired.rows[0]?.locked) return undefined;
  try {
    return await task();
  } finally {
    await pool.query("SELECT pg_advisory_unlock(hashtext($1))", [key]);
  }
}

export async function saveOAuthPendingState(state: string, flow: string, payload: Record<string, unknown>, expiresAt: Date): Promise<void> {
  await getPool().query("DELETE FROM oauth_pending_states WHERE expires_at <= now()");
  await getPool().query("INSERT INTO oauth_pending_states (state,flow,payload,expires_at) VALUES ($1,$2,$3,$4)", [state, flow, JSON.stringify(payload), expiresAt]);
}
export async function consumeOAuthPendingState<T extends Record<string, unknown>>(state: string, flow: string): Promise<T | null> {
  await getPool().query("DELETE FROM oauth_pending_states WHERE state=$1 AND expires_at <= now()", [state]);
  const result = await getPool().query("DELETE FROM oauth_pending_states WHERE state=$1 AND flow=$2 AND expires_at > now() RETURNING payload", [state, flow]);
  return result.rows[0]?.payload as T | undefined ?? null;
}
export async function consumeRateLimit(scope: string, subject: string, maxAttempts: number, windowSeconds: number): Promise<boolean> {
  await getPool().query("DELETE FROM auth_rate_limits WHERE window_ends_at <= now()");
  const result = await getPool().query(`INSERT INTO auth_rate_limits (scope,subject,attempts,window_ends_at) VALUES ($1,$2,1,now()+($3 * interval '1 second')) ON CONFLICT (scope,subject) DO UPDATE SET attempts=CASE WHEN auth_rate_limits.window_ends_at <= now() THEN 1 ELSE auth_rate_limits.attempts+1 END, window_ends_at=CASE WHEN auth_rate_limits.window_ends_at <= now() THEN now()+($3 * interval '1 second') ELSE auth_rate_limits.window_ends_at END RETURNING attempts,window_ends_at`, [scope, subject, windowSeconds]);
  return Number(result.rows[0].attempts) <= maxAttempts;
}

/** A deliberately small database readiness probe for the deployment health endpoint. */
export async function checkDatabaseHealth(): Promise<void> {
  await getPool().query("SELECT 1");
}
