import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import express from "express";
import request from "supertest";
import { getPool, closePool, createWorkspace, getIntegrationCredential, listIntegrations } from "@mai-chat/db";
import { registerSlackOAuthRoutes, type SlackOAuthConfig, type SlackOAuthDeps } from "../src/slack-oauth.js";

loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
loadEnv();

// Real Express app, real local Postgres (same "mock only the external
// network call" line every package here draws) -- the only thing mocked
// is exchangeCodeForToken, standing in for the real HTTPS call to
// slack.com/api/oauth.v2.user.access (see slack-oauth.ts's own comment on
// why that response's exact shape isn't fully verified against a live
// account yet -- this suite locks in everything AROUND that call: state
// handling, error redirects, and what gets stored once a token comes
// back, regardless of exactly how Slack's real response is shaped).

const config: SlackOAuthConfig = {
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  redirectUri: "http://localhost:4000/auth/slack/callback",
  webAppUrl: "http://localhost:3000",
};

function makeApp(deps: SlackOAuthDeps) {
  const app = express();
  app.use(express.json());
  registerSlackOAuthRoutes(app, config, deps);
  return app;
}

beforeAll(async () => {
  const schema = await readFile(fileURLToPath(new URL("../../../packages/db/sql/schema.sql", import.meta.url)), "utf8");
  await getPool().query(schema);
});

afterAll(async () => {
  await closePool();
});

describe("Slack OAuth start", () => {
  it("redirects to Slack's user-token authorize endpoint with client_id, redirect_uri, scope, and a state", async () => {
    const workspace = await createWorkspace(`Slack OAuth test ${Math.random()}`);
    const app = makeApp({ exchangeCodeForToken: async () => ({ error: "not used in this test" }) });

    const res = await request(app).get(`/workspaces/${workspace.id}/integrations/slack/oauth/start`);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.origin + location.pathname).toBe("https://slack.com/oauth/v2_user/authorize");
    expect(location.searchParams.get("client_id")).toBe("test-client-id");
    expect(location.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(location.searchParams.get("scope")).toContain("chat:write");
    expect(location.searchParams.get("scope")).toContain("channels:history");
    // channels:read (and its group/mpim/im siblings) are what let the
    // agent list/discover conversations by name -- distinct from the
    // *:history scopes above, which only cover reading messages inside a
    // conversation it already knows about. Found missing live
    // 2026-09-21 asking "what Slack channels can you see?".
    expect(location.searchParams.get("scope")).toContain("channels:read");
    expect(location.searchParams.get("state")).toBeTruthy();
  });

  it("404s for a workspace id that doesn't exist", async () => {
    const app = makeApp({ exchangeCodeForToken: async () => ({ error: "not used" }) });
    const res = await request(app).get(`/workspaces/00000000-0000-0000-0000-000000000000/integrations/slack/oauth/start`);
    expect(res.status).toBe(404);
  });

  it("503s when Slack login isn't configured on this server", async () => {
    const workspace = await createWorkspace(`Slack OAuth unconfigured ${Math.random()}`);
    const app = express();
    app.use(express.json());
    registerSlackOAuthRoutes(app, { ...config, clientId: "", clientSecret: "" }, { exchangeCodeForToken: async () => ({ error: "n/a" }) });
    const res = await request(app).get(`/workspaces/${workspace.id}/integrations/slack/oauth/start`);
    expect(res.status).toBe(503);
  });
});

describe("Slack OAuth callback", () => {
  async function startFlow(app: ReturnType<typeof makeApp>, workspaceId: string): Promise<string> {
    const startRes = await request(app).get(`/workspaces/${workspaceId}/integrations/slack/oauth/start`);
    const location = new URL(startRes.headers.location);
    return location.searchParams.get("state")!;
  }

  it("on success, stores the access token and team name, and redirects back into the app with slack=connected", async () => {
    const workspace = await createWorkspace(`Slack OAuth success ${Math.random()}`);
    const app = makeApp({ exchangeCodeForToken: async () => ({ accessToken: "xoxp-real-token", teamName: "Acme Corp" }) });
    const state = await startFlow(app, workspace.id);

    const res = await request(app).get(`/auth/slack/callback`).query({ code: "auth-code-123", state });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.pathname).toBe(`/w/${workspace.id}`);
    expect(location.searchParams.get("slack")).toBe("connected");

    const credential = await getIntegrationCredential(workspace.id, "slack");
    expect(credential?.token).toBe("xoxp-real-token");
    const integrations = await listIntegrations(workspace.id);
    const slack = integrations.find((i) => i.type === "slack");
    expect(slack && "teamName" in slack ? slack.teamName : undefined).toBe("Acme Corp");
  });

  it("falls back to a generic team name when Slack's response doesn't include one", async () => {
    const workspace = await createWorkspace(`Slack OAuth no team name ${Math.random()}`);
    const app = makeApp({ exchangeCodeForToken: async () => ({ accessToken: "xoxp-token-2" }) });
    const state = await startFlow(app, workspace.id);

    await request(app).get(`/auth/slack/callback`).query({ code: "code", state });
    const integrations = await listIntegrations(workspace.id);
    const slack = integrations.find((i) => i.type === "slack");
    expect(slack && "teamName" in slack ? slack.teamName : undefined).toBe("Slack");
  });

  it("redirects with an error and stores nothing when the code exchange fails", async () => {
    const workspace = await createWorkspace(`Slack OAuth exchange fails ${Math.random()}`);
    const app = makeApp({ exchangeCodeForToken: async () => ({ error: "invalid_grant" }) });
    const state = await startFlow(app, workspace.id);

    const res = await request(app).get(`/auth/slack/callback`).query({ code: "bad-code", state });
    const location = new URL(res.headers.location);
    expect(location.searchParams.get("slack")).toBe("error");
    expect(location.searchParams.get("slackMessage")).toBe("invalid_grant");

    const credential = await getIntegrationCredential(workspace.id, "slack");
    expect(credential).toBeNull();
  });

  it("redirects with an error when Slack itself reports one (e.g. the user denied consent)", async () => {
    const workspace = await createWorkspace(`Slack OAuth denied ${Math.random()}`);
    const app = makeApp({ exchangeCodeForToken: async () => ({ error: "should not be called" }) });
    const state = await startFlow(app, workspace.id);

    const res = await request(app).get(`/auth/slack/callback`).query({ state, error: "access_denied" });
    const location = new URL(res.headers.location);
    expect(location.searchParams.get("slack")).toBe("error");
    expect(location.searchParams.get("slackMessage")).toContain("access_denied");
  });

  it("rejects a state that's already been used (single-use CSRF protection)", async () => {
    const workspace = await createWorkspace(`Slack OAuth replay ${Math.random()}`);
    const app = makeApp({ exchangeCodeForToken: async () => ({ accessToken: "xoxp-once" }) });
    const state = await startFlow(app, workspace.id);

    await request(app).get(`/auth/slack/callback`).query({ code: "code", state });
    const replay = await request(app).get(`/auth/slack/callback`).query({ code: "code", state });
    const location = new URL(replay.headers.location);
    expect(location.searchParams.get("slack")).toBe("error");
    expect(location.searchParams.get("slackMessage")).toContain("expired or was already used");
  });
});
