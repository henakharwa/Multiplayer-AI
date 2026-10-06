// Cross-instance coordination for live chat: shared event fan-out and
// the per-conversation agent-turn lock. See 0002_realtime_coordination.sql.
import { getPool } from "./pool.js";

export const REALTIME_CHANNEL = "realtime_events";

/** Stores an event and notifies every listening server process. */
export async function publishRealtimeEvent(room: string, origin: string, payload: unknown): Promise<void> {
  const result = await getPool().query("INSERT INTO realtime_events (room, origin, payload) VALUES ($1, $2, $3::jsonb) RETURNING id", [room, origin, JSON.stringify(payload)]);
  await getPool().query("SELECT pg_notify($1, $2)", [REALTIME_CHANNEL, JSON.stringify({ id: String(result.rows[0].id), origin })]);
}

export async function getRealtimeEvent(id: string): Promise<{ room: string; origin: string; payload: unknown } | null> {
  const result = await getPool().query("SELECT room, origin, payload FROM realtime_events WHERE id = $1", [id]);
  const row = result.rows[0];
  return row ? { room: String(row.room), origin: String(row.origin), payload: row.payload } : null;
}

/** Events only need to live long enough for every process to read them. */
export async function pruneRealtimeEvents(olderThanSeconds = 300): Promise<number> {
  const result = await getPool().query("DELETE FROM realtime_events WHERE created_at < now() - ($1::int * interval '1 second')", [olderThanSeconds]);
  return result.rowCount ?? 0;
}

/** Takes the room's agent-turn lock unless another holder has a live one. */
export async function tryAcquireAgentTurnLock(room: string, holder: string, ttlSeconds: number): Promise<boolean> {
  const result = await getPool().query(
    `INSERT INTO agent_turn_locks (room, holder, expires_at) VALUES ($1, $2, now() + ($3::int * interval '1 second'))
     ON CONFLICT (room) DO UPDATE SET holder = EXCLUDED.holder, expires_at = EXCLUDED.expires_at
     WHERE agent_turn_locks.expires_at < now()
     RETURNING room`,
    [room, holder, ttlSeconds]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function releaseAgentTurnLock(room: string, holder: string): Promise<void> {
  await getPool().query("DELETE FROM agent_turn_locks WHERE room = $1 AND holder = $2", [room, holder]);
}
