import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import request from "supertest";
import * as db from "@mai-chat/db";
import { getPool, closePool, upsertUserFromGithub, createSession } from "@mai-chat/db";
import { createChatServer, type CreateServerDeps } from "../src/server.js";
import { wrapForProposal } from "../src/actions.js";
import { RoomRegistry } from "../src/rooms.js";
import type { GithubClient } from "@mai-chat/integrations";
import type { ToolExecutor } from "../src/tools.js";

// Coverage for docs/spec.md's Phase 2 "Action audit trail (who asked for
// what, what the agent did, when)" -- the audit_events table, the routes
// that write to it (workspace creation, GitHub connect, an agent action's
// full propose -> confirm/cancel lifecycle), and the GET .../audit route
// itself, including its type/search filters.

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

let ownerCookie: string;
let ownerName: string;

beforeAll(async () => {
  const schema = await readFile(fileURLToPath(new URL("../../../packages/db/sql/schema.sql", import.meta.url)), "utf8");
  await getPool().query(schema);
  const owner = await upsertUserFromGithub({ githubId: `audit-owner-${randomUUID()}`, username: "owner", displayName: "Audit Owner" });
  ownerName = owner.displayName;
  ownerCookie = `mai_session=${(await createSession(owner.id, 60_000)).token}`;
});
afterAll(async () => { await closePool(); });

