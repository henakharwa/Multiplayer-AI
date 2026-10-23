import type { Express, NextFunction, Request, Response } from "express";
import { captureError } from "./error-tracking.js";
import * as db from "@mai-chat/db";
import type { RoomRegistry } from "./rooms.js";
import type { ToolExecutor } from "./tools.js";
import { UUID_RE, paramString, errMessage } from "./http-utils.js";
import type { CreateServerDeps } from "./server.js";
import { getRemoteMcpClient } from "./remote-mcp-pool.js";
import { listMcpToolExecutors } from "./mcp-tools.js";
import { buildNotionTools } from "./notion-tools.js";
import { buildFigmaTools } from "./figma-tools.js";
import type { IntegrationType, PendingAction, TeamActivity } from "@mai-chat/shared-types";
import { offlineGithubTeamApi, type GithubTeamApi, type RepoAccess } from "./github-api.js";
import { describeActionTarget, findActionWarnings, guardGithubTools, providerForTool, type GithubWorkspaceContext } from "./github-team.js";

type ActionAgentKind = "project" | "github" | "slack" | "linear" | "notion" | "figma";

function completionAgentFor(agentKind: ActionAgentKind | null | undefined, toolName: string): string {
  if (agentKind === "project") return "Project Agent";
  if (agentKind === "github") return "GitHub Agent";
  if (agentKind === "slack") return "Slack Agent";
  if (agentKind === "linear") return "Linear Agent";
  if (agentKind === "notion") return "Notion Agent";
  if (agentKind === "figma") return "Figma Agent";
  // Legacy pending actions predate agent_kind. Retain a best-effort label
  // for them without changing their recorded request.
  if (toolName.startsWith("slack_")) return "Slack Agent";
  if (toolName.startsWith("linear_")) return "Linear Agent";
  if (toolName.startsWith("notion_")) return "Notion Agent";
  if (toolName.startsWith("figma_")) return "Figma Agent";
  // The remaining mutating tools in the current workspace surface come
  // from GitHub MCP (issue_write, create_pull_request, file writes, etc.).
  return "GitHub Agent";
}

export interface ProviderAccount {
  // Every connection belongs to one member; actions run as that member.
  via: "user";
  userId: string | null;
  // Provider account name, e.g. a GitHub username.
  account: string | null;
}

export interface WorkspaceTools {
  tools: ToolExecutor[];
  githubTools: ToolExecutor[];
  slackTools: ToolExecutor[];
  linearTools: ToolExecutor[];
  notionTools: ToolExecutor[];
  figmaTools: ToolExecutor[];
  // Set when GitHub tools were loaded: the member's one repository, what
  // their account can do there, and who the tools act as. agent.ts tells the
  // model which owner/repo to pass, since GitHub's MCP tools take both on
  // every call.
  githubContext?: GithubWorkspaceContext;
  // Set when this member connected GitHub but hasn't chosen a repository,
  // so the agent can say what to do instead of guessing.
  githubNotice?: string;
  // The account each provider's tools act as this turn.
  accounts: Partial<Record<IntegrationType, ProviderAccount>>;
  // Open issues in a repository, read with the same account (duplicate checks).
  listOpenIssues?: (owner: string, repo: string) => Promise<Array<{ number: number; title: string; url: string }>>;
}

export interface BuildToolsOptions {
  // Called with "owner/repo" whenever a GitHub tool call reaches the repository.
  onGithubRepoUsed?: (fullName: string) => void;
}

export function teamApiFor(deps: CreateServerDeps): GithubTeamApi {
  return deps.githubTeamApi ?? offlineGithubTeamApi;
}

