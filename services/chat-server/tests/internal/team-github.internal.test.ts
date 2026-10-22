// Several members working in the same GitHub repositories: the workspace
// repository list and per-account access (TG-01), who each answer acted as
// (TG-02), duplicate warnings (TG-03), the run-as rule (TG-04), verified
// webhooks, real event triggers and the GitHub App fallback (TG-05), and
// live team activity (TG-06).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import request from "supertest";
import { WebSocket } from "ws";
import * as db from "@mai-chat/db";
import type { ChatMessage, PendingAction, TeamActivity } from "@mai-chat/shared-types";
import { createChatServer } from "../../src/server.js";
import type { ToolExecutor } from "../../src/tools.js";
import type { GithubTeamApi, RepoAccess } from "../../src/github-api.js";
import type { RunAgentTurnInput, RunAgentTurnResult } from "../../src/agent.js";
import { describeActionTarget, findActionWarnings, summarizeGithubEvent, titleSimilarity, verifyGithubSignature } from "../../src/github-team.js";
import { parseRepositoryInput } from "../../src/routes/github-team.js";
import { setupDatabase, makeUser, makeDeps, makeWorkspace, grantEditor, type TestUser } from "./helpers.js";

type ToolCall = { tool: string; args: Record<string, unknown>; token: string };
const toolCalls: ToolCall[] = [];
const factoryCalls: Array<{ token: string; accountKey?: string }> = [];

function fakeGithubTools(token: string): ToolExecutor[] {
  const tool = (name: string, mutates: boolean, result: unknown): ToolExecutor => ({
    definition: { type: "function", function: { name, description: name.replace(/_/g, " "), parameters: { type: "object" } } },
    ...(mutates ? { mutates: true, describe: (args: Record<string, unknown>) => `${name.replace(/_/g, " ")} ${args.issue_number ?? args.title ?? ""}`.trim() } : {}),
    execute: async (args) => {
      toolCalls.push({ tool: name, args, token });
      return result;
    },
  });
  return [
    tool("list_issues", false, [{ number: 14, title: "Login fails" }]),
    tool("add_issue_comment", true, { html_url: "https://github.com/acme/web/issues/14#issuecomment-1" }),
    tool("issue_write", true, { html_url: "https://github.com/acme/web/issues/30" }),
  ];
}

const access: Record<string, RepoAccess> = {};
let appOn = false;
const hooks: Array<{ url: string; secret: string; events: string[] }> = [];
const logins: Record<string, string> = { "tok-admin": "hena-gh", "tok-stevens": "stevens-gh", "tok-casey": "casey-gh" };
const teamApi: GithubTeamApi = {
  getLogin: async (token) => logins[token] ?? null,
  getRepoAccess: async (token, owner, repo) => access[`${token}:${owner}/${repo}`] ?? "write",
  listOpenIssues: async () => [{ number: 22, title: "Login fails on Safari", url: "https://github.com/acme/web/issues/22" }],
  createRepoWebhook: async (_token, _owner, _repo, input) => {
    hooks.push(input);
    return { id: 991 };
  },
  app: {
    configured: () => appOn,
    installUrl: () => (appOn ? "https://github.com/apps/nexus-test/installations/new" : null),
    webhookSecret: () => "app-secret",
    isInstalled: async () => appOn,
    installationToken: async () => (appOn ? "tok-app" : null),
    botLogin: () => "nexus-test[bot]",
  },
};

let script: (input: RunAgentTurnInput) => Promise<RunAgentTurnResult> = async () => ({ reply: "ok", toolCallsMade: 0, toolTrace: [], providerPromptTokens: 0, providerCompletionTokens: 0, providerCostUsd: null });
const seenInputs: RunAgentTurnInput[] = [];

const { app, server } = createChatServer(
  makeDeps({
    githubMcpToolsFactory: async ({ token, accountKey }) => {
      factoryCalls.push({ token, accountKey });
      return fakeGithubTools(token);
    },
    githubTeamApi: teamApi,
    runAgentTurn: async (input) => {
      seenInputs.push(input);
      return script(input);
    },
  })
);
let port = 0;
let admin: TestUser;
let stevens: TestUser;
let casey: TestUser;
let ws: Awaited<ReturnType<typeof makeWorkspace>>;

