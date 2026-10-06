// Postgres-backed RoomBus: lets several chat-server processes share live
// chat. Each event is stored in realtime_events and announced with
// pg_notify; every process LISTENs, reads the event by id and delivers it
// to its own sockets. The agent-turn lock is a row in agent_turn_locks.
//
// Enabled in production (or with REALTIME_BUS=postgres). Without it the
// server keeps all live state in memory, which is correct for one process.
import { randomUUID } from "node:crypto";
import * as db from "@mai-chat/db";
import type { BusMessage, RoomBus } from "./rooms.js";

const PRUNE_INTERVAL_MS = 60_000;

// A dedicated pg connection (not from the pool) that holds the LISTEN.
type ListenerClient = Awaited<ReturnType<typeof db.openListenerConnection>>;

/** Returns immediately; the LISTEN connection is opened in the background. */
export function createPostgresRoomBus(): RoomBus {
  const instanceId = randomUUID();
  const handlers: Array<(message: BusMessage) => void> = [];
  let listener: ListenerClient | null = null;
  let closed = false;
  const onNotification = (note: { channel: string; payload?: string | undefined }) => {
    if (note.channel !== db.REALTIME_CHANNEL || !note.payload) return;
    let envelope: { id?: string; origin?: string };
    try { envelope = JSON.parse(note.payload); } catch { return; }
    if (!envelope.id || envelope.origin === instanceId) return;
    void db.getRealtimeEvent(envelope.id).then((event) => {
      if (!event) return;
      for (const handler of handlers) handler(event.payload as BusMessage);
    }).catch((error) => console.error("realtime event read failed", error));
  };
  const ready = db.openListenerConnection().then(async (client: ListenerClient) => {
    if (closed) { await db.closeListenerConnection(client); return; }
    listener = client;
    client.on("notification", onNotification);
    client.on("error", (error) => console.error("realtime listener error", error));
    await client.query(`LISTEN ${db.REALTIME_CHANNEL}`);
  }).catch((error) => console.error("realtime listener could not start", error));
  const pruner = setInterval(() => { void db.pruneRealtimeEvents().catch(() => undefined); }, PRUNE_INTERVAL_MS);
  pruner.unref();

  return {
    instanceId,
    async publish(message) {
      if (closed) return;
      await db.publishRealtimeEvent(message.room, instanceId, message);
    },
    subscribe(handler) {
      handlers.push(handler);
    },
    tryLock(room, ttlSeconds) {
      return db.tryAcquireAgentTurnLock(room, instanceId, ttlSeconds);
    },
    unlock(room) {
      return db.releaseAgentTurnLock(room, instanceId);
    },
    async close() {
      closed = true;
      clearInterval(pruner);
      await ready;
      if (listener) {
        await db.closeListenerConnection(listener);
        listener = null;
      }
    },
  };
}

export function realtimeBusEnabled(): boolean {
  const mode = process.env.REALTIME_BUS;
  if (mode === "memory") return false;
  return mode === "postgres" || process.env.NODE_ENV === "production";
}
