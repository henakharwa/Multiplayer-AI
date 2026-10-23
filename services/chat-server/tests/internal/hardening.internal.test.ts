// Regression coverage for four bugs found in a code review (2026-10-22):
// a crash on a failed database write in live chat, unbounded chat messages,
// no per-person limit on agent turns, and pending actions that ran twice
// when approved twice at the same moment. (The account-takeover regression
// lives with the other sign-in tests in tests/email-google-auth.test.ts.)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { WebSocket } from "ws";
import * as db from "@mai-chat/db";
import { createChatServer, MAX_CHAT_MESSAGE_CHARS, type CreateServerDeps } from "../../src/server.js";
import type { ToolExecutor } from "../../src/tools.js";
import { makeDeps, makeUser, makeWorkspace, setupDatabase, type TestUser } from "./helpers.js";

beforeAll(setupDatabase);
afterAll(async () => {
  await db.getPool().query("ALTER TABLE messages DROP CONSTRAINT IF EXISTS hardening_test_reject_marker");
});

type Event = { type: string; error?: string; status?: string; message?: { content: string } };

async function startServer(overrides: Partial<CreateServerDeps> = {}) {
  const chat = createChatServer(makeDeps(overrides));
  await new Promise<void>((resolve) => chat.server.listen(0, resolve));
  const port = (chat.server.address() as { port: number }).port;
  return { ...chat, port, stop: () => new Promise<void>((resolve) => chat.server.close(() => resolve())) };
}

async function openChat(port: number, user: TestUser, workspace: { id: string; conversationId: string }) {
  const ws = new WebSocket(`ws://localhost:${port}/ws?workspaceId=${workspace.id}&conversationId=${workspace.conversationId}`, { headers: { Cookie: user.cookie } });
  const events: Event[] = [];
  let closeCode: number | undefined;
  ws.on("message", (data) => events.push(JSON.parse(data.toString())));
  ws.on("close", (code) => { closeCode = code; });
  ws.on("error", () => undefined);
  await waitFor(() => events.some((event) => event.type === "history"));
  return { ws, events, closeCode: () => closeCode };
}

async function waitFor(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for condition");
}

