import type { Express, Request, Response } from "express";
import * as db from "@mai-chat/db";
import type { RoomRegistry } from "./rooms.js";
import type { ToolExecutor } from "./tools.js";
import { UUID_RE, paramString, errMessage } from "./http-utils.js";
import type { CreateServerDeps } from "./server.js";
import { getRemoteMcpClient } from "./remote-mcp-pool.js";
import { listMcpToolExecutors } from "./mcp-tools.js";
import { buildNotionTools } from "./notion-tools.js";

function completionAgentFor(toolName: string): string {
  if (toolName.startsWith("slack_")) return "Slack Agent";
  if (toolName.startsWith("linear_")) return "Linear Agent";
  if (toolName.startsWith("notion_")) return "Notion Agent";
  if (toolName.startsWith("figma_")) return "Figma Agent";
  // The remaining mutating tools in the current workspace surface come
  // from GitHub MCP (issue_write, create_pull_request, file writes, etc.).
  return "GitHub Agent";
}

export interface WorkspaceTools {
  tools: ToolExecutor[];
  githubTools: ToolExecutor[];
  slackTools: ToolExecutor[];
  linearTools: ToolExecutor[];
  notionTools: ToolExecutor[];
  figmaTools: ToolExecutor[];
  // Set exactly when a GitHub repo is connected and its MCP tools were
  // loaded -- agent.ts needs this to tell the model which owner/repo to
  // pass as arguments, since (unlike the old Octokit client) GitHub's MCP
  // tools aren't pre-bound to one repo; every call takes owner/repo
  // explicitly.
  githubContext?: { owner: string; repo: string };
}

// Builds the full read+write tool set for whatever's connected to a
// workspace. Shared by the agent loop (server.ts's runAgentReply, which
// wraps the mutating ones via wrapForProposal below before handing them to
// the LLM) and by the confirm route below (which needs the SAME tools,
// unwrapped, to actually run one once a human approves it).
export async function buildToolsForWorkspace(workspaceId: string, deps: CreateServerDeps): Promise<WorkspaceTools> {
  const integrations = await db.listIntegrations(workspaceId);
  const tools: ToolExecutor[] = [];
  const githubAgentTools: ToolExecutor[] = [];
  const slackAgentTools: ToolExecutor[] = [];
  const remoteAgentTools: Record<"linear" | "notion" | "figma", ToolExecutor[]> = { linear: [], notion: [], figma: [] };
  let githubContext: { owner: string; repo: string } | undefined;
  for (const integration of integrations) {
    if (integration.type === "github") {
      const credential = await db.getIntegrationCredential(workspaceId, "github");
      if (credential?.owner && credential?.repo) {
        try {
          const githubTools = await deps.githubMcpToolsFactory({ workspaceId, token: credential.token });
          tools.push(...githubTools);
          githubAgentTools.push(...githubTools);
          githubContext = { owner: credential.owner, repo: credential.repo };
        } catch (err) {
          // A misconfigured/unreachable GitHub MCP server (e.g. Docker
          // Desktop isn't installed or isn't running) shouldn't take the
          // whole chat down -- surface it in the server's own logs and just
          // proceed without GitHub tools this turn, the same as if the
          // integration weren't connected at all.
          console.error(`[actions] workspace ${workspaceId}: GitHub MCP tools unavailable:`, errMessage(err));
        }
      }
    } else if (integration.type === "slack") {
      const credential = await db.getIntegrationCredential(workspaceId, "slack");
      if (credential?.token) {
        try {
          const slackTools = await deps.slackMcpToolsFactory({ workspaceId, accessToken: credential.token });
          tools.push(...slackTools);
          slackAgentTools.push(...slackTools);
        } catch (err) {
          // Same fail-open-without-Slack-tools policy as the GitHub MCP
          // branch above: an unreachable Slack MCP server (a revoked/
          // expired token, slack.com briefly down) shouldn't take the
          // whole chat down.
          console.error(`[actions] workspace ${workspaceId}: Slack MCP tools unavailable:`, errMessage(err));
        }
      }
    } else if (integration.type === "notion") {
      const credential = await db.getIntegrationCredential(workspaceId, "notion");
      if (credential?.token) {
        const notionTools = buildNotionTools(credential.token);
        tools.push(...notionTools);
        remoteAgentTools.notion.push(...notionTools);
      }
    } else {
      const credential = await db.getIntegrationCredential(workspaceId, integration.type);
      if (credential?.token && integration.endpoint) {
        try {
          const client = await getRemoteMcpClient(workspaceId, integration.type, integration.endpoint, credential.token);
          const providerTools = await listMcpToolExecutors(client);
          tools.push(...providerTools);
          remoteAgentTools[integration.type].push(...providerTools);
        } catch (err) {
          console.error(`[actions] workspace ${workspaceId}: ${integration.type} MCP tools unavailable:`, errMessage(err));
        }
      }
    }
  }
  return { tools, githubTools: githubAgentTools, slackTools: slackAgentTools, linearTools: remoteAgentTools.linear, notionTools: remoteAgentTools.notion, figmaTools: remoteAgentTools.figma, githubContext };
}

