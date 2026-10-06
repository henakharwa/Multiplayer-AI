// Artifacts: CRUD, ownership rules, versions, comments, presence, generation and public sharing.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { closePool } from "@mai-chat/db";
import { setupDatabase, makeUser, newApp, makeWorkspace, NIL_UUID, type TestUser } from "./helpers.js";

const app = newApp();
let admin: TestUser; let editor: TestUser; let editor2: TestUser; let outsider: TestUser;
let ws: Awaited<ReturnType<typeof makeWorkspace>>;
beforeAll(async () => {
  await setupDatabase();
  admin = await makeUser("Admin"); editor = await makeUser("Editor"); editor2 = await makeUser("EditorTwo"); outsider = await makeUser("Outsider");
  ws = await makeWorkspace(app, admin, [editor, editor2]);
});
afterAll(async () => { await closePool(); });

const base = () => `/workspaces/${ws.id}/artifacts`;
const create = (user: TestUser, body: Record<string, unknown>) => request(app).post(base()).set("Cookie", user.cookie).send(body);

describe("AR-01 create artifacts", () => {
  it("basic: creates each artifact type and lists them", async () => {
    for (const type of ["plan", "report", "release_notes", "dashboard", "task_list"]) {
      const res = await create(editor, { type, title: `My ${type}`, content: "Body" });
      expect(res.status, type).toBe(201);
      expect(res.body).toMatchObject({ type, status: "draft", createdByUserId: editor.id });
    }
    expect((await request(app).get(base()).set("Cookie", admin.cookie)).body.length).toBeGreaterThanOrEqual(5);
  });
  it("edge: unknown type/status fall back to plan/draft; title and content are required", async () => {
    const fallback = await create(admin, { type: "spreadsheet", status: "secret", title: "T", content: "C" });
    expect(fallback.body).toMatchObject({ type: "plan", status: "draft" });
    for (const body of [{ title: "T" }, { content: "C" }, { title: "  ", content: "C" }]) expect((await create(admin, body)).status).toBe(400);
    expect((await create(admin, { title: "t".repeat(201), content: "C" })).status).toBe(400);
  });
  it("edge: owner must be a workspace member", async () => {
    expect((await create(admin, { title: "T", content: "C", ownerUserId: outsider.id })).status).toBe(400);
    expect((await create(admin, { title: "T", content: "C", ownerUserId: editor.id })).body.ownerUserId).toBe(editor.id);
  });
  it("edge: dashboard data is sanitised and capped", async () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ id: `c${i}`, label: `Item ${i}`, done: i % 2 === 0 }));
    const res = await create(admin, { type: "dashboard", title: "Dash", content: "C", dashboardData: { checklist: [...items, "junk", null] } });
    expect(res.status).toBe(201);
    expect(res.body.dashboardData.checklist.length).toBeLessThanOrEqual(20);
    expect((await create(admin, { type: "dashboard", title: "Dash", content: "C", dashboardData: "not-an-object" })).body.dashboardData).toBeNull();
  });
});

describe("AR-02 edit and delete (author or Admin only)", () => {
  it("basic: the author edits; the Admin edits; another Editor is refused", async () => {
    const artifact = (await create(editor, { title: "Plan", content: "v1" })).body;
    expect((await request(app).patch(`${base()}/${artifact.id}`).set("Cookie", editor.cookie).send({ title: "Plan", content: "v2" })).status).toBe(200);
    expect((await request(app).patch(`${base()}/${artifact.id}`).set("Cookie", admin.cookie).send({ title: "Plan", content: "v3" })).status).toBe(200);
    expect((await request(app).patch(`${base()}/${artifact.id}`).set("Cookie", editor2.cookie).send({ title: "Plan", content: "hack" })).status).toBe(403);
    expect((await request(app).delete(`${base()}/${artifact.id}`).set("Cookie", editor2.cookie)).status).toBe(403);
    expect((await request(app).delete(`${base()}/${artifact.id}`).set("Cookie", editor.cookie)).status).toBe(204);
  });
  it("edge: unknown and malformed ids are 404", async () => {
    expect((await request(app).patch(`${base()}/${NIL_UUID}`).set("Cookie", admin.cookie).send({ title: "x", content: "y" })).status).toBe(404);
    expect((await request(app).delete(`${base()}/nope`).set("Cookie", admin.cookie)).status).toBe(404);
    expect((await request(app).get(`${base()}/nope/versions`).set("Cookie", admin.cookie)).status).toBe(404);
  });
});

