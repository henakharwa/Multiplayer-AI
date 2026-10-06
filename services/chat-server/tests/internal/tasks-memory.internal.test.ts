// Tasks board and workspace memory (shared capabilities).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { closePool } from "@mai-chat/db";
import { setupDatabase, makeUser, newApp, makeWorkspace, NIL_UUID, type TestUser } from "./helpers.js";

const app = newApp();
let admin: TestUser; let editor: TestUser; let outsider: TestUser;
let ws: Awaited<ReturnType<typeof makeWorkspace>>;
beforeAll(async () => {
  await setupDatabase();
  admin = await makeUser("Admin"); editor = await makeUser("Editor"); outsider = await makeUser("Outsider");
  ws = await makeWorkspace(app, admin, [editor]);
});
afterAll(async () => { await closePool(); });

const tasks = () => `/workspaces/${ws.id}/tasks`;
const memory = () => `/workspaces/${ws.id}/memory`;

describe("TK-01 create tasks", () => {
  it("basic: Editor creates a task with owner, due date and description", async () => {
    const res = await request(app).post(tasks()).set("Cookie", editor.cookie).send({ title: "  Write spec  ", description: "v1", ownerUserId: admin.id, dueDate: "2026-12-01" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ title: "Write spec", status: "todo", ownerUserId: admin.id, dueDate: "2026-12-01" });
  });
  it("basic: a task can be created straight into another column", async () => {
    const res = await request(app).post(tasks()).set("Cookie", admin.cookie).send({ title: "Already reviewing", status: "review" });
    expect(res.body.status).toBe("review");
  });
  it("edge: blank, missing or over-long titles are 400", async () => {
    for (const body of [{}, { title: "" }, { title: "   " }, { title: 42 }, { title: "t".repeat(201) }]) {
      expect((await request(app).post(tasks()).set("Cookie", admin.cookie).send(body)).status).toBe(400);
    }
  });
  it("edge: owner must be a workspace member; unknown status or impossible date is a 400", async () => {
    expect((await request(app).post(tasks()).set("Cookie", admin.cookie).send({ title: "x", ownerUserId: outsider.id })).status).toBe(400);
    expect((await request(app).post(tasks()).set("Cookie", admin.cookie).send({ title: "x", status: "blocked" })).status).toBe(400);
    expect((await request(app).post(tasks()).set("Cookie", admin.cookie).send({ title: "x", dueDate: "2026-02-31" })).status).toBe(400);
    expect((await request(app).post(tasks()).set("Cookie", admin.cookie).send({ title: "x", dueDate: "tomorrow" })).status).toBe(400);
  });
  it("edge: unicode and HTML-like text is stored verbatim", async () => {
    const title = "<script>alert(1)</script> — 日本語 ✅";
    const res = await request(app).post(tasks()).set("Cookie", admin.cookie).send({ title });
    expect(res.body.title).toBe(title);
  });
});

describe("TK-02 update and delete tasks", () => {
  it("basic: moves a task across columns without touching other fields", async () => {
    const task = (await request(app).post(tasks()).set("Cookie", admin.cookie).send({ title: "Move me", ownerUserId: editor.id, dueDate: "2026-11-11" })).body;
    for (const status of ["in_progress", "review", "done", "todo"]) {
      const res = await request(app).patch(`${tasks()}/${task.id}`).set("Cookie", editor.cookie).send({ status });
      expect(res.body).toMatchObject({ status, title: "Move me", ownerUserId: editor.id, dueDate: "2026-11-11" });
    }
  });
  it("edge: owner and due date can be cleared explicitly", async () => {
    const task = (await request(app).post(tasks()).set("Cookie", admin.cookie).send({ title: "Clear me", ownerUserId: editor.id, dueDate: "2026-11-11" })).body;
    const res = await request(app).patch(`${tasks()}/${task.id}`).set("Cookie", admin.cookie).send({ ownerUserId: null, dueDate: null });
    expect(res.body).toMatchObject({ ownerUserId: null, dueDate: null, title: "Clear me" });
  });
  it("edge: blank title and non-member owner are refused on update", async () => {
    const task = (await request(app).post(tasks()).set("Cookie", admin.cookie).send({ title: "Keep" })).body;
    expect((await request(app).patch(`${tasks()}/${task.id}`).set("Cookie", admin.cookie).send({ title: " " })).status).toBe(400);
    expect((await request(app).patch(`${tasks()}/${task.id}`).set("Cookie", admin.cookie).send({ ownerUserId: outsider.id })).status).toBe(400);
  });
  it("edge: unknown and malformed task ids are 404", async () => {
    expect((await request(app).patch(`${tasks()}/${NIL_UUID}`).set("Cookie", admin.cookie).send({ status: "done" })).status).toBe(404);
    expect((await request(app).patch(`${tasks()}/not-a-uuid`).set("Cookie", admin.cookie).send({ status: "done" })).status).toBe(404);
    expect((await request(app).delete(`${tasks()}/not-a-uuid`).set("Cookie", admin.cookie)).status).toBe(404);
  });
  it("basic: delete removes it; deleting again is a 404", async () => {
    const task = (await request(app).post(tasks()).set("Cookie", editor.cookie).send({ title: "Bye" })).body;
    expect((await request(app).delete(`${tasks()}/${task.id}`).set("Cookie", admin.cookie)).status).toBe(204);
    expect((await request(app).delete(`${tasks()}/${task.id}`).set("Cookie", admin.cookie)).status).toBe(404);
  });
  it("security: a task cannot be changed through another workspace, and outsiders are refused", async () => {
    const task = (await request(app).post(tasks()).set("Cookie", admin.cookie).send({ title: "Mine" })).body;
    const other = await makeWorkspace(app, outsider);
    expect((await request(app).patch(`/workspaces/${other.id}/tasks/${task.id}`).set("Cookie", outsider.cookie).send({ status: "done" })).status).toBe(404);
    expect((await request(app).get(tasks()).set("Cookie", outsider.cookie)).status).toBe(403);
  });
});