// Swaps every mutating tool's `execute` for one that queues a
// PendingAction and broadcasts it to the room, instead of touching GitHub
// for real. The agent loop (services/chat-server/src/agent.ts) never
// knows the difference -- it just sees a tool result telling it the
// action is awaiting confirmation. The REAL call only happens from the
// /actions/:id/confirm route below, which looks the same tool back up by
// name (via a fresh, unwrapped buildToolsForWorkspace call) and invokes
// its original execute. Read-only tools pass through untouched.
export function wrapForProposal(
  tools: ToolExecutor[],
  workspaceId: string,
  conversationId: string,
  rooms: RoomRegistry,
  // Whoever's chat message triggered this agent turn -- recorded on the
  // pending action itself (see schema.sql) and on the "action.proposed"
  // audit event below, so the trail answers "who asked for what", not
  // just "what did the agent do". Optional: some call sites (tests that
  // build tools directly) don't have a requesting user to attribute.
  requestedBy?: { userId: string; name: string }
): ToolExecutor[] {
  return tools.map((tool) => {
    if (!tool.mutates) return tool;
    return {
      ...tool,
      execute: async (args: Record<string, unknown>) => {
        const description = tool.describe ? tool.describe(args) : `Run ${tool.definition.function.name}`;
        const preview = tool.preview ? tool.preview(args) : undefined;
        const action = await db.createPendingAction({
          workspaceId,
          conversationId,
          toolName: tool.definition.function.name,
          description,
          preview,
          args,
          requestedByUserId: requestedBy?.userId,
          requestedByName: requestedBy?.name,
        });
        rooms.broadcast(`${workspaceId}:${conversationId}`, { type: "pending_action", action });
        await db.notifyWorkspaceMembers({
          workspaceId,
          conversationId,
          kind: "decision_needed",
          text: `Decision needed: ${description}`,
          excludeUserIds: rooms.participants(`${workspaceId}:${conversationId}`).flatMap((participant) => participant.userId ? [participant.userId] : []),
        });
        await db.recordAuditEvent({
          workspaceId,
          eventType: "action.proposed",
          actorType: "agent",
          actorName: "Agent",
          summary: requestedBy
            ? `Agent proposed (asked by ${requestedBy.name}): ${description}`
            : `Agent proposed: ${description}`,
          metadata: { actionId: action.id, toolName: action.toolName, requestedByUserId: requestedBy?.userId ?? null, requestedByName: requestedBy?.name ?? null },
        });
        return {
          status: "awaiting_user_confirmation",
          actionId: action.id,
          description,
          note: "This has NOT happened yet. A human in the chat must confirm it from the card now shown in the UI before it runs. Do not tell the user it's done -- tell them what you're proposing and that it needs their confirmation.",
        };
      },
    };
  });
}