describe("AR-03 versions and restore", () => {
  it("basic: each save adds a version and an old version can be restored", async () => {
    const artifact = (await create(editor, { title: "Doc", content: "first" })).body;
    await request(app).patch(`${base()}/${artifact.id}`).set("Cookie", editor.cookie).send({ title: "Doc", content: "second" });
    const versions = (await request(app).get(`${base()}/${artifact.id}/versions`).set("Cookie", editor2.cookie)).body;
    expect(versions.length).toBeGreaterThanOrEqual(2);
    const first = versions.find((v: { content: string }) => v.content === "first");
    const restored = await request(app).post(`${base()}/${artifact.id}/versions/${first.id}/restore`).set("Cookie", editor.cookie);
    expect(restored.status).toBe(200);
    expect(restored.body.content).toBe("first");
  });
  it("edge: another Editor cannot restore; an unknown or foreign version is a 404", async () => {
    const a = (await create(editor, { title: "A", content: "a" })).body;
    const b = (await create(editor, { title: "B", content: "b" })).body;
    const bVersion = (await request(app).get(`${base()}/${b.id}/versions`).set("Cookie", editor.cookie)).body[0];
    expect((await request(app).post(`${base()}/${a.id}/versions/${bVersion.id}/restore`).set("Cookie", editor2.cookie)).status).toBe(403);
    expect((await request(app).post(`${base()}/${a.id}/versions/${bVersion.id}/restore`).set("Cookie", editor.cookie)).status).toBe(404);
    expect((await request(app).post(`${base()}/${a.id}/versions/${NIL_UUID}/restore`).set("Cookie", editor.cookie)).status).toBe(404);
    expect((await request(app).post(`${base()}/${a.id}/versions/v1/restore`).set("Cookie", editor.cookie)).status).toBe(404);
  });
});

describe("AR-04 comments and presence", () => {
  it("basic: any member comments; comments list with author names", async () => {
    const artifact = (await create(admin, { title: "Discuss", content: "x" })).body;
    expect((await request(app).post(`${base()}/${artifact.id}/comments`).set("Cookie", editor2.cookie).send({ content: "  Looks good  " })).status).toBe(201);
    const list = (await request(app).get(`${base()}/${artifact.id}/comments`).set("Cookie", admin.cookie)).body;
    expect(list[0]).toMatchObject({ content: "Looks good", authorName: "EditorTwo" });
  });
  it("edge: blank comments are 400; very long comments are capped at 8,000 characters", async () => {
    const artifact = (await create(admin, { title: "Long", content: "x" })).body;
    expect((await request(app).post(`${base()}/${artifact.id}/comments`).set("Cookie", admin.cookie).send({ content: "   " })).status).toBe(400);
    const long = await request(app).post(`${base()}/${artifact.id}/comments`).set("Cookie", admin.cookie).send({ content: "z".repeat(9000) });
    expect(long.body.content.length).toBe(8000);
  });
  it("basic: presence heartbeats list the other active viewers", async () => {
    const artifact = (await create(admin, { type: "dashboard", title: "Live", content: "x" })).body;
    await request(app).post(`${base()}/${artifact.id}/presence`).set("Cookie", admin.cookie);
    const res = await request(app).post(`${base()}/${artifact.id}/presence`).set("Cookie", editor.cookie);
    expect(res.body.viewers).toEqual([{ userId: admin.id, name: "Admin" }]);
  });
});

