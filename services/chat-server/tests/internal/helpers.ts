// Shared setup for the internal (feature-by-feature) test suite.
// Real Express app + real Postgres; only external providers, the LLM and
// email delivery are faked.
import { randomUUID } from "node:crypto";
import request from "supertest";
import * as db from "@mai-chat/db";
import { createChatServer, type CreateServerDeps } from "../../src/server.js";
import type { OutgoingEmail } from "../../src/mailer.js";

export const sentEmails: OutgoingEmail[] = [];

export function makeDeps(overrides: Partial<CreateServerDeps> = {}): CreateServerDeps {
  return {
    githubClientFactory: () => ({ listIssues: async () => [] }),
    slackClientFactory: () => ({ postMessage: async () => {} }),
    githubMcpToolsFactory: async () => [],
    slackMcpToolsFactory: async () => [],
    runAgentTurn: async () => ({ reply: "Agent reply", toolCallsMade: 0 }),
    mailer: { send: async (email) => { sentEmails.push(email); } },
    githubOAuthConfig: { clientId: "", clientSecret: "", redirectUri: "", webAppUrl: "http://localhost:3000" },
    githubOAuthDeps: { exchangeCodeForToken: async () => ({ error: "not used" }), listRepositoriesForToken: async () => [] },
    slackOAuthConfig: { clientId: "", clientSecret: "", redirectUri: "", webAppUrl: "http://localhost:3000" },
    slackOAuthDeps: { exchangeCodeForToken: async () => ({ error: "not used" }) },
    ...overrides,
  };
}

export async function setupDatabase(): Promise<void> {
  await db.runMigrations();
  // Rate limits are stored in the database and shared by every request
  // from 127.0.0.1 in this run; start each file with a clean slate.
  await db.getPool().query("DELETE FROM auth_rate_limits");
}

export type TestUser = { id: string; displayName: string; email: string; cookie: string };

export async function makeUser(label: string): Promise<TestUser> {
  const unique = randomUUID().slice(0, 8);
  const email = `${label.toLowerCase()}-${unique}@example.test`;
  const user = await db.createPasswordUser({ email, displayName: label, passwordHash: "not-a-real-hash", emailVerified: true });
  const session = await db.createSession(user.id, 60 * 60_000);
  return { id: user.id, displayName: label, email, cookie: `mai_session=${session.token}` };
}

export function newApp(overrides: Partial<CreateServerDeps> = {}) {
  return createChatServer(makeDeps(overrides)).app;
}

/** Admin creates a workspace; any editors join it with the join code. */
export async function makeWorkspace(app: ReturnType<typeof newApp>, admin: TestUser, editors: TestUser[] = []) {
  const created = await request(app).post("/workspaces").set("Cookie", admin.cookie).send({ name: `Internal WS ${randomUUID().slice(0, 8)}` });
  if (created.status !== 201) throw new Error(`workspace create failed: ${created.status} ${JSON.stringify(created.body)}`);
  for (const editor of editors) {
    const joined = await request(app).post(`/workspaces/by-code/${created.body.joinCode}/join`).set("Cookie", editor.cookie);
    if (joined.status !== 200) throw new Error(`join failed: ${joined.status}`);
  }
  const conversations = await request(app).get(`/workspaces/${created.body.id}/conversations`).set("Cookie", admin.cookie);
  return { id: created.body.id as string, joinCode: created.body.joinCode as string, name: created.body.name as string, conversationId: conversations.body[0].id as string };
}

export async function grantEditor(workspaceId: string, permissions: Partial<Record<string, boolean>>) {
  const policy = await db.getWorkspacePermissionPolicy(workspaceId);
  await db.setWorkspacePermissionPolicy(workspaceId, { admin: policy.admin, editor: { ...policy.editor, ...permissions } as typeof policy.editor });
}

export const NIL_UUID = "00000000-0000-0000-0000-000000000000";
