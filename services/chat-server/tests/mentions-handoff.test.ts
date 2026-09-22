import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import request from "supertest";
import { WebSocket } from "ws";
import * as db from "@mai-chat/db";
import { getPool, closePool, upsertUserFromGithub, createSession } from "@mai-chat/db";
import { createChatServer, type CreateServerDeps } from "../src/server.js";
import type { GithubClient } from "@mai-chat/integrations";

// End-to-end coverage for docs/spec.md's Phase 2 "Handoff and @-mention
// mechanics": a message that @-mentions ONLY a teammate (never the
// agent) is handed off -- it's still a normal, visible chat message, it
// just never starts an agent turn, and it's exempt from the "one agent
// turn at a time" busy-lock since it was never going to touch the agent.
// See services/chat-server/src/mentions.ts (the parsing) and server.ts's
// WebSocket handler (where the decision to skip the agent turn is made).

loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
loadEnv();

const fakeGithubClient: GithubClient = { listIssues: async () => [] };

function makeDeps(overrides: Partial<CreateServerDeps> = {}): CreateServerDeps {
  return {
    githubClientFactory: () => fakeGithubClient,
    githubMcpToolsFactory: async () => [],
    slackMcpToolsFactory: async () => [],
    runAgentTurn: async () => ({ reply: "Agent reply", toolCallsMade: 0 }),
    githubOAuthConfig: { clientId: "", clientSecret: "", redirectUri: "", webAppUrl: "http://localhost:3000" },
    githubOAuthDeps: { exchangeCodeForToken: async () => ({ error: "unused" }), listRepositoriesForToken: async () => [] },
    slackOAuthConfig: { clientId: "", clientSecret: "", redirectUri: "", webAppUrl: "http://localhost:3000" },
    slackOAuthDeps: { exchangeCodeForToken: async () => ({ error: "unused" }) },
    ...overrides,
  };
}

let aliceCookie: string;
let bobCookie: string;
let bobName: string;

beforeAll(async () => {
  const schema = await readFile(fileURLToPath(new URL("../../../packages/db/sql/schema.sql", import.meta.url)), "utf8");
  await getPool().query(schema);
  const alice = await upsertUserFromGithub({ githubId: "mentions-alice", username: "alice", displayName: "Alice" });
  const bob = await upsertUserFromGithub({ githubId: "mentions-bob", username: "bob", displayName: "Bob" });
  bobName = bob.displayName;
  aliceCookie = `mai_session=${(await createSession(alice.id, 60_000)).token}`;
  bobCookie = `mai_session=${(await createSession(bob.id, 60_000)).token}`;
});
afterAll(async () => { await closePool(); });

async function createTestWorkspace(app: ReturnType<typeof import("../src/server.js").createApp>) {
  const res = await request(app).post("/workspaces").set("Cookie", aliceCookie).send({ name: `Mentions Co ${Math.random()}` });
  return res.body as { id: string; joinCode: string; name: string };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timed out waiting for condition");
}