const result = (reply: string, toolCallsMade: number, proposedActionIds: string[] = []): RunAgentTurnResult => ({ reply, toolCallsMade, toolTrace: [], providerPromptTokens: 0, providerCompletionTokens: 0, providerCostUsd: null, proposedActionIds });

async function waitFor<T>(check: () => T | undefined | null | false | Promise<T | undefined | null | false>, timeoutMs = 5000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await check();
    if (value) return value as T;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for condition");
}

/** Opens a socket as `user`, sends one GitHub agent message, and returns the agent's reply and every event seen. */
async function githubTurn(user: TestUser, content: string, conversationId = ws.conversationId) {
  const events: Array<{ type: string; message?: ChatMessage; action?: PendingAction; activity?: TeamActivity }> = [];
  const socket = new WebSocket(`ws://localhost:${port}/ws?workspaceId=${ws.id}&conversationId=${conversationId}`, { headers: { Cookie: user.cookie, Origin: "http://localhost:3000" } });
  socket.on("message", (data) => events.push(JSON.parse(data.toString())));
  await new Promise((resolve) => socket.on("open", resolve));
  await waitFor(() => events.some((event) => event.type === "presence"));
  socket.send(JSON.stringify({ type: "chat", content, agentKind: "github" }));
  const reply = await waitFor(() => events.find((event) => event.type === "message" && event.message?.role === "agent")?.message);
  await waitFor(() => events.some((event) => event.type === "agent_status" && (event as { status?: string }).status === "idle"));
  socket.close();
  return { reply, events };
}

async function connectGithub(user: TestUser, token: string) {
  await db.saveGithubOAuthToken({ workspaceId: ws.id, token, ownerUserId: user.id });
}

const as = (user: TestUser) => ({
  get: (path: string) => request(app).get(path).set("Cookie", user.cookie),
  post: (path: string, body: unknown = {}) => request(app).post(path).set("Cookie", user.cookie).send(body as object),
  delete: (path: string) => request(app).delete(path).set("Cookie", user.cookie),
});

function sign(secret: string, body: string) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

beforeAll(async () => {
  await setupDatabase();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as { port: number }).port;
  admin = await makeUser("Admin");
  stevens = await makeUser("Stevens");
  casey = await makeUser("Casey");
  ws = await makeWorkspace(app, admin, [stevens, casey]);
  await connectGithub(admin, "tok-admin");
  await connectGithub(stevens, "tok-stevens");
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.closePool();
});
beforeEach(() => {
  toolCalls.length = 0;
  seenInputs.length = 0;
  appOn = false;
});