describe("AR-05 generation", () => {
  it("basic: dashboard refresh and report generation work for the author", async () => {
    const dash = (await create(editor, { type: "dashboard", title: "Dash", content: "x" })).body;
    const refreshed = await request(app).post(`${base()}/${dash.id}/refresh-dashboard`).set("Cookie", editor.cookie);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.dashboardData).not.toBeNull();
    const report = (await create(editor, { type: "report", title: "Weekly", content: "x" })).body;
    const generated = await request(app).post(`${base()}/${report.id}/generate-report`).set("Cookie", editor.cookie);
    expect(generated.status).toBe(200);
    expect(generated.body.content.length).toBeGreaterThan(0);
  });
  it("edge: generators refuse the wrong artifact type", async () => {
    const plan = (await create(editor, { type: "plan", title: "Plan", content: "x" })).body;
    for (const action of ["refresh-dashboard", "generate-report", "generate-release-notes"]) {
      expect((await request(app).post(`${base()}/${plan.id}/${action}`).set("Cookie", editor.cookie)).status, action).toBe(400);
    }
    const dash = (await create(editor, { type: "dashboard", title: "D", content: "x" })).body;
    expect((await request(app).post(`${base()}/${dash.id}/generate-assisted-draft`).set("Cookie", editor.cookie)).status).toBe(400);
  });
  it("edge: share to Slack needs a channel and a Slack connection", async () => {
    const plan = (await create(editor, { title: "Share", content: "x" })).body;
    expect((await request(app).post(`${base()}/${plan.id}/share-to-slack`).set("Cookie", editor.cookie).send({ channel: " " })).status).toBe(400);
    const noSlack = await request(app).post(`${base()}/${plan.id}/share-to-slack`).set("Cookie", editor.cookie).send({ channel: "general" });
    expect(noSlack.status).toBe(400);
    expect(noSlack.body.error).toMatch(/Slack isn't connected/);
  });
});

describe("AR-06 public share links", () => {
  it("basic: a published plan shares publicly and stops working when revoked", async () => {
    const plan = (await create(editor, { type: "plan", status: "published", title: "Public plan", content: "Hello" })).body;
    const shared = await request(app).post(`${base()}/${plan.id}/share`).set("Cookie", editor.cookie);
    expect(shared.body.shareToken).toBeTruthy();
    const view = await request(app).get(`/public/artifacts/${shared.body.shareToken}`);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ title: "Public plan", content: "Hello" });
    expect(view.body).not.toHaveProperty("createdByUserId");
    await request(app).delete(`${base()}/${plan.id}/share`).set("Cookie", editor.cookie);
    expect((await request(app).get(`/public/artifacts/${shared.body.shareToken}`)).status).toBe(404);
  });
  it("edge: drafts are not served even with a token; tokens are type-specific", async () => {
    const draft = (await create(editor, { type: "plan", title: "Draft", content: "x" })).body;
    const token = (await request(app).post(`${base()}/${draft.id}/share`).set("Cookie", editor.cookie)).body.shareToken;
    expect((await request(app).get(`/public/artifacts/${token}`)).status).toBe(404);
    const dash = (await create(editor, { type: "dashboard", status: "published", title: "D", content: "x" })).body;
    const dashToken = (await request(app).post(`${base()}/${dash.id}/share`).set("Cookie", editor.cookie)).body.shareToken;
    expect((await request(app).get(`/public/dashboards/${dashToken}`)).status).toBe(200);
    expect((await request(app).get(`/public/artifacts/${dashToken}`)).status).toBe(404);
    expect((await request(app).get(`/public/release-notes/${dashToken}`)).status).toBe(404);
  });
  it("edge: random and malformed tokens are 404", async () => {
    for (const token of ["nope", NIL_UUID, "'%20OR%201=1--"]) {
      expect((await request(app).get(`/public/artifacts/${token}`)).status).toBe(404);
      expect((await request(app).get(`/public/dashboards/${token}`)).status).toBe(404);
    }
  });
  it("security: another Editor cannot share or revoke; outsiders cannot list", async () => {
    const plan = (await create(editor, { title: "Mine", content: "x" })).body;
    expect((await request(app).post(`${base()}/${plan.id}/share`).set("Cookie", editor2.cookie)).status).toBe(403);
    expect((await request(app).delete(`${base()}/${plan.id}/share`).set("Cookie", editor2.cookie)).status).toBe(403);
    expect((await request(app).get(base()).set("Cookie", outsider.cookie)).status).toBe(403);
  });
});
