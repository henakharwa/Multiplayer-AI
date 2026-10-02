import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import * as db from "@mai-chat/db";
import { createGithubClient, createSlackClient, type GithubClient, type SlackClient } from "@mai-chat/integrations";
import type { AuditEventType, Participant } from "@mai-chat/shared-types";
import { RoomRegistry } from "./rooms.js";
import { toLlmHistory } from "./history.js";
import { runAgentTurn as defaultRunAgentTurn, replyForResolvedActions, type AgentKind, type RunAgentTurnInput, type RunAgentTurnResult } from "./agent.js";
import { resolveLlmConfig } from "./llm-client.js";
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
  // Release Notes' "Share to Slack" action only -- see the note on
  // packages/integrations/src/slack.ts's SlackClient.
  slackClientFactory: (opts: { token: string }) => SlackClient;
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
    // Render retains a blank variable as an empty string. `??` treats that
    // as configured, which made GITHUB_TOOLS= select GitHub MCP's large
    // default surface instead of this curated list and overflow Groq.
    toolsets: process.env.GITHUB_TOOLSETS || undefined,
    // GitHub MCP adds explicit tools to selected toolsets. Keep the curated
    // base set when Actions (or another toolset) is enabled, unless an operator
    // deliberately provides a complete GITHUB_TOOLS override.
    tools: process.env.GITHUB_TOOLS || DEFAULT_GITHUB_TOOLS,
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
  slackClientFactory: createSlackClient,
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