export function registerActionRoutes(app: Express, deps: CreateServerDeps, rooms: RoomRegistry): void {
  app.get("/workspaces/:id/actions", async (req: Request, res: Response) => {
    const workspaceId = paramString(req.params.id);
    if (!UUID_RE.test(workspaceId)) return res.status(400).json({ error: "invalid workspace id" });
    const conversationId = typeof req.query.conversationId === "string" ? req.query.conversationId : "";
    if (!UUID_RE.test(conversationId)) return res.status(400).json({ error: "valid conversationId is required" });
    const onlyPending = req.query.status !== "all";
    res.json(await db.listPendingActions(workspaceId, conversationId, onlyPending));
  });

  app.post("/workspaces/:id/actions/:actionId/confirm", (req: Request, res: Response) => {
    void resolveAction(req, res, "confirmed");
  });

  app.post("/workspaces/:id/actions/:actionId/cancel", (req: Request, res: Response) => {
    void resolveAction(req, res, "cancelled");
  });

  async function resolveAction(req: Request, res: Response, intent: "confirmed" | "cancelled"): Promise<void> {
    const workspaceId = paramString(req.params.id);
    const actionId = paramString(req.params.actionId);
    if (!UUID_RE.test(workspaceId) || !UUID_RE.test(actionId)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    const action = await db.getPendingAction(workspaceId, actionId);
    if (!action) {
      res.status(404).json({ error: "action not found" });
      return;
    }
    const role = await db.getWorkspaceRole(workspaceId, req.user!.id);
    if (role !== "admin") {
      res.status(403).json({ error: "Only workspace admins can approve or cancel write actions." });
      return;
    }
    if (action.status !== "pending") {
      res.status(409).json({ error: `action is already ${action.status}` });
      return;
    }
    const actorName = req.user!.displayName;

    if (intent === "cancelled") {
      const resolved = await db.resolvePendingAction({ workspaceId, id: actionId, status: "cancelled" });
      rooms.broadcast(`${workspaceId}:${action.conversationId}`, { type: "pending_action_update", action: resolved });
      const message = await db.insertMessage({
        workspaceId,
        conversationId: action.conversationId,
        role: "system",
        authorName: "System",
        content: `${actorName} cancelled: ${action.description}`,
      });
      rooms.broadcast(`${workspaceId}:${action.conversationId}`, { type: "message", message });
      await db.notifyWorkspaceMembers({
        workspaceId,
        conversationId: action.conversationId,
        kind: "action_completed",
        text: `${actorName} completed: ${action.description}`,
        excludeUserIds: rooms.participants(`${workspaceId}:${action.conversationId}`).flatMap((participant) => participant.userId ? [participant.userId] : []),
      });
      await db.recordAuditEvent({
        workspaceId,
        eventType: "action.cancelled",
        actorType: "user",
        actorUserId: req.user?.id ?? null,
        actorName,
        summary: `${actorName} cancelled: ${action.description}`,
        metadata: { actionId, toolName: action.toolName },
      });
      res.json(resolved);
      return;
    }

    const { tools } = await buildToolsForWorkspace(workspaceId, deps);
    const tool = tools.find((t) => t.definition.function.name === action.toolName);
    if (!tool) {
      console.error(
        `[actions] workspace ${workspaceId}: confirm failed for action ${actionId} (${action.toolName}) -- integration no longer connected`
      );
      const resolved = await db.resolvePendingAction({
        workspaceId,
        id: actionId,
        status: "failed",
        result: "The integration this action needed is no longer connected.",
      });
      rooms.broadcast(`${workspaceId}:${action.conversationId}`, { type: "pending_action_update", action: resolved });
      // Without this, the card just silently vanishes from the UI (it's no
      // longer "pending") and nobody -- neither the humans in the room nor
      // the agent's own next-turn history -- ever learns the confirm
      // actually failed. See the same reasoning on the catch block below,
      // which hit this exact silent-failure shape live.
      const failureMessage = await db.insertMessage({
        workspaceId,
        conversationId: action.conversationId,
        role: "system",
        authorName: "System",
        content: `${actorName} tried to confirm "${action.description}", but it failed: the integration this action needed is no longer connected.`,
      });
      rooms.broadcast(`${workspaceId}:${action.conversationId}`, { type: "message", message: failureMessage });
      await db.recordAuditEvent({
        workspaceId,
        eventType: "action.failed",
        actorType: "user",
        actorUserId: req.user?.id ?? null,
        actorName,
        summary: `${actorName} tried to confirm "${action.description}", but the integration it needed is no longer connected`,
        metadata: { actionId, toolName: action.toolName },
      });
      res.status(409).json({ error: "integration no longer connected" });
      return;
    }

    try {
      const result = await tool.execute(action.args);
      const resultText = typeof result === "string" ? result : JSON.stringify(result);
      const resolved = await db.resolvePendingAction({ workspaceId, id: actionId, status: "confirmed", result: resultText });
      rooms.broadcast(`${workspaceId}:${action.conversationId}`, { type: "pending_action_update", action: resolved });
      const message = await db.insertMessage({
        workspaceId,
        conversationId: action.conversationId,
        role: "system",
        authorName: "System",
        content: `${actorName} confirmed: ${action.description}`,
      });
      rooms.broadcast(`${workspaceId}:${action.conversationId}`, { type: "message", message });
      // A click acknowledgement only proves someone approved the action;
      // it does not prove the provider call finished. Publish this separate
      // agent message only after execute() succeeds, so a later question
      // cannot leave the room with the stale "pending" wording the model
      // used before the provider completed the write.
      const completionMessage = await db.insertMessage({
        workspaceId,
        conversationId: action.conversationId,
        role: "agent",
        authorName: completionAgentFor(action.toolName),
        content: `The requested action has completed: ${action.description}.`,
      });
      rooms.broadcast(`${workspaceId}:${action.conversationId}`, { type: "message", message: completionMessage });
      await db.recordAuditEvent({
        workspaceId,
        eventType: "action.confirmed",
        actorType: "user",
        actorUserId: req.user?.id ?? null,
        actorName,
        summary: `${actorName} confirmed: ${action.description}`,
        metadata: { actionId, toolName: action.toolName },
      });
      res.json(resolved);
    } catch (err) {
      // Found live: a failed confirm (e.g. Docker/the GitHub MCP container
      // not reachable, a stale token, GitHub rejecting the write) used to
      // resolve the action to "failed" and stop there -- no chat message,
      // no server log. The card disappears (correctly, it's resolved), but
      // that reads to a human as "it must have worked", and the agent has
      // no way to know its own proposal failed, so it just repeats its
      // generic "please confirm" line forever. Both gaps fixed here.
      const failureReason = errMessage(err);
      console.error(`[actions] workspace ${workspaceId}: confirm failed for action ${actionId} (${action.toolName}):`, failureReason);
      const resolved = await db.resolvePendingAction({ workspaceId, id: actionId, status: "failed", result: failureReason });
      rooms.broadcast(`${workspaceId}:${action.conversationId}`, { type: "pending_action_update", action: resolved });
      const failureMessage = await db.insertMessage({
        workspaceId,
        conversationId: action.conversationId,
        role: "system",
        authorName: "System",
        content: `${actorName} tried to confirm "${action.description}", but it failed: ${failureReason}`,
      });
      rooms.broadcast(`${workspaceId}:${action.conversationId}`, { type: "message", message: failureMessage });
      await db.recordAuditEvent({
        workspaceId,
        eventType: "action.failed",
        actorType: "user",
        actorUserId: req.user?.id ?? null,
        actorName,
        summary: `${actorName} tried to confirm "${action.description}", but it failed: ${failureReason}`,
        metadata: { actionId, toolName: action.toolName, failureReason },
      });
      res.status(502).json({ error: failureReason });
    }
  }
}