describe("MM-01 workspace memory", () => {
  it("basic: Editor saves knowledge and Admin records a decision", async () => {
    const k = await request(app).post(memory()).set("Cookie", editor.cookie).send({ title: "Deploy steps", content: "Use the pipeline", sourceUrl: "https://example.com/runbook" });
    expect(k.status).toBe(201);
    expect(k.body.kind).toBe("knowledge");
    const d = await request(app).post(memory()).set("Cookie", admin.cookie).send({ kind: "decision", title: "Use Postgres", content: "Chosen", freshUntil: "2027-01-01" });
    expect(d.body.kind).toBe("decision");
    const list = (await request(app).get(memory()).set("Cookie", editor.cookie)).body;
    expect(list.map((m: { id: string }) => m.id)).toEqual(expect.arrayContaining([k.body.id, d.body.id]));
  });
  it("basic: every member can edit and delete any entry (shared capability)", async () => {
    const entry = (await request(app).post(memory()).set("Cookie", admin.cookie).send({ title: "Admin note", content: "a" })).body;
    const edited = await request(app).patch(`${memory()}/${entry.id}`).set("Cookie", editor.cookie).send({ title: "Admin note", content: "edited by editor" });
    expect(edited.status).toBe(200);
    expect(edited.body.content).toBe("edited by editor");
    expect((await request(app).delete(`${memory()}/${entry.id}`).set("Cookie", editor.cookie)).status).toBe(204);
  });
  it("edge: missing title/content, bad URL scheme and invalid review date are 400", async () => {
    for (const body of [{ title: "x" }, { content: "x" }, { title: " ", content: " " }, { title: "x", content: "y", sourceUrl: "javascript:alert(1)" }, { title: "x", content: "y", sourceUrl: "not a url" }, { title: "x", content: "y", freshUntil: "someday" }]) {
      expect((await request(app).post(memory()).set("Cookie", admin.cookie).send(body)).status, JSON.stringify(body)).toBe(400);
    }
  });
  it("edge: over-long title or content is a 400", async () => {
    expect((await request(app).post(memory()).set("Cookie", admin.cookie).send({ title: "t".repeat(201), content: "x" })).status).toBe(400);
    expect((await request(app).post(memory()).set("Cookie", admin.cookie).send({ title: "x", content: "c".repeat(20_001) })).status).toBe(400);
  });
  it("edge: unknown and malformed ids are 404", async () => {
    expect((await request(app).patch(`${memory()}/${NIL_UUID}`).set("Cookie", admin.cookie).send({ title: "x", content: "y" })).status).toBe(404);
    expect((await request(app).delete(`${memory()}/bad-id`).set("Cookie", admin.cookie)).status).toBe(404);
  });
  it("security: outsiders cannot read or write memory", async () => {
    expect((await request(app).get(memory()).set("Cookie", outsider.cookie)).status).toBe(403);
    expect((await request(app).post(memory()).set("Cookie", outsider.cookie).send({ title: "x", content: "y" })).status).toBe(403);
  });
});