describe("action audit trail", () => {
  it("records a workspace.created event when a workspace is made", async () => {
    const { app } = createChatServer(makeDeps());
    const created = await request(app).post("/workspaces").set("Cookie", ownerCookie).send({ name: `Audit WS ${randomUUID()}` });
    expect(created.status).toBe(201);

    const audit = await request(app).get(`/workspaces/${created.body.id}/audit`).set("Cookie", ownerCookie);
    expect(audit.status).toBe(200);
    expect(audit.body.events).toHaveLength(1);
    expect(audit.body.events[0]).toMatchObject({ eventType: "workspace.created", actorType: "user", actorName: ownerName });
    expect(audit.body.events[0].summary).toContain(created.body.name);
  });

  it("records an integration.connected event for a pasted GitHub token", async () => {
    const { app } = createChatServer(makeDeps());
    const workspace = await request(app).post("/workspaces").set("Cookie", ownerCookie).send({ name: `Audit WS ${randomUUID()}` });
    await request(app)
      .post(`/workspaces/${workspace.body.id}/integrations/github`)
      .set("Cookie", ownerCookie)
      .send({ owner: "acme", repo: "widgets", token: "gh-token" });

    const audit = await request(app).get(`/workspaces/${workspace.body.id}/audit`).set("Cookie", ownerCookie).query({ type: "integration.connected" });
    expect(audit.status).toBe(200);
    expect(audit.body.events).toHaveLength(1);
    expect(audit.body.events[0].summary).toContain("acme/widgets");
  });

  it("logs an agent action's full propose -> confirm lifecycle, attributing it to whoever asked", async () => {
    const rooms = new RoomRegistry();
    const workingTool: ToolExecutor = {
      definition: { type: "function", function: { name: "fake_write_tool", description: "fake", parameters: { type: "object" } } },
      mutates: true,
      describe: () => "do the thing",
      execute: async () => "done",
    };
    const workspaceId = randomUUID();
    // wrapForProposal doesn't touch the DB's workspace row, only
    // pending_actions/audit_events -- but the workspace FK on both tables
    // means it needs to actually exist first.
    const created = await db.createWorkspace(`Audit WS ${randomUUID()}`);
    const requester = { userId: randomUUID(), name: "Requesting Member" };
    // Satisfy the FK on pending_actions/audit_events.requested_by_user_id
    // /actor_user_id -- a real signed-in user, distinct from the owner
    // used for the confirm call below.
    const requesterUser = await upsertUserFromGithub({ githubId: `audit-req-${randomUUID()}`, username: "req", displayName: requester.name });

    const [wrapped] = wrapForProposal([workingTool], created.id, rooms, { userId: requesterUser.id, name: requester.name });
    const result = (await wrapped.execute({})) as { actionId: string };

    const afterPropose = await db.listAuditEvents(created.id);
    expect(afterPropose[0]).toMatchObject({ eventType: "action.proposed", actorType: "agent" });
    expect(afterPropose[0].summary).toContain(requester.name);
    expect(afterPropose[0].summary).toContain("do the thing");

    // The confirm route rebuilds the tool set from whatever's actually
    // connected to the workspace (see actions.ts's resolveAction) rather
    // than reusing the one wrapForProposal was called with above, so a
    // GitHub integration + a matching githubMcpToolsFactory override are
    // both needed here for it to find "fake_write_tool" again.
    const { app } = createChatServer(makeDeps({ githubMcpToolsFactory: async () => [workingTool] }));
    await request(app).post(`/workspaces/${created.id}/integrations/github`).set("Cookie", ownerCookie).send({ owner: "acme", repo: "widgets", token: "gh-token" });
    const confirm = await request(app)
      .post(`/workspaces/${created.id}/actions/${result.actionId}/confirm`)
      .set("Cookie", ownerCookie)
      .send({ actorName: ownerName });
    expect(confirm.status).toBe(200);

    const afterConfirm = await db.listAuditEvents(created.id);
    // Newest first -- the confirm should now be the top event, and both
    // the earlier propose and the GitHub connect (needed above so the
    // confirm route could find the tool again) are still in the trail.
    expect(afterConfirm[0]).toMatchObject({ eventType: "action.confirmed", actorType: "user", actorName: ownerName });
    expect(afterConfirm.map((e) => e.eventType)).toEqual(
      expect.arrayContaining(["action.confirmed", "action.proposed", "integration.connected"])
    );

    const action = await db.getPendingAction(created.id, result.actionId);
    expect(action?.requestedByName).toBe(requester.name);
  });

  it("logs action.cancelled when a pending action is cancelled instead of confirmed", async () => {
    const rooms = new RoomRegistry();
    const tool: ToolExecutor = {
      definition: { type: "function", function: { name: "fake_write_tool", description: "fake", parameters: { type: "object" } } },
      mutates: true,
      execute: async () => "unused",
    };
    const workspace = await db.createWorkspace(`Audit WS ${randomUUID()}`);
    const [wrapped] = wrapForProposal([tool], workspace.id, rooms);
    const result = (await wrapped.execute({})) as { actionId: string };

    const { app } = createChatServer(makeDeps());
    const cancel = await request(app)
      .post(`/workspaces/${workspace.id}/actions/${result.actionId}/cancel`)
      .set("Cookie", ownerCookie)
      .send({ actorName: ownerName });
    expect(cancel.status).toBe(200);

    const events = await db.listAuditEvents(workspace.id, { eventType: "action.cancelled" });
    expect(events).toHaveLength(1);
    expect(events[0].actorName).toBe(ownerName);
  });

  it("filters by search text across actor name and summary", async () => {
    const { app } = createChatServer(makeDeps());
    const workspace = await request(app).post("/workspaces").set("Cookie", ownerCookie).send({ name: `Findable Name ${randomUUID()}` });

    const matching = await request(app).get(`/workspaces/${workspace.body.id}/audit`).set("Cookie", ownerCookie).query({ q: ownerName });
    expect(matching.body.events.length).toBeGreaterThanOrEqual(1);

    const notMatching = await request(app).get(`/workspaces/${workspace.body.id}/audit`).set("Cookie", ownerCookie).query({ q: "definitely-not-present-xyz" });
    expect(notMatching.body.events).toHaveLength(0);
  });

  it("rejects an invalid workspace id and 404s for an unknown one", async () => {
    const { app } = createChatServer(makeDeps());
    expect((await request(app).get(`/workspaces/not-a-uuid/audit`).set("Cookie", ownerCookie)).status).toBe(400);
    expect((await request(app).get(`/workspaces/${randomUUID()}/audit`).set("Cookie", ownerCookie)).status).toBe(404);
  });

  it("requires a signed-in session", async () => {
    const { app } = createChatServer(makeDeps());
    const workspace = await request(app).post("/workspaces").set("Cookie", ownerCookie).send({ name: `Audit WS ${randomUUID()}` });
    const res = await request(app).get(`/workspaces/${workspace.body.id}/audit`);
    expect(res.status).toBe(401);
  });
});