// Builds the full read+write tool set for whatever's connected to a
// workspace. Shared by the agent loop (server.ts's runAgentReply, which
// wraps the mutating ones via wrapForProposal below before handing them to
// the LLM) and by the confirm route below (which needs the SAME tools,
// unwrapped, to actually run one once a human approves it).
export async function buildToolsForWorkspace(workspaceId: string, deps: CreateServerDeps, requestingUserId?: string, options: BuildToolsOptions = {}): Promise<WorkspaceTools> {
  const available = await db.listIntegrations(workspaceId);
  const api = teamApiFor(deps);
  // A member can work only through a connection they own. This preserves
  // source access boundaries even though every member can see the connected
  // account directory in the workspace UI.
  const integrations = (["github", "slack", "linear", "notion", "figma"] as const).flatMap((type) => {
    const accounts = available.filter((integration) => integration.type === type);
    const owned = accounts.find((integration) => integration.ownerUserId === requestingUserId);
    return owned ? [owned] : [];
  });
  const tools: ToolExecutor[] = [];
  const githubAgentTools: ToolExecutor[] = [];
  const slackAgentTools: ToolExecutor[] = [];
  const remoteAgentTools: Record<"linear" | "notion" | "figma", ToolExecutor[]> = { linear: [], notion: [], figma: [] };
  const accounts: WorkspaceTools["accounts"] = {};
  let githubContext: GithubWorkspaceContext | undefined;
  let githubNotice: string | undefined;
  let listOpenIssues: WorkspaceTools["listOpenIssues"];
  const actingUser = requestingUserId ? await db.getUserById(requestingUserId) : null;

  // GitHub: the one repository this member chose, through their own account.
  const loadGithub = async (token: string, account: string | null, owner: string, repo: string) => {
    try {
      const githubTools = await deps.githubMcpToolsFactory({ workspaceId, token, accountKey: requestingUserId });
      const access: RepoAccess = await api.getRepoAccess(token, owner, repo).catch((): RepoAccess => "unknown");
      githubContext = { owner, repo, access, account, actingAs: actingUser?.displayName ?? "this member" };
      const guarded = guardGithubTools(githubTools, githubContext, options.onGithubRepoUsed);
      tools.push(...guarded);
      githubAgentTools.push(...guarded);
      accounts.github = { via: "user", userId: requestingUserId ?? null, account };
      listOpenIssues = (issueOwner, issueRepo) => api.listOpenIssues(token, issueOwner, issueRepo);
    } catch (err) {
      // A misconfigured/unreachable GitHub MCP server (e.g. Docker isn't
      // running) shouldn't take the whole chat down -- surface it in the
      // server's own logs and proceed without GitHub tools this turn, the
      // same as if the integration weren't connected at all.
      console.error(`[actions] workspace ${workspaceId}: GitHub MCP tools unavailable:`, errMessage(err));
    }
  };

  for (const integration of integrations) {
    if (integration.type === "github") {
      const credential = await db.getIntegrationCredential(workspaceId, "github", integration.id);
      if (credential?.token) {
        let login = integration.accountLogin ?? null;
        if (!login && integration.id) {
          login = await api.getLogin(credential.token);
          if (login) await db.setIntegrationAccountLogin(integration.id, login).catch(() => undefined);
        }
        if (credential.owner && credential.repo) await loadGithub(credential.token, login, credential.owner, credential.repo);
        else githubNotice = `${actingUser?.displayName ?? "The person asking"} connected GitHub but hasn't chosen a repository yet. They can choose one under Integrations → GitHub.`;
      }
    } else if (integration.type === "slack") {
      const credential = await db.getIntegrationCredential(workspaceId, "slack", integration.id);
      if (credential?.token) {
        try {
          const slackTools = await deps.slackMcpToolsFactory({ workspaceId, accessToken: credential.token });
          tools.push(...slackTools);
          slackAgentTools.push(...slackTools);
          accounts.slack = { via: "user", userId: requestingUserId ?? null, account: integration.teamName ?? null };
        } catch (err) {
          // Same fail-open-without-Slack-tools policy as the GitHub MCP
          // branch above: an unreachable Slack MCP server (a revoked/
          // expired token, slack.com briefly down) shouldn't take the
          // whole chat down.
          console.error(`[actions] workspace ${workspaceId}: Slack MCP tools unavailable:`, errMessage(err));
        }
      }
    } else if (integration.type === "notion") {
      const credential = await db.getIntegrationCredential(workspaceId, "notion", integration.id);
      if (credential?.token) {
        const notionTools = buildNotionTools(credential.token);
        tools.push(...notionTools);
        remoteAgentTools.notion.push(...notionTools);
        accounts.notion = { via: "user", userId: requestingUserId ?? null, account: integration.accountName ?? null };
      }
    } else if (integration.type === "figma") {
      // Figma's REST API accepts personal access tokens and OAuth tokens;
      // its hosted MCP server rejects personal tokens. See figma-tools.ts.
      const credential = await db.getIntegrationCredential(workspaceId, "figma", integration.id);
      if (credential?.token) {
        // The chosen Figma team is stored as "<id>" or "<id>:<name>"; see db's setFigmaTeam.
        const figmaTools = buildFigmaTools(credential.token, fetch, credential.repo?.split(":")[0] || undefined);
        tools.push(...figmaTools);
        remoteAgentTools.figma.push(...figmaTools);
        accounts.figma = { via: "user", userId: requestingUserId ?? null, account: integration.accountName ?? null };
      }
    } else {
      const credential = await db.getIntegrationCredential(workspaceId, integration.type, integration.id);
      if (credential?.token && integration.endpoint) {
        try {
          const client = await getRemoteMcpClient(workspaceId, integration.type, integration.endpoint, credential.token);
          const providerTools = await listMcpToolExecutors(client, integration.type[0].toUpperCase() + integration.type.slice(1));
          tools.push(...providerTools);
          remoteAgentTools[integration.type].push(...providerTools);
          accounts[integration.type] = { via: "user", userId: requestingUserId ?? null, account: integration.accountName ?? null };
        } catch (err) {
          console.error(`[actions] workspace ${workspaceId}: ${integration.type} MCP tools unavailable:`, errMessage(err));
        }
      }
    }
  }

  return { tools, githubTools: githubAgentTools, slackTools: slackAgentTools, linearTools: remoteAgentTools.linear, notionTools: remoteAgentTools.notion, figmaTools: remoteAgentTools.figma, githubContext, githubNotice, accounts, listOpenIssues };
}