export function workflowRequestsExternalChange(instructions: string): boolean {
  const text = instructions.toLowerCase();
  // An explicit prohibition wins, even if the sentence names a write tool
  // (for example, "do not send a Slack message").
  if (/\b(?:do not|don't|never)\s+(?:make|create|open|update|edit|delete|merge|close|comment|post|send|publish)\b/.test(text)) return false;
  // Workflows normally review and report. Expose proposal tools only when
  // the saved workflow explicitly requests an external mutation.
  return /\b(?:create|open|update|edit|delete|merge|close|comment|post|send|publish)\b[\s\S]{0,80}\b(?:issue|pull request|pr\b|file|readme|branch|comment|message|slack|release)\b/.test(text);
}

export function parseWorkspaceMemoryInput(body: Record<string, unknown>) {
  const kind = body.kind === "decision" ? "decision" : "knowledge";
  const rawFreshUntil = typeof body.freshUntil === "string" ? body.freshUntil.trim() : "";
  if (rawFreshUntil && Number.isNaN(Date.parse(rawFreshUntil))) throw new Error("Review date must be valid.");
  const sourceUrl = typeof body.sourceUrl === "string" ? body.sourceUrl.trim() : "";
  if (sourceUrl) {
    let parsed: URL;
    try { parsed = new URL(sourceUrl); } catch { throw new Error("Source URL must be a valid http:// or https:// URL."); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Source URL must start with http:// or https://.");
  }
  return {
    kind,
    title: typeof body.title === "string" ? body.title : "",
    content: typeof body.content === "string" ? body.content : "",
    sourceTitle: typeof body.sourceTitle === "string" ? body.sourceTitle : null,
    sourceUrl: sourceUrl || null,
    freshUntil: rawFreshUntil || null,
  } as const;
}

/**
 * Prevent a provider outage from turning a memory-backed workflow into a
 * refusal. A workflow may still need live GitHub data for a complete report,
 * but saved workspace policy is enough to produce a clearly-labelled draft.
 */
export function preferWorkspaceMemoryForRepositoryUnavailableWorkflow(reply: string, workspaceMemory: string, isWorkflow: boolean): string {
  if (!isWorkflow || !workspaceMemory.trim()) return reply;
  const refusesForMissingRepository = /\b(?:can't|cannot|unable|won't)\b[\s\S]{0,650}\b(?:github\s+repository|repository|repo)\b/i.test(reply)
    && /\brelease\s+(?:update|policy)\b/i.test(reply);
  if (!refusesForMissingRepository) return reply;

  return `Live GitHub data is unavailable, so this is a policy-based release update rather than a live repository report.\n\n${workspaceMemory}\n\nUse the saved policy above for the release decision. Connect a repository later to add current pull-request, issue, and CI details.`;
}

const artifactTypes = ["plan", "report", "release_notes", "dashboard", "task_list"] as const;
const artifactStatuses = ["draft", "published", "archived"] as const;
function dashboardData(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const items = <T>(key: string, map: (item: Record<string, unknown>, index: number) => T) => Array.isArray(raw[key]) ? raw[key].slice(0, 20).filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)).map(map) : [];
  const text = (value: unknown, max = 160) => typeof value === "string" ? value.trim().slice(0, max) : "";
  return { health: ["on_track", "at_risk", "off_track"].includes(raw.health as string) ? raw.health as "on_track" | "at_risk" | "off_track" : "on_track",
    metrics: items("metrics", (item, index) => ({ id: text(item.id, 80) || `metric-${index}`, label: text(item.label), value: text(item.value), trend: ["up", "down", "flat"].includes(item.trend as string) ? item.trend as "up" | "down" | "flat" : "flat", target: text(item.target) })),
    milestones: items("milestones", (item, index) => ({ id: text(item.id, 80) || `milestone-${index}`, label: text(item.label), progress: Math.max(0, Math.min(100, Number(item.progress) || 0)) })),
    risks: items("risks", (item, index) => ({ id: text(item.id, 80) || `risk-${index}`, title: text(item.title), severity: ["low", "medium", "high"].includes(item.severity as string) ? item.severity as "low" | "medium" | "high" : "medium", owner: text(item.owner) })),
    decisions: items("decisions", (item, index) => ({ id: text(item.id, 80) || `decision-${index}`, title: text(item.title), owner: text(item.owner), dueDate: text(item.dueDate, 30) })),
    checklist: items("checklist", (item, index) => ({ id: text(item.id, 80) || `check-${index}`, label: text(item.label), done: Boolean(item.done) })),
  };
}
export function parseWorkspaceArtifactInput(body: Record<string, unknown>) {
  return {
    type: artifactTypes.includes(body.type as typeof artifactTypes[number]) ? body.type as typeof artifactTypes[number] : "plan",
    status: artifactStatuses.includes(body.status as typeof artifactStatuses[number]) ? body.status as typeof artifactStatuses[number] : "draft",
    title: typeof body.title === "string" ? body.title.trim() : "",
    summary: typeof body.summary === "string" ? body.summary.trim() : "",
    content: typeof body.content === "string" ? body.content.trim() : "",
    dashboardData: dashboardData(body.dashboardData),
    ownerUserId: typeof body.ownerUserId === "string" && UUID_RE.test(body.ownerUserId) ? body.ownerUserId : null,
    releaseVersion: typeof body.releaseVersion === "string" && body.releaseVersion.trim() ? body.releaseVersion.trim().slice(0, 40) : null,
  };
}

async function workspaceDashboardSnapshot(workspaceId: string, deps: CreateServerDeps) {
  const [integrations, workflows, members, conversations, recentAudit] = await Promise.all([
    db.listIntegrations(workspaceId), db.listWorkspaceWorkflows(workspaceId), db.listWorkspaceMembers(workspaceId), db.listConversations(workspaceId),
    db.listAuditEvents(workspaceId, { eventType: "action.failed", limit: 10 }),
  ]);
  const pendingActions = (await Promise.all(conversations.map((conversation) => db.listPendingActions(workspaceId, conversation.id, true)))).flat();
  const activeWorkflows = workflows.filter((workflow) => workflow.enabled);
  const failedWorkflows = workflows.filter((workflow) => workflow.lastRunStatus === "failed");
  const failedActions = recentAudit;

  // Real, live GitHub numbers when a repo is connected -- not just a
  // count of *that* connection, but what it's actually reporting right
  // now. Verification-only client (see integrations/github.ts), so a
  // dead/revoked token degrades this one metric rather than the whole
  // dashboard: caught and treated as "no data" instead of failing the
  // refresh.
  const githubIntegration = integrations.find((integration): integration is Extract<typeof integrations[number], { type: "github" }> => integration.type === "github" && Boolean(integration.owner) && Boolean(integration.repo));
  let openGithubIssues: number | null = null;
  if (githubIntegration?.id && githubIntegration.owner && githubIntegration.repo) {
    try {
      const credential = await db.getIntegrationCredential(workspaceId, "github", githubIntegration.id);
      if (credential) {
        const issues = await deps.githubClientFactory({ token: credential.token, owner: githubIntegration.owner, repo: githubIntegration.repo }).listIssues("open", 50);
        openGithubIssues = issues.length;
      }
    } catch {
      // Token revoked, repo renamed, rate-limited, etc. -- leave the
      // metric out rather than failing the whole dashboard refresh.
      openGithubIssues = null;
    }
  }

  // off_track is for when something is actually broken right now (a
  // repeatedly failing action, not just a stale workflow) -- at_risk
  // covers the softer "nothing connected yet" / "one workflow failing"
  // cases the health badge already handled.
  const health: "on_track" | "at_risk" | "off_track" =
    failedActions.length >= 3 ? "off_track" : failedWorkflows.length || failedActions.length ? "at_risk" : integrations.length ? "on_track" : "at_risk";

  const risks = [
    ...failedActions.slice(0, 3).map((event) => ({ id: `audit-${event.id}`, title: event.summary, severity: "high" as const, owner: event.actorName })),
    ...failedWorkflows.slice(0, 3).map((workflow) => ({ id: `workflow-${workflow.id}`, title: `Workflow failed: ${workflow.name}${workflow.lastRunError ? ` — ${workflow.lastRunError.slice(0, 90)}` : ""}`, severity: "high" as const, owner: "Workflow owner" })),
    ...(integrations.length ? [] : [{ id: "connections", title: "No connected tool is available for live workspace data", severity: "medium" as const, owner: "Workspace Admin" }]),
  ];
  const metrics = [
    { id: "tools", label: "Connected tools", value: String(integrations.length), trend: "flat" as const, target: "At least 1" },
    { id: "workflows", label: "Active workflows", value: String(activeWorkflows.length), trend: "flat" as const, target: "Configured" },
    { id: "approvals", label: "Pending approvals", value: String(pendingActions.length), trend: pendingActions.length ? "up" as const : "flat" as const, target: "0" },
    { id: "members", label: "Team members", value: String(members.length), trend: "flat" as const, target: "Collaborating" },
    ...(openGithubIssues === null ? [] : [{ id: "github-issues", label: "Open GitHub issues/PRs", value: String(openGithubIssues), trend: "flat" as const, target: "Triaged" }]),
  ];
  return { health, metrics, milestones: [
    { id: "workflow-health", label: "Workflow reliability", progress: activeWorkflows.length ? Math.round(((activeWorkflows.length - failedWorkflows.length) / activeWorkflows.length) * 100) : 0 },
    { id: "workspace-ready", label: "Workspace readiness", progress: Math.min(100, (integrations.length ? 50 : 0) + (activeWorkflows.length ? 30 : 0) + (members.length > 1 ? 20 : 0)) },
  ], risks, decisions: pendingActions.slice(0, 3).map((action) => ({ id: `approval-${action.id}`, title: action.description, owner: action.requestedByName ?? "Workspace Admin", dueDate: "" })), checklist: [
    { id: "integration", label: "Connect at least one workspace tool", done: integrations.length > 0 },
    { id: "workflow", label: "Enable an automation workflow", done: activeWorkflows.length > 0 },
    { id: "approvals", label: "Resolve pending approval requests", done: pendingActions.length === 0 },
  ] };
}

// Drafts a Release Notes artifact's content from real GitHub activity --
// merged PRs since the last published release note (or the last 30 days,
// if there isn't one) become Highlights, closed issues in that window
// become Fixes, and open bug-labeled issues become Known issues. Every
// line links back to the actual PR/issue and credits its author, so the
// draft isn't just prose -- see the "Generate from GitHub" button in
// apps/web's artifacts page. A person still edits this before publishing;
// it's a draft, not a silent auto-publish.
async function workspaceReleaseNotesDraft(workspaceId: string, artifactId: string, deps: CreateServerDeps): Promise<string> {
  const [integrations, existingArtifacts] = await Promise.all([db.listIntegrations(workspaceId), db.listWorkspaceArtifacts(workspaceId)]);
  const githubIntegration = integrations.find(
    (integration): integration is Extract<typeof integrations[number], { type: "github" }> =>
      integration.type === "github" && Boolean(integration.owner) && Boolean(integration.repo)
  );
  const previousRelease = existingArtifacts
    .filter((artifact) => artifact.type === "release_notes" && artifact.status === "published" && artifact.id !== artifactId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const since = previousRelease ? new Date(previousRelease.createdAt) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const sinceLabel = since.toISOString().slice(0, 10);

  if (!githubIntegration?.id || !githubIntegration.owner || !githubIntegration.repo) {
    return `## Highlights

_No GitHub repo is connected to this workspace yet -- connect one in Integrations to auto-generate this from merged PRs and closed issues._

## Fixes

## Known issues
`;
  }
  const credential = await db.getIntegrationCredential(workspaceId, "github", githubIntegration.id);
  if (!credential) {
    return `## Highlights

_GitHub's connection needs to be re-authorized before this can be generated._

## Fixes

## Known issues
`;
  }
  const client = deps.githubClientFactory({ token: credential.token, owner: githubIntegration.owner, repo: githubIntegration.repo });
  try {
    const [pulls, closedIssues, openIssues] = await Promise.all([
      client.listPullRequests("closed", 50),
      client.listIssues("closed", 50),
      client.listIssues("open", 50),
    ]);
    const mergedPrs = pulls.filter((pr) => pr.merged && new Date(pr.updatedAt) >= since);
    const fixedIssues = closedIssues.filter((issue) => new Date(issue.updatedAt) >= since);
    const knownIssues = openIssues.filter((issue) => issue.labels.some((label) => /bug/i.test(label))).slice(0, 10);

    const highlightLines = mergedPrs.length
      ? mergedPrs.map((pr) => `- ${pr.title} ([#${pr.number}](${pr.url})) by @${pr.author}`).join("\n")
      : "_No PRs merged since the last release._";
    const fixLines = fixedIssues.length
      ? fixedIssues.map((issue) => `- ${issue.title} ([#${issue.number}](${issue.url})) by @${issue.author}`).join("\n")
      : "_No issues closed since the last release._";
    const knownLines = knownIssues.length
      ? knownIssues.map((issue) => `- ${issue.title} ([#${issue.number}](${issue.url}))`).join("\n")
      : "_No open bugs flagged right now._";

    return `## Highlights
${highlightLines}

## Fixes
${fixLines}

## Known issues
${knownLines}

_Generated from ${githubIntegration.owner}/${githubIntegration.repo} activity since ${sinceLabel}._`;
  } catch (err) {
    return `## Highlights

_Could not reach GitHub to generate this: ${errMessage(err)}_

## Fixes

## Known issues
`;
  }
}

// Drafts a Report artifact's content from the workspace's own recent
// activity (the audit trail, integrations, and membership) -- since the
// last published report for this workspace, or the last 7 days if there
// isn't one. Same "draft, don't silently publish" contract as the release
// notes generator above: a person still reviews and edits this.
async function workspaceReportDraft(workspaceId: string, artifactId: string): Promise<string> {
  const existingArtifacts = await db.listWorkspaceArtifacts(workspaceId);
  const previousReport = existingArtifacts
    .filter((artifact) => artifact.type === "report" && artifact.status === "published" && artifact.id !== artifactId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const since = previousReport ? new Date(previousReport.createdAt) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const sinceLabel = since.toISOString().slice(0, 10);

  const [recentEvents, members, integrations] = await Promise.all([
    db.listAuditEvents(workspaceId, { limit: 200 }),
    db.listWorkspaceMembers(workspaceId),
    db.listIntegrations(workspaceId),
  ]);
  const windowEvents = recentEvents.filter((event) => new Date(event.createdAt) >= since);
  const confirmed = windowEvents.filter((event) => event.eventType === "action.confirmed");
  const failed = windowEvents.filter((event) => event.eventType === "action.failed");
  const joined = windowEvents.filter((event) => event.eventType === "member.joined");
  const connected = windowEvents.filter((event) => event.eventType === "integration.connected");
  const stillPending = recentEvents.filter((event) => event.eventType === "action.proposed").length
    - recentEvents.filter((event) => event.eventType === "action.confirmed" || event.eventType === "action.cancelled" || event.eventType === "action.failed").length;

  const progressItems = [
    `${confirmed.length} agent action${confirmed.length === 1 ? "" : "s"} confirmed and completed`,
    ...(joined.length ? [`${joined.length} new team member${joined.length === 1 ? "" : "s"} joined (${members.length} total now)`] : []),
    ...(connected.length ? [`${connected.length} new tool connection${connected.length === 1 ? "" : "s"}: ${connected.map((event) => event.summary).slice(0, 5).join("; ")}`] : []),
    ...(confirmed.length === 0 && joined.length === 0 && connected.length === 0 ? ["No recorded activity in this window."] : []),
  ];
  const riskItems = failed.length ? failed.slice(0, 5).map((event) => event.summary) : ["_No failed actions in this window._"];
  const nextStepItems = [
    ...(stillPending > 0 ? [`${stillPending} pending approval${stillPending === 1 ? "" : "s"} still awaiting a decision`] : []),
    ...(integrations.length === 0 ? ["Connect a tool (GitHub or Slack) so future reports have real activity to summarize"] : []),
    ...(stillPending <= 0 && integrations.length > 0 ? ["No blocking follow-ups identified -- add anything the team should know here."] : []),
  ];
  const bullets = (items: string[]) => items.map((item) => `- ${item}`).join(String.fromCharCode(10));

  return [
    "## Progress",
    bullets(progressItems),
    "",
    "## Risks",
    bullets(riskItems),
    "",
    "## Next step",
    bullets(nextStepItems),
    "",
    `_Generated from this workspace's activity since ${sinceLabel}._`,
  ].join(String.fromCharCode(10));
}


async function workspaceAssistedArtifactDraft(workspaceId: string, artifact: Awaited<ReturnType<typeof db.getWorkspaceArtifact>>, prompt: string) {
  if (!artifact) return "";
  if (artifact.type === "report") return workspaceReportDraft(workspaceId, artifact.id);
  if (artifact.type === "release_notes") return "";
  const [memories, events, workflows, integrations, members] = await Promise.all([
    db.listWorkspaceMemory(workspaceId), db.listAuditEvents(workspaceId, { limit: 30 }), db.listWorkspaceWorkflows(workspaceId), db.listIntegrations(workspaceId), db.listWorkspaceMembers(workspaceId),
  ]);
  const memoryLines = memories.slice(0, 5).map((memory) => `- ${memory.title}: ${memory.content.replace(/\s+/g, " ").slice(0, 180)}`);
  const eventLines = events.slice(0, 6).map((event) => `- ${event.summary}`);
  const workflowLines = workflows.filter((workflow) => workflow.enabled).slice(0, 5).map((workflow) => `- ${workflow.name}${workflow.lastRunStatus ? ` (${workflow.lastRunStatus})` : ""}`);
  const contextNote = prompt.trim() ? `\n_Requested focus: ${prompt.trim().slice(0, 500)}_\n` : "";
  const failureLines = events.filter((event) => event.eventType === "action.failed").slice(0, 3).map((event) => `- ${event.summary}`);
  if (artifact.type === "plan") return [
    "## Goal", prompt.trim() || artifact.summary || "Define the outcome this workspace should achieve.", "",
    "## Scope", "- Use the workspace context below to confirm what is in and out of scope.", "",
    "## Workstreams", ...(workflowLines.length ? workflowLines : ["- Establish the primary workstream and owner."]), "",
    "## Milestones", "- [ ] Confirm scope and owners — Owner: Workspace Admin — Due: ", "- [ ] Review progress and risks — Owner:  — Due: ", "",
    "## Risks", ...(failureLines.length ? failureLines : ["- No recorded failures. Review connected tools and open approvals."]), "",
    "## Success metrics", `- Connected tools: ${integrations.length}`, `- Active workflows: ${workflows.filter((workflow) => workflow.enabled).length}`, `- Team members: ${members.length}`, "",
    "## Workspace memory", ...(memoryLines.length ? memoryLines : ["- No saved workspace memory yet."]), contextNote,
  ].join("\n");
  if (artifact.type === "task_list") return [
    "## Priority tasks", "- [ ] Confirm the intended outcome — Owner:  — Due: ", "- [ ] Review workspace memory and decisions — Owner:  — Due: ", ...(integrations.length ? [] : ["- [ ] Connect a workspace tool for live context — Owner: Workspace Admin — Due: "]), ...(workflows.filter((workflow) => workflow.enabled).length ? [] : ["- [ ] Enable the recurring workflow needed for this work — Owner:  — Due: "]), "",
    "## Follow-up from recent activity", ...(eventLines.length ? eventLines.map((event) => event.replace(/^- /, "- [ ] ")) : ["- [ ] No recent activity to triage."]), "",
    "## Dependencies", "- [ ] Confirm dependencies and handoffs — Owner:  — Due: ", "",
    "## Context", ...(memoryLines.length ? memoryLines : ["- No saved workspace memory yet."]), contextNote,
  ].join("\n");
  return artifact.content;
}


async function aiArtifactDraft(workspaceId: string, artifact: NonNullable<Awaited<ReturnType<typeof db.getWorkspaceArtifact>>>, prompt: string, deps: CreateServerDeps): Promise<string> {
  const sourceDraft = artifact.type === "release_notes"
    ? await workspaceReleaseNotesDraft(workspaceId, artifact.id, deps)
    : await workspaceAssistedArtifactDraft(workspaceId, artifact, prompt);
  const workspaceMemory = await db.workspaceMemoryContext(workspaceId);
  const request = [
    `Create a polished ${artifact.type.replace("_", " ")} for the shared workspace.`,
    "Return only the artifact in Markdown. Do not mention being an AI, this prompt, unavailable tools, or any drafting process.",
    "Use only facts in the existing notes and context, grounded source draft, and saved workspace memory. Preserve relevant details from existing notes; improve their organization but do not invent facts, owners, dates, metrics, or completed work.",
    prompt.trim() ? `The user wants this focus: ${prompt.trim().slice(0, 500)}` : "Use the artifact title and summary as the intended focus.",
    `Artifact title: ${artifact.title}`,
    artifact.summary ? `Artifact summary: ${artifact.summary}` : "",
    artifact.content.trim() ? "Existing notes and context — retain relevant details from this material:\n" + artifact.content.trim().slice(0, 12_000) : "",
    "Grounded source draft:", sourceDraft,
  ].filter(Boolean).join("\n\n");
  const result = await deps.runAgentTurn({
    history: [{ role: "user", content: request }],
    tools: [],
    agentKind: "project",
    customInstructions: "You are writing a shared workspace artifact. Produce complete, useful Markdown with clear headings, concise bullets, and checklist items where appropriate. Do not propose or perform external actions.",
    workspaceMemory,
    maxTurns: 1,
    llmConfig: resolveLlmConfig({ maxTokens: 1400 }),
  });
  const content = result.reply.trim();
  if (!content) throw new Error("The AI model returned an empty draft.");
  return content;
}

export function createApp(deps: CreateServerDeps = defaultDeps) {
  const app = express();
  // Browser Origin never includes a trailing slash. Normalizing the
  // configured URL avoids rejecting legitimate deployed requests when a
  // host dashboard stores the URL as `https://example.com/`.
  const webAppUrl = (process.env.WEB_APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  app.use(cors({ origin: webAppUrl, credentials: true }));
  app.use(express.json());
  app.use((req, res, next) => {
    const requestId = randomUUID();
    res.setHeader("x-request-id", requestId);
    res.on("finish", () => {
      // Keep normal successful traffic quiet. Render captures these JSON
      // lines for failures without exposing request bodies or secrets.
      if (res.statusCode >= 400) console.error(JSON.stringify({ level: "error", event: "http_request", requestId, method: req.method, path: req.path, status: res.statusCode }));
    });
    next();
  });
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
    emailVerificationEnabled: process.env.EMAIL_VERIFICATION_ENABLED === "true",
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

  async function requirePermission(req: Request, res: Response, permission: keyof import("@mai-chat/shared-types").WorkspacePermissions): Promise<boolean> {
    const workspaceId = paramString(req.params.id);
    const role = await db.getWorkspaceRole(workspaceId, req.user!.id);
    if (!role || !(await db.hasWorkspacePermission(workspaceId, role, permission))) {
      res.status(403).json({ error: "Your workspace role does not have permission for this action." });
      return false;
    }
    return true;
  }

  // Liveness proves the process can answer HTTP; readiness also proves its
  // required datastore is reachable. Neither endpoint leaks configuration.
  app.get("/healthz", (_req: Request, res: Response) => res.json({ ok: true, service: "chat-server" }));

  // Unauthenticated on purpose -- this is the public read-only link
  // generated by POST .../share below. Returns only the safe subset
  // (see PublicDashboardView); never the full artifact, and only while
  // the dashboard is published and a share link is still active.
  app.get("/public/dashboards/:token", async (req: Request, res: Response) => {
    const token = paramString(req.params.token);
    if (!token) return res.status(404).json({ error: "not found" });
    const view = await db.getPublicDashboardByShareToken(token);
    if (!view) return res.status(404).json({ error: "This dashboard link is no longer available." });
    res.json(view);
  });

  app.get("/public/release-notes/:token", async (req: Request, res: Response) => {
    const token = paramString(req.params.token);
    if (!token) return res.status(404).json({ error: "not found" });
    const view = await db.getPublicReleaseNotesByShareToken(token);
    if (!view) return res.status(404).json({ error: "This release notes link is no longer available." });
    res.json(view);
  });

  // Same pattern as the two routes above, for the three artifact types
  // (Plan, Report, Task list) that share one generic public view instead
  // of a type-specific one -- see PublicArtifactView and
  // getPublicArtifactByShareToken's own type filter.
  app.get("/public/artifacts/:token", async (req: Request, res: Response) => {
    const token = paramString(req.params.token);
    if (!token) return res.status(404).json({ error: "not found" });
    const view = await db.getPublicArtifactByShareToken(token);
    if (!view) return res.status(404).json({ error: "This artifact link is no longer available." });
    res.json(view);
  });
  app.get("/readyz", async (_req: Request, res: Response) => {
    try {
      await db.checkDatabaseHealth();
      res.json({ ok: true, service: "chat-server", database: "connected" });
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "readiness_check_failed", error: errMessage(error) }));
      res.status(503).json({ ok: false, service: "chat-server", database: "unavailable" });
    }
  });

  app.get("/notifications", requireAuth, async (req: Request, res: Response) => {
    const notifications = await db.listNotifications(req.user!.id);
    const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : null;
    res.json(workspaceId ? notifications.filter((notification) => notification.workspaceId === workspaceId) : notifications);
  });

  app.post("/notifications/read", requireAuth, async (req: Request, res: Response) => {
    const workspaceId = typeof req.body?.workspaceId === "string" ? req.body.workspaceId : "";
    if (!UUID_RE.test(workspaceId)) return res.status(400).json({ error: "valid workspaceId is required" });
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id: unknown): id is string => typeof id === "string" && UUID_RE.test(id)) : [];
    if (ids.length) await db.markNotificationSelectionRead(req.user!.id, workspaceId, ids);
    else await db.markNotificationsRead(req.user!.id, workspaceId);
    res.status(204).end();
  });

  app.get("/notifications/preferences", requireAuth, async (req: Request, res: Response) => {
    const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : "";
    if (!UUID_RE.test(workspaceId)) return res.status(400).json({ error: "valid workspaceId is required" });
    res.json(await db.getNotificationPreferences(workspaceId, req.user!.id));
  });

  app.put("/notifications/preferences", requireAuth, async (req: Request, res: Response) => {
    const workspaceId = typeof req.body?.workspaceId === "string" ? req.body.workspaceId : "";
    if (!UUID_RE.test(workspaceId)) return res.status(400).json({ error: "valid workspaceId is required" });
    res.json(await db.updateNotificationPreferences(workspaceId, req.user!.id, req.body ?? {}));
  });

  app.post("/workspaces", async (req: Request, res: Response) => {
    const name = typeof req.body?.name === "string" ? db.normalizeWorkspaceName(req.body.name) : "";
    if (!name) return res.status(400).json({ error: "name is required" });
    let workspace;
    try {
      workspace = await db.createWorkspace(name, req.user!.id);
    } catch (error) {
      if (error instanceof db.WorkspaceNameTakenError) return res.status(409).json({ error: error.message, workspace: error.workspace });
      throw error;
    }
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

  app.post("/workspaces/:id/invitations", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin"]))) return;
    const workspaceId = paramString(req.params.id);
    if (!UUID_RE.test(workspaceId)) return res.status(400).json({ error: "invalid workspace id" });
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ error: "A valid email address is required." });
    const role = req.body?.role;
    if (role !== "admin" && role !== "editor") return res.status(400).json({ error: "Choose Admin or Editor access." });
    const workspace = await db.getWorkspaceById(workspaceId);
    if (!workspace) return res.status(404).json({ error: "not found" });
    if (await db.isWorkspaceMemberEmail(workspaceId, email)) return res.status(409).json({ error: "This user is already in the workspace." });
    const invite = await db.createWorkspaceInvitation({ workspaceId, email, invitedByUserId: req.user!.id, role });
    const inviteUrl = new URL("/", webAppUrl);
    inviteUrl.searchParams.set("invite", invite.token);
    try {
      await deps.mailer.send({
        to: invite.email,
        subject: `You're invited to ${workspace.name} on Nexus`,
        text: `${req.user!.displayName} invited you to join the ${workspace.name} workspace as an ${invite.role}.\n\nOpen this invitation: ${inviteUrl}\n\nSign in or create an account with ${invite.email}. This invitation expires in 7 days.`,
      });
    } catch (error) {
      await db.deleteWorkspaceInvitation(invite.token);
      const message = errMessage(error);
      console.error(JSON.stringify({ level: "error", event: "workspace_invitation_email_failed", workspaceId, error: message }));
      const publicError = /EAUTH|Invalid login|Username and Password not accepted/i.test(message)
        ? "Gmail rejected the sign-in. Check the Gmail address and use a new Google App Password."
        : /ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND/i.test(message)
          ? "The server could not connect to Gmail SMTP. Check Render’s logs and try again."
          : "The invitation email could not be sent. Check the Gmail configuration and try again.";
      return res.status(502).json({ error: publicError });
    }
    await db.recordAuditEvent({
      workspaceId,
      eventType: "member.invited",
      actorType: "user",
      actorUserId: req.user!.id,
      actorName: req.user!.displayName,
      summary: `${req.user!.displayName} invited ${invite.email} to join the workspace as ${invite.role}`,
    });
    res.status(201).json({ email: invite.email, role: invite.role, expiresAt: invite.expiresAt });
  });

  app.get("/workspaces/:id/invitations", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin"]))) return;
    const workspaceId = paramString(req.params.id);
    if (!UUID_RE.test(workspaceId)) return res.status(400).json({ error: "invalid workspace id" });
    res.json(await db.listWorkspaceInvitations(workspaceId));
  });

  app.delete("/workspaces/:id/invitations/:invitationId", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin"]))) return;
    const workspaceId = paramString(req.params.id);
    if (!UUID_RE.test(workspaceId)) return res.status(400).json({ error: "invalid workspace id" });
    if (!(await db.revokeWorkspaceInvitation(workspaceId, paramString(req.params.invitationId)))) return res.status(404).json({ error: "invitation not found" });
    res.status(204).end();
  });

  app.post("/workspace-invitations/accept", requireAuth, async (req: Request, res: Response) => {
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    if (!token || token.length > 256) return res.status(400).json({ error: "A valid invitation is required." });
    const result = await db.acceptWorkspaceInvitation(token, req.user!.id);
    if (result.kind === "invalid") return res.status(404).json({ error: "This invitation is invalid, expired, or has already been used." });
    if (result.kind === "email_mismatch") return res.status(403).json({ error: `This invitation was sent to ${result.email}. Sign in with that email address to join.` });
    await db.recordAuditEvent({ workspaceId: result.workspaceId, eventType: "member.joined", actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} joined the workspace through an email invitation` });
    res.json({ workspaceId: result.workspaceId });
  });

  app.get("/workspaces/by-code/:joinCode", async (req: Request, res: Response) => {
    const workspace = await db.getWorkspaceByJoinCode(paramString(req.params.joinCode));
    if (!workspace) return res.status(404).json({ error: "not found" });
    res.json(workspace);
  });

  app.get("/workspaces", async (req: Request, res: Response) => {
    res.json(await db.listWorkspacesForUser(req.user!.id));
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

  app.get("/workspaces/:id/permissions", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    res.json(await db.getWorkspacePermissionPolicy(paramString(req.params.id)));
  });

  app.put("/workspaces/:id/permissions", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin"]))) return;
    const policy = req.body;
    if (!policy?.admin || !policy?.editor) return res.status(400).json({ error: "Admin and Editor permissions are required." });
    const saved = await db.setWorkspacePermissionPolicy(paramString(req.params.id), policy);
    await db.recordAuditEvent({ workspaceId: paramString(req.params.id), eventType: "workspace.permissions_updated", actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} updated workspace permissions` });
    res.json(saved);
  });
  app.get("/workspaces/:id/permission-requests", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin"]))) return;
    res.json(await db.listPermissionRequests(paramString(req.params.id)));
  });
  app.post("/workspaces/:id/permission-requests", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["editor"]))) return;
    const permission = req.body?.permission;
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    const policy = await db.getWorkspacePermissionPolicy(paramString(req.params.id));
    if (!Object.keys(policy.editor).includes(permission)) return res.status(400).json({ error: "Invalid permission." });
    if (policy.editor[permission as keyof import("@mai-chat/shared-types").WorkspacePermissions]) return res.status(409).json({ error: "You already have this permission." });
    if (!reason || reason.length > 1000) return res.status(400).json({ error: "Give a reason between 1 and 1,000 characters." });
    res.status(201).json(await db.createPermissionRequest(paramString(req.params.id), req.user!.id, permission, reason));
  });
  app.post("/workspaces/:id/permission-requests/:requestId/:decision", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin"]))) return;
    const decision = paramString(req.params.decision);
    if (decision !== "approve" && decision !== "reject") return res.status(404).json({ error: "Unknown decision." });
    const workspaceId = paramString(req.params.id);
    const request = await db.resolvePermissionRequest(workspaceId, paramString(req.params.requestId), decision === "approve" ? "approved" : "denied");
    if (!request) return res.status(404).json({ error: "Request not found." });
    if (decision === "approve") {
      const policy = await db.getWorkspacePermissionPolicy(workspaceId);
      policy.editor[request.permission] = true;
      await db.setWorkspacePermissionPolicy(workspaceId, policy);
      await db.notifyWorkspaceUser({ workspaceId, userId: request.user_id, kind: "permission_request", text: `${req.user!.displayName} approved your request for ${request.permission}. You can use it now.` });
    } else {
      await db.notifyWorkspaceUser({ workspaceId, userId: request.user_id, kind: "permission_request", text: `${req.user!.displayName} declined your request for ${request.permission}.` });
    }
    res.status(204).end();
  });

  app.get("/workspaces/:id/agents", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    res.json(await db.listWorkspaceAgents(paramString(req.params.id)));
  });
  app.get("/workspaces/:id/agent-models", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const configured = (process.env.AGENT_LLM_ALLOWED_MODELS ?? "").split(",").map((model) => model.trim()).filter(Boolean);
    res.json(["workspace-default", ...configured]);
  });
  app.post("/workspaces/:id/agents", async (req: Request, res: Response) => {
    if (!(await requirePermission(req, res, "createAgents"))) return;
    const body = req.body ?? {};
    if (typeof body.name !== "string" || !["project", "github", "slack", "linear", "notion", "figma"].includes(body.baseAgent)) return res.status(400).json({ error: "A name and base agent are required." });
    const agent = await db.createWorkspaceAgent({ workspaceId: paramString(req.params.id), name: body.name, baseAgent: body.baseAgent, instructions: typeof body.instructions === "string" ? body.instructions : "", knowledge: typeof body.knowledge === "string" ? body.knowledge : "", approvedProviders: Array.isArray(body.approvedProviders) ? body.approvedProviders.filter((item: unknown) => ["github", "slack", "linear", "notion", "figma"].includes(item as string)) : [], model: typeof body.model === "string" ? body.model : "workspace-default", ownerUserId: req.user!.id });
    await db.recordAuditEvent({ workspaceId: agent.workspaceId, eventType: "agent.created", actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} created agent draft ${agent.name}` });
    res.status(201).json(agent);
  });
  app.patch("/workspaces/:id/agents/:agentId", async (req: Request, res: Response) => {
    if (!(await requirePermission(req, res, "createAgents"))) return;
    const body = req.body ?? {};
    const agent = await db.updateWorkspaceAgent(paramString(req.params.id), paramString(req.params.agentId), { name: typeof body.name === "string" ? body.name : undefined, baseAgent: ["project", "github", "slack", "linear", "notion", "figma"].includes(body.baseAgent) ? body.baseAgent : undefined, instructions: typeof body.instructions === "string" ? body.instructions : undefined, knowledge: typeof body.knowledge === "string" ? body.knowledge : undefined, approvedProviders: Array.isArray(body.approvedProviders) ? body.approvedProviders.filter((item: unknown) => ["github", "slack", "linear", "notion", "figma"].includes(item as string)) : undefined, model: typeof body.model === "string" ? body.model : undefined });
    if (!agent) return res.status(404).json({ error: "Agent not found." });
    await db.recordAuditEvent({ workspaceId: agent.workspaceId, eventType: "agent.updated", actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} updated agent ${agent.name}` });
    res.json(agent);
  });
  app.post("/workspaces/:id/agents/:agentId/publish", async (req: Request, res: Response) => {
    if (!(await requirePermission(req, res, "publishAgents"))) return;
    const agent = await db.publishWorkspaceAgent(paramString(req.params.id), paramString(req.params.agentId), req.user!.id);
    if (!agent) return res.status(404).json({ error: "Agent not found." });
    await db.recordAuditEvent({ workspaceId: agent.workspaceId, eventType: "agent.published", actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} published ${agent.name} version ${agent.publishedVersion}` });
    res.json(agent);
  });
  app.delete("/workspaces/:id/agents/:agentId", async (req: Request, res: Response) => {
    if (!(await requirePermission(req, res, "createAgents"))) return;
    const agent = await db.deleteWorkspaceAgent(paramString(req.params.id), paramString(req.params.agentId));
    if (!agent) return res.status(404).json({ error: "Agent not found." });
    await db.recordAuditEvent({ workspaceId: agent.workspaceId, eventType: "agent.deleted", actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} deleted agent ${agent.name}` });
    res.status(204).end();
  });
  app.get("/workspaces/:id/agents/:agentId/versions", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    res.json(await db.listWorkspaceAgentVersions(paramString(req.params.id), paramString(req.params.agentId)));
  });

  const workflowTriggers = ["manual", "schedule", "github_issue", "github_status", "slack_mention"] as const;
  const workflowAgents = ["project", "github", "slack", "linear", "notion", "figma"] as const;
  function workflowInput(body: Record<string, unknown>) {
    const trigger = workflowTriggers.includes(body.trigger as typeof workflowTriggers[number]) ? body.trigger as typeof workflowTriggers[number] : "manual";
    const agentKind = workflowAgents.includes(body.agentKind as typeof workflowAgents[number]) ? body.agentKind as typeof workflowAgents[number] : "project";
    const scheduleMinutes = Number(body.scheduleMinutes);
    return {
      name: typeof body.name === "string" ? body.name : "", description: typeof body.description === "string" ? body.description : "",
      instructions: typeof body.instructions === "string" ? body.instructions : "", agentKind,
      workspaceAgentId: typeof body.workspaceAgentId === "string" && UUID_RE.test(body.workspaceAgentId) ? body.workspaceAgentId : null,
      conversationId: typeof body.conversationId === "string" && UUID_RE.test(body.conversationId) ? body.conversationId : null,
      trigger, scheduleMinutes: trigger === "schedule" && Number.isInteger(scheduleMinutes) && scheduleMinutes >= 5 && scheduleMinutes <= 10080 ? scheduleMinutes : null,
      enabled: typeof body.enabled === "boolean" ? body.enabled : true,
    };
  }

  app.get("/workspaces/:id/workflows", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    res.json(await db.listWorkspaceWorkflows(paramString(req.params.id)));
  });
  app.post("/workspaces/:id/workflows", async (req: Request, res: Response) => {
    if (!(await requirePermission(req, res, "createAgents"))) return;
    const input = workflowInput(req.body ?? {});
    if (!input.name.trim() || !input.instructions.trim()) return res.status(400).json({ error: "A workflow name and instructions are required." });
    if (input.trigger === "schedule" && !input.scheduleMinutes) return res.status(400).json({ error: "Choose an interval between 5 minutes and 7 days." });
    if (input.workspaceAgentId && !(await db.getPublishedWorkspaceAgent(paramString(req.params.id), input.workspaceAgentId))) return res.status(400).json({ error: "Choose a published workspace agent." });
    const workflow = await db.createWorkspaceWorkflow(paramString(req.params.id), req.user!.id, input);
    await db.recordAuditEvent({ workspaceId: workflow.workspaceId, eventType: "workflow.created", actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} created workflow ${workflow.name}` });
    res.status(201).json(workflow);
  });
  app.patch("/workspaces/:id/workflows/:workflowId", async (req: Request, res: Response) => {
    if (!(await requirePermission(req, res, "createAgents"))) return;
    const input = workflowInput(req.body ?? {});
    if (!input.name.trim() || !input.instructions.trim()) return res.status(400).json({ error: "A workflow name and instructions are required." });
    if (input.trigger === "schedule" && !input.scheduleMinutes) return res.status(400).json({ error: "Choose an interval between 5 minutes and 7 days." });
    if (input.workspaceAgentId && !(await db.getPublishedWorkspaceAgent(paramString(req.params.id), input.workspaceAgentId))) return res.status(400).json({ error: "Choose a published workspace agent." });
    const workflow = await db.updateWorkspaceWorkflow(paramString(req.params.id), paramString(req.params.workflowId), input);
    if (!workflow) return res.status(404).json({ error: "Workflow not found." });
    await db.recordAuditEvent({ workspaceId: workflow.workspaceId, eventType: "workflow.updated", actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} updated workflow ${workflow.name}` });
    res.json(workflow);
  });
  app.delete("/workspaces/:id/workflows/:workflowId", async (req: Request, res: Response) => {
    if (!(await requirePermission(req, res, "createAgents"))) return;
    const workflow = await db.deleteWorkspaceWorkflow(paramString(req.params.id), paramString(req.params.workflowId));
    if (!workflow) return res.status(404).json({ error: "Workflow not found." });
    await db.recordAuditEvent({ workspaceId: workflow.workspaceId, eventType: "workflow.deleted", actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} deleted workflow ${workflow.name}` });
    res.status(204).end();
  });
  app.get("/workspaces/:id/workflows/:workflowId/runs", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    res.json(await db.listWorkflowRuns(paramString(req.params.id), paramString(req.params.workflowId)));
  });
  app.get("/workspaces/:id/observability/retention", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    res.json(await db.getObservabilityRetentionPolicy(paramString(req.params.id)));
  });
  app.put("/workspaces/:id/observability/retention", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const retentionDays = Number(req.body?.retentionDays);
    if (![7, 30, 90, 365].includes(retentionDays)) return res.status(400).json({ error: "retentionDays must be 7, 30, 90, or 365" });
    const policy = await db.updateObservabilityRetentionPolicy(paramString(req.params.id), retentionDays as 7 | 30 | 90 | 365);
    const removed = await db.enforceWorkflowRunRetention();
    res.json({ ...policy, removed });
  });
  app.post("/workspaces/:id/workflows/:workflowId/run", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const workflow = await db.getWorkspaceWorkflow(paramString(req.params.id), paramString(req.params.workflowId));
    if (!workflow) return res.status(404).json({ error: "Workflow not found." });
    const requestedTrigger = req.body?.trigger;
    const trigger = workflowTriggers.includes(requestedTrigger) && requestedTrigger !== "schedule" ? requestedTrigger : "manual";
    if (trigger !== "manual" && trigger !== workflow.trigger) return res.status(400).json({ error: "This event does not match the workflow trigger." });
    const eventText = typeof req.body?.eventText === "string" ? req.body.eventText.trim().slice(0, 4_000) : "";
    const runner = app.locals.runWorkflow as undefined | ((workflow: Awaited<ReturnType<typeof db.getWorkspaceWorkflow>>, trigger: typeof workflowTriggers[number], user: { id: string; displayName: string }, eventText?: string) => Promise<void>);
    if (!runner) return res.status(503).json({ error: "Workflow runner is starting. Try again in a moment." });
    void runner(workflow, trigger, { id: req.user!.id, displayName: req.user!.displayName }, eventText || undefined);
    res.status(202).json({ accepted: true });
  });

  const taskStatuses = ["todo", "in_progress", "review", "done"] as const;
  function taskInput(body: Record<string, unknown>) {
    const dueDate = typeof body.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.dueDate) ? body.dueDate : null;
    return { title: typeof body.title === "string" ? body.title : "", description: typeof body.description === "string" ? body.description : "", status: taskStatuses.includes(body.status as typeof taskStatuses[number]) ? body.status as typeof taskStatuses[number] : undefined, ownerUserId: typeof body.ownerUserId === "string" && UUID_RE.test(body.ownerUserId) ? body.ownerUserId : null, dueDate, sourceConversationId: typeof body.sourceConversationId === "string" && UUID_RE.test(body.sourceConversationId) ? body.sourceConversationId : null };
  }
  app.get("/workspaces/:id/tasks", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    res.json(await db.listWorkspaceTasks(paramString(req.params.id)));
  });
  app.post("/workspaces/:id/tasks", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const input = taskInput(req.body ?? {});
    if (!input.title.trim()) return res.status(400).json({ error: "A task title is required." });
    const task = await db.createWorkspaceTask({ workspaceId: paramString(req.params.id), ...input, createdByUserId: req.user!.id });
    res.status(201).json(task);
  });
  app.patch("/workspaces/:id/tasks/:taskId", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const input = taskInput(req.body ?? {});
    if (typeof req.body?.title === "string" && !input.title.trim()) return res.status(400).json({ error: "A task title is required." });
    const task = await db.updateWorkspaceTask(paramString(req.params.id), paramString(req.params.taskId), input);
    if (!task) return res.status(404).json({ error: "Task not found." });
    res.json(task);
  });
  app.delete("/workspaces/:id/tasks/:taskId", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const task = await db.deleteWorkspaceTask(paramString(req.params.id), paramString(req.params.taskId));
    if (!task) return res.status(404).json({ error: "Task not found." });
    res.status(204).end();
  });

  async function canManageMemory(req: Request, memoryId: string) {
    const workspaceId = paramString(req.params.id);
    const memory = await db.getWorkspaceMemory(workspaceId, memoryId);
    if (!memory) return { memory: null, allowed: false };
    const role = await db.getWorkspaceRole(workspaceId, req.user!.id);
    return { memory, allowed: role === "admin" || memory.createdByUserId === req.user!.id };
  }
  app.get("/workspaces/:id/memory", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    res.json(await db.listWorkspaceMemory(paramString(req.params.id)));
  });
  app.post("/workspaces/:id/memory", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    let input;
    try { input = parseWorkspaceMemoryInput(req.body ?? {}); } catch (error) { return res.status(400).json({ error: errMessage(error) }); }
    if (!input.title.trim() || !input.content.trim()) return res.status(400).json({ error: "A memory title and content are required." });
    const memory = await db.createWorkspaceMemory({ workspaceId: paramString(req.params.id), ...input, createdByUserId: req.user!.id });
    await db.recordAuditEvent({ workspaceId: memory.workspaceId, eventType: "memory.created", actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} saved ${memory.kind} memory ${memory.title}` });
    res.status(201).json(memory);
  });
  app.patch("/workspaces/:id/memory/:memoryId", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const access = await canManageMemory(req, paramString(req.params.memoryId));
    if (!access.memory) return res.status(404).json({ error: "Memory not found." });
    if (!access.allowed) return res.status(403).json({ error: "Only the memory author or an Admin can edit this entry." });
    let input;
    try { input = parseWorkspaceMemoryInput(req.body ?? {}); } catch (error) { return res.status(400).json({ error: errMessage(error) }); }
    if (!input.title.trim() || !input.content.trim()) return res.status(400).json({ error: "A memory title and content are required." });
    const memory = await db.updateWorkspaceMemory(paramString(req.params.id), paramString(req.params.memoryId), input);
    if (!memory) return res.status(404).json({ error: "Memory not found." });
    await db.recordAuditEvent({ workspaceId: memory.workspaceId, eventType: "memory.updated", actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} updated memory ${memory.title}` });
    res.json(memory);
  });
  app.delete("/workspaces/:id/memory/:memoryId", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const access = await canManageMemory(req, paramString(req.params.memoryId));
    if (!access.memory) return res.status(404).json({ error: "Memory not found." });
    if (!access.allowed) return res.status(403).json({ error: "Only the memory author or an Admin can delete this entry." });
    const memory = await db.deleteWorkspaceMemory(paramString(req.params.id), paramString(req.params.memoryId));
    if (!memory) return res.status(404).json({ error: "Memory not found." });
    await db.recordAuditEvent({ workspaceId: memory.workspaceId, eventType: "memory.deleted", actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} deleted memory ${memory.title}` });
    res.status(204).end();
  });

  async function canManageArtifact(req: Request, artifactId: string) {
    const workspaceId = paramString(req.params.id); const artifact = await db.getWorkspaceArtifact(workspaceId, artifactId);
    if (!artifact) return { artifact: null, allowed: false };
    const role = await db.getWorkspaceRole(workspaceId, req.user!.id);
    return { artifact, allowed: role === "admin" || artifact.createdByUserId === req.user!.id };
  }
  app.get("/workspaces/:id/artifacts", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    res.json(await db.listWorkspaceArtifacts(paramString(req.params.id)));
  });
  app.post("/workspaces/:id/artifacts", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const input = parseWorkspaceArtifactInput(req.body ?? {});
    if (!input.title || !input.content) return res.status(400).json({ error: "An artifact title and content are required." });
    if (input.ownerUserId && !(await db.getWorkspaceRole(paramString(req.params.id), input.ownerUserId))) return res.status(400).json({ error: "Artifact owner must be a workspace member." });
    const artifact = await db.createWorkspaceArtifact(paramString(req.params.id), req.user!.id, input);
    await db.recordAuditEvent({ workspaceId: artifact.workspaceId, eventType: "artifact.created", actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} created ${artifact.type.replace("_", " ")} ${artifact.title}` });
    res.status(201).json(artifact);
  });
  app.patch("/workspaces/:id/artifacts/:artifactId", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const access = await canManageArtifact(req, paramString(req.params.artifactId));
    if (!access.artifact) return res.status(404).json({ error: "Artifact not found." });
    if (!access.allowed) return res.status(403).json({ error: "Only the artifact author or an Admin can edit it." });
    const input = parseWorkspaceArtifactInput(req.body ?? {});
    if (!input.title || !input.content) return res.status(400).json({ error: "An artifact title and content are required." });
    if (input.ownerUserId && !(await db.getWorkspaceRole(paramString(req.params.id), input.ownerUserId))) return res.status(400).json({ error: "Artifact owner must be a workspace member." });
    const artifact = await db.updateWorkspaceArtifact(paramString(req.params.id), paramString(req.params.artifactId), input, req.user!.id);
    if (!artifact) return res.status(404).json({ error: "Artifact not found." });
    await db.recordAuditEvent({ workspaceId: artifact.workspaceId, eventType: "artifact.updated", actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} updated artifact ${artifact.title}` }); res.json(artifact);
  });
  app.delete("/workspaces/:id/artifacts/:artifactId", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const access = await canManageArtifact(req, paramString(req.params.artifactId));
    if (!access.artifact) return res.status(404).json({ error: "Artifact not found." });
    if (!access.allowed) return res.status(403).json({ error: "Only the artifact author or an Admin can delete it." });
    const artifact = await db.deleteWorkspaceArtifact(paramString(req.params.id), paramString(req.params.artifactId));
    if (!artifact) return res.status(404).json({ error: "Artifact not found." });
    await db.recordAuditEvent({ workspaceId: artifact.workspaceId, eventType: "artifact.deleted", actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} deleted artifact ${artifact.title}` }); res.status(204).end();
  });
  app.get("/workspaces/:id/artifacts/:artifactId/versions", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    if (!(await db.getWorkspaceArtifact(paramString(req.params.id), paramString(req.params.artifactId)))) return res.status(404).json({ error: "Artifact not found." });
    res.json(await db.listWorkspaceArtifactVersions(paramString(req.params.id), paramString(req.params.artifactId)));
  });
  app.post("/workspaces/:id/artifacts/:artifactId/versions/:versionId/restore", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const access = await canManageArtifact(req, paramString(req.params.artifactId));
    if (!access.artifact) return res.status(404).json({ error: "Artifact not found." });
    if (!access.allowed) return res.status(403).json({ error: "Only the artifact author or an Admin can restore a version." });
    const artifact = await db.restoreWorkspaceArtifactVersion(paramString(req.params.id), paramString(req.params.artifactId), paramString(req.params.versionId), req.user!.id);
    if (!artifact) return res.status(404).json({ error: "Artifact version not found." });
    await db.recordAuditEvent({ workspaceId: artifact.workspaceId, eventType: "artifact.updated", actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} restored version of artifact ${artifact.title}` }); res.json(artifact);
  });
  app.post("/workspaces/:id/artifacts/:artifactId/refresh-dashboard", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const access = await canManageArtifact(req, paramString(req.params.artifactId));
    if (!access.artifact) return res.status(404).json({ error: "Artifact not found." });
    if (!access.allowed) return res.status(403).json({ error: "Only the artifact author or an Admin can refresh it." });
    if (access.artifact.type !== "dashboard") return res.status(400).json({ error: "Only Dashboard artifacts can be refreshed." });
    const dashboardData = await workspaceDashboardSnapshot(access.artifact.workspaceId, deps);
    const artifact = await db.updateWorkspaceArtifact(access.artifact.workspaceId, access.artifact.id, { type: access.artifact.type, status: access.artifact.status, title: access.artifact.title, summary: access.artifact.summary, content: access.artifact.content, dashboardData, ownerUserId: access.artifact.ownerUserId, releaseVersion: access.artifact.releaseVersion }, req.user!.id);
    if (!artifact) return res.status(404).json({ error: "Artifact not found." });
    await db.recordAuditEvent({ workspaceId: artifact.workspaceId, eventType: "artifact.updated", actorType: "system", actorName: "Dashboard refresh", summary: `${req.user!.displayName} refreshed live workspace data for ${artifact.title}` }); res.json(artifact);
  });

  app.post("/workspaces/:id/artifacts/:artifactId/generate-assisted-draft", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const access = await canManageArtifact(req, paramString(req.params.artifactId));
    if (!access.artifact) return res.status(404).json({ error: "Artifact not found." });
    if (!access.allowed) return res.status(403).json({ error: "Only the artifact author or an Admin can generate it." });
    if (access.artifact.type === "dashboard") return res.status(400).json({ error: "Dashboards use Refresh live data instead." });
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : "";
    let content: string;
    try { content = await aiArtifactDraft(access.artifact.workspaceId, access.artifact, prompt, deps); }
    catch (error) { return res.status(503).json({ error: `AI draft unavailable: ${errMessage(error)}` }); }
    const artifact = await db.updateWorkspaceArtifact(access.artifact.workspaceId, access.artifact.id, { type: access.artifact.type, status: access.artifact.status, title: access.artifact.title, summary: access.artifact.summary, content, dashboardData: null, ownerUserId: access.artifact.ownerUserId, releaseVersion: access.artifact.releaseVersion }, req.user!.id);
    if (!artifact) return res.status(404).json({ error: "Artifact not found." });
    await db.recordAuditEvent({ workspaceId: artifact.workspaceId, eventType: "artifact.updated", actorType: "system", actorName: "Artifact assistant", summary: `${req.user!.displayName} generated a workspace-assisted draft for ${artifact.title}` });
    res.json(artifact);
  });
  app.post("/workspaces/:id/artifacts/:artifactId/generate-release-notes", async (req: Request, res: Response) => {
    const access = await canManageArtifact(req, paramString(req.params.artifactId));
    if (!access.artifact) return res.status(404).json({ error: "Artifact not found." });
    if (!access.allowed) return res.status(403).json({ error: "Only the artifact author or an Admin can generate it." });
    if (access.artifact.type !== "release_notes") return res.status(400).json({ error: "Only Release notes artifacts can be generated." });
    const content = await workspaceReleaseNotesDraft(access.artifact.workspaceId, access.artifact.id, deps);
    const artifact = await db.updateWorkspaceArtifact(access.artifact.workspaceId, access.artifact.id, { type: access.artifact.type, status: access.artifact.status, title: access.artifact.title, summary: access.artifact.summary, content, dashboardData: null, ownerUserId: access.artifact.ownerUserId, releaseVersion: access.artifact.releaseVersion }, req.user!.id);
    if (!artifact) return res.status(404).json({ error: "Artifact not found." });
    await db.recordAuditEvent({ workspaceId: artifact.workspaceId, eventType: "artifact.updated", actorType: "system", actorName: "Release notes generator", summary: `${req.user!.displayName} generated release notes for ${artifact.title} from GitHub activity` });
    res.json(artifact);
  });

  app.post("/workspaces/:id/artifacts/:artifactId/generate-report", async (req: Request, res: Response) => {
    const access = await canManageArtifact(req, paramString(req.params.artifactId));
    if (!access.artifact) return res.status(404).json({ error: "Artifact not found." });
    if (!access.allowed) return res.status(403).json({ error: "Only the artifact author or an Admin can generate it." });
    if (access.artifact.type !== "report") return res.status(400).json({ error: "Only Report artifacts can be generated." });
    const content = await workspaceReportDraft(access.artifact.workspaceId, access.artifact.id);
    const artifact = await db.updateWorkspaceArtifact(access.artifact.workspaceId, access.artifact.id, { type: access.artifact.type, status: access.artifact.status, title: access.artifact.title, summary: access.artifact.summary, content, dashboardData: null, ownerUserId: access.artifact.ownerUserId, releaseVersion: access.artifact.releaseVersion }, req.user!.id);
    if (!artifact) return res.status(404).json({ error: "Artifact not found." });
    await db.recordAuditEvent({ workspaceId: artifact.workspaceId, eventType: "artifact.updated", actorType: "system", actorName: "Report generator", summary: `${req.user!.displayName} generated a status report for ${artifact.title} from workspace activity` });
    res.json(artifact);
  });

  app.post("/workspaces/:id/artifacts/:artifactId/share-to-slack", async (req: Request, res: Response) => {
    const access = await canManageArtifact(req, paramString(req.params.artifactId));
    if (!access.artifact) return res.status(404).json({ error: "Artifact not found." });
    if (!access.allowed) return res.status(403).json({ error: "Only the artifact author or an Admin can share it." });
    const channel = typeof req.body?.channel === "string" ? req.body.channel.trim() : "";
    if (!channel) return res.status(400).json({ error: "A Slack channel is required." });
    const slackIntegration = (await db.listIntegrations(access.artifact.workspaceId)).find((integration) => integration.type === "slack");
    if (!slackIntegration?.id) return res.status(400).json({ error: "Slack isn't connected for this workspace yet." });
    const credential = await db.getIntegrationCredential(access.artifact.workspaceId, "slack", slackIntegration.id);
    if (!credential) return res.status(400).json({ error: "Slack isn't connected for this workspace yet." });
    const text = `*${access.artifact.title}*${access.artifact.releaseVersion ? ` (${access.artifact.releaseVersion})` : ""}\n${access.artifact.content.slice(0, 2800)}`;
    try {
      await deps.slackClientFactory({ token: credential.token }).postMessage(channel, text);
    } catch (err) {
      return res.status(400).json({ error: `Could not post to Slack: ${errMessage(err)}` });
    }
    await db.recordAuditEvent({ workspaceId: access.artifact.workspaceId, eventType: "artifact.updated", actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} shared ${access.artifact.type.replace("_", " ")} "${access.artifact.title}" to Slack (#${channel})` });
    res.status(204).end();
  });
  app.get("/workspaces/:id/artifacts/:artifactId/comments", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    if (!(await db.getWorkspaceArtifact(paramString(req.params.id), paramString(req.params.artifactId)))) return res.status(404).json({ error: "Artifact not found." });
    res.json(await db.listWorkspaceArtifactComments(paramString(req.params.id), paramString(req.params.artifactId)));
  });
  app.post("/workspaces/:id/artifacts/:artifactId/comments", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
    if (!content) return res.status(400).json({ error: "A comment is required." });
    const artifact = await db.getWorkspaceArtifact(paramString(req.params.id), paramString(req.params.artifactId));
    if (!artifact) return res.status(404).json({ error: "Artifact not found." });
    const comment = await db.createWorkspaceArtifactComment(artifact.workspaceId, artifact.id, req.user!.id, content.slice(0, 8_000));
    await db.recordAuditEvent({ workspaceId: artifact.workspaceId, eventType: "artifact.commented", actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} commented on artifact ${artifact.title}` }); res.status(201).json(comment);
  });

  // In-memory only -- who's currently looking at a given dashboard.
  // Scoped to this one server instance/process, same tradeoff as
  // RoomRegistry's chat presence: ephemeral, not persisted, reset on
  // restart. Keyed by "workspaceId:artifactId" -> userId -> last heartbeat.
  const dashboardViewers = new Map<string, Map<string, { name: string; lastSeenAt: number }>>();
  const PRESENCE_TTL_MS = 20_000;
  function activeViewers(key: string, excludeUserId?: string): { userId: string; name: string }[] {
    const viewers = dashboardViewers.get(key);
    if (!viewers) return [];
    const cutoff = Date.now() - PRESENCE_TTL_MS;
    for (const [userId, entry] of viewers) {
      if (entry.lastSeenAt < cutoff) viewers.delete(userId);
    }
    return Array.from(viewers.entries()).filter(([userId]) => userId !== excludeUserId).map(([userId, entry]) => ({ userId, name: entry.name }));
  }

  // A lightweight heartbeat, not a WebSocket -- the artifacts page isn't
  // otherwise connected live, and a dashboard's data already only changes
  // on an explicit refresh, so short polling is enough to show "who else
  // is looking at this right now" without adding a second realtime
  // transport just for this one page.
  app.post("/workspaces/:id/artifacts/:artifactId/presence", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const workspaceId = paramString(req.params.id);
    const artifactId = paramString(req.params.artifactId);
    if (!(await db.getWorkspaceArtifact(workspaceId, artifactId))) return res.status(404).json({ error: "Artifact not found." });
    const key = `${workspaceId}:${artifactId}`;
    let viewers = dashboardViewers.get(key);
    if (!viewers) { viewers = new Map(); dashboardViewers.set(key, viewers); }
    viewers.set(req.user!.id, { name: req.user!.displayName, lastSeenAt: Date.now() });
    res.json({ viewers: activeViewers(key, req.user!.id) });
  });

  // Generates (or, with DELETE, revokes) a public, unauthenticated
  // read-only link for a dashboard -- see GET /public/dashboards/:token
  // above. Anyone who can already manage the artifact can toggle this;
  // there's nothing workspace-private in what the link exposes (see
  // PublicDashboardView).
  app.post("/workspaces/:id/artifacts/:artifactId/share", async (req: Request, res: Response) => {
    const access = await canManageArtifact(req, paramString(req.params.artifactId));
    if (!access.artifact) return res.status(404).json({ error: "Artifact not found." });
    if (!access.allowed) return res.status(403).json({ error: "Only the artifact author or an Admin can share it." });
    const artifact = await db.setArtifactShareToken(access.artifact.workspaceId, access.artifact.id, false);
    if (!artifact) return res.status(404).json({ error: "Artifact not found." });
    await db.recordAuditEvent({ workspaceId: artifact.workspaceId, eventType: "artifact.updated", actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} created a public share link for ${artifact.title}` });
    res.json(artifact);
  });
  app.delete("/workspaces/:id/artifacts/:artifactId/share", async (req: Request, res: Response) => {
    const access = await canManageArtifact(req, paramString(req.params.artifactId));
    if (!access.artifact) return res.status(404).json({ error: "Artifact not found." });
    if (!access.allowed) return res.status(403).json({ error: "Only the artifact author or an Admin can revoke sharing." });
    const artifact = await db.setArtifactShareToken(access.artifact.workspaceId, access.artifact.id, true);
    if (!artifact) return res.status(404).json({ error: "Artifact not found." });
    await db.recordAuditEvent({ workspaceId: artifact.workspaceId, eventType: "artifact.updated", actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} revoked the public share link for ${artifact.title}` });
    res.json(artifact);
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

  app.delete("/workspaces/:id/members/:userId", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin"]))) return;
    const workspaceId = paramString(req.params.id);
    const userId = paramString(req.params.userId);
    const members = await db.listWorkspaceMembersWithRoles(workspaceId);
    const target = members.find((member) => member.id === userId);
    if (!target) return res.status(404).json({ error: "member not found" });
    if (target.role === "admin" && members.filter((member) => member.role === "admin").length === 1) return res.status(409).json({ error: "A workspace must keep at least one admin." });
    if (!(await db.removeWorkspaceMemberAndPersonalIntegrations(workspaceId, userId))) return res.status(404).json({ error: "member not found" });
    res.status(204).end();
  });

  // Members may leave a workspace themselves. Personal integrations are
  // removed with their membership so an explicit future rejoin begins with
  // no retained provider credentials.
  app.delete("/workspaces/:id/membership", async (req: Request, res: Response) => {
    const workspaceId = paramString(req.params.id);
    if (!UUID_RE.test(workspaceId)) return res.status(400).json({ error: "invalid workspace id" });
    const role = await db.getWorkspaceRole(workspaceId, req.user!.id);
    if (!role) return res.status(404).json({ error: "member not found" });
    if (!(await db.removeWorkspaceMemberAndPersonalIntegrations(workspaceId, req.user!.id))) {
      return res.status(404).json({ error: "member not found" });
    }
    await db.recordAuditEvent({
      workspaceId,
      eventType: "member.left",
      actorType: "user",
      actorUserId: req.user!.id,
      actorName: req.user!.displayName,
      summary: `${req.user!.displayName} left the workspace and removed their personal tool connections`,
    });
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

  app.patch("/workspaces/:id/conversations/:conversationId", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const workspaceId = paramString(req.params.id);
    const conversationId = paramString(req.params.conversationId);
    if (!UUID_RE.test(workspaceId) || !UUID_RE.test(conversationId)) return res.status(400).json({ error: "invalid conversation id" });
    const title = typeof req.body?.title === "string" ? req.body.title.trim() : null;
    const pinned = typeof req.body?.pinned === "boolean" ? req.body.pinned : null;
    const archived = typeof req.body?.archived === "boolean" ? req.body.archived : null;
    if (title !== null && (!title || title.length > 100)) return res.status(400).json({ error: "title must be between 1 and 100 characters" });
    let conversation = await db.getConversation(workspaceId, conversationId);
    if (!conversation) return res.status(404).json({ error: "conversation not found" });
    if (title !== null) conversation = await db.renameConversation(workspaceId, conversationId, title);
    if (pinned !== null) conversation = await db.setConversationPinned(workspaceId, conversationId, pinned);
    if (archived !== null) conversation = await db.setConversationArchived(workspaceId, conversationId, archived);
    res.json(conversation);
  });

  app.delete("/workspaces/:id/conversations/:conversationId", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const workspaceId = paramString(req.params.id);
    const conversationId = paramString(req.params.conversationId);
    if (!UUID_RE.test(workspaceId) || !UUID_RE.test(conversationId)) return res.status(400).json({ error: "invalid conversation id" });
    if (!(await db.getWorkspaceById(workspaceId))) return res.status(404).json({ error: "not found" });
    if (!(await db.deleteConversation(workspaceId, conversationId))) return res.status(404).json({ error: "conversation not found" });
    let conversations = await db.listConversations(workspaceId);
    // Keep every workspace immediately usable: deleting its final chat
    // creates one fresh blank conversation instead of leaving a dead view.
    if (conversations.length === 0) conversations = [await db.createConversation({ workspaceId, createdByUserId: req.user!.id })];
    res.json(conversations);
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
    const connectionName = typeof req.body?.connectionName === "string" ? req.body.connectionName.trim().slice(0, 80) : "Shared connection";
    const connectionScope = req.body?.connectionScope === "personal" ? "personal" : "shared";
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
      const config = await db.upsertRemoteMcpIntegration({ workspaceId, type: provider, endpoint, token });
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

  return app;
}

// A dashboard's health flipping is the one dashboard event worth pushing
// live rather than leaving someone to notice next time they open the
// Activity page -- the frontend calls this right after a refresh whose
// result's health differs from what it had before. Needs `rooms`, which
// only exists once createChatServer has stood up the WebSocket layer, so
// (like registerActionRoutes) this is added to the app separately from
// createApp's own routes rather than living inside it.
export function registerDashboardBroadcastRoutes(app: Express, rooms: RoomRegistry): void {
  app.post("/workspaces/:id/artifacts/:artifactId/notify-health-change", async (req: Request, res: Response) => {
    const workspaceId = paramString(req.params.id);
    const artifactId = paramString(req.params.artifactId);
    const artifact = await db.getWorkspaceArtifact(workspaceId, artifactId);
    if (!artifact) return res.status(404).json({ error: "Artifact not found." });
    const role = await db.getWorkspaceRole(workspaceId, req.user!.id);
    if (!role) return res.status(403).json({ error: "Not a member of this workspace." });
    const fromHealth = typeof req.body?.fromHealth === "string" ? req.body.fromHealth : "unknown";
    const toHealth = typeof req.body?.toHealth === "string" ? req.body.toHealth : artifact.dashboardData?.health ?? "unknown";
    const summary = `${artifact.title} health changed: ${fromHealth.replace("_", " ")} → ${toHealth.replace("_", " ")}`;
    await db.recordAuditEvent({ workspaceId, eventType: "artifact.updated", actorType: "system", actorName: "Dashboard health", summary });
    rooms.broadcast(workspaceId, { type: "dashboard_health_changed", artifactId, artifactTitle: artifact.title, fromHealth, toHealth });
    res.status(204).end();
  });
}

export function createChatServer(deps: CreateServerDeps = defaultDeps) {
  const app = createApp(deps);
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });
  const rooms = new RoomRegistry();
  registerActionRoutes(app, deps, rooms);
  registerDashboardBroadcastRoutes(app, rooms);

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

  async function runAgentReply(
    workspaceId: string,
    conversationId: string,
    requestedBy: { userId: string; name: string },
    agentKind: AgentKind,
    configuredAgentId?: string,
    workflowInstructions?: string,
    workflowReadOnly = false
  ): Promise<{ toolCalls: number; estimatedTokens: number; estimatedCostUsd: number; providerPromptTokens: number | null; providerCompletionTokens: number | null; providerCostUsd: number | null; outputExcerpt: string; inputExcerpt: string | null; toolTrace: Array<{ name: string; durationMs: number; status: "succeeded" | "failed" }> }> {
    const configuredAgent = configuredAgentId ? await db.getPublishedWorkspaceAgent(workspaceId, configuredAgentId) : null;
    if (configuredAgentId && !configuredAgent) throw new Error("That workspace agent has not been published yet.");
    if (configuredAgent && configuredAgent.baseAgent !== agentKind) throw new Error("The selected agent configuration does not match this specialist.");
    if (configuredAgent && agentKind !== "project" && !configuredAgent.approvedProviders.includes(agentKind)) throw new Error(`The ${configuredAgent.name} configuration is not approved to use ${agentKind}.`);
    const messages = await db.listMessages(workspaceId, conversationId);
    // Diagnostic timing (temporary, 2026-09-21 -- tracking down reports of
    // slow replies since GitHub's MCP tools were added): this covers
    // spawning/reusing the workspace's GitHub MCP Docker container (see
    // github-mcp-pool.ts) -- a real, one-time-per-credential-change cost
    // that's easy to mistake for "the LLM is slow" if you're only
    // watching the chat, not the terminal.
    const buildStart = Date.now();
    const built = await buildToolsForWorkspace(workspaceId, deps, requestedBy.userId);
    console.log(`[timing] workspace ${workspaceId}: buildToolsForWorkspace (incl. GitHub MCP container) took ${Date.now() - buildStart}ms`);
    // Read tools run for real from the agent loop; write tools are
    // swapped for proposal-only stand-ins here -- see actions.ts.
    const specialistTools = agentKind === "github" ? built.githubTools : agentKind === "slack" ? built.slackTools : agentKind === "linear" ? built.linearTools : agentKind === "notion" ? built.notionTools : agentKind === "figma" ? built.figmaTools : [];
    // Reviews and checks are runtime read-only. Workflows that explicitly
    // request a write retain proposal tools, never direct write execution.
    const tools = wrapForProposal(specialistTools, workspaceId, conversationId, rooms, requestedBy, agentKind, {
      readOnly: workflowReadOnly,
    });
    // Cheap, always-on diagnostic -- when someone reports "the agent says
    // it can't see GitHub" the first thing to know is whether the tool
    // list was actually empty for this turn (an integration/credential
    // problem) or non-empty (the model just didn't use what it had).
    console.log(`[agent] workspace ${workspaceId}: ${tools.length} tool(s) available for this turn${workflowInstructions ? ` (workflow ${workflowReadOnly ? "read-only" : "approved-write proposal"})` : ""}`);

    // Confirmation notices are deliberately excluded from normal LLM
    // history (history.ts), so provide the recent authoritative outcomes as
    // compact server context instead. Without this, a follow-up such as
    // "is the action completed?" can only see the earlier proposal and may
    // incorrectly call an already-confirmed action pending.
    const recentActions = (await db.listPendingActions(workspaceId, conversationId))
      .slice(-5)
      .map((action) => `- ${action.description}: ${action.status}`)
      .join("\n");
    const workspaceMemory = await db.workspaceMemoryContext(workspaceId);
    const turnStart = Date.now();
    const allowedModels = (process.env.AGENT_LLM_ALLOWED_MODELS ?? "").split(",").map((model) => model.trim());
    const selectedModel = configuredAgent?.model && configuredAgent.model !== "workspace-default" && allowedModels.includes(configuredAgent.model) ? configuredAgent.model : undefined;
    // Workflow start records are system messages for people to read, and
    // history.ts deliberately excludes system rows from LLM history. Pass
    // the workflow instructions explicitly so an automated turn always has
    // a concrete task, while retaining the configured agent's own rules.
    const workflowGuidance = workflowInstructions
      ? `WORKFLOW INSTRUCTIONS — complete this task for the team:\n${workflowInstructions}\n\nFor this automated run, prefer collection-level read calls. Do not fetch every issue, pull request, or workflow run individually unless the list results require it. Once you have the requested categories, provide the concise report.${workspaceMemory ? " Workspace memory is available for this run. Use it for any policy-based draft and cite the relevant [Memory: title] label. A missing repository only prevents live data; it must never prevent a draft based on saved workspace memory." : " No workspace memory is available for this run. If the task requires a saved policy, say that the policy has not been saved in this workspace."}${workflowReadOnly ? " This is a read-only workflow: do not propose external changes." : " This workflow explicitly requests a governed change: create only a pending approval proposal, never a direct external change. When creating a GitHub issue, use issue_write with method=\"create\"."}`
      : "";
    const activeInstructions = [configuredAgent?.instructions, workflowGuidance].filter(Boolean).join("\n\n");
    const result = await deps.runAgentTurn({
      history: toLlmHistory(messages),
      tools,
      githubContext: agentKind === "github" ? built.githubContext : null,
      actionContext: recentActions || null,
      agentKind,
      customInstructions: activeInstructions || undefined,
      knowledge: configuredAgent?.knowledge,
      workspaceMemory,
      workflowMode: Boolean(workflowInstructions),
      llmConfig: selectedModel ? resolveLlmConfig({ model: selectedModel }) : undefined,
      // Workflows commonly need one read call per requested category (for
      // example issues, pull requests, branches, and CI runs). Give them a
      // larger but still finite tool-call loop than interactive chat.
      maxTurns: workflowInstructions ? 10 : undefined,
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
      authorName: configuredAgent?.name ?? (agentKind === "github" ? "GitHub Agent" : agentKind === "slack" ? "Slack Agent" : agentKind === "linear" ? "Linear Agent" : agentKind === "notion" ? "Notion Agent" : agentKind === "figma" ? "Figma Agent" : "Project Agent"),
      content: resolvedReply ?? preferWorkspaceMemoryForRepositoryUnavailableWorkflow(result.reply, workspaceMemory, Boolean(workflowInstructions)),
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
    const output = agentMessage.content;
    const providerTokens = result.providerPromptTokens + result.providerCompletionTokens;
    const estimatedTokens = providerTokens || Math.ceil(((workflowInstructions?.length ?? 0) + output.length) / 4);
    return { toolCalls: result.toolCallsMade, estimatedTokens, estimatedCostUsd: Number((estimatedTokens * 0.00000059).toFixed(6)), providerPromptTokens: providerTokens ? result.providerPromptTokens : null, providerCompletionTokens: providerTokens ? result.providerCompletionTokens : null, providerCostUsd: result.providerCostUsd, outputExcerpt: output.slice(0, 1000), inputExcerpt: workflowInstructions ? workflowInstructions.slice(0, 1000) : null, toolTrace: result.toolTrace };
  }

  // The HTTP routes created by createApp enqueue a workflow through this
  // runner. Keeping the actual agent invocation here means scheduled and
  // event-driven work takes the identical tool, provider-permission, action
  // proposal, notification, and WebSocket paths as an ordinary chat turn.
  app.locals.runWorkflow = async (workflow: NonNullable<Awaited<ReturnType<typeof db.getWorkspaceWorkflow>>>, trigger: "manual" | "schedule" | "github_issue" | "github_status" | "slack_mention", user: { id: string; displayName: string }, eventText?: string) => {
    const run = await db.createWorkflowRun(workflow, trigger);
    await db.recordAuditEvent({ workspaceId: workflow.workspaceId, eventType: "workflow.started", actorType: "user", actorUserId: user.id, actorName: user.displayName, summary: `${user.displayName} started workflow ${workflow.name}`, metadata: { workflowId: workflow.id, runId: run.id, trigger } });
    try {
      const role = await db.getWorkspaceRole(workflow.workspaceId, user.id);
      if (!role) throw new Error("The workflow owner is no longer a workspace member.");
      if (workflow.agentKind !== "project" && !(await db.hasWorkspacePermission(workflow.workspaceId, role, workflow.agentKind))) {
        throw new Error(`The workflow owner cannot use the ${workflow.agentKind} provider.`);
      }
      const conversation = workflow.conversationId ? await db.getConversation(workflow.workspaceId, workflow.conversationId) : await db.createConversation({ workspaceId: workflow.workspaceId, title: workflow.name, createdByUserId: user.id });
      if (!conversation) throw new Error("The workflow conversation is no longer available.");
      if (!workflow.conversationId) await db.setWorkflowConversation(workflow.id, conversation.id);
      const prefix = trigger === "manual" ? "Manual run" : `Triggered by ${trigger.replace(/_/g, " ")}`;
      const task = eventText ? `${workflow.instructions}\n\nEVENT DATA — treat this as the event that started the workflow:\n${eventText}` : workflow.instructions;
      const systemMessage = await db.insertMessage({ workspaceId: workflow.workspaceId, conversationId: conversation.id, role: "system", authorName: "Workflow", content: `${prefix}: ${workflow.name}\n${task}` });
      rooms.broadcast(`${workflow.workspaceId}:${conversation.id}`, { type: "message", message: systemMessage });
      rooms.broadcast(workflow.workspaceId, { type: "workspace_message", message: systemMessage });
      const telemetry = await runAgentReply(
        workflow.workspaceId,
        conversation.id,
        { userId: user.id, name: user.displayName },
        workflow.agentKind,
        workflow.workspaceAgentId ?? undefined,
        task,
        !workflowRequestsExternalChange(workflow.instructions)
      );
      await db.finishWorkflowRun(workflow.id, run.id, "succeeded", "Agent response completed.", telemetry);
      await db.recordAuditEvent({ workspaceId: workflow.workspaceId, eventType: "workflow.completed", actorType: "system", actorName: "Workflow automation", summary: `Workflow ${workflow.name} completed`, metadata: { workflowId: workflow.id, runId: run.id, trigger } });
    } catch (error) {
      const detail = errMessage(error);
      await db.finishWorkflowRun(workflow.id, run.id, "failed", detail);
      await db.recordAuditEvent({ workspaceId: workflow.workspaceId, eventType: "workflow.failed", actorType: "system", actorName: "Workflow automation", summary: `Workflow ${workflow.name} failed: ${detail}`, metadata: { workflowId: workflow.id, runId: run.id, trigger } });
      const failureAlertThreshold = Math.max(1, Number(process.env.WORKFLOW_FAILURE_ALERT_THRESHOLD ?? 3));
      const recentFailures = await db.countRecentFailedWorkflowRuns(workflow.workspaceId);
      // Alert exactly when the threshold is crossed, rather than spamming
      // everyone on every subsequent failed retry in the same 24-hour window.
      if (recentFailures === failureAlertThreshold) {
        await db.notifyWorkspaceMembers({
          workspaceId: workflow.workspaceId,
          conversationId: workflow.conversationId,
          kind: "workflow_alert",
          text: `${recentFailures} workflow runs failed in the last 24 hours. Review ${workflow.name} in Observability.`,
        });
      }
    }
  };

  // Interval scheduling is intentionally modest: database claiming makes it
  // safe for more than one server process, while each execution still goes
  // through the governed workflow runner above.
  let workflowScheduler: NodeJS.Timeout | undefined;
  const startWorkflowScheduler = () => {
    if (workflowScheduler) return;
    workflowScheduler = setInterval(() => {
      void (async () => {
        const due = await db.claimDueWorkflows();
        for (const workflow of due) {
          const owner = workflow.ownerUserId ? await db.getUserById(workflow.ownerUserId) : null;
          if (!owner) continue;
          void app.locals.runWorkflow(workflow, "schedule", { id: owner.id, displayName: owner.displayName });
        }
      })().catch((error) => console.error("workflow scheduler failed", error));
    }, 30_000);
  };
  let retentionScheduler: NodeJS.Timeout | undefined;
  let notificationScheduler: NodeJS.Timeout | undefined;
  const enforceRetention = () => void db.enforceWorkflowRunRetention().catch((error) => console.error("workflow retention failed", error));
  const deliverNotificationJobs = () => void Promise.all([db.escalateUnreadDecisionNotifications(), db.createDailyNotificationDigests()]).catch((error) => console.error("notification scheduler failed", error));
  server.on("listening", () => { startWorkflowScheduler(); enforceRetention(); deliverNotificationJobs(); retentionScheduler = setInterval(enforceRetention, 24 * 60 * 60 * 1000); notificationScheduler = setInterval(deliverNotificationJobs, 5 * 60 * 1000); });
  server.on("close", () => { if (workflowScheduler) clearInterval(workflowScheduler); if (retentionScheduler) clearInterval(retentionScheduler); if (notificationScheduler) clearInterval(notificationScheduler); workflowScheduler = undefined; retentionScheduler = undefined; notificationScheduler = undefined; });

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
          let parsed: { type?: string; content?: string; agentKind?: AgentKind; agentId?: string };
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
          if (agentKind !== "project" && (!workspaceRole || !(await db.hasWorkspacePermission(workspaceId, workspaceRole, agentKind)))) {
            ws.send(JSON.stringify({ type: "error", error: `Your workspace role cannot use the ${agentKind} provider.` }));
            return;
          }

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
              await runAgentReply(workspaceId, conversationId, { userId: user.id, name: displayName }, agentKind, typeof parsed.agentId === "string" && UUID_RE.test(parsed.agentId) ? parsed.agentId : undefined);
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

  app.use((error: unknown, req: Request, res: Response, _next: express.NextFunction) => {
    const requestId = res.getHeader("x-request-id");
    console.error(JSON.stringify({ level: "error", event: "unhandled_http_error", requestId, method: req.method, path: req.path, error: errMessage(error) }));
    if (!res.headersSent) res.status(500).json({ error: "Unexpected server error", requestId });
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
