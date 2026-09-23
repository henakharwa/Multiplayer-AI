import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { WebSocket } from "ws";
import { closePool, createSession, getPool, upsertUserFromGithub } from "@mai-chat/db";
import { createChatServer, type CreateServerDeps } from "../src/server.js";
import type { GithubClient } from "@mai-chat/integrations";
import type { ToolExecutor } from "../src/tools.js";

loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
loadEnv();

// Release-gate coverage for the second YC demo integration. The app's OAuth
// routes, WebSocket chat, approval endpoint, and audit trail are real; only
// Slack's external OAuth exchange, MCP client, and the LLM decision are
// deterministic test doubles.

let adminCookie: string;

const githubClient: GithubClient = { listIssues: async () => [] };

function makeDeps(overrides: Partial<CreateServerDeps> = {}): CreateServerDeps {
  return {
    githubClientFactory: () => githubClient,
    githubMcpToolsFactory: async () => [],
    slackMcpToolsFactory: async () => [],
    runAgentTurn: async () => ({ reply: "Agent reply", toolCallsMade: 0 }),
    githubOAuthConfig: { clientId: "", clientSecret: "", redirectUri: "", webAppUrl: "http://localhost:3000" },
    githubOAuthDeps: { exchangeCodeForToken: async () => ({ accessToken: "unused" }), listRepositoriesForToken: async () => [] },
    slackOAuthConfig: {
      clientId: "test-slack-client",
      clientSecret: "test-slack-secret",
      redirectUri: "http://localhost:4000/auth/slack/callback",
      webAppUrl: "http://localhost:3000",
    },
    slackOAuthDeps: { exchangeCodeForToken: async () => ({ accessToken: "slack-oauth-token", teamName: "Agent QA" }) },
    ...overrides,
  };
}

beforeAll(async () => {
  const schema = await readFile(fileURLToPath(new URL("../../../packages/db/sql/schema.sql", import.meta.url)), "utf8");
  await getPool().query(schema);
  const admin = await upsertUserFromGithub({
    githubId: `slack-workflow-admin-${randomUUID()}`,
    username: "slack-workflow-admin",
    displayName: "Slack Workflow Admin",
  });
  adminCookie = `mai_session=${(await createSession(admin.id, 60_000)).token}`;
});

afterAll(async () => {
  await closePool();
});

describe("Slack workflow release gate", () => {
  it("connects through OAuth, reads channels, proposes a message, approves it, and records the audit trail", async () => {
    const readCalls: Record<string, unknown>[] = [];
    const writeCalls: Record<string, unknown>[] = [];
    const readTool: ToolExecutor = {
      definition: { type: "function", function: { name: "list_channels", description: "List Slack channels", parameters: { type: "object" } } },
      execute: async (args) => {
        readCalls.push(args);
        return [{ id: "C_AGENT_QA", name: "agent-qa" }];
      },
    };
    const writeTool: ToolExecutor = {
      definition: { type: "function", function: { name: "post_message", description: "Post a Slack message", parameters: { type: "object" } } },
      mutates: true,
      describe: (args) => `Post message to ${String(args.channel)}`,
      preview: (args) => `Message: ${String(args.text)}`,
      execute: async (args) => {
        writeCalls.push(args);
        return { ok: true, channel: args.channel, ts: "123.456" };
      },
    };
    const { app, server } = createChatServer(
      makeDeps({
        slackMcpToolsFactory: async () => [readTool, writeTool],
        slackOAuthDeps: {
          exchangeCodeForToken: async (code) => {
            expect(code).toBe("slack-authorize-code");
            return { accessToken: "slack-oauth-token", teamName: "Agent QA" };
          },
        },
        runAgentTurn: async ({ tools, agentKind }) => {
          expect(agentKind).toBe("slack");
          const listChannels = tools.find((tool) => tool.definition.function.name === "list_channels");
          const postMessage = tools.find((tool) => tool.definition.function.name === "post_message");
          expect(listChannels).toBeDefined();
          expect(postMessage).toBeDefined();
          await listChannels!.execute({});
          const proposal = await postMessage!.execute({ channel: "C_AGENT_QA", text: "Agent QA seed message" });
          expect(proposal).toMatchObject({ status: "awaiting_user_confirmation" });
          return { reply: "I found the Agent QA channel and proposed a test message.", toolCallsMade: 2 };
        },
      })
    );

    const workspace = await request(app)
      .post("/workspaces")
      .set("Cookie", adminCookie)
      .send({ name: `Slack workflow ${randomUUID()}` });
    expect(workspace.status).toBe(201);
    const workspaceId = workspace.body.id as string;

    const oauthStart = await request(app)
      .get(`/workspaces/${workspaceId}/integrations/slack/oauth/start`)
      .set("Cookie", adminCookie);
    expect(oauthStart.status).toBe(302);
    const authorizeUrl = new URL(oauthStart.headers.location);
    expect(authorizeUrl.origin).toBe("https://slack.com");

    const oauthCallback = await request(app)
      .get("/auth/slack/callback")
      .set("Cookie", adminCookie)
      .query({ state: authorizeUrl.searchParams.get("state"), code: "slack-authorize-code" });
    expect(oauthCallback.status).toBe(302);
    expect(oauthCallback.headers.location).toBe(`http://localhost:3000/w/${workspaceId}?slack=connected`);

    const conversations = await request(app).get(`/workspaces/${workspaceId}/conversations`).set("Cookie", adminCookie);
    const conversationId = conversations.body[0].id as string;

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as { port: number }).port;
    const socket = new WebSocket(`ws://localhost:${port}/ws?workspaceId=${workspaceId}&conversationId=${conversationId}`, {
      headers: { Cookie: adminCookie },
    });
    const events: Array<{ type: string; status?: string }> = [];
    socket.on("message", (data) => events.push(JSON.parse(data.toString())));

    try {
      await new Promise<void>((resolve) => socket.on("open", () => resolve()));
      await waitFor(() => events.some((event) => event.type === "history"));
      socket.send(JSON.stringify({ type: "chat", agentKind: "slack", content: "List channels and post an Agent QA message." }));
      await waitFor(() => events.some((event) => event.type === "agent_status" && event.status === "idle"));

      expect(readCalls).toEqual([{}]);
      expect(writeCalls).toEqual([]);
      const pending = await request(app)
        .get(`/workspaces/${workspaceId}/actions`)
        .set("Cookie", adminCookie)
        .query({ conversationId });
      expect(pending.body).toEqual([
        expect.objectContaining({ toolName: "post_message", status: "pending", description: "Post message to C_AGENT_QA" }),
      ]);

      const approval = await request(app)
        .post(`/workspaces/${workspaceId}/actions/${pending.body[0].id}/confirm`)
        .set("Cookie", adminCookie);
      expect(approval.status).toBe(200);
      expect(approval.body).toMatchObject({ status: "confirmed" });
      expect(writeCalls).toEqual([{ channel: "C_AGENT_QA", text: "Agent QA seed message" }]);

      const audit = await request(app).get(`/workspaces/${workspaceId}/audit`).set("Cookie", adminCookie);
      expect(audit.body.events.map((event: { eventType: string }) => event.eventType)).toEqual(
        expect.arrayContaining(["integration.connected", "action.proposed", "action.confirmed"])
      );
    } finally {
      socket.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for WebSocket event");
}
