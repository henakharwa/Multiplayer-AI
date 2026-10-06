import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import type { WebSocket } from "ws";
import { closePool, runMigrations } from "@mai-chat/db";
import { RoomRegistry, type RoomBus } from "../src/rooms.js";
import { createPostgresRoomBus } from "../src/realtime-bus.js";

loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

// Two registries, each with its own Postgres bus, stand in for two
// chat-server processes sharing one database.
let busA: RoomBus; let busB: RoomBus;
let a: RoomRegistry; let b: RoomRegistry;
beforeAll(async () => {
  await runMigrations();
  busA = createPostgresRoomBus(); busB = createPostgresRoomBus();
  a = new RoomRegistry(busA); b = new RoomRegistry(busB);
  await new Promise((resolve) => setTimeout(resolve, 300)); // LISTEN connections
});
afterAll(async () => { await busA.close(); await busB.close(); await closePool(); });

function fakeSocket() {
  const received: unknown[] = [];
  const ws = { OPEN: 1, CONNECTING: 0, readyState: 1, send: (data: string) => received.push(JSON.parse(data)), close: () => undefined } as unknown as WebSocket;
  return { ws, received };
}
async function waitFor(predicate: () => boolean, timeoutMs = 3000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("realtime coordination across processes", () => {
  it("delivers a broadcast from one process to sockets connected to another", async () => {
    const room = `room-${Math.random()}`;
    const socket = fakeSocket();
    a.join(room, socket.ws, { clientId: "c1", userId: "u1", displayName: "Ada", connectedAt: new Date().toISOString() });
    b.broadcast(room, { type: "message", text: "hello from B" });
    await waitFor(() => socket.received.some((event) => (event as { text?: string }).text === "hello from B"));
  });

  it("shares presence so each process sees members connected elsewhere", async () => {
    const room = `room-${Math.random()}`;
    a.join(room, fakeSocket().ws, { clientId: "c2", userId: "u2", displayName: "Ben", connectedAt: new Date().toISOString() });
    b.join(room, fakeSocket().ws, { clientId: "c3", userId: "u3", displayName: "Cy", connectedAt: new Date().toISOString() });
    await waitFor(() => b.participants(room).length === 2 && a.participants(room).length === 2);
  });

  it("allows only one agent turn per conversation across processes", async () => {
    const room = `room-${Math.random()}`;
    expect(await a.tryAcquireAgentTurn(room)).toBe(true);
    expect(await b.tryAcquireAgentTurn(room)).toBe(false);
    await a.releaseAgentTurn(room);
    expect(await b.tryAcquireAgentTurn(room)).toBe(true);
    await b.releaseAgentTurn(room);
  });
});
