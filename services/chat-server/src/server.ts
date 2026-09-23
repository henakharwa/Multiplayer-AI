import express, { type Request, type Response } from "express";
import cors from "cors";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import * as db from "@mai-chat/db";
import { createGithubClient, type GithubClient } from "@mai-chat/integrations";
import type { AuditEventType, Participant } from "@mai-chat/shared-types";
import { RoomRegistry } from "./rooms.js";
import { toLlmHistory } from "./history.js";
import { runAgentTurn as defaultRunAgentTurn, replyForResolvedActions, type AgentKind, type RunAgentTurnInput, type RunAgentTurnResult } from "./agent.js";
import { buildToolsForWorkspace, wrapForProposal, registerActionRoutes } from "./actions.js";
import { parseMentions } from "./mentions.js";
import type { ToolExecutor } from "./tools.js";
import { getGithubMcpClient, DEFAULT_GITHUB_TOOLS } from "./github-mcp-pool.js";
import { getSlackMcpClient } from "./slack-mcp-pool.js";
import { listMcpToolExecutors } from "./mcp-tools.js";
import { UUID_RE, paramString, errMessage } from "./http-utils.js";
import { attachUser, requireAuth, parseSessionToken, registerUserAuthRoutes, type UserAuthDeps, type UserAuthConfig } from "./auth.js";
import { registerEmailVerificationRoutes } from "./email-verification.js";
import { registerPasswordResetRoutes } from "./password-reset.js";
import { createMailer, defaultMailerConfig, type Mailer } from "./mailer.js";
import { registerProviderOAuthRoutes } from "./provider-oauth.js";
import {
  registerGithubOAuthRoutes,
  defaultGithubOAuthDeps,
  type GithubOAuthConfig,
  type GithubOAuthDeps,
} from "./github-oauth.js";
import {
  registerSlackOAuthRoutes,
  defaultSlackOAuthDeps,
  type SlackOAuthConfig,
  type SlackOAuthDeps,
} from "./slack-oauth.js";

// Workspace HTTP routes and WebSocket connections require a valid session.
// The landing page stays public. OAuth login reuses the integration callback,
// with a login-prefixed state distinguishing authentication from repo access.

export interface CreateServerDeps {
  userAuthDeps?: UserAuthDeps;
  // Used ONLY to verify a pasted GitHub token/owner/repo before saving it
  // (the two /integrations/github... routes below) -- NOT the agent's
  // GitHub tool source anymore. See githubMcpToolsFactory for that.
  githubClientFactory: (opts: { token: string; owner: string; repo: string }) => GithubClient;
  // The agent's actual GitHub tool surface: spawns (or reuses) this
  // workspace's own GitHub MCP server process and returns its tools
  // converted to this project's ToolExecutor shape. Injectable so tests
  // can supply canned tools without spawning a real subprocess -- see
  // github-mcp-pool.ts / mcp-tools.ts for the real implementation.
  githubMcpToolsFactory: (opts: { workspaceId: string; token: string }) => Promise<ToolExecutor[]>;
  // The agent's actual Slack tool surface -- connects to (or reuses a
  // connection to) Slack's own official MCP server with this workspace's
  // stored OAuth access token and returns its tools converted to this
  // project's ToolExecutor shape. Replaces the old hand-rolled
  // buildSlackTools()/packages/integrations/src/slack.ts client entirely
  // -- see slack-mcp-pool.ts / slack-oauth.ts. Injectable so tests can
  // supply canned tools without a real network call to mcp.slack.com.
  slackMcpToolsFactory: (opts: { workspaceId: string; accessToken: string }) => Promise<ToolExecutor[]>;
  runAgentTurn: (input: RunAgentTurnInput) => Promise<RunAgentTurnResult>;
  // Sends password-reset and email-verification mail. Injectable so
  // tests never hit a real provider -- the default (no RESEND_API_KEY
  // configured) just logs the message, which is enough for tests to
  // assert against (and safe/harmless if a test run leaves it on).
  mailer: Mailer;
  // GitHub OAuth login ("+ Add channel" in the UI) -- config comes from
  // env vars by default (see defaultGithubOAuthConfig below); deps are
  // injectable so tests never hit github.com for real.
  githubOAuthConfig: GithubOAuthConfig;
  githubOAuthDeps: GithubOAuthDeps;
  // Slack OAuth login -- the ONLY way to connect Slack now (see
  // slack-oauth.ts's own comment for why there's no pasted-token
  // fallback the way GitHub has one).
  slackOAuthConfig: SlackOAuthConfig;
  slackOAuthDeps: SlackOAuthDeps;
}