describe("HD-01 live chat survives a failed database write", () => {
  it("reports the failure to the sender and keeps serving everyone", async () => {
    const { app, port, stop } = await startServer();
    const admin = await makeUser("Admin");
    const workspace = await makeWorkspace(app, admin);
    const chat = await openChat(port, admin, workspace);
    // Make the database reject exactly one message, the way a lost
    // connection or a full disk would.
    await db.getPool().query("ALTER TABLE messages ADD CONSTRAINT hardening_test_reject_marker CHECK (content NOT LIKE '%hardening-reject-me%') NOT VALID");
    try {
      chat.ws.send(JSON.stringify({ type: "chat", content: "@agent hardening-reject-me" }));
      await waitFor(() => chat.events.some((event) => event.type === "error" && /couldn't be sent/.test(event.error ?? "")));
    } finally {
      await db.getPool().query("ALTER TABLE messages DROP CONSTRAINT IF EXISTS hardening_test_reject_marker");
    }
    // The agent lock was handed back, so the room is usable straight away.
    chat.ws.send(JSON.stringify({ type: "chat", content: "@agent are you still there?" }));
    await waitFor(() => chat.events.some((event) => event.type === "message" && event.message?.content === "Agent reply"));
    expect((await request(app).get("/auth/me").set("Cookie", admin.cookie)).status).toBe(200);
    chat.ws.close();
    await stop();
  });
});

describe("HD-02 chat message size", () => {
  it("rejects a message over the limit without storing or broadcasting it", async () => {
    const { app, port, stop } = await startServer();
    const admin = await makeUser("Admin");
    const workspace = await makeWorkspace(app, admin);
    const chat = await openChat(port, admin, workspace);
    chat.ws.send(JSON.stringify({ type: "chat", content: "y".repeat(MAX_CHAT_MESSAGE_CHARS + 1) }));
    await waitFor(() => chat.events.some((event) => event.type === "error" && /at most/.test(event.error ?? "")));
    expect(await db.listMessages(workspace.id, workspace.conversationId)).toHaveLength(0);
    chat.ws.close();
    await stop();
  });

  it("closes a connection that sends an oversized frame", async () => {
    const { app, port, stop } = await startServer();
    const admin = await makeUser("Admin");
    const workspace = await makeWorkspace(app, admin);
    const chat = await openChat(port, admin, workspace);
    chat.ws.send(JSON.stringify({ type: "chat", content: "z".repeat(2 * 1024 * 1024) }));
    await waitFor(() => chat.closeCode() !== undefined);
    expect(chat.closeCode()).toBe(1009);
    expect(await db.listMessages(workspace.id, workspace.conversationId)).toHaveLength(0);
    await stop();
  });
});

describe("HD-03 per-person agent turn limit", () => {
  it("stops starting agent turns once someone reaches their hourly allowance", async () => {
    const previous = process.env.AGENT_TURNS_PER_USER_PER_HOUR;
    process.env.AGENT_TURNS_PER_USER_PER_HOUR = "2";
    let agentTurns = 0;
    const { app, port, stop } = await startServer({ runAgentTurn: async () => { agentTurns++; return { reply: "Agent reply", toolCallsMade: 0 }; } });
    try {
      const admin = await makeUser("Admin");
      const workspace = await makeWorkspace(app, admin);
      const chat = await openChat(port, admin, workspace);
      for (let turn = 1; turn <= 2; turn++) {
        chat.ws.send(JSON.stringify({ type: "chat", content: `@agent request ${turn}` }));
        await waitFor(() => chat.events.filter((event) => event.type === "agent_status" && event.status === "idle").length === turn);
      }
      chat.ws.send(JSON.stringify({ type: "chat", content: "@agent request 3" }));
      await waitFor(() => chat.events.some((event) => event.type === "error" && /hourly limit/.test(event.error ?? "")));
      expect(agentTurns).toBe(2);
      // Handoffs to teammates never touch the agent and stay allowed.
      const teammate = await makeUser("Teammate");
      await request(app).post(`/workspaces/by-code/${workspace.joinCode}/join`).set("Cookie", teammate.cookie);
      chat.ws.send(JSON.stringify({ type: "chat", content: "@Teammate can you take this?" }));
      await waitFor(() => chat.events.some((event) => event.type === "message" && event.message?.content === "@Teammate can you take this?"));
      chat.ws.close();
    } finally {
      if (previous === undefined) delete process.env.AGENT_TURNS_PER_USER_PER_HOUR;
      else process.env.AGENT_TURNS_PER_USER_PER_HOUR = previous;
      await stop();
    }
  });
});

describe("HD-04 approving the same action twice at once", () => {
  it("runs the write exactly once", async () => {
    let runs = 0;
    const tool: ToolExecutor = {
      definition: { type: "function", function: { name: "fake_write_tool", description: "fake", parameters: { type: "object" } } },
      mutates: true,
      execute: async () => { runs++; await new Promise((resolve) => setTimeout(resolve, 200)); return "created issue"; },
    };
    const { app, stop } = await startServer({ githubMcpToolsFactory: async () => [tool] });
    const admin = await makeUser("Admin");
    const secondAdmin = await makeUser("Second Admin");
    const workspace = await makeWorkspace(app, admin, [secondAdmin]);
    await db.getPool().query("UPDATE workspace_members SET role = 'admin' WHERE workspace_id = $1 AND user_id = $2", [workspace.id, secondAdmin.id]);
    await db.upsertGithubIntegration({ workspaceId: workspace.id, owner: "acme", repo: "widgets", token: "token", connectionName: "GitHub", connectionScope: "personal", ownerUserId: admin.id });
    const pending = await db.createPendingAction({ workspaceId: workspace.id, conversationId: workspace.conversationId, toolName: "fake_write_tool", description: "open an issue", args: {}, requestedByUserId: admin.id });
    const url = `/workspaces/${workspace.id}/actions/${pending.id}/confirm`;
    const responses = await Promise.all([
      request(app).post(url).set("Cookie", admin.cookie).send({}),
      request(app).post(url).set("Cookie", secondAdmin.cookie).send({}),
      request(app).post(url).set("Cookie", admin.cookie).send({}),
    ]);
    expect(runs).toBe(1);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(2);
    expect((await db.getPendingAction(workspace.id, pending.id))?.status).toBe("confirmed");
    // A later retry sees the settled result rather than running it again.
    expect((await request(app).post(url).set("Cookie", admin.cookie).send({})).status).toBe(409);
    expect(runs).toBe(1);
    await stop();
  });
});

describe("HD-05 signing out on one device", () => {
  it("keeps personal tool connections until the person's last session signs out", async () => {
    const { app, stop } = await startServer();
    const admin = await makeUser("Admin");
    const workspace = await makeWorkspace(app, admin);
    await db.upsertGithubIntegration({ workspaceId: workspace.id, owner: "acme", repo: "widgets", token: "token", connectionName: "GitHub", connectionScope: "personal", ownerUserId: admin.id });
    const laptop = `mai_session=${(await db.createSession(admin.id, 60 * 60_000)).token}`;
    const personal = async () => (await db.listIntegrations(workspace.id)).filter((integration) => integration.type === "github");

    // Signing out on the laptop leaves the other session (admin.cookie) and the connection intact.
    expect((await request(app).post("/auth/logout").set("Cookie", laptop)).status).toBe(204);
    expect((await request(app).get("/auth/me").set("Cookie", laptop)).status).toBe(401);
    expect((await request(app).get("/auth/me").set("Cookie", admin.cookie)).status).toBe(200);
    expect(await personal()).toHaveLength(1);

    // The last sign-out still disconnects personal tools, as before.
    expect((await request(app).post("/auth/logout").set("Cookie", admin.cookie)).status).toBe(204);
    expect(await personal()).toHaveLength(0);
    await stop();
  });
});
