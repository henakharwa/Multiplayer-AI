// Linear, Notion and Figma connect only through their OAuth logins
// (provider-oauth.ts). The callback stores the member's own connection and
// records who connected what in Activity.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import * as db from "@mai-chat/db";
import { setupDatabase, makeUser, newApp, makeWorkspace, type TestUser } from "./helpers.js";

const app = newApp();
let admin: TestUser;
let ws: Awaited<ReturnType<typeof makeWorkspace>>;

beforeAll(async () => {
  await setupDatabase();
  admin = await makeUser("Admin");
  ws = await makeWorkspace(app, admin);
  vi.stubEnv("FIGMA_OAUTH_CLIENT_ID", "figma-client");
  vi.stubEnv("FIGMA_OAUTH_CLIENT_SECRET", "figma-secret");
});
afterAll(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await db.closePool();
});

describe("PO-01 provider OAuth connections", () => {
  it("Figma login requests folders:read, stores the member's connection and records it in Activity", async () => {
    const start = await request(app).get(`/workspaces/${ws.id}/integrations/figma/oauth/start`).set("Cookie", admin.cookie);
    expect(start.status).toBe(302);
    const authorize = new URL(start.headers.location);
    expect(authorize.origin + authorize.pathname).toBe("https://www.figma.com/oauth");
    expect(authorize.searchParams.get("scope")?.split(",")).toEqual(expect.arrayContaining(["file_content:read", "file_comments:write", "folders:read"]));
    const state = authorize.searchParams.get("state");

    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href === "https://api.figma.com/v1/oauth/token") return new Response(JSON.stringify({ access_token: "figu_oauth_token" }), { status: 200 });
      if (href === "https://api.figma.com/v1/me") return new Response(JSON.stringify({ handle: "hena kharwa" }), { status: 200 });
      return realFetch(url, init);
    });
    const callback = await request(app).get(`/auth/mcp/figma/callback?state=${state}&code=abc`);
    vi.unstubAllGlobals();
    expect(callback.status).toBe(302);
    expect(callback.headers.location).toContain("figma=connected");

    const figma = (await request(app).get(`/workspaces/${ws.id}/integrations`).set("Cookie", admin.cookie)).body.find((item: { type: string }) => item.type === "figma");
    expect(figma).toMatchObject({ ownerUserId: admin.id, accountName: "hena kharwa" });
    expect(JSON.stringify(figma)).not.toContain("figu_oauth_token");
    const audit = await db.listAuditEvents(ws.id, { eventType: "integration.connected" });
    expect(audit.some((event) => event.summary === "Admin connected Figma (hena kharwa)" && event.actorUserId === admin.id)).toBe(true);
  });

  it("FIGMA_OAUTH_SCOPES overrides the requested scopes", async () => {
    vi.stubEnv("FIGMA_OAUTH_SCOPES", "file_content:read,current_user:read");
    const start = await request(app).get(`/workspaces/${ws.id}/integrations/figma/oauth/start`).set("Cookie", admin.cookie);
    expect(new URL(start.headers.location).searchParams.get("scope")).toBe("file_content:read,current_user:read");
    vi.stubEnv("FIGMA_OAUTH_SCOPES", "");
  });
});
