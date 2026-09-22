import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import request from "supertest";
import { getPool, closePool, upsertUserFromGithub, createSession } from "@mai-chat/db";
import { createChatServer, type CreateServerDeps } from "../src/server.js";
import type { ToolExecutor } from "../src/tools.js";
import type { GithubClient } from "@mai-chat/integrations";

loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
loadEnv();

// Regression coverage for a real bug found live: confirming a pending
// GitHub/Slack action that then fails (integration gone, or the tool
// itself throwing -- e.g. the GitHub MCP Docker container being
// unreachable) used to resolve the action silently. The card vanished
// from the UI with no chat message and no server log, so a human reading
// the room had no way to tell the confirm didn't actually work, and the
// agent's own next turn had no idea its proposal had failed either. Both
// gaps are fixed in services/chat-server/src/actions.ts's resolveAction.

let sessionCookie: string;
const fakeGithubClient: GithubClient = {
  listIssues: async () => [],
};

function makeDeps(overrides: Partial<CreateServerDeps> = {}): CreateServerDeps {
  return {
    githubClientFactory: () => fakeGithubClient,
    githubMcpToolsFactory: async () => [],
    slackMcpToolsFactory: async () => [],
    runAgentTurn: async () => ({ reply: "Agent reply", toolCallsMade: 0 }),
    githubOAuthConfig: { clientId: "", clientSecret: "", redirectUri: "", webAppUrl: "http://localhost:3000" },
    githubOAuthDeps: { exchangeCodeForToken: async () => ({ error: "not used in this test" }), listRepositoriesForToken: async () => [] },
    slackOAuthConfig: { clientId: "", clientSecret: "", redirectUri: "", webAppUrl: "http://localhost:3000" },
    slackOAuthDeps: { exchangeCodeForToken: async () => ({ error: "not used in this test" }) },
    ...overrides,
  };
}

beforeAll(async () => {
  const schema = await readFile(fileURLToPath(new URL("../../../packages/db/sql/schema.sql", import.meta.url)), "utf8");
  await getPool().query(schema);
  const user = await upsertUserFromGithub({ githubId: "test-auth-hena", username: "hena", displayName: "hena" });
  sessionCookie = `mai_session=${(await createSession(user.id, 60000)).token}`;
});

afterAll(async () => {
  await closePool();
});

async function createWorkspaceWithGithub(app: ReturnType<typeof import("../src/server.js").createApp>) {
  const created = await request(app).post("/workspaces").set("Cookie", sessionCookie).send({ name: `Confirm test ${Math.random()}` });
  const workspaceId = created.body.id as string;
  await request(app).post(`/workspaces/${workspaceId}/integrations/github`).set("Cookie", sessionCookie).send({ token: "gh-token", owner: "acme", repo: "widgets" });
  return workspaceId;
}

describe("confirming a pending action that fails", () => {
  it("tells the room and logs when the tool's own execute() throws (e.g. GitHub MCP unreachable)", async () => {
    const failingTool: ToolExecutor = {
      definition: { type: "function", function: { name: "fake_write_tool", description: "fake", parameters: { type: "object" } } },
      mutates: true,
      execute: async () => {
        throw new Error("boom: docker not reachable");
      },
    };
    const { app } = createChatServer(makeDeps({ githubMcpToolsFactory: async () => [failingTool] }));
    const workspaceId = await createWorkspaceWithGithub(app);

    // Create the pending action the same way wrapForProposal would, via a
    // direct DB call (no HTTP route creates one outside the agent loop).
    const db = await import("@mai-chat/db");
    const pending = await db.createPendingAction({
      workspaceId,
      toolName: "fake_write_tool",
      description: "edit main.py",
      args: {},
    });

    const confirmRes = await request(app).post(`/workspaces/${workspaceId}/actions/${pending.id}/confirm`).set("Cookie", sessionCookie).send({ actorName: "hena" });
    expect(confirmRes.status).toBe(502);
    expect(confirmRes.body.error).toContain("boom: docker not reachable");

    const resolved = await db.getPendingAction(workspaceId, pending.id);
    expect(resolved?.status).toBe("failed");

    const messages = await db.listMessages(workspaceId);
    const failureMessage = messages.find((m) => m.role === "system" && m.content.includes("tried to confirm"));
    expect(failureMessage).toBeDefined();
    expect(failureMessage?.content).toContain("hena");
    expect(failureMessage?.content).toContain("boom: docker not reachable");
  });

  it("tells the room when the integration is no longer connected by the time someone confirms", async () => {
    const { app } = createChatServer(makeDeps({ githubMcpToolsFactory: async () => [] }));
    const workspaceId = await createWorkspaceWithGithub(app);

    const db = await import("@mai-chat/db");
    const pending = await db.createPendingAction({
      workspaceId,
      toolName: "some_tool_that_is_gone",
      description: "open a PR",
      args: {},
    });

    const confirmRes = await request(app).post(`/workspaces/${workspaceId}/actions/${pending.id}/confirm`).set("Cookie", sessionCookie).send({ actorName: "hena" });
    expect(confirmRes.status).toBe(409);

    const resolved = await db.getPendingAction(workspaceId, pending.id);
    expect(resolved?.status).toBe("failed");

    const messages = await db.listMessages(workspaceId);
    const failureMessage = messages.find((m) => m.role === "system" && m.content.includes("tried to confirm"));
    expect(failureMessage).toBeDefined();
    expect(failureMessage?.content).toContain("no longer connected");
  });
});