// Real implementation of githubMcpToolsFactory above -- spawns (or, for an
// unchanged token, reuses) this workspace's GitHub MCP server container
// via the module-level pool in github-mcp-pool.ts (`docker run` under the
// hood), and converts its tool list via mcp-tools.ts. Requires Docker
// Desktop installed and running -- see README.md's "GitHub tools via MCP
// server" section. GITHUB_MCP_DOCKER_IMAGE can override the image (e.g.
// to pin a version) if left unset it defaults to GitHub's own published
// ghcr.io/github/github-mcp-server.
export async function defaultGithubMcpToolsFactory(opts: { workspaceId: string; token: string }): Promise<ToolExecutor[]> {
  const client = await getGithubMcpClient(opts.workspaceId, {
    token: opts.token,
    image: process.env.GITHUB_MCP_DOCKER_IMAGE,
    toolsets: process.env.GITHUB_TOOLSETS,
    tools: process.env.GITHUB_TOOLS ?? (process.env.GITHUB_TOOLSETS ? undefined : DEFAULT_GITHUB_TOOLS),
  });
  return listMcpToolExecutors(client);
}

// Real implementation of slackMcpToolsFactory above -- connects to (or
// reuses a connection to) Slack's own official MCP server via the
// module-level pool in slack-mcp-pool.ts, using this workspace's stored
// Slack OAuth access token, and converts its tool list via the same
// generic mcp-tools.ts conversion GitHub's tools already go through.
// SLACK_MCP_SERVER_URL can override the endpoint (e.g. for a local
// stand-in during development); unset defaults to Slack's real
// https://mcp.slack.com/mcp.
export async function defaultSlackMcpToolsFactory(opts: { workspaceId: string; accessToken: string }): Promise<ToolExecutor[]> {
  const client = await getSlackMcpClient(opts.workspaceId, {
    accessToken: opts.accessToken,
    serverUrl: process.env.SLACK_MCP_SERVER_URL || undefined,
  });
  return listMcpToolExecutors(client);
}

// Centralized here (rather than read ad hoc at each call site) so tests can
// pass a whole config object instead of mutating process.env.
export function defaultGithubOAuthConfig(): GithubOAuthConfig {
  const publicUrl = process.env.CHAT_SERVER_PUBLIC_URL ?? `http://localhost:${process.env.CHAT_SERVER_PORT ?? 4000}`;
  return {
    clientId: process.env.GITHUB_OAUTH_CLIENT_ID ?? "",
    clientSecret: process.env.GITHUB_OAUTH_CLIENT_SECRET ?? "",
    redirectUri: `${publicUrl.replace(/\/$/, "")}/auth/github/callback`,
    webAppUrl: process.env.WEB_APP_URL ?? "http://localhost:3000",
  };
}

export function defaultSlackOAuthConfig(): SlackOAuthConfig {
  const publicUrl = process.env.CHAT_SERVER_PUBLIC_URL ?? `http://localhost:${process.env.CHAT_SERVER_PORT ?? 4000}`;
  return {
    clientId: process.env.SLACK_OAUTH_CLIENT_ID ?? "",
    clientSecret: process.env.SLACK_OAUTH_CLIENT_SECRET ?? "",
    redirectUri: `${publicUrl.replace(/\/$/, "")}/auth/slack/callback`,
    webAppUrl: process.env.WEB_APP_URL ?? "http://localhost:3000",
  };
}

const defaultDeps: CreateServerDeps = {
  githubClientFactory: createGithubClient,
  githubMcpToolsFactory: defaultGithubMcpToolsFactory,
  slackMcpToolsFactory: defaultSlackMcpToolsFactory,
  runAgentTurn: defaultRunAgentTurn,
  get mailer() {
    return createMailer(defaultMailerConfig());
  },
  get githubOAuthConfig() {
    return defaultGithubOAuthConfig();
  },
  githubOAuthDeps: defaultGithubOAuthDeps,
  get slackOAuthConfig() {
    return defaultSlackOAuthConfig();
  },
  slackOAuthDeps: defaultSlackOAuthDeps,
};