export const PROVIDER_LABELS: Record<IntegrationType, string> = { github: "GitHub", slack: "Slack", linear: "Linear", notion: "Notion", figma: "Figma" };

/** How a provider account is shown, e.g. "@octocat" for GitHub. */
export function formatAccount(provider: IntegrationType, account: string | null | undefined): string | null {
  if (!account) return null;
  return provider === "github" ? `@${account.replace(/^@/, "")}` : account;
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
  // pending action itself (see sql/migrations/0001_baseline.sql) and on the "action.proposed"
  // audit event below, so the trail answers "who asked for what", not
  // just "what did the agent do". Optional: some call sites (tests that
  // build tools directly) don't have a requesting user to attribute.
  requestedBy?: { userId: string; name: string },
  agentKind?: ActionAgentKind,
  options?: {
    readOnly?: boolean;
    // The account the proposal will run as when approved (defaults to the requester).
    runAs?: ProviderAccount;
    // Open issues for the duplicate check on new GitHub issues.
    listOpenIssues?: WorkspaceTools["listOpenIssues"];
  }
): ToolExecutor[] {
  // An automation review must never be able to turn an unexpected model
  // tool call into a pending external change. Remove mutating tools from its
  // visible surface entirely; returning them unwrapped would execute a write.
  const visibleTools = options?.readOnly ? tools.filter((tool) => !tool.mutates) : tools;
  return visibleTools.map((tool) => {
    if (!tool.mutates) return tool;
    return {
      ...tool,
      execute: async (args: Record<string, unknown>) => {
        // Refuse before anything is queued, so no one is asked to approve a
        // change that can't be made (e.g. outside the member's repository).
        tool.validate?.(args);
        const toolName = tool.definition.function.name;
        const description = tool.describe ? tool.describe(args) : `Run ${toolName}`;
        const preview = tool.preview ? tool.preview(args) : undefined;
        const target = describeActionTarget(toolName, args, agentKind);
        // Duplicate and conflict checks never block a proposal; they only
        // inform the people deciding on it.
        const existing = await db.listActionsForConflictCheck(workspaceId).catch(() => []);
        let openIssues: Array<{ number: number; title: string; url: string }> = [];
        if (target.provider === "github" && target.kind === "new_issue" && target.repo && options?.listOpenIssues) {
          const [owner, repo] = target.repo.split("/");
          openIssues = await options.listOpenIssues(owner, repo).catch(() => []);
        }
        const warnings = findActionWarnings({ target, toolName, requestedByUserId: requestedBy?.userId, existing, openIssues });
        const runAs = options?.runAs;
        const action = await db.createPendingAction({
          workspaceId,
          conversationId,
          toolName,
          description,
          preview,
          args,
          requestedByUserId: requestedBy?.userId,
          requestedByName: requestedBy?.name,
          agentKind: agentKind ?? null,
          runAsUserId: runAs ? runAs.userId : requestedBy?.userId ?? null,
          runAsAccount: runAs?.account ?? null,
          target,
          warnings,
        });
        rooms.broadcast(`${workspaceId}:${conversationId}`, { type: "pending_action", action: { ...action, runAsAvailable: true } });
        await db.notifyWorkspaceMembers({
          workspaceId,
          conversationId,
          kind: "decision_needed",
          text: `Decision needed: ${description}${warnings.length ? ` (${warnings.length} possible duplicate${warnings.length === 1 ? "" : "s"})` : ""}`,
          priority: "high",
          resourceType: "action",
          resourceId: action.id,
        });
        await db.recordAuditEvent({
          workspaceId,
          eventType: "action.proposed",
          actorType: "agent",
          actorName: "Agent",
          summary: `Agent prepared an action for review${requestedBy?.name ? ` (requested by ${requestedBy.name})` : ""}: ${description}`,
          metadata: { actionId: action.id, toolName: action.toolName, requestedByUserId: requestedBy?.userId ?? null, requestedByName: requestedBy?.name ?? null, target: target.label, repo: target.repo ?? null, warnings: warnings.length },
        });
        return {
          status: "awaiting_user_confirmation",
          actionId: action.id,
          description,
          ...(warnings.length ? { possibleDuplicates: warnings.map((warning) => warning.message) } : {}),
          note: `This has NOT happened yet. A human in the chat must confirm it from the card now shown in the UI before it runs. Do not tell the user it's done -- tell them what you're proposing and that it needs their confirmation.${warnings.length ? " Mention the possible duplicates listed above in one short sentence so the team can decide." : ""}`,
        };
      },
    };
  });
}

