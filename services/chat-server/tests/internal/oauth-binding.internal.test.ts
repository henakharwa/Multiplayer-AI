// Security regression (review 2026-10-22): a tool connection must be finished
// in the same signed-in session that started it. Before the fix, the OAuth
// callbacks saved the returned token for whoever *started* the flow, so an
// attacker could start "Connect GitHub" and send the provider's authorize
// link to a victim. If the victim had used the app before, GitHub skipped
// the consent screen, and the victim's account was stored as the
// attacker's connection.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import * as db from "@mai-chat/db";
import { makeUser, makeWorkspace, newApp, setupDatabase, type TestUser } from "./helpers.js";

const githubConfig = { clientId: "gh-client", clientSecret: "gh-secret", redirectUri: "http://localhost:4000/auth/github/callback", webAppUrl: "http://localhost:3000" };
const slackConfig = { clientId: "slack-client", clientSecret: "slack-secret", redirectUri: "http://localhost:4000/auth/slack/callback", webAppUrl: "http://localhost:3000" };
const app = newApp({
  githubOAuthConfig: githubConfig,
  githubOAuthDeps: { exchangeCodeForToken: async () => ({ accessToken: "gho_victim_token" }), listRepositoriesForToken: async () => [] },
  slackOAuthConfig: slackConfig,
  slackOAuthDeps: { exchangeCodeForToken: async () => ({ accessToken: "xoxp-victim-token", teamName: "Victim Co" }) },
});

let attacker: TestUser;
let victim: TestUser;
let ws: Awaited<ReturnType<typeof makeWorkspace>>;

beforeAll(async () => {
  await setupDatabase();
  attacker = await makeUser("Attacker");
  victim = await makeUser("Victim");
  ws = await makeWorkspace(app, attacker);
  vi.stubEnv("FIGMA_OAUTH_CLIENT_ID", "figma-client");
  vi.stubEnv("FIGMA_OAUTH_CLIENT_SECRET", "figma-secret");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function startFlow(path: string, who: TestUser): Promise<string> {
  const start = await request(app).get(path).set("Cookie", who.cookie);
  expect(start.status).toBe(302);
  return new URL(start.headers.location).searchParams.get("state")!;
}

const ownedBy = async (type: string, userId: string) =>
  (await db.listIntegrations(ws.id)).filter((integration) => integration.type === type && integration.ownerUserId === userId);

describe("OB-01 a connection finishes only in the session that started it", () => {
  it("GitHub: another person's browser can't complete it", async () => {
    const state = await startFlow(`/workspaces/${ws.id}/integrations/github/oauth/start`, attacker);
    const hijack = await request(app).get("/auth/github/callback").query({ code: "victim-code", state }).set("Cookie", victim.cookie);
    expect(hijack.status).toBe(302);
    expect(hijack.headers.location).toContain("github=error");
    expect(await ownedBy("github", attacker.id)).toHaveLength(0);

    // Signed out entirely: also refused.
    const state2 = await startFlow(`/workspaces/${ws.id}/integrations/github/oauth/start`, attacker);
    const anonymous = await request(app).get("/auth/github/callback").query({ code: "victim-code", state: state2 });
    expect(anonymous.headers.location).toContain("github=error");
    expect(await ownedBy("github", attacker.id)).toHaveLength(0);

    // The person who started it can still finish it.
    const state3 = await startFlow(`/workspaces/${ws.id}/integrations/github/oauth/start`, attacker);
    const own = await request(app).get("/auth/github/callback").query({ code: "own-code", state: state3 }).set("Cookie", attacker.cookie);
    expect(own.headers.location).toContain("github=connected");
    expect(await ownedBy("github", attacker.id)).toHaveLength(1);
  });

  it("Slack: another person's browser can't complete it", async () => {
    const state = await startFlow(`/workspaces/${ws.id}/integrations/slack/oauth/start`, attacker);
    const hijack = await request(app).get("/auth/slack/callback").query({ code: "victim-code", state }).set("Cookie", victim.cookie);
    expect(hijack.headers.location).toContain("slack=error");
    expect(await ownedBy("slack", attacker.id)).toHaveLength(0);
  });

  it("Figma, Linear and Notion: another person's browser can't complete it", async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href === "https://api.figma.com/v1/oauth/token") return new Response(JSON.stringify({ access_token: "figu_victim" }), { status: 200 });
      if (href === "https://api.figma.com/v1/me") return new Response(JSON.stringify({ handle: "victim" }), { status: 200 });
      return realFetch(url, init);
    });
    const state = await startFlow(`/workspaces/${ws.id}/integrations/figma/oauth/start`, attacker);
    const hijack = await request(app).get(`/auth/mcp/figma/callback`).query({ code: "victim-code", state }).set("Cookie", victim.cookie);
    vi.unstubAllGlobals();
    expect(hijack.headers.location).toContain("figma=error");
    expect(await ownedBy("figma", attacker.id)).toHaveLength(0);
  });
});