describe("@-mention / handoff mechanics", () => {
  it("a message @-mentioning only a teammate is broadcast normally but never starts an agent turn", async () => {
    let agentCalls = 0;
    const { server, app } = createChatServer(makeDeps({ runAgentTurn: async () => { agentCalls++; return { reply: "should not run", toolCallsMade: 0 }; } }));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    const workspace = await createTestWorkspace(app);

    const wsUrlBase = `ws://localhost:${port}/ws`;
    const alice = new WebSocket(`${wsUrlBase}?workspaceId=${workspace.id}`, { headers: { Cookie: aliceCookie } });
    const bob = new WebSocket(`${wsUrlBase}?workspaceId=${workspace.id}`, { headers: { Cookie: bobCookie } });
    const bobEvents: { type: string; message?: { content: string; mentionsAgent: boolean; mentionedUserIds: string[] } }[] = [];
    bob.on("message", (data) => bobEvents.push(JSON.parse(data.toString())));

    await Promise.all([new Promise((r) => alice.on("open", r)), new Promise((r) => bob.on("open", r))]);
    await waitFor(() => bobEvents.some((e) => e.type === "presence"));

    alice.send(JSON.stringify({ type: "chat", content: `@${bobName} can you take this one?` }));

    await waitFor(() => bobEvents.some((e) => e.type === "message" && e.message?.content.includes("take this one")));
    const delivered = bobEvents.find((e) => e.type === "message" && e.message?.content.includes("take this one"));
    expect(delivered?.message?.mentionsAgent).toBe(false);
    expect(delivered?.message?.mentionedUserIds).toHaveLength(1);

    // Give any (wrongly) started agent turn a moment to have shown up.
    await new Promise((r) => setTimeout(r, 150));
    expect(agentCalls).toBe(0);
    expect(bobEvents.some((e) => e.type === "agent_status")).toBe(false);

    const audit = await db.listAuditEvents(workspace.id, { eventType: "handoff.directed" });
    expect(audit).toHaveLength(1);
    expect(audit[0].summary).toContain(bobName);
    expect(audit[0].summary).toContain("take this one");

    alice.close();
    bob.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("a handoff message is delivered even while the agent is busy on someone else's request", async () => {
    let resolveAgent: (() => void) | null = null;
    const agentGate = new Promise<void>((resolve) => { resolveAgent = resolve; });
    const { server, app } = createChatServer(
      makeDeps({ runAgentTurn: async () => { await agentGate; return { reply: "Done", toolCallsMade: 0 }; } })
    );
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    const workspace = await createTestWorkspace(app);

    const wsUrlBase = `ws://localhost:${port}/ws`;
    const alice = new WebSocket(`${wsUrlBase}?workspaceId=${workspace.id}`, { headers: { Cookie: aliceCookie } });
    const bob = new WebSocket(`${wsUrlBase}?workspaceId=${workspace.id}`, { headers: { Cookie: bobCookie } });
    const aliceEvents: { type: string; status?: string; error?: string; message?: { content: string } }[] = [];
    alice.on("message", (data) => aliceEvents.push(JSON.parse(data.toString())));

    await Promise.all([new Promise((r) => alice.on("open", r)), new Promise((r) => bob.on("open", r))]);
    await waitFor(() => aliceEvents.some((e) => e.type === "presence"));

    alice.send(JSON.stringify({ type: "chat", content: "@agent look into this" }));
    await waitFor(() => aliceEvents.some((e) => e.type === "agent_status" && e.status === "busy"));

    // A plain (non-mention) message is correctly rejected while busy...
    alice.send(JSON.stringify({ type: "chat", content: "another one for the agent" }));
    await waitFor(() => aliceEvents.some((e) => e.type === "error"));

    // ...but a handoff to a teammate goes through anyway.
    alice.send(JSON.stringify({ type: "chat", content: `@${bobName} can you look at this instead?` }));
    await waitFor(() => aliceEvents.some((e) => e.type === "message" && e.message?.content.includes("look at this instead")));

    resolveAgent?.();
    alice.close();
    bob.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("still starts an agent turn when the agent is explicitly @-mentioned alongside a teammate", async () => {
    let agentCalls = 0;
    const { server, app } = createChatServer(makeDeps({ runAgentTurn: async () => { agentCalls++; return { reply: "On it", toolCallsMade: 0 }; } }));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    const workspace = await createTestWorkspace(app);

    const alice = new WebSocket(`ws://localhost:${port}/ws?workspaceId=${workspace.id}`, { headers: { Cookie: aliceCookie } });
    const events: { type: string }[] = [];
    alice.on("message", (data) => events.push(JSON.parse(data.toString())));
    await new Promise((r) => alice.on("open", r));
    // Wait for "presence" (not just the socket's own "open"), same as the
    // other tests in this file -- the server's own message listener is
    // only registered after its async connect-time setup (session lookup,
    // workspace lookup, presence broadcast) finishes, so sending right on
    // "open" can race ahead of that and get silently dropped.
    await waitFor(() => events.some((e) => e.type === "presence"));

    alice.send(JSON.stringify({ type: "chat", content: `@agent and @${bobName}, take a look` }));
    await waitFor(() => events.some((e) => e.type === "agent_status"));
    await waitFor(() => agentCalls === 1);

    alice.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