/** Adds runAsAvailable: whether the member the action runs as still has a usable connection. */
export async function withRunAsAvailability(workspaceId: string, deps: CreateServerDeps, actions: PendingAction[]): Promise<PendingAction[]> {
  if (!actions.some((action) => action.status === "pending")) return actions;
  const integrations = await db.listIntegrations(workspaceId);
  const members = new Set((await db.listWorkspaceMembers(workspaceId)).map((member) => member.id));
  return actions.map((action) => {
    if (action.status !== "pending") return action;
    const provider = providerForTool(action.toolName, action.agentKind);
    const userId = action.runAsUserId ?? action.requestedByUserId;
    if (!userId) return { ...action, runAsAvailable: true };
    const connected = integrations.some((integration) => integration.type === provider && integration.ownerUserId === userId);
    return { ...action, runAsAvailable: connected && members.has(userId) };
  });
}

/** A link to what a confirmed action created or changed, when the provider returned one. */
function resultUrl(resultText: string): string | null {
  return resultText.match(/https:\/\/github\.com\/[^"\s\\]+/)?.[0] ?? null;
}

export function registerActionRoutes(app: Express, deps: CreateServerDeps, rooms: RoomRegistry): void {
  app.get("/workspaces/:id/actions", async (req: Request, res: Response) => {
    const workspaceId = paramString(req.params.id);
    if (!UUID_RE.test(workspaceId)) return res.status(400).json({ error: "invalid workspace id" });
    const conversationId = typeof req.query.conversationId === "string" ? req.query.conversationId : "";
    if (!UUID_RE.test(conversationId)) return res.status(400).json({ error: "valid conversationId is required" });
    if (!(await db.getWorkspaceRole(workspaceId, req.user!.id))) return res.status(403).json({ error: "You do not have permission to perform this action." });
    const onlyPending = req.query.status !== "all";
    res.json(await withRunAsAvailability(workspaceId, deps, await db.listPendingActions(workspaceId, conversationId, onlyPending)));
  });

  // Passing failures to next() (instead of `void`) sends them to the error
  // handler; an unhandled rejection here would terminate the server.
  app.post("/workspaces/:id/actions/:actionId/confirm", (req: Request, res: Response, next: NextFunction) => {
    resolveAction(req, res, "confirmed").catch(next);
  });

  app.post("/workspaces/:id/actions/:actionId/cancel", (req: Request, res: Response, next: NextFunction) => {
    resolveAction(req, res, "cancelled").catch(next);
  });

  async function resolveAction(req: Request, res: Response, intent: "confirmed" | "cancelled"): Promise<void> {
    const workspaceId = paramString(req.params.id);
    const actionId = paramString(req.params.actionId);
    if (!UUID_RE.test(workspaceId) || !UUID_RE.test(actionId)) {
      res.status(400).json({ error: "invalid id" });
      return;
    }
    // Two approvals arriving together (two Admins, a double-click, a retry)
    // used to both pass the "still pending" check below and run the write
    // twice -- two issues, two Slack posts. Only one request at a time may
    // resolve a given action, across every server process; the status is
    // re-read once the lock is held, so the second request sees the result.
    const outcome = await db.tryWithAdvisoryLock(`pending-action:${actionId}`, () => resolveActionLocked(req, res, intent, workspaceId, actionId));
    if (!outcome.acquired) {
      res.status(409).json({ error: "Someone is already confirming or cancelling this action." });
    }
  }

  async function resolveActionLocked(req: Request, res: Response, intent: "confirmed" | "cancelled", workspaceId: string, actionId: string): Promise<void> {
    const action = await db.getPendingAction(workspaceId, actionId);
    if (!action) {
      res.status(404).json({ error: "action not found" });
      return;
    }
    const role = await db.getWorkspaceRole(workspaceId, req.user!.id);
    if (!role || !(await db.hasWorkspacePermission(workspaceId, role, "approveActions"))) {
      res.status(403).json({ error: "Your workspace role does not have permission to approve or cancel write actions." });
      return;
    }
    if (action.status !== "pending") {
      res.status(409).json({ error: `action is already ${action.status}` });
      return;
    }
    const actorName = req.user!.displayName;
    const roomId = `${workspaceId}:${action.conversationId}`;
    const watchers = () => [req.user!.id, ...rooms.participants(roomId).flatMap((participant) => (participant.userId ? [participant.userId] : []))];

    if (intent === "cancelled") {
      const resolved = await db.resolvePendingAction({ workspaceId, id: actionId, status: "cancelled" });
      rooms.broadcast(roomId, { type: "pending_action_update", action: resolved });
      const message = await db.insertMessage({
        workspaceId,
        conversationId: action.conversationId,
        role: "system",
        authorName: "System",
        content: `${actorName} cancelled: ${action.description}`,
      });
      rooms.broadcast(roomId, { type: "message", message });
      await db.notifyWorkspaceMembers({
        workspaceId,
        conversationId: action.conversationId,
        kind: "action_completed",
        text: `${actorName} cancelled: ${action.description}`,
        excludeUserIds: watchers(),
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

    // Run-as rule: an approved action runs with the requester's own
    // connection. When that is no longer usable, the approver may choose to
    // run it as themselves.
    const provider = providerForTool(action.toolName, action.agentKind);
    const runAsMe = req.body?.runAs === "me";
    const runUserId = runAsMe ? req.user!.id : action.runAsUserId ?? action.requestedByUserId ?? req.user!.id;
    const built = await buildToolsForWorkspace(workspaceId, deps, runUserId);
    // A GitHub action can only run through an account that works in the
    // repository it targets and can write there. Each member works in one
    // repository, so a connection pointed at another repository, or one that
    // can only read this one, counts as unavailable.
    const repoBlocked = (tools: WorkspaceTools) => {
      if (provider !== "github" || !action.target?.repo) return false;
      const context = tools.githubContext;
      if (!context) return true;
      return `${context.owner}/${context.repo}`.toLowerCase() !== action.target.repo.toLowerCase() || context.access === "none" || context.access === "read";
    };
    const tool = repoBlocked(built) ? undefined : built.tools.find((t) => t.definition.function.name === action.toolName);
    if (!tool) {
      // Offer "Run as me" instead of failing when the approver's own
      // connection can do it. The action stays pending until they choose.
      if (!runAsMe && runUserId !== req.user!.id) {
        const mine = await buildToolsForWorkspace(workspaceId, deps, req.user!.id);
        if (!repoBlocked(mine) && mine.tools.some((t) => t.definition.function.name === action.toolName)) {
          const who = `${action.runAsName ?? action.requestedByName ?? "The requester"}'s ${PROVIDER_LABELS[provider]} connection`;
          res.status(409).json({
            error: `${who} can no longer run this action. You can run it as yourself${formatAccount(provider, mine.accounts[provider]?.account) ? ` (${formatAccount(provider, mine.accounts[provider]?.account)})` : ""} instead.`,
            code: "run_as_unavailable",
            canRunAsMe: true,
          });
          return;
        }
      }
      console.error(
        `[actions] workspace ${workspaceId}: confirm failed for action ${actionId} (${action.toolName}) -- integration no longer connected`
      );
      const resolved = await db.resolvePendingAction({
        workspaceId,
        id: actionId,
        status: "failed",
        result: "The integration this action needed is no longer connected.",
      });
      rooms.broadcast(roomId, { type: "pending_action_update", action: resolved });
      // Without this, the card just silently vanishes from the UI (it's no
      // longer "pending") and nobody -- neither the humans in the room nor
      // the agent's own next-turn history -- ever learns the confirm
      // actually failed.
      const failureMessage = await db.insertMessage({
        workspaceId,
        conversationId: action.conversationId,
        role: "system",
        authorName: "System",
        content: `${actorName} tried to confirm "${action.description}", but it failed: the integration this action needed is no longer connected.`,
      });
      rooms.broadcast(roomId, { type: "message", message: failureMessage });
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

    const executed = built.accounts[provider];
    const executedAccount = formatAccount(provider, executed?.account);
    const executedAsName = runAsMe ? actorName : action.runAsName ?? action.requestedByName ?? actorName;
    try {
      const result = await tool.execute(action.args);
      const resultText = typeof result === "string" ? result : JSON.stringify(result);
      await db.setActionExecutedAs(workspaceId, actionId, runUserId ?? null, executed?.account ?? null);
      const resolved = await db.resolvePendingAction({ workspaceId, id: actionId, status: "confirmed", result: resultText });
      rooms.broadcast(roomId, { type: "pending_action_update", action: resolved });
      const ranAs = runAsMe
        ? ` It ran as ${actorName}${executedAccount ? ` (${executedAccount})` : ""} because ${action.runAsName ?? action.requestedByName ?? "the requester"}'s connection was unavailable.`
        : executedAccount ? ` Ran as ${executedAsName} (${executedAccount}).` : "";
      const message = await db.insertMessage({
        workspaceId,
        conversationId: action.conversationId,
        role: "system",
        authorName: "System",
        content: `${actorName} confirmed: ${action.description}.${ranAs}`,
      });
      rooms.broadcast(roomId, { type: "message", message });
      // A click acknowledgement only proves someone approved the action;
      // it does not prove the provider call finished. Publish this separate
      // agent message only after execute() succeeds, so a later question
      // cannot leave the room with the stale "pending" wording the model
      // used before the provider completed the write.
      const completionMessage = await db.insertMessage({
        workspaceId,
        conversationId: action.conversationId,
        role: "agent",
        authorName: completionAgentFor(action.agentKind, action.toolName),
        content: `The requested action has completed: ${action.description}.`,
        provenance: { provider, via: "user", actedAsUserId: runUserId ?? null, actedAsName: executedAsName, account: executed?.account ?? null, ...(action.target?.repo ? { repos: [action.target.repo] } : {}) },
      });
      rooms.broadcast(roomId, { type: "message", message: completionMessage });
      // Members who are not watching this conversation learn the write
      // actually happened (the cancel branch above sends the matching
      // "cancelled" notification).
      await db.notifyWorkspaceMembers({
        workspaceId,
        conversationId: action.conversationId,
        kind: "action_completed",
        text: `${actorName} confirmed and completed: ${action.description}`,
        excludeUserIds: watchers(),
      });
      // One line for team awareness: whose agent changed what, and where.
      const requester = action.requestedByName ?? executedAsName;
      const activity = action.target
        ? `${requester}'s agent made a ${action.target.kind === "comment" ? `comment on ${action.target.label}` : action.target.kind.startsWith("new_") ? action.target.label : `change to ${action.target.label}`}${requester === actorName ? "" : ` (approved by ${actorName})`}`
        : `${actorName} confirmed: ${action.description}`;
      const url = resultUrl(resultText);
      const event = await db.recordAuditEvent({
        workspaceId,
        eventType: "action.confirmed",
        actorType: "user",
        actorUserId: req.user?.id ?? null,
        actorName,
        summary: `${actorName} confirmed: ${action.description}`,
        metadata: { actionId, toolName: action.toolName, provider, target: action.target?.label ?? null, repo: action.target?.repo ?? null, executedAs: executedAccount ?? executedAsName, activity, url },
      });
      const teamActivity: TeamActivity = { id: event.id, source: "nexus", actorName, summary: activity, repo: action.target?.repo ?? null, url, createdAt: event.createdAt };
      rooms.broadcast(workspaceId, { type: "team_activity", activity: teamActivity });
      res.json(resolved);
    } catch (err) {
      // A failed confirm (e.g. the GitHub MCP container not reachable, a
      // stale token, GitHub rejecting the write) resolves the action to
      // "failed", posts why in the room, and records it.
      const failureReason = errMessage(err);
      console.error(`[actions] workspace ${workspaceId}: confirm failed for action ${actionId} (${action.toolName}):`, failureReason);
      captureError(err, { where: "action-confirm", workspaceId, actionId, toolName: action.toolName });
      const resolved = await db.resolvePendingAction({ workspaceId, id: actionId, status: "failed", result: failureReason });
      rooms.broadcast(roomId, { type: "pending_action_update", action: resolved });
      const failureMessage = await db.insertMessage({
        workspaceId,
        conversationId: action.conversationId,
        role: "system",
        authorName: "System",
        content: `${actorName} tried to confirm "${action.description}", but it failed: ${failureReason}`,
      });
      rooms.broadcast(roomId, { type: "message", message: failureMessage });
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
