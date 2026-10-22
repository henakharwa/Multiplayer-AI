// Team GitHub: the workspace repository list, webhook setup, the GitHub
// webhook receiver, recent team activity, and taking over a workflow whose
// owner left.
import express, { type Request, type Response } from "express";
import * as db from "@mai-chat/db";
import type { WorkspaceGithubSetup, WorkspaceRepository } from "@mai-chat/shared-types";
import { UUID_RE, paramString, errMessage } from "../http-utils.js";
import type { RouteContext } from "./context.js";
import { teamApiFor } from "../actions.js";
import { GITHUB_WEBHOOK_EVENTS, listTeamActivity, verifyGithubSignature } from "../github-team.js";

const REPO_PART = /^[A-Za-z0-9_.-]{1,100}$/;

/** Accepts "owner/repo", a github.com URL, or separate owner and repo fields. */
export function parseRepositoryInput(body: Record<string, unknown>): { owner: string; repo: string } | null {
  const raw = typeof body.fullName === "string" ? body.fullName : typeof body.url === "string" ? body.url : null;
  let owner = typeof body.owner === "string" ? body.owner.trim() : "";
  let repo = typeof body.repo === "string" ? body.repo.trim() : "";
  if (raw) {
    const match = raw.trim().replace(/\.git$/, "").match(/(?:github\.com[/:])?([^/\s]+)\/([^/\s#?]+)\/?$/);
    if (match) [owner, repo] = [match[1], match[2]];
  }
  return REPO_PART.test(owner) && REPO_PART.test(repo) ? { owner, repo } : null;
}

function publicApiUrl(): string {
  return (process.env.CHAT_SERVER_PUBLIC_URL ?? `http://localhost:${process.env.CHAT_SERVER_PORT ?? 4000}`).replace(/\/+$/, "");
}

export function workspaceWebhookUrl(workspaceId: string): string {
  return `${publicApiUrl()}/webhooks/github/workspaces/${workspaceId}`;
}

/** Handles a verified GitHub event for one workspace (set by createChatServer). */
export type GithubEventHandler = (workspaceId: string, event: string, payload: Record<string, unknown>, deliveryId: string) => Promise<void>;

/**
 * Receivers are registered before the JSON body parser: the signature is
 * computed over the exact bytes GitHub sent.
 */
export function registerGithubWebhookRoutes({ app, deps }: Pick<RouteContext, "app" | "deps">): void {
  const raw = express.raw({ type: "*/*", limit: "10mb" });
  const handlerFor = () => app.locals.handleGithubEvent as GithubEventHandler | undefined;

  async function deliver(req: Request, res: Response, targets: Array<{ workspaceId: string; repositoryId: string }>, event: string, payload: Record<string, unknown>) {
    const deliveryId = req.header("x-github-delivery") ?? `${event}:${Date.now()}`;
    const handler = handlerFor();
    let processed = 0;
    for (const target of targets) {
      // A retried delivery, or the same event from both the repository
      // webhook and the GitHub App, runs once per workspace.
      if (!(await db.recordWebhookDelivery(target.workspaceId, deliveryId, event))) continue;
      await db.touchRepositoryEvent(target.repositoryId);
      processed++;
      if (handler) await handler(target.workspaceId, event, payload, deliveryId).catch((error) => console.error("[github-webhook] handling failed", errMessage(error)));
    }
    res.status(202).json({ ok: true, processed });
  }

  function parse(req: Request, res: Response): { event: string; payload: Record<string, unknown>; body: Buffer } | null {
    const event = req.header("x-github-event");
    if (!event || !Buffer.isBuffer(req.body)) {
      res.status(400).json({ error: "Not a GitHub webhook delivery." });
      return null;
    }
    try {
      return { event, payload: JSON.parse(req.body.toString("utf8")) as Record<string, unknown>, body: req.body };
    } catch {
      res.status(400).json({ error: "The delivery body must be JSON (set the webhook content type to application/json)." });
      return null;
    }
  }

  // A repository webhook added for one workspace, signed with that workspace's secret.
  app.post("/webhooks/github/workspaces/:workspaceId", raw, async (req: Request, res: Response) => {
    const workspaceId = paramString(req.params.workspaceId);
    if (!UUID_RE.test(workspaceId)) return res.status(404).json({ error: "not found" });
    const secret = await db.getWorkspaceWebhookSecret(workspaceId);
    if (!secret) return res.status(404).json({ error: "This workspace has no GitHub webhook set up." });
    if (!Buffer.isBuffer(req.body) || !verifyGithubSignature(secret, req.body, req.header("x-hub-signature-256"))) {
      return res.status(401).json({ error: "Invalid signature. Check that the webhook secret matches the one shown in Nexus." });
    }
    const parsed = parse(req, res);
    if (!parsed) return;
    const repository = parsed.payload.repository as { full_name?: string } | undefined;
    const [owner, repo] = String(repository?.full_name ?? "").split("/");
    const match = (await db.listWorkspaceRepositories(workspaceId)).find(
      (candidate) => candidate.owner.toLowerCase() === (owner ?? "").toLowerCase() && candidate.repo.toLowerCase() === (repo ?? "").toLowerCase()
    );
    if (!match) return res.status(202).json({ ok: true, processed: 0, note: "This repository is not on the workspace's repository list." });
    await deliver(req, res, [{ workspaceId, repositoryId: match.id }], parsed.event, parsed.payload);
  });

  // The workspace GitHub App: one webhook for every installation, routed to
  // each workspace that has the repository on its list.
  app.post("/webhooks/github", raw, async (req: Request, res: Response) => {
    const api = teamApiFor(deps);
    const secret = api.app.webhookSecret();
    if (!secret) return res.status(404).json({ error: "GitHub App webhooks are not configured on this server." });
    if (!Buffer.isBuffer(req.body) || !verifyGithubSignature(secret, req.body, req.header("x-hub-signature-256"))) {
      return res.status(401).json({ error: "Invalid signature." });
    }
    const parsed = parse(req, res);
    if (!parsed) return;
    const repository = parsed.payload.repository as { full_name?: string } | undefined;
    if (!repository?.full_name) return res.status(202).json({ ok: true, processed: 0 });
    const [owner, repo] = repository.full_name.split("/");
    await deliver(req, res, await db.findWorkspacesForRepository(owner, repo), parsed.event, parsed.payload);
  });
}

export function registerGithubTeamRoutes({ app, deps, requireRole, requirePermission }: RouteContext): void {
  const api = () => teamApiFor(deps);

  async function ownGithubToken(workspaceId: string, userId: string): Promise<string | null> {
    const integration = (await db.listIntegrations(workspaceId)).find((candidate) => candidate.type === "github" && candidate.ownerUserId === userId);
    return integration ? (await db.getIntegrationCredential(workspaceId, "github", integration.id))?.token ?? null : null;
  }

  app.get("/workspaces/:id/repositories", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const workspaceId = paramString(req.params.id);
    const repositories = await db.listWorkspaceRepositories(workspaceId);
    const token = await ownGithubToken(workspaceId, req.user!.id);
    const appConfigured = api().app.configured();
    const withAccess: WorkspaceRepository[] = await Promise.all(
      repositories.map(async (repository) => ({
        ...repository,
        myAccess: token ? await api().getRepoAccess(token, repository.owner, repository.repo).catch(() => "unknown" as const) : "not_connected",
        appInstalled: appConfigured ? await api().app.isInstalled(repository.owner, repository.repo).catch(() => false) : null,
      }))
    );
    res.json(withAccess);
  });

  app.post("/workspaces/:id/repositories", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin"]))) return;
    const workspaceId = paramString(req.params.id);
    const parsed = parseRepositoryInput(req.body ?? {});
    if (!parsed) return res.status(400).json({ error: "Enter a repository as owner/name, for example acme/web." });
    const token = await ownGithubToken(workspaceId, req.user!.id);
    if (token) {
      const access = await api().getRepoAccess(token, parsed.owner, parsed.repo);
      if (access === "none") return res.status(400).json({ error: `Your GitHub account can't access ${parsed.owner}/${parsed.repo}. Check the name, or ask a repository admin for access first.` });
    }
    const repository = await db.addWorkspaceRepository({ workspaceId, owner: parsed.owner, repo: parsed.repo, addedByUserId: req.user!.id });
    if (!repository) return res.status(409).json({ error: `${parsed.owner}/${parsed.repo} is already on this workspace's list.` });
    await db.recordAuditEvent({ workspaceId, eventType: "repository.added", actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} added ${repository.fullName} to the workspace repositories`, metadata: { repo: repository.fullName } });
    res.status(201).json(repository);
  });

  app.delete("/workspaces/:id/repositories/:repositoryId", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin"]))) return;
    const workspaceId = paramString(req.params.id);
    const removed = await db.removeWorkspaceRepository(workspaceId, paramString(req.params.repositoryId));
    if (!removed) return res.status(404).json({ error: "Repository not found." });
    await db.recordAuditEvent({ workspaceId, eventType: "repository.removed", actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} removed ${removed.fullName} from the workspace repositories`, metadata: { repo: removed.fullName } });
    res.status(204).end();
  });

  app.post("/workspaces/:id/repositories/:repositoryId/default", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin"]))) return;
    const workspaceId = paramString(req.params.id);
    const repository = await db.setDefaultWorkspaceRepository(workspaceId, paramString(req.params.repositoryId));
    if (!repository) return res.status(404).json({ error: "Repository not found." });
    await db.recordAuditEvent({ workspaceId, eventType: "repository.updated", actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} made ${repository.fullName} the default repository`, metadata: { repo: repository.fullName } });
    res.json(repository);
  });

  app.get("/workspaces/:id/github/setup", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const workspaceId = paramString(req.params.id);
    const isAdmin = (await db.getWorkspaceRole(workspaceId, req.user!.id)) === "admin";
    const status = await db.getWorkspaceWebhookStatus(workspaceId);
    const setup: WorkspaceGithubSetup = {
      webhookUrl: workspaceWebhookUrl(workspaceId),
      ...(isAdmin ? { webhookSecret: await db.getOrCreateWorkspaceWebhookSecret(workspaceId) } : {}),
      events: GITHUB_WEBHOOK_EVENTS,
      lastDeliveryAt: status.lastDeliveryAt,
      lastEvent: status.lastEvent,
      app: { configured: api().app.configured(), installUrl: api().app.installUrl() },
    };
    res.json(setup);
  });

  app.post("/workspaces/:id/github/webhook-secret/rotate", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin"]))) return;
    const workspaceId = paramString(req.params.id);
    const secret = await db.rotateWorkspaceWebhookSecret(workspaceId);
    await db.recordAuditEvent({ workspaceId, eventType: "repository.updated", actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} replaced the GitHub webhook secret` });
    res.json({ webhookSecret: secret });
  });

  // Adds the repository webhook with the Admin's own GitHub account (they
  // need admin rights on the repository).
  app.post("/workspaces/:id/repositories/:repositoryId/webhook", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin"]))) return;
    const workspaceId = paramString(req.params.id);
    const repository = await db.getWorkspaceRepository(workspaceId, paramString(req.params.repositoryId));
    if (!repository) return res.status(404).json({ error: "Repository not found." });
    const token = await ownGithubToken(workspaceId, req.user!.id);
    if (!token) return res.status(400).json({ error: "Connect your GitHub account first." });
    try {
      const secret = await db.getOrCreateWorkspaceWebhookSecret(workspaceId);
      const hook = await api().createRepoWebhook(token, repository.owner, repository.repo, { url: workspaceWebhookUrl(workspaceId), secret, events: GITHUB_WEBHOOK_EVENTS });
      await db.setRepositoryWebhookId(workspaceId, repository.id, hook.id);
      await db.recordAuditEvent({ workspaceId, eventType: "repository.updated", actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} connected GitHub events for ${repository.fullName}`, metadata: { repo: repository.fullName } });
      res.json({ ...repository, webhookId: hook.id });
    } catch (error) {
      res.status(400).json({ error: errMessage(error) });
    }
  });

  app.get("/workspaces/:id/team-activity", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    res.json(await listTeamActivity(paramString(req.params.id), { hours: 24, limit: 20 }));
  });

  // An Admin (or Editor with Manage workflows) takes over a workflow, for
  // example when its owner left the workspace.
  app.post("/workspaces/:id/workflows/:workflowId/take-over", async (req: Request, res: Response) => {
    if (!(await requirePermission(req, res, "manageWorkflows"))) return;
    const workspaceId = paramString(req.params.id);
    const workflow = await db.setWorkflowOwner(workspaceId, paramString(req.params.workflowId), req.user!.id);
    if (!workflow) return res.status(404).json({ error: "Workflow not found." });
    await db.recordAuditEvent({ workspaceId, eventType: "workflow.updated", actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} took over workflow ${workflow.name}`, metadata: { workflowId: workflow.id } });
    res.json(workflow);
  });
}
