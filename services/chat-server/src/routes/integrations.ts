// Integrations: connect, test, list and disconnect provider connections.
import * as db from "@mai-chat/db";
import { UUID_RE, errMessage, paramString } from "../http-utils.js";
import { testIntegrationConnection } from "../integration-health.js";
import { registerGithubOAuthRoutes } from "../github-oauth.js";
import { registerSlackOAuthRoutes } from "../slack-oauth.js";
import type { Request, Response } from "express";
import type { AuditEventType } from "@mai-chat/shared-types";
import type { RouteContext } from "./context.js";

export function registerIntegrationsRoutes({ app, deps, requireRole, requirePermission }: RouteContext): void {
  // Real connection check for one connection (Integrations → Test connection).
  app.post("/workspaces/:id/integrations/:integrationKey/test", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const workspaceId = paramString(req.params.id);
    const key = paramString(req.params.integrationKey);
    const integration = (await db.listIntegrations(workspaceId)).find((item) => item.id === key || (!item.id && item.type === key));
    if (!integration) return res.status(404).json({ error: "Connection not found." });
    res.json(await testIntegrationConnection(workspaceId, integration));
  });

  app.get("/workspaces/:id/integrations", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    if (!UUID_RE.test(paramString(req.params.id))) return res.status(400).json({ error: "invalid workspace id" });
    const workspace = await db.getWorkspaceById(paramString(req.params.id));
    if (!workspace) return res.status(404).json({ error: "not found" });
    res.json(await db.listIntegrations(paramString(req.params.id)));
  });

  app.get("/workspaces/:id/capabilities/connect-tools", async (req: Request, res: Response) => {
    if (!(await requirePermission(req, res, "connectTools"))) return;
    res.status(204).end();
  });

  app.delete("/workspaces/:id/integrations/:provider", async (req: Request, res: Response) => {
    if (!(await requirePermission(req, res, "connectTools"))) return;
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const workspaceId = paramString(req.params.id);
    const provider = paramString(req.params.provider);
    const integrationId = typeof req.query.integrationId === "string" ? req.query.integrationId : "";
    if (!UUID_RE.test(workspaceId)) return res.status(400).json({ error: "invalid workspace id" });
    if (!["github", "slack", "linear", "notion", "figma"].includes(provider)) return res.status(404).json({ error: "unknown integration" });
    if (!UUID_RE.test(integrationId)) return res.status(400).json({ error: "valid integrationId is required" });
    const removed = await db.deleteIntegrationForOwner(workspaceId, provider as "github" | "slack" | "linear" | "notion" | "figma", integrationId, req.user!.id);
    if (!removed) return res.status(404).json({ error: "integration not found or is not owned by you" });
    await db.recordAuditEvent({ workspaceId, eventType: "integration.disconnected" as AuditEventType, actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} disconnected ${provider}`, metadata: { integration: provider } });
    res.status(204).end();
  });

  app.post("/workspaces/:id/integrations/github", async (req: Request, res: Response) => {
    if (!(await requirePermission(req, res, "connectTools"))) return;
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
    // One account per provider per workspace member, including this manual fallback.
    const connectionName = "My GitHub";
    const connectionScope = "personal" as const;
    const config = await db.upsertGithubIntegration({ workspaceId: paramString(req.params.id), owner, repo, token, connectionName: connectionName || "Shared connection", connectionScope, ownerUserId: req.user!.id });
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
    if (!(await requirePermission(req, res, "connectTools"))) return;
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const workspaceId = paramString(req.params.id);
    const provider = paramString(req.params.provider);
    if (provider !== "linear" && provider !== "notion" && provider !== "figma") return res.status(404).json({ error: "unknown MCP provider" });
    const endpoint = typeof req.body?.endpoint === "string" ? req.body.endpoint.trim() : "";
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    if (!endpoint.startsWith("https://") || !token) return res.status(400).json({ error: "HTTPS MCP endpoint and token are required" });
    try {
      const config = await db.upsertRemoteMcpIntegration({ workspaceId, type: provider, endpoint, token, ownerUserId: req.user!.id });
      res.status(201).json(config);
    } catch (error) { res.status(400).json({ error: errMessage(error) }); }
  });

  registerGithubOAuthRoutes(app, deps.githubOAuthConfig, deps.githubOAuthDeps);
  registerSlackOAuthRoutes(app, deps.slackOAuthConfig, deps.slackOAuthDeps);

  app.post("/workspaces/:id/integrations/github/repo", async (req: Request, res: Response) => {
    if (!(await requirePermission(req, res, "connectTools"))) return;
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    if (!UUID_RE.test(paramString(req.params.id))) return res.status(400).json({ error: "invalid workspace id" });
    const workspaceId = paramString(req.params.id);
    const workspace = await db.getWorkspaceById(workspaceId);
    if (!workspace) return res.status(404).json({ error: "not found" });
    const { owner, repo } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof owner !== "string" || typeof repo !== "string" || !owner || !repo) {
      return res.status(400).json({ error: "owner and repo are both required" });
    }
    const integration = (await db.listIntegrations(workspaceId)).find(
      (candidate) => candidate.type === "github" && candidate.ownerUserId === req.user!.id
    );
    const credential = integration ? await db.getIntegrationCredential(workspaceId, "github", integration.id) : null;
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
    const config = await db.setGithubRepo({ workspaceId, owner, repo, ownerUserId: req.user!.id });
    if (!config) return res.status(404).json({ error: "GitHub isn't connected for this workspace yet." });
    res.json(config);
  });

  // No pasted-bot-token Slack route anymore -- Slack connects ONLY via
  // OAuth now (registerSlackOAuthRoutes above), since Slack's official
  // MCP server requires a real user access token from that exact flow; a
  // hand-pasted token could never authenticate to it. See slack-oauth.ts.
}
