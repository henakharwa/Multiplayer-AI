// Notifications sent to other members when a governed write action is
// cancelled or confirmed. Regression: a cancel used to notify members that
// the action was "completed", and a successful confirm sent no notification.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import * as db from "@mai-chat/db";
import type { ToolExecutor } from "../../src/tools.js";
import { setupDatabase, makeUser, newApp, makeWorkspace, type TestUser } from "./helpers.js";

const writeTool: ToolExecutor = {
  definition: { type: "function", function: { name: "fake_comment_tool", description: "fake", parameters: { type: "object" } } },
  mutates: true,
  execute: async () => ({ ok: true }),
};

const app = newApp({ githubMcpToolsFactory: async () => [writeTool] });
let admin: TestUser; let editor: TestUser;
let ws: Awaited<ReturnType<typeof makeWorkspace>>;

beforeAll(async () => {
  await setupDatabase();
  admin = await makeUser("Admin"); editor = await makeUser("Editor");
  ws = await makeWorkspace(app, admin, [editor]);
  const github = await request(app).post(`/workspaces/${ws.id}/integrations/github`).set("Cookie", admin.cookie).send({ owner: "acme", repo: "widgets", token: "gh-token" });
  expect(github.status).toBe(201);
});
afterAll(async () => { await db.closePool(); });

async function propose(description: string) {
  return db.createPendingAction({ workspaceId: ws.id, conversationId: ws.conversationId, toolName: "fake_comment_tool", description, args: {} });
}

async function editorNotificationTexts(): Promise<string[]> {
  return (await db.listNotifications(editor.id, { workspaceId: ws.id, limit: 50 })).map((notification) => notification.text);
}

describe("AC-01 action resolution notifications", () => {
  it("a cancel tells other members it was cancelled, never completed", async () => {
    const pending = await propose("comment on issue 14");
    const res = await request(app).post(`/workspaces/${ws.id}/actions/${pending.id}/cancel`).set("Cookie", admin.cookie).send({});
    expect(res.status).toBe(200);
    const texts = await editorNotificationTexts();
    expect(texts).toContain("Admin cancelled: comment on issue 14");
    expect(texts.some((text) => text.includes("completed: comment on issue 14"))).toBe(false);
  });

  it("a successful confirm tells other members it completed", async () => {
    const pending = await propose("comment on issue 15");
    const res = await request(app).post(`/workspaces/${ws.id}/actions/${pending.id}/confirm`).set("Cookie", admin.cookie).send({});
    expect(res.status).toBe(200);
    expect((await db.getPendingAction(ws.id, pending.id))?.status).toBe("confirmed");
    const texts = await editorNotificationTexts();
    expect(texts).toContain("Admin confirmed and completed: comment on issue 15");
  });

  it("the person who resolved the action is not notified about their own click", async () => {
    const pending = await propose("comment on issue 16");
    await request(app).post(`/workspaces/${ws.id}/actions/${pending.id}/cancel`).set("Cookie", admin.cookie).send({});
    const adminTexts = (await db.listNotifications(admin.id, { workspaceId: ws.id, limit: 50 })).map((notification) => notification.text);
    expect(adminTexts.some((text) => text.includes("comment on issue 16"))).toBe(false);
  });
});