export function createApp(deps: CreateServerDeps = defaultDeps) {
  const app = express();
  // Browser Origin never includes a trailing slash. Normalizing the
  // configured URL avoids rejecting legitimate deployed requests when a
  // host dashboard stores the URL as `https://example.com/`.
  const webAppUrl = (process.env.WEB_APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  app.use(cors({ origin: webAppUrl, credentials: true }));
  app.use(express.json());
  app.use((req, res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers.origin && req.headers.origin !== webAppUrl) {
      res.status(403).json({ error: "Untrusted request origin" });
      return;
    }
    next();
  });
  app.use(attachUser());
  const userAuthConfig: UserAuthConfig = {
    ...deps.githubOAuthConfig,
    google: {
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
      redirectUri: `${(process.env.CHAT_SERVER_PUBLIC_URL ?? "http://localhost:4000").replace(/\/$/, "")}/auth/login/google/callback`,
    },
    redirectUri: deps.githubOAuthConfig.redirectUri,
    webAppUrl,
    secureCookie: new URL(webAppUrl).protocol === "https:",
  };
  registerUserAuthRoutes(app, userAuthConfig, deps.userAuthDeps, deps.mailer);
  registerEmailVerificationRoutes(app, userAuthConfig, deps.mailer);
  registerPasswordResetRoutes(app, userAuthConfig, deps.mailer);
  app.use("/workspaces", requireAuth);
  registerProviderOAuthRoutes(app);

  async function requireRole(req: Request, res: Response, allowed: Array<"admin" | "editor">): Promise<boolean> {
    const workspaceId = paramString(req.params.id);
    const role = await db.getWorkspaceRole(workspaceId, req.user!.id);
    if (!role || !allowed.includes(role)) {
      res.status(403).json({ error: "You do not have permission to perform this action." });
      return false;
    }
    return true;
  }

  app.get("/healthz", (_req: Request, res: Response) => res.json({ ok: true }));

  app.get("/notifications", requireAuth, async (req: Request, res: Response) => {
    const notifications = await db.listNotifications(req.user!.id);
    const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : null;
    res.json(workspaceId ? notifications.filter((notification) => notification.workspaceId === workspaceId) : notifications);
  });

  app.post("/notifications/read", requireAuth, async (req: Request, res: Response) => {
    const workspaceId = typeof req.body?.workspaceId === "string" ? req.body.workspaceId : "";
    if (!UUID_RE.test(workspaceId)) return res.status(400).json({ error: "valid workspaceId is required" });
    await db.markNotificationsRead(req.user!.id, workspaceId);
    res.status(204).end();
  });

  app.post("/workspaces", async (req: Request, res: Response) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name) return res.status(400).json({ error: "name is required" });
    const workspace = await db.createWorkspace(name);
    await db.addWorkspaceMember(workspace.id, req.user!.id, "admin");
    await db.createConversation({ workspaceId: workspace.id, createdByUserId: req.user!.id });
    await db.recordAuditEvent({
      workspaceId: workspace.id,
      eventType: "workspace.created",
      actorType: "user",
      actorUserId: req.user!.id,
      actorName: req.user!.displayName,
      summary: `${req.user!.displayName} created the workspace "${workspace.name}"`,
    });
    res.status(201).json(workspace);
  });

  app.get("/workspaces/by-code/:joinCode", async (req: Request, res: Response) => {
    const workspace = await db.getWorkspaceByJoinCode(paramString(req.params.joinCode));
    if (!workspace) return res.status(404).json({ error: "not found" });
    res.json(workspace);
  });

  app.get("/workspaces/:id", async (req: Request, res: Response) => {
    if (!UUID_RE.test(paramString(req.params.id))) return res.status(400).json({ error: "invalid workspace id" });
    const workspace = await db.getWorkspaceById(paramString(req.params.id));
    if (!workspace) return res.status(404).json({ error: "not found" });
    res.json(workspace);
  });

  app.get("/workspaces/:id/members", async (req: Request, res: Response) => {
    const workspaceId = paramString(req.params.id);
    if (!UUID_RE.test(workspaceId)) return res.status(400).json({ error: "invalid workspace id" });
    res.json(await db.listWorkspaceMembersWithRoles(workspaceId));
  });

  app.patch("/workspaces/:id/members/:userId", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin"]))) return;
    const role = req.body?.role;
    if (role !== "admin" && role !== "editor") return res.status(400).json({ error: "valid role is required" });
    const members = await db.listWorkspaceMembersWithRoles(paramString(req.params.id));
    const target = members.find((member) => member.id === paramString(req.params.userId));
    if (!target) return res.status(404).json({ error: "member not found" });
    if (target.role === "admin" && role !== "admin" && members.filter((member) => member.role === "admin").length === 1) {
      return res.status(409).json({ error: "A workspace must keep at least one admin." });
    }
    await db.setWorkspaceMemberRole(paramString(req.params.id), target.id, role);
    res.status(204).end();
  });

  app.get("/workspaces/:id/messages", async (req: Request, res: Response) => {
    if (!UUID_RE.test(paramString(req.params.id))) return res.status(400).json({ error: "invalid workspace id" });
    const workspace = await db.getWorkspaceById(paramString(req.params.id));
    if (!workspace) return res.status(404).json({ error: "not found" });
    const conversationId = typeof req.query.conversationId === "string" ? req.query.conversationId : "";
    if (!UUID_RE.test(conversationId) || !(await db.getConversation(paramString(req.params.id), conversationId))) {
      return res.status(400).json({ error: "valid conversationId is required" });
    }
    res.json(await db.listMessages(paramString(req.params.id), conversationId));
  });

  app.get("/workspaces/:id/conversations", async (req: Request, res: Response) => {
    const workspaceId = paramString(req.params.id);
    if (!UUID_RE.test(workspaceId)) return res.status(400).json({ error: "invalid workspace id" });
    if (!(await db.getWorkspaceById(workspaceId))) return res.status(404).json({ error: "not found" });
    let conversations = await db.listConversations(workspaceId);
    if (conversations.length === 0) conversations = [await db.createConversation({ workspaceId, createdByUserId: req.user!.id })];
    res.json(conversations);
  });

  app.post("/workspaces/:id/conversations", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const workspaceId = paramString(req.params.id);
    if (!UUID_RE.test(workspaceId)) return res.status(400).json({ error: "invalid workspace id" });
    if (!(await db.getWorkspaceById(workspaceId))) return res.status(404).json({ error: "not found" });
    const title = typeof req.body?.title === "string" ? req.body.title : undefined;
    res.status(201).json(await db.createConversation({ workspaceId, title, createdByUserId: req.user!.id }));
  });

  // Action audit trail (docs/spec.md Phase 2: "who asked for what, what
  // the agent did, when") -- see actions.ts / the WebSocket handlers
  // above for where these rows get written, and packages/db's
  // audit_events table for the storage shape. Filters mirror what the
  // Activity panel's search box + type dropdown send: `q` is a
  // case-insensitive substring match against actor name and summary,
  // `type` an exact AuditEventType, `before` an ISO timestamp for
  // "load older" pagination (keyset, not offset -- see listAuditEvents).
  app.get("/workspaces/:id/audit", async (req: Request, res: Response) => {
    if (!UUID_RE.test(paramString(req.params.id))) return res.status(400).json({ error: "invalid workspace id" });
    const workspaceId = paramString(req.params.id);
    const workspace = await db.getWorkspaceById(workspaceId);
    if (!workspace) return res.status(404).json({ error: "not found" });
    const eventType = typeof req.query.type === "string" && req.query.type ? (req.query.type as AuditEventType) : undefined;
    const search = typeof req.query.q === "string" && req.query.q.trim() ? req.query.q.trim() : undefined;
    const before = typeof req.query.before === "string" && req.query.before ? req.query.before : undefined;
    const limitParam = Number(req.query.limit);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined;
    const events = await db.listAuditEvents(workspaceId, { eventType, search, before, limit });
    res.json({ events, nextBefore: events.length > 0 ? events[events.length - 1].createdAt : null });
  });

  app.get("/workspaces/:id/integrations", async (req: Request, res: Response) => {
    if (!UUID_RE.test(paramString(req.params.id))) return res.status(400).json({ error: "invalid workspace id" });
    const workspace = await db.getWorkspaceById(paramString(req.params.id));
    if (!workspace) return res.status(404).json({ error: "not found" });
    res.json(await db.listIntegrations(paramString(req.params.id)));
  });

  app.delete("/workspaces/:id/integrations/:provider", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const workspaceId = paramString(req.params.id);
    const provider = paramString(req.params.provider);
    if (!UUID_RE.test(workspaceId)) return res.status(400).json({ error: "invalid workspace id" });
    if (!["github", "slack", "linear", "notion", "figma"].includes(provider)) return res.status(404).json({ error: "unknown integration" });
    const removed = await db.deleteIntegration(workspaceId, provider as "github" | "slack" | "linear" | "notion" | "figma");
    if (!removed) return res.status(404).json({ error: "integration not found" });
    await db.recordAuditEvent({ workspaceId, eventType: "integration.disconnected" as AuditEventType, actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} disconnected ${provider}`, metadata: { integration: provider } });
    res.status(204).end();
  });

  app.post("/workspaces/:id/integrations/github", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    if (!UUID_RE.test(paramString(req.params.id))) return res.status(400).json({ error: "invalid workspace id" });
    const workspace = await db.getWorkspaceById(paramString(req.params.id));
    if (!workspace) return res.status(404).json({ error: "not found" });
    const { owner, repo, token } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof owner !== "string" || typeof repo !== "string" || typeof token !== "string" || !owner || !repo || !token) {
      return res.status(400).json({ error: "owner, repo, and token are all required" });
    }
    try {
      // Verify the token actually works before saving it -- real
      // validation against the live API, not trust-on-write.
      await deps.githubClientFactory({ token, owner, repo }).listIssues("open", 1);
    } catch (err) {
      return res.status(400).json({ error: `could not verify GitHub access: ${errMessage(err)}` });
    }
    const config = await db.upsertGithubIntegration({ workspaceId: paramString(req.params.id), owner, repo, token });
    await db.recordAuditEvent({
      workspaceId: paramString(req.params.id),
      eventType: "integration.connected",
      actorType: "user",
      actorUserId: req.user!.id,
      actorName: req.user!.displayName,
      summary: `${req.user!.displayName} connected GitHub (${owner}/${repo})`,
      metadata: { integration: "github", owner, repo },
    });
    res.status(201).json(config);
  });

  app.post("/workspaces/:id/integrations/:provider/mcp", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const workspaceId = paramString(req.params.id);
    const provider = paramString(req.params.provider);
    if (provider !== "linear" && provider !== "notion" && provider !== "figma") return res.status(404).json({ error: "unknown MCP provider" });
    const endpoint = typeof req.body?.endpoint === "string" ? req.body.endpoint.trim() : "";
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    if (!endpoint.startsWith("https://") || !token) return res.status(400).json({ error: "HTTPS MCP endpoint and token are required" });
    try {
      const config = await db.upsertRemoteMcpIntegration({ workspaceId, type: provider, endpoint, token });
      res.status(201).json(config);
    } catch (error) { res.status(400).json({ error: errMessage(error) }); }
  });

  registerGithubOAuthRoutes(app, deps.githubOAuthConfig, deps.githubOAuthDeps);
  registerSlackOAuthRoutes(app, deps.slackOAuthConfig, deps.slackOAuthDeps);

  app.post("/workspaces/:id/integrations/github/repo", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    if (!UUID_RE.test(paramString(req.params.id))) return res.status(400).json({ error: "invalid workspace id" });
    const workspaceId = paramString(req.params.id);
    const workspace = await db.getWorkspaceById(workspaceId);
    if (!workspace) return res.status(404).json({ error: "not found" });
    const { owner, repo } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof owner !== "string" || typeof repo !== "string" || !owner || !repo) {
      return res.status(400).json({ error: "owner and repo are both required" });
    }
    const credential = await db.getIntegrationCredential(workspaceId, "github");
    if (!credential) return res.status(404).json({ error: "GitHub isn't connected for this workspace yet." });
    try {
      // Same "verify against the live API before saving" policy as the
      // pasted-token route above -- a repo picked from the list should
      // always work, but the token's access could have changed between
      // listing and picking (e.g. an org revoked it).
      await deps.githubClientFactory({ token: credential.token, owner, repo }).listIssues("open", 1);
    } catch (err) {
      return res.status(400).json({ error: `could not verify access to ${owner}/${repo}: ${errMessage(err)}` });
    }
    const config = await db.setGithubRepo({ workspaceId, owner, repo });
    if (!config) return res.status(404).json({ error: "GitHub isn't connected for this workspace yet." });
    res.json(config);
  });

  // No pasted-bot-token Slack route anymore -- Slack connects ONLY via
  // OAuth now (registerSlackOAuthRoutes above), since Slack's official
  // MCP server requires a real user access token from that exact flow; a
  // hand-pasted token could never authenticate to it. See slack-oauth.ts.

  return app;
}

export function createChatServer(deps: CreateServerDeps = defaultDeps) {
  const app = createApp(deps);
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });
  const rooms = new RoomRegistry();
  registerActionRoutes(app, deps, rooms);

  // A WebSocket can go dark without ever firing a "close" event -- a
  // laptop sleeping, wifi dropping, a dev-server hot reload orphaning the
  // old connection object -- which otherwise leaves a stale entry sitting
  // in RoomRegistry forever (and shows up as a "ghost" duplicate in the
  // presence list, e.g. the same person listed twice after reconnecting,
  // since the old dead connection never got cleaned up). Standard `ws`
  // library pattern: ping every open connection on an interval, and
  // terminate any socket that didn't answer the PREVIOUS ping with a
  // pong. terminate() synchronously emits "close", which runs the normal
  // rooms.leave()/presence-rebroadcast handling below, same as any other
  // disconnect.
  type HeartbeatSocket = WebSocket & { isAlive?: boolean };
  const HEARTBEAT_INTERVAL_MS = 30_000;
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      const socket = client as HeartbeatSocket;
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  wss.on("close", () => clearInterval(heartbeat));

  async function runAgentReply(workspaceId: string, conversationId: string, requestedBy: { userId: string; name: string }, agentKind: AgentKind): Promise<void> {
    const messages = await db.listMessages(workspaceId, conversationId);
    // Diagnostic timing (temporary, 2026-09-21 -- tracking down reports of
    // slow replies since GitHub's MCP tools were added): this covers
    // spawning/reusing the workspace's GitHub MCP Docker container (see
    // github-mcp-pool.ts) -- a real, one-time-per-credential-change cost
    // that's easy to mistake for "the LLM is slow" if you're only
    // watching the chat, not the terminal.
    const buildStart = Date.now();
    const built = await buildToolsForWorkspace(workspaceId, deps);
    console.log(`[timing] workspace ${workspaceId}: buildToolsForWorkspace (incl. GitHub MCP container) took ${Date.now() - buildStart}ms`);
    // Read tools run for real from the agent loop; write tools are
    // swapped for proposal-only stand-ins here -- see actions.ts.
    const specialistTools = agentKind === "github" ? built.githubTools : agentKind === "slack" ? built.slackTools : agentKind === "linear" ? built.linearTools : agentKind === "notion" ? built.notionTools : agentKind === "figma" ? built.figmaTools : [];
    const tools = wrapForProposal(specialistTools, workspaceId, conversationId, rooms, requestedBy);
    // Cheap, always-on diagnostic -- when someone reports "the agent says
    // it can't see GitHub" the first thing to know is whether the tool
    // list was actually empty for this turn (an integration/credential
    // problem) or non-empty (the model just didn't use what it had).
    console.log(`[agent] workspace ${workspaceId}: ${tools.length} tool(s) available for this turn`);

    // Confirmation notices are deliberately excluded from normal LLM
    // history (history.ts), so provide the recent authoritative outcomes as
    // compact server context instead. Without this, a follow-up such as
    // "is the action completed?" can only see the earlier proposal and may
    // incorrectly call an already-confirmed action pending.
    const recentActions = (await db.listPendingActions(workspaceId, conversationId))
      .slice(-5)
      .map((action) => `- ${action.description}: ${action.status}`)
      .join("\n");
    const turnStart = Date.now();
    const result = await deps.runAgentTurn({
      history: toLlmHistory(messages),
      tools,
      githubContext: agentKind === "github" ? built.githubContext : null,
      actionContext: recentActions || null,
      agentKind,
    });
    console.log(`[timing] workspace ${workspaceId}: runAgentTurn (all LLM calls + tool calls, see [timing] lines above) took ${Date.now() - turnStart}ms`);
    const proposedActions = await Promise.all(
      (result.proposedActionIds ?? []).map((actionId) => db.getPendingAction(workspaceId, actionId))
    );
    const resolvedReply = replyForResolvedActions(
      proposedActions.filter((action): action is NonNullable<typeof action> => action !== null),
      agentKind
    );
    const agentMessage = await db.insertMessage({
      workspaceId,
      conversationId,
      role: "agent",
      authorName: agentKind === "github" ? "GitHub Agent" : agentKind === "slack" ? "Slack Agent" : agentKind === "linear" ? "Linear Agent" : agentKind === "notion" ? "Notion Agent" : agentKind === "figma" ? "Figma Agent" : "Project Agent",
      content: resolvedReply ?? result.reply,
    });
    rooms.broadcast(`${workspaceId}:${conversationId}`, { type: "message", message: agentMessage });
    rooms.broadcast(workspaceId, { type: "workspace_message", message: agentMessage });
    await db.notifyWorkspaceMembers({
      workspaceId,
      conversationId,
      kind: "agent_completed",
      text: "Agent completed a response in the workspace.",
      excludeUserIds: rooms.participants(`${workspaceId}:${conversationId}`).flatMap((participant) => participant.userId ? [participant.userId] : []),
    });
  }

  wss.on("connection", (ws: WebSocket, req) => {
    if (req.headers.origin && req.headers.origin !== (process.env.WEB_APP_URL ?? "http://localhost:3000").replace(/\/+$/, "")) {
      ws.close(4003, "Untrusted origin");
      return;
    }
    // See the heartbeat setInterval above -- marks this connection alive
    // on open and on every pong, so a dead connection gets pruned instead
    // of lingering (and showing up as a duplicate) in the presence list.
    (ws as HeartbeatSocket).isAlive = true;
    ws.on("pong", () => {
      (ws as HeartbeatSocket).isAlive = true;
    });

    // Found live while testing @-mention/handoff routing: the real
    // message handler is only attached once the async setup below
    // (session lookup, workspace lookup, addWorkspaceMember, history
    // send) finishes, but a client is free to send its first chat message
    // the instant ITS OWN "open" event fires -- which can easily win that
    // race, especially on a slow DB round trip. Before this fix, a
    // message sent that early was silently dropped: no listener was
    // registered yet, so `ws.on("message", ...)` never saw it and the
    // client got no error, no echo, nothing. This tiny synchronous
    // listener is attached before any of those awaits run, so nothing can
    // be sent before it exists; it just queues raw frames until the real
    // handler below replaces it and flushes the queue in order.
    const earlyMessages: Buffer[] = [];
    let handleMessage: ((raw: Buffer) => void) | null = null;
    ws.on("message", (raw: Buffer) => {
      if (handleMessage) handleMessage(raw);
      else earlyMessages.push(raw);
    });

    void (async () => {
      const url = new URL(req.url ?? "", "http://localhost");
      const workspaceId = url.searchParams.get("workspaceId") ?? "";
      const conversationId = url.searchParams.get("conversationId") ?? "";
      const sessionToken = parseSessionToken(req.headers.cookie);
      const user = sessionToken ? await db.getUserBySessionToken(sessionToken) : null;
      if (!user) {
        ws.close(4001, "Sign in required");
        return;
      }
      const displayName = user.displayName;

      if (!UUID_RE.test(workspaceId) || !UUID_RE.test(conversationId)) {
        ws.close(4000, "workspaceId and conversationId are required");
        return;
      }
      const workspace = await db.getWorkspaceById(workspaceId);
      if (!workspace) {
        ws.close(4004, "workspace not found");
        return;
      }
      if (!(await db.getConversation(workspaceId, conversationId))) {
        ws.close(4004, "conversation not found");
        return;
      }
      const roomId = `${workspaceId}:${conversationId}`;

      const isFirstJoin = await db.addWorkspaceMember(workspaceId, user.id, "admin");
      const workspaceRole = await db.getWorkspaceRole(workspaceId, user.id);
      if (isFirstJoin) {
        await db.recordAuditEvent({
          workspaceId,
          eventType: "member.joined",
          actorType: "user",
          actorUserId: user.id,
          actorName: displayName,
          summary: `${displayName} joined the workspace`,
        });
      }
      const participant: Participant = { clientId: randomUUID(), userId: user.id, displayName, connectedAt: new Date().toISOString(), activeConversationId: conversationId };
      rooms.join(workspaceId, ws, participant);
      rooms.join(roomId, ws, participant);

      const history = await db.listMessages(workspaceId, conversationId);
      ws.send(JSON.stringify({ type: "history", messages: history }));
      rooms.broadcast(roomId, { type: "presence", participants: rooms.participants(roomId) });
      rooms.broadcast(workspaceId, { type: "workspace_presence", participants: rooms.participants(workspaceId) });

      handleMessage = (raw: Buffer) => {
        void (async () => {
          if (!sessionToken || !(await db.getUserBySessionToken(sessionToken))) {
            ws.close(4001, "Sign in required");
            return;
          }
          let parsed: { type?: string; content?: string; agentKind?: AgentKind };
          try {
            parsed = JSON.parse(raw.toString());
          } catch {
            ws.send(JSON.stringify({ type: "error", error: "invalid JSON" }));
            return;
          }
          if (parsed.type !== "chat" || typeof parsed.content !== "string" || !parsed.content.trim()) {
            ws.send(JSON.stringify({ type: "error", error: "expected {type: 'chat', content: string}" }));
            return;
          }
          const content = parsed.content.trim();
          const agentKind: AgentKind = parsed.agentKind === "github" || parsed.agentKind === "slack" || parsed.agentKind === "linear" || parsed.agentKind === "notion" || parsed.agentKind === "figma" || parsed.agentKind === "project"
            ? parsed.agentKind
            : /@github\b/i.test(content) ? "github" : /@slack\b/i.test(content) ? "slack" : "project";

          // @-mention / handoff mechanics (docs/spec.md Phase 2). Matched
          // against real workspace membership, not just who's currently
          // online, so @-mentioning an offline teammate still resolves --
          // see listWorkspaceMembers's own comment. A message that
          // @-mentions ONLY teammate(s), never the agent, is a handoff:
          // it's still a normal chat message (inserted/broadcast exactly
          // like any other, below), it just never starts an agent turn.
          const members = await db.listWorkspaceMembers(workspaceId);
          const mentions = parseMentions(
            content,
            members.map((m) => ({ userId: m.id, displayName: m.displayName }))
          );

          // Only one agent turn runs at a time per workspace -- everyone
          // shares this chat, and a second message arriving mid-turn would
          // have the agent read an incomplete/interleaved history and
          // could double-fire the same mutating tool. The UI already
          // disables the composer for everyone in the room while busy (see
          // the agent_status broadcast below); this is the server-side
          // backstop for a genuine race (e.g. a second tab, or a message
          // already in flight the instant busy became true). A handoff
          // message (mentions.mentionsAgent === false) never touches the
          // agent at all, so it's exempt -- no reason to make someone wait
          // to hand a task to a teammate just because the agent happens to
          // be busy on something else.
          if (mentions.mentionsAgent && rooms.isBusy(roomId)) {
            ws.send(JSON.stringify({ type: "error", error: "The agent is still working on the previous request. Please wait for it to finish." }));
            return;
          }

          const userMessage = await db.insertMessage({
            workspaceId,
            conversationId,
            role: "user",
            authorName: displayName,
            userId: user.id,
            content,
            mentionsAgent: mentions.mentionsAgent,
            mentionedUserIds: mentions.mentionedUserIds,
          });
          rooms.broadcast(roomId, { type: "message", message: userMessage });
          rooms.broadcast(workspaceId, { type: "workspace_message", message: userMessage });

          if (!mentions.mentionsAgent) {
            // Handed off, not addressed to the agent -- log it to the
            // audit trail (docs/spec.md: "so who's driving this stays
            // visible") and stop here; no agent turn to run.
            const handoffNames = members.filter((m) => mentions.mentionedUserIds.includes(m.id)).map((m) => m.displayName);
            await db.recordAuditEvent({
              workspaceId,
              eventType: "handoff.directed",
              actorType: "user",
              actorUserId: user.id,
              actorName: displayName,
              summary: `${displayName} handed off to ${handoffNames.join(", ") || "a teammate"}: ${content}`,
              metadata: { mentionedUserIds: mentions.mentionedUserIds },
            });
            return;
          }

          rooms.setBusy(roomId, true);
          rooms.broadcast(roomId, { type: "agent_status", status: "busy" });

          // Not awaited from the outer handler -- the sender's own message
          // is never delayed waiting on the agent -- but internally this
          // IIFE does wait for the turn to finish so the busy flag (and its
          // matching "idle" broadcast) always clears, success or failure,
          // via the finally below.
          (async () => {
            try {
              await runAgentReply(workspaceId, conversationId, { userId: user.id, name: displayName }, agentKind);
            } catch (err) {
              console.error("agent turn failed", err);
              const errorMessage = await db.insertMessage({
                workspaceId,
                conversationId,
                role: "system",
                authorName: "System",
                content: `The agent couldn't reply: ${errMessage(err)}`,
              });
              rooms.broadcast(roomId, { type: "message", message: errorMessage });
              rooms.broadcast(workspaceId, { type: "workspace_message", message: errorMessage });
            } finally {
              rooms.setBusy(roomId, false);
              rooms.broadcast(roomId, { type: "agent_status", status: "idle" });
            }
          })();
        })();
      };
      // Replay, in order, anything that arrived before this handler was
      // ready -- see the earlyMessages comment above.
      for (const raw of earlyMessages) handleMessage(raw);
      earlyMessages.length = 0;

      ws.on("close", () => {
        rooms.leave(roomId, ws);
        rooms.leave(workspaceId, ws);
        rooms.broadcast(roomId, { type: "presence", participants: rooms.participants(roomId) });
        rooms.broadcast(workspaceId, { type: "workspace_presence", participants: rooms.participants(workspaceId) });
      });
    })();
  });

  return {
    app,
    server,
    rooms,
    start(port: number) {
      server.listen(port);
      console.log(`chat-server listening on :${port}`);
      return server;
    },
  };
}
