// Regression coverage (review 2026-10-22): workflow runs start in the
// background, so a database failure while starting one must be recorded,
// not escape as an unhandled promise rejection (which stops the server).
// Workflows may also only post into their own workspace's conversations.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import * as db from "@mai-chat/db";
import { makeUser, makeWorkspace, newApp, setupDatabase, type TestUser } from "./helpers.js";

const app = newApp();
let admin: TestUser;
let ws: Awaited<ReturnType<typeof makeWorkspace>>;

beforeAll(async () => {
  await setupDatabase();
  admin = await makeUser("Admin");
  ws = await makeWorkspace(app, admin);
});
afterAll(async () => {
  await db.getPool().query("ALTER TABLE workspace_workflow_runs DROP CONSTRAINT IF EXISTS workflow_hardening_reject");
});

describe("WH-01 workflow runs", () => {
  it("a database failure while starting a run doesn't escape as an unhandled rejection", async () => {
    const created = await request(app).post(`/workspaces/${ws.id}/workflows`).set("Cookie", admin.cookie).send({ name: "Reject me", instructions: "Say hello." });
    expect(created.status).toBe(201);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    await db.getPool().query(
      `ALTER TABLE workspace_workflow_runs ADD CONSTRAINT workflow_hardening_reject CHECK (workflow_id <> '${created.body.id}'::uuid) NOT VALID`,
    );
    try {
      const run = await request(app).post(`/workspaces/${ws.id}/workflows/${created.body.id}/run`).set("Cookie", admin.cookie).send({});
      expect(run.status).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 300));
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await db.getPool().query("ALTER TABLE workspace_workflow_runs DROP CONSTRAINT IF EXISTS workflow_hardening_reject");
    }
    expect(unhandled).toHaveLength(0);
    // The server still answers normally.
    expect((await request(app).get(`/workspaces/${ws.id}/workflows`).set("Cookie", admin.cookie)).status).toBe(200);
  });

  it("refuses a delivery conversation from another workspace", async () => {
    const other = await makeWorkspace(app, admin);
    const sent = await request(app)
      .post(`/workspaces/${ws.id}/workflows`)
      .set("Cookie", admin.cookie)
      .send({ name: "Cross-post", instructions: "Say hello.", conversationId: other.conversationId });
    expect(sent.status).toBe(400);
    const own = await request(app)
      .post(`/workspaces/${ws.id}/workflows`)
      .set("Cookie", admin.cookie)
      .send({ name: "Same workspace", instructions: "Say hello.", conversationId: ws.conversationId });
    expect(own.status).toBe(201);
    const moved = await request(app)
      .patch(`/workspaces/${ws.id}/workflows/${own.body.id}`)
      .set("Cookie", admin.cookie)
      .send({ name: "Same workspace", instructions: "Say hello.", conversationId: other.conversationId });
    expect(moved.status).toBe(400);
  });
});