describe("TG-01 workspace repositories and per-account access", () => {
  it("only Admins manage the list; names are validated and checked against the Admin's own access", async () => {
    access["tok-admin:acme/private"] = "none";
    expect((await as(stevens).post(`/workspaces/${ws.id}/repositories`, { fullName: "acme/web" })).status).toBe(403);
    expect((await as(admin).post(`/workspaces/${ws.id}/repositories`, { fullName: "not a repo" })).status).toBe(400);
    expect((await as(admin).post(`/workspaces/${ws.id}/repositories`, { fullName: "acme/private" })).body.error).toMatch(/can't access acme\/private/);
    const web = await as(admin).post(`/workspaces/${ws.id}/repositories`, { fullName: "https://github.com/acme/web" });
    expect(web.status).toBe(201);
    expect(web.body).toMatchObject({ fullName: "acme/web", isDefault: true });
    expect((await as(admin).post(`/workspaces/${ws.id}/repositories`, { owner: "ACME", repo: "WEB" })).status).toBe(409);
    const secret = await as(admin).post(`/workspaces/${ws.id}/repositories`, { fullName: "acme/secret" });
    expect(secret.body.isDefault).toBe(false);
  });

  it("shows each member what their own account can do on each repository", async () => {
    access["tok-stevens:acme/secret"] = "none";
    const forStevens = await as(stevens).get(`/workspaces/${ws.id}/repositories`);
    expect(forStevens.body.map((repository: { fullName: string; myAccess: string }) => [repository.fullName, repository.myAccess])).toEqual([
      ["acme/web", "write"],
      ["acme/secret", "none"],
    ]);
    const forCasey = await as(casey).get(`/workspaces/${ws.id}/repositories`);
    expect(forCasey.body.every((repository: { myAccess: string }) => repository.myAccess === "not_connected")).toBe(true);
  });

  it("reaches workspace repositories through the asker's own account and refuses anything else", async () => {
    const errors: string[] = [];
    script = async ({ tools }) => {
      const list = tools.find((tool) => tool.definition.function.name === "list_issues")!;
      for (const repo of ["other", "secret"]) {
        await list.execute({ owner: "acme", repo }).catch((error: Error) => errors.push(error.message));
      }
      await list.execute({ owner: "acme", repo: "web" });
      return result("Two open issues in acme/web.", 3);
    };
    const { reply } = await githubTurn(stevens, "What is open?");
    expect(errors[0]).toMatch(/acme\/other is not one of this workspace's repositories \(acme\/web, acme\/secret\)/);
    expect(errors[1]).toMatch(/Your GitHub account \(@stevens-gh\) can't access acme\/secret/);
    expect(toolCalls).toEqual([{ tool: "list_issues", args: { owner: "acme", repo: "web" }, token: "tok-stevens" }]);
    // Each member keeps their own GitHub server process.
    expect(factoryCalls.at(-1)).toEqual({ token: "tok-stevens", accountKey: stevens.id });
    expect(seenInputs[0].githubContext).toMatchObject({ owner: "acme", repo: "web", account: "stevens-gh", actingAs: "Stevens", via: "user", workspaceList: true });
    expect(seenInputs[0].githubContext?.repos).toEqual([
      { owner: "acme", repo: "web", access: "write", isDefault: true },
      { owner: "acme", repo: "secret", access: "none", isDefault: false },
    ]);
    // TG-02: the reply records whose account answered and where it read.
    expect(reply.provenance).toEqual({ provider: "github", via: "user", actedAsUserId: stevens.id, actedAsName: "Stevens", account: "stevens-gh", repos: ["acme/web"] });
  });

  it("tells a member without a GitHub connection what to do instead of using someone else's", async () => {
    script = async () => result("Connect GitHub first.", 0);
    const { reply } = await githubTurn(casey, "What is open?");
    expect(seenInputs[0].tools).toEqual([]);
    expect(seenInputs[0].githubNotice).toMatch(/works on acme\/web, acme\/secret, but Casey has not connected their GitHub account/);
    expect(reply.provenance ?? null).toBeNull();
  });

  it("lets an Admin change the default and remove a repository", async () => {
    const list = (await as(admin).get(`/workspaces/${ws.id}/repositories`)).body as Array<{ id: string; fullName: string }>;
    const secret = list.find((repository) => repository.fullName === "acme/secret")!;
    expect((await as(stevens).post(`/workspaces/${ws.id}/repositories/${secret.id}/default`)).status).toBe(403);
    expect((await as(admin).post(`/workspaces/${ws.id}/repositories/${secret.id}/default`)).body.isDefault).toBe(true);
    expect((await as(admin).delete(`/workspaces/${ws.id}/repositories/${secret.id}`)).status).toBe(204);
    const after = (await as(admin).get(`/workspaces/${ws.id}/repositories`)).body as Array<{ fullName: string; isDefault: boolean }>;
    expect(after).toEqual([expect.objectContaining({ fullName: "acme/web", isDefault: true })]);
    const events = await db.listAuditEvents(ws.id, { limit: 50 });
    expect(events.map((event) => event.eventType)).toEqual(expect.arrayContaining(["repository.added", "repository.updated", "repository.removed"]));
  });
});

describe("TG-03 duplicate and conflict warnings", () => {
  it("flags a teammate's waiting change to the same issue and similar open issues", async () => {
    script = async ({ tools }) => {
      const comment = tools.find((tool) => tool.definition.function.name === "add_issue_comment")!;
      const proposal = (await comment.execute({ owner: "acme", repo: "web", issue_number: 14, body: "Looking into it" })) as { actionId: string };
      return result("Proposed a comment.", 1, [proposal.actionId]);
    };
    await githubTurn(stevens, "Comment on #14");
    let second: Record<string, unknown> = {};
    script = async ({ tools }) => {
      const comment = tools.find((tool) => tool.definition.function.name === "add_issue_comment")!;
      second = (await comment.execute({ owner: "acme", repo: "web", issue_number: 14, body: "Me too" })) as Record<string, unknown>;
      return result("Proposed a comment.", 1, [second.actionId as string]);
    };
    const { events } = await githubTurn(admin, "Comment on #14 as well");
    const card = events.find((event) => event.type === "pending_action")!.action!;
    expect(card.target).toMatchObject({ provider: "github", kind: "comment", repo: "acme/web", number: 14, key: "github:acme/web#14" });
    expect(card.warnings).toEqual([expect.objectContaining({ kind: "pending_duplicate", message: "Stevens already has a waiting comment on #14 in acme/web (conversation “What is open?”)." })]);
    expect(card.runAsAccount).toBe("hena-gh");
    // The agent is told too, so it can mention it.
    expect(second.possibleDuplicates).toEqual(["Stevens already has a waiting comment on #14 in acme/web (conversation “What is open?”)."]);

    script = async ({ tools }) => {
      const create = tools.find((tool) => tool.definition.function.name === "issue_write")!;
      await create.execute({ method: "create", owner: "acme", repo: "web", title: "Login fails in Safari browser" });
      return result("Proposed an issue.", 1);
    };
    const created = await githubTurn(stevens, "Open an issue for the Safari login bug");
    const issueCard = created.events.find((event) => event.type === "pending_action")!.action!;
    expect(issueCard.warnings).toEqual([expect.objectContaining({ kind: "similar_issue", url: "https://github.com/acme/web/issues/22", message: "Similar open issue #22 “Login fails on Safari” already exists in acme/web." })]);
  });

  it("describes targets and compares titles sensibly", () => {
    expect(describeActionTarget("merge_pull_request", { owner: "a", repo: "b", pullNumber: 7 }, "github")).toMatchObject({ kind: "merge", key: "github:a/b#7", label: "#7 in a/b" });
    expect(describeActionTarget("create_or_update_file", { owner: "a", repo: "b", path: "README.md", branch: "main" }, "github").key).toBe("github:a/b:file:main:README.md");
    expect(describeActionTarget("save_issue", { title: "Ship it" }, "linear")).toMatchObject({ kind: "new_issue", key: "linear:new-issue:ship it" });
    expect(titleSimilarity("Login fails on Safari", "Safari login failure")).toBeGreaterThanOrEqual(0.5);
    expect(titleSimilarity("Update the README", "Payment webhook times out")).toBe(0);
    const target = describeActionTarget("add_issue_comment", { owner: "a", repo: "b", issue_number: 3 }, "github");
    const confirmed = { id: "x", status: "confirmed", toolName: "add_issue_comment", target, requestedByName: "Casey", requestedByUserId: "u2", resolvedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() } as unknown as PendingAction;
    expect(findActionWarnings({ target, toolName: "add_issue_comment", requestedByUserId: "u1", existing: [confirmed] })[0].message).toBe("Casey's agent already made a comment on #3 in a/b 2 hours ago.");
  });
});

describe("TG-04 run-as rule", () => {
  it("runs as the requester, and offers Run as me when the requester's connection is gone", async () => {
    const pending = (await db.listActionsForConflictCheck(ws.id)).filter((action) => action.status === "pending");
    const stevensComment = pending.find((action) => action.requestedByUserId === stevens.id && action.toolName === "add_issue_comment")!;
    const adminComment = pending.find((action) => action.requestedByUserId === admin.id)!;
    expect(stevensComment.runAsUserId).toBe(stevens.id);
    expect(stevensComment.runAsAccount).toBe("stevens-gh");

    // Normal path: the requester's own account performs the write.
    expect((await as(admin).post(`/workspaces/${ws.id}/actions/${adminComment.id}/confirm`)).status).toBe(200);
    expect(toolCalls.at(-1)).toMatchObject({ tool: "add_issue_comment", token: "tok-admin" });

    // Stevens disconnects: the card says so and the approver can run it as themselves.
    const stevensGithub = (await db.listIntegrations(ws.id)).find((integration) => integration.type === "github" && integration.ownerUserId === stevens.id)!;
    await db.deleteIntegrationForOwner(ws.id, "github", stevensGithub.id!, stevens.id);
    const listed = (await as(admin).get(`/workspaces/${ws.id}/actions?conversationId=${ws.conversationId}`)).body as PendingAction[];
    expect(listed.find((action) => action.id === stevensComment.id)?.runAsAvailable).toBe(false);
    const refused = await as(admin).post(`/workspaces/${ws.id}/actions/${stevensComment.id}/confirm`);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "run_as_unavailable", canRunAsMe: true });
    expect(refused.body.error).toMatch(/Stevens's GitHub connection can no longer run this action. You can run it as yourself \(@hena-gh\)/);
    expect((await db.getPendingAction(ws.id, stevensComment.id))?.status).toBe("pending");

    const ran = await as(admin).post(`/workspaces/${ws.id}/actions/${stevensComment.id}/confirm`, { runAs: "me" });
    expect(ran.status).toBe(200);
    expect(toolCalls.at(-1)).toMatchObject({ tool: "add_issue_comment", token: "tok-admin" });
    const done = await db.getPendingAction(ws.id, stevensComment.id);
    expect(done).toMatchObject({ status: "confirmed", executedAsUserId: admin.id, executedAsAccount: "hena-gh" });
    const messages = await db.listMessages(ws.id, ws.conversationId);
    expect(messages.some((message) => message.content.includes("It ran as Admin (@hena-gh) because Stevens's connection was unavailable."))).toBe(true);
    await connectGithub(stevens, "tok-stevens");
  });

  it("offers Run as me when the requester's account can only read the repository", async () => {
    script = async ({ tools }) => {
      const comment = tools.find((tool) => tool.definition.function.name === "add_issue_comment")!;
      const proposal = (await comment.execute({ owner: "acme", repo: "web", issue_number: 20, body: "On it" })) as { actionId: string };
      return result("Proposed a comment.", 1, [proposal.actionId]);
    };
    const { events } = await githubTurn(stevens, "Comment on #20");
    const card = events.find((event) => event.type === "pending_action")!.action!;
    access["tok-stevens:acme/web"] = "read";
    const refused = await as(admin).post(`/workspaces/${ws.id}/actions/${card.id}/confirm`);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("run_as_unavailable");
    expect((await as(admin).post(`/workspaces/${ws.id}/actions/${card.id}/confirm`, { runAs: "me" })).status).toBe(200);
    expect(toolCalls.at(-1)).toMatchObject({ tool: "add_issue_comment", token: "tok-admin" });
    delete access["tok-stevens:acme/web"];
  });
});

describe("TG-05 GitHub webhooks, event triggers and the workspace GitHub App", () => {
  const issueOpened = (number: number, repo = "acme/web") =>
    JSON.stringify({ action: "opened", issue: { number, title: "Checkout button broken", html_url: `https://github.com/${repo}/issues/${number}`, body: "Steps to reproduce" }, repository: { full_name: repo }, sender: { login: "octocat", type: "User" } });

  it("shows the webhook URL to members and the secret to Admins only", async () => {
    const forAdmin = await as(admin).get(`/workspaces/${ws.id}/github/setup`);
    expect(forAdmin.body.webhookUrl).toMatch(new RegExp(`/webhooks/github/workspaces/${ws.id}$`));
    expect(forAdmin.body.webhookSecret).toMatch(/^[0-9a-f]{48}$/);
    expect(forAdmin.body.events).toContain("issues");
    expect((await as(stevens).get(`/workspaces/${ws.id}/github/setup`)).body.webhookSecret).toBeUndefined();
    const repository = (await as(admin).get(`/workspaces/${ws.id}/repositories`)).body[0];
    const hook = await as(admin).post(`/workspaces/${ws.id}/repositories/${repository.id}/webhook`);
    expect(hook.body.webhookId).toBe(991);
    expect(hooks.at(-1)).toMatchObject({ url: forAdmin.body.webhookUrl, secret: forAdmin.body.webhookSecret });
  });

  it("verifies signatures, records the event, pushes it live, starts matching workflows, and ignores redeliveries", async () => {
    const workflow = await as(admin).post(`/workspaces/${ws.id}/workflows`, { name: "Triage new issues", instructions: "Summarize the new issue.", agentKind: "github", trigger: "github_issue" });
    expect(workflow.status).toBe(201);
    script = async () => result("Triage: checkout bug, needs an owner.", 1);
    const secret = (await as(admin).get(`/workspaces/${ws.id}/github/setup`)).body.webhookSecret as string;
    const body = issueOpened(31);
    const url = `/webhooks/github/workspaces/${ws.id}`;
    const headers = (signature: string, delivery: string) => ({ "content-type": "application/json", "x-github-event": "issues", "x-github-delivery": delivery, "x-hub-signature-256": signature });

    expect((await request(app).post(url).set(headers(sign("wrong", body), "d-1")).send(body)).status).toBe(401);

    const live: TeamActivity[] = [];
    const socket = new WebSocket(`ws://localhost:${port}/ws?workspaceId=${ws.id}&conversationId=${ws.conversationId}`, { headers: { Cookie: stevens.cookie, Origin: "http://localhost:3000" } });
    socket.on("message", (data) => {
      const event = JSON.parse(data.toString());
      if (event.type === "team_activity") live.push(event.activity);
    });
    await new Promise((resolve) => socket.on("open", resolve));
    await new Promise((resolve) => setTimeout(resolve, 150));

    const accepted = await request(app).post(url).set(headers(sign(secret, body), "d-1")).send(body);
    expect(accepted.status).toBe(202);
    expect(accepted.body.processed).toBe(1);
    await waitFor(() => live.length > 0);
    expect(live[0]).toMatchObject({ source: "github", summary: "@octocat opened issue #31 “Checkout button broken” in acme/web", url: "https://github.com/acme/web/issues/31" });

    const run = await waitFor(async () => (await db.listWorkflowRuns(ws.id, workflow.body.id)).find((candidate) => candidate.status !== "running"));
    expect(run).toMatchObject({ trigger: "github_issue", status: "succeeded" });
    expect(seenInputs.at(-1)?.customInstructions).toMatch(/EVENT DATA[\s\S]*Checkout button broken[\s\S]*Steps to reproduce/);

    // GitHub retries the same delivery: it is acknowledged but not run again.
    expect((await request(app).post(url).set(headers(sign(secret, body), "d-1")).send(body)).body.processed).toBe(0);
    // A repository that is not on the list is ignored.
    const other = issueOpened(5, "acme/elsewhere");
    expect((await request(app).post(url).set(headers(sign(secret, other), "d-2")).send(other)).body.processed).toBe(0);
    socket.close();

    const activity = (await as(stevens).get(`/workspaces/${ws.id}/team-activity`)).body as TeamActivity[];
    expect(activity.some((item) => item.source === "github" && item.summary.includes("#31"))).toBe(true);
    expect(activity.some((item) => item.source === "nexus" && item.summary === "Stevens's agent made a comment on #14 in acme/web (approved by Admin)")).toBe(true);
    await as(admin).delete(`/workspaces/${ws.id}/workflows/${workflow.body.id}`);
  });

  it("accepts GitHub App deliveries for every workspace with the repository, signed with the App secret", async () => {
    const body = issueOpened(40);
    const res = await request(app)
      .post("/webhooks/github")
      .set({ "content-type": "application/json", "x-github-event": "issues", "x-github-delivery": `app-${randomUUID()}`, "x-hub-signature-256": sign("app-secret", body) })
      .send(body);
    expect(res.status).toBe(202);
    expect(res.body.processed).toBeGreaterThanOrEqual(1);
  });

  it("keeps a workflow running through the GitHub App after its owner leaves, and lets an Admin take it over otherwise", async () => {
    await grantEditor(ws.id, { manageWorkflows: true });
    await connectGithub(casey, "tok-casey");
    const workflow = await as(casey).post(`/workspaces/${ws.id}/workflows`, { name: "Issue digest", instructions: "Summarize the new issue.", agentKind: "github", trigger: "github_issue" });
    expect(workflow.status).toBe(201);
    await grantEditor(ws.id, { manageWorkflows: false });
    expect((await as(admin).delete(`/workspaces/${ws.id}/members/${casey.id}`)).status).toBeLessThan(300);
    const listed = (await as(admin).get(`/workspaces/${ws.id}/workflows`)).body.find((item: { id: string }) => item.id === workflow.body.id);
    expect(listed).toMatchObject({ ownerName: "Casey", ownerIsMember: false });

    const secret = (await as(admin).get(`/workspaces/${ws.id}/github/setup`)).body.webhookSecret as string;
    const deliver = (number: number) => {
      const body = issueOpened(number);
      return request(app)
        .post(`/webhooks/github/workspaces/${ws.id}`)
        .set({ "content-type": "application/json", "x-github-event": "issues", "x-github-delivery": `d-${randomUUID()}`, "x-hub-signature-256": sign(secret, body) })
        .send(body);
    };

    // Without the App, the run fails with a clear next step.
    await deliver(50);
    const failed = await waitFor(async () => (await db.listWorkflowRuns(ws.id, workflow.body.id)).find((candidate) => candidate.status === "failed"));
    expect(failed.detail).toMatch(/no longer a workspace member\. An Admin can take it over on the Workflows page, or install the workspace GitHub App/);

    // With the App installed, it runs as the App on the workspace repositories.
    appOn = true;
    script = async ({ tools }) => {
      await tools.find((tool) => tool.definition.function.name === "list_issues")!.execute({ owner: "acme", repo: "web" });
      return result("Digest posted.", 1);
    };
    await deliver(51);
    await waitFor(async () => (await db.listWorkflowRuns(ws.id, workflow.body.id)).find((candidate) => candidate.status === "succeeded"));
    expect(seenInputs.at(-1)?.githubContext).toMatchObject({ via: "app", account: "nexus-test[bot]", owner: "acme", repo: "web" });
    expect(toolCalls.at(-1)).toMatchObject({ tool: "list_issues", token: "tok-app" });
    expect(factoryCalls.at(-1)).toEqual({ token: "tok-app", accountKey: "app" });

    // Editors without Manage workflows cannot take it over; Admins can.
    expect((await as(stevens).post(`/workspaces/${ws.id}/workflows/${workflow.body.id}/take-over`)).status).toBe(403);
    const taken = await as(admin).post(`/workspaces/${ws.id}/workflows/${workflow.body.id}/take-over`);
    expect(taken.body).toMatchObject({ ownerUserId: admin.id, ownerIsMember: true });
  });
});

describe("TG-06 team activity in the agent's context", () => {
  it("gives the GitHub agent recent teammate and GitHub activity", async () => {
    script = async () => result("Already handled.", 0);
    await githubTurn(admin, "Should I comment on #14?");
    expect(seenInputs[0].teamActivity).toMatch(/Stevens's agent made a comment on #14 in acme\/web \(approved by Admin\)/);
    expect(seenInputs[0].teamActivity).toMatch(/@octocat opened issue #31/);
  });
});

describe("helpers", () => {
  it("parses repository input in the common forms", () => {
    expect(parseRepositoryInput({ fullName: "acme/web" })).toEqual({ owner: "acme", repo: "web" });
    expect(parseRepositoryInput({ url: "https://github.com/acme/web.git" })).toEqual({ owner: "acme", repo: "web" });
    expect(parseRepositoryInput({ owner: "acme", repo: "web" })).toEqual({ owner: "acme", repo: "web" });
    expect(parseRepositoryInput({ fullName: "acme" })).toBeNull();
  });

  it("verifies signatures in constant time and summarizes the common events", () => {
    const body = Buffer.from('{"a":1}');
    expect(verifyGithubSignature("s", body, sign("s", '{"a":1}'))).toBe(true);
    expect(verifyGithubSignature("s", body, undefined)).toBe(false);
    expect(summarizeGithubEvent("pull_request", { action: "closed", pull_request: { number: 9, title: "Fix", merged: true, html_url: "u" }, repository: { full_name: "a/b" }, sender: { login: "x" } }).summary).toBe("@x merged pull request #9 “Fix” in a/b");
    const ci = summarizeGithubEvent("workflow_run", { action: "completed", workflow_run: { name: "CI", conclusion: "failure", head_branch: "main" }, repository: { full_name: "a/b" }, sender: { login: "x" } });
    expect(ci).toMatchObject({ summary: "CI “CI” failure on main in a/b", trigger: "github_status", ignore: false });
    expect(summarizeGithubEvent("workflow_run", { action: "requested", workflow_run: {}, repository: { full_name: "a/b" } }).ignore).toBe(true);
  });
});
