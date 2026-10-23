// How several members share GitHub in one workspace:
//  - each member works in exactly one repository at a time: the one they
//    chose for their own GitHub connection (Integrations -> GitHub);
//  - the agent reaches it only through that member's own account, and a
//    request aimed at any other repository is refused, never swapped out;
//  - every proposed change records what it targets, so duplicates and
//    conflicts with teammates' work can be flagged before approval;
//  - GitHub webhook deliveries from members' repositories become activity,
//    live updates and workflow triggers.
import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import * as db from "@mai-chat/db";
import type { ActionTarget, ActionWarning, IntegrationType, PendingAction, TeamActivity } from "@mai-chat/shared-types";
import type { ToolExecutor } from "./tools.js";
import type { RepoAccess } from "./github-api.js";

export const GITHUB_WEBHOOK_EVENTS = ["issues", "issue_comment", "pull_request", "pull_request_review", "push", "workflow_run", "status", "release"];

// -- The member's repository ------------------------------------------------

/** What the GitHub agent is told about the repository and the account it acts as. */
export interface GithubWorkspaceContext {
  // The one repository this member works in.
  owner: string;
  repo: string;
  // What the member's account can do there.
  access: RepoAccess;
  // GitHub username the tools act as, when known.
  account: string | null;
  actingAs: string;
  teamActivity?: string | null;
}

const sameRepo = (a: { owner: string; repo: string }, b: { owner: string; repo: string }) =>
  a.owner.toLowerCase() === b.owner.toLowerCase() && a.repo.toLowerCase() === b.repo.toLowerCase();

// Search qualifiers that would widen a search beyond one repository.
const SCOPE_QUALIFIER = /(^|\s)-?(repo|org|user|owner):\S+/gi;

/** Limits a GitHub search query to one repository, whatever it asked for. */
export function scopeQueryToRepo(query: string, owner: string, repo: string): string {
  const rest = query.replace(SCOPE_QUALIFIER, " ").replace(/\s+/g, " ").trim();
  return `${rest} repo:${owner}/${repo}`.trim();
}

/**
 * Wraps GitHub tools so every call stays in the member's one repository and
 * respects what their account can do there. A call naming another
 * repository is refused; a search is limited to the repository. The error
 * text goes back to the model, which tells the member what to do.
 */
export function guardGithubTools(tools: ToolExecutor[], context: GithubWorkspaceContext, onRepoUsed?: (fullName: string) => void): ToolExecutor[] {
  const fullName = `${context.owner}/${context.repo}`;
  const who = context.account ? `@${context.account}` : `${context.actingAs}'s account`;
  // Returns the arguments to call with (a search is limited to the
  // repository), or throws with what the member can do instead.
  const check = (args: Record<string, unknown>, mutates: boolean): { callArgs: Record<string, unknown>; touchesRepo: boolean } => {
    const owner = typeof args.owner === "string" ? args.owner.trim() : "";
    const repo = typeof args.repo === "string" ? args.repo.trim() : "";
    let callArgs = args;
    if (owner || repo) {
      if (!sameRepo({ owner, repo }, context)) {
        throw new Error(
          `You're working in ${fullName}, so ${owner || "?"}/${repo || "?"} can't be used. To work in a different repository, change your repository under Integrations → GitHub.`
        );
      }
    } else if (typeof args.query === "string") {
      callArgs = { ...args, query: scopeQueryToRepo(args.query, context.owner, context.repo) };
    }
    const touchesRepo = Boolean(owner || repo || typeof args.query === "string");
    if (touchesRepo && context.access === "none") {
      throw new Error(`Your GitHub account (${who}) can't access ${fullName}. Ask a repository admin to give it access, or reconnect GitHub with an account that has access.`);
    }
    if (touchesRepo && context.access === "read" && mutates) {
      throw new Error(`Your GitHub account (${who}) can read ${fullName} but cannot make changes there.`);
    }
    return { callArgs, touchesRepo };
  };
  return tools.map((tool) => ({
    ...tool,
    validate: (args: Record<string, unknown>) => {
      check(args, Boolean(tool.mutates));
    },
    execute: async (args: Record<string, unknown>) => {
      const { callArgs, touchesRepo } = check(args, Boolean(tool.mutates));
      if (touchesRepo) onRepoUsed?.(fullName);
      return tool.execute(callArgs);
    },
  }));
}

// -- Action targets and duplicate detection ---------------------------------

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const number = (value: unknown): number | null => {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};
const normalizeTitle = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();
const shortHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);

export function providerForTool(toolName: string, agentKind?: PendingAction["agentKind"]): IntegrationType {
  if (agentKind && agentKind !== "project") return agentKind;
  if (toolName.startsWith("slack_")) return "slack";
  if (toolName.startsWith("notion_")) return "notion";
  if (toolName.startsWith("figma_")) return "figma";
  if (toolName.startsWith("linear_") || ["save_issue", "save_comment"].includes(toolName)) return "linear";
  return "github";
}

/** What a write action changes, in a form two actions can be compared by. */
export function describeActionTarget(toolName: string, args: Record<string, unknown>, agentKind?: PendingAction["agentKind"]): ActionTarget {
  const provider = providerForTool(toolName, agentKind);
  if (provider === "github") {
    const owner = text(args.owner);
    const repo = text(args.repo);
    const full = owner && repo ? `${owner}/${repo}` : null;
    const where = full ? ` in ${full}` : "";
    const base = `github:${(full ?? "unknown").toLowerCase()}`;
    const issueNumber = number(args.issue_number) ?? number(args.issueNumber);
    const pullNumber = number(args.pullNumber) ?? number(args.pull_number);
    const method = text(args.method)?.toLowerCase();
    const title = text(args.title);
    if ((toolName === "issue_write" && method === "create") || toolName === "create_issue") {
      return { provider, kind: "new_issue", repo: full ?? undefined, title: title ?? undefined, key: `${base}:new-issue:${normalizeTitle(title ?? "")}`, label: `new issue “${title ?? "untitled"}”${where}` };
    }
    if (toolName === "create_pull_request") {
      const head = text(args.head) ?? "?";
      const baseBranch = text(args.base) ?? "default branch";
      return { provider, kind: "new_pull_request", repo: full ?? undefined, title: title ?? undefined, branch: head, key: `${base}:new-pr:${head.toLowerCase()}->${baseBranch.toLowerCase()}`, label: `pull request from ${head} into ${baseBranch}${where}` };
    }
    const itemNumber = issueNumber ?? pullNumber;
    if (itemNumber) {
      const kind = toolName === "add_issue_comment" ? "comment" : /merge/.test(toolName) ? "merge" : pullNumber ? "pull_request_update" : "issue_update";
      return { provider, kind, repo: full ?? undefined, number: itemNumber, key: `${base}#${itemNumber}`, label: `#${itemNumber}${where}` };
    }
    const path = text(args.path);
    if (path) {
      const branch = text(args.branch) ?? "default branch";
      return { provider, kind: "file", repo: full ?? undefined, path, branch, key: `${base}:file:${branch.toLowerCase()}:${path}`, label: `${path} on ${branch}${where}` };
    }
    const branch = text(args.branch);
    if (toolName === "create_branch" && branch) {
      return { provider, kind: "branch", repo: full ?? undefined, branch, key: `${base}:branch:${branch.toLowerCase()}`, label: `branch ${branch}${where}` };
    }
    return { provider, kind: toolName, repo: full ?? undefined, key: `${base}:${toolName}:${shortHash(args)}`, label: full ?? "GitHub" };
  }
  if (provider === "slack") {
    const channel = text(args.channel_id) ?? text(args.channel) ?? "unknown";
    const message = text(args.message) ?? text(args.text) ?? "";
    return { provider, kind: "message", channel, key: `slack:${channel.toLowerCase()}:${shortHash(normalizeTitle(message))}`, label: `#${channel.replace(/^#/, "")}` };
  }
  if (provider === "linear") {
    const id = text(args.id) ?? text(args.issueId) ?? text(args.issue_id);
    const title = text(args.title);
    if (toolName === "save_issue" && !id) {
      return { provider, kind: "new_issue", title: title ?? undefined, key: `linear:new-issue:${normalizeTitle(title ?? "")}`, label: `new Linear issue “${title ?? "untitled"}”` };
    }
    if (id) return { provider, kind: toolName === "save_comment" ? "comment" : "issue_update", key: `linear:issue:${id.toLowerCase()}`, label: `Linear issue ${id}` };
    return { provider, kind: toolName, key: `linear:${toolName}:${shortHash(args)}`, label: "Linear" };
  }
  if (provider === "notion") {
    const page = text(args.page_id);
    if (page) return { provider, kind: toolName === "notion_append_text" ? "append" : "page_update", key: `notion:page:${page.replace(/-/g, "").toLowerCase()}`, label: "Notion page" };
    return { provider, kind: toolName, key: `notion:${toolName}:${shortHash(args)}`, label: "Notion" };
  }
  const file = text(args.file);
  return { provider, kind: toolName, key: `${provider}:${(file ?? toolName).toLowerCase()}:${text(args.node_id) ?? ""}:${shortHash(args.message ?? args)}`, label: file ? "Figma file" : provider };
}

const STOP_WORDS = new Set(["the", "and", "for", "with", "when", "from", "that", "this", "into", "not", "are", "was", "but", "fix", "issue", "bug", "add", "new"]);
function titleWords(title: string): Set<string> {
  return new Set((title.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((word) => word.length >= 3 && !STOP_WORDS.has(word)));
}

/** 0..1 overlap of the meaningful words in two titles. */
export function titleSimilarity(a: string, b: string): number {
  const left = titleWords(a);
  const right = titleWords(b);
  if (!left.size || !right.size) return normalizeTitle(a) === normalizeTitle(b) && a.trim() ? 1 : 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  const jaccard = shared / (left.size + right.size - shared);
  const containment = shared / Math.min(left.size, right.size);
  return Math.max(jaccard, containment >= 1 && Math.min(left.size, right.size) >= 2 ? 0.8 : 0);
}

const SIMILAR = 0.5;

function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "recently";
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

function verbFor(target: ActionTarget): string {
  switch (target.kind) {
    case "comment": return `comment on ${target.label}`;
    case "merge": return `merge of ${target.label}`;
    case "issue_update":
    case "pull_request_update": return `change to ${target.label}`;
    case "new_issue": return target.label;
    case "new_pull_request": return target.label;
    case "file": return `change to ${target.label}`;
    case "branch": return target.label;
    case "message": return `message to ${target.label}`;
    default: return `change to ${target.label}`;
  }
}

/**
 * Warnings for a new proposal: the same target already waiting for approval
 * or changed in the last day, and (for new issues) similar titles waiting or
 * already open.
 */
export function findActionWarnings(input: {
  target: ActionTarget;
  toolName: string;
  requestedByUserId?: string | null;
  existing: Array<PendingAction & { conversationTitle?: string | null }>;
  openIssues?: Array<{ number: number; title: string; url: string }>;
  now?: number;
}): ActionWarning[] {
  const warnings: ActionWarning[] = [];
  const who = (action: PendingAction) =>
    action.requestedByUserId && action.requestedByUserId === input.requestedByUserId ? "You" : action.requestedByName ?? "A teammate";
  const where = (action: PendingAction & { conversationTitle?: string | null }) => (action.conversationTitle ? ` (conversation “${action.conversationTitle}”)` : "");
  for (const action of input.existing) {
    if (!action.target) continue;
    const sameTarget = action.target.key === input.target.key;
    if (action.status === "pending" && sameTarget) {
      warnings.push({ kind: "pending_duplicate", actionId: action.id, message: `${who(action)} already ${who(action) === "You" ? "have" : "has"} a waiting ${verbFor(action.target)}${where(action)}.` });
    } else if (action.status === "confirmed" && sameTarget && action.toolName === input.toolName) {
      const actor = who(action) === "You" ? "Your agent" : `${who(action)}'s agent`;
      warnings.push({ kind: "recent_duplicate", actionId: action.id, message: `${actor} already made a ${verbFor(action.target)} ${ago(action.resolvedAt, input.now)}.` });
    } else if (
      action.status === "pending" &&
      input.target.kind === "new_issue" &&
      action.target.kind === "new_issue" &&
      action.target.provider === input.target.provider &&
      (action.target.repo ?? "").toLowerCase() === (input.target.repo ?? "").toLowerCase() &&
      input.target.title &&
      action.target.title &&
      titleSimilarity(input.target.title, action.target.title) >= SIMILAR
    ) {
      warnings.push({ kind: "similar_pending", actionId: action.id, message: `${who(action)} already ${who(action) === "You" ? "have" : "has"} a similar ${action.target.label} waiting for approval${where(action)}.` });
    }
  }
  if (input.target.kind === "new_issue" && input.target.title) {
    const similar = (input.openIssues ?? [])
      .map((issue) => ({ issue, score: titleSimilarity(input.target.title ?? "", issue.title) }))
      .filter((entry) => entry.score >= SIMILAR)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2);
    for (const { issue } of similar) {
      warnings.push({ kind: "similar_issue", url: issue.url, message: `Similar open issue #${issue.number} “${issue.title}” already exists${input.target.repo ? ` in ${input.target.repo}` : ""}.` });
    }
  }
  // One warning per underlying action/issue.
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = warning.actionId ?? warning.url ?? warning.message;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// -- Webhooks ---------------------------------------------------------------

/** Constant-time check of GitHub's X-Hub-Signature-256 header. */
export function verifyGithubSignature(secret: string, rawBody: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`);
  const received = Buffer.from(header);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

export interface GithubEventSummary {
  repo: string;
  actor: string;
  summary: string;
  url: string | null;
  // The workflow trigger this event starts, if any.
  trigger: "github_issue" | "github_status" | null;
  // Passed to a triggered workflow as its event data.
  eventText: string;
  // Ignored events are acknowledged but not recorded.
  ignore: boolean;
}

type Payload = Record<string, any>;

/** Turns a webhook payload into one readable line, plus the trigger it fires. */
export function summarizeGithubEvent(event: string, payload: Payload): GithubEventSummary {
  const repo: string = payload.repository?.full_name ?? "unknown repository";
  const actor: string = payload.sender?.login ?? "someone";
  const result = (summary: string, url: string | null, trigger: GithubEventSummary["trigger"] = null, ignore = false, detail = ""): GithubEventSummary => ({
    repo,
    actor,
    summary,
    url,
    trigger,
    ignore,
    eventText: `${summary}${url ? `\n${url}` : ""}${detail ? `\n\n${detail.slice(0, 1500)}` : ""}`,
  });
  const action: string = payload.action ?? "";
  if (event === "ping") return result(`GitHub webhook connected for ${repo}`, null, null, false);
  if (event === "issues") {
    const issue = payload.issue ?? {};
    const interesting = ["opened", "closed", "reopened", "assigned", "labeled"].includes(action);
    const extra = action === "assigned" && payload.assignee?.login ? ` to @${payload.assignee.login}` : action === "labeled" && payload.label?.name ? ` “${payload.label.name}”` : "";
    return result(`@${actor} ${action} issue #${issue.number} “${issue.title}”${extra} in ${repo}`, issue.html_url ?? null, action === "opened" ? "github_issue" : null, !interesting, action === "opened" ? String(issue.body ?? "") : "");
  }
  if (event === "issue_comment") {
    const issue = payload.issue ?? {};
    const kind = issue.pull_request ? "pull request" : "issue";
    return result(`@${actor} commented on ${kind} #${issue.number} “${issue.title}” in ${repo}`, payload.comment?.html_url ?? issue.html_url ?? null, null, action !== "created");
  }
  if (event === "pull_request") {
    const pr = payload.pull_request ?? {};
    const verb = action === "closed" ? (pr.merged ? "merged" : "closed") : action === "ready_for_review" ? "marked ready for review" : action;
    return result(`@${actor} ${verb} pull request #${pr.number} “${pr.title}” in ${repo}`, pr.html_url ?? null, null, !["opened", "closed", "reopened", "ready_for_review"].includes(action));
  }
  if (event === "pull_request_review") {
    const pr = payload.pull_request ?? {};
    const state = String(payload.review?.state ?? "").toLowerCase().replace(/_/g, " ");
    return result(`@${actor} reviewed pull request #${pr.number} (${state || "commented"}) in ${repo}`, payload.review?.html_url ?? pr.html_url ?? null, null, action !== "submitted");
  }
  if (event === "push") {
    const branch = String(payload.ref ?? "").replace(/^refs\/heads\//, "");
    const count = Array.isArray(payload.commits) ? payload.commits.length : 0;
    return result(`@${actor} pushed ${count} commit${count === 1 ? "" : "s"} to ${branch} in ${repo}`, payload.compare ?? null, null, count === 0 || !String(payload.ref ?? "").startsWith("refs/heads/"));
  }
  if (event === "workflow_run") {
    const run = payload.workflow_run ?? {};
    const conclusion = String(run.conclusion ?? "").replace(/_/g, " ");
    return result(
      `CI “${run.name ?? "workflow"}” ${conclusion || "finished"} on ${run.head_branch ?? "a branch"} in ${repo}`,
      run.html_url ?? null,
      action === "completed" ? "github_status" : null,
      action !== "completed",
      `Workflow: ${run.name ?? ""}\nBranch: ${run.head_branch ?? ""}\nConclusion: ${run.conclusion ?? ""}\nCommit: ${run.head_sha ?? ""}`
    );
  }
  if (event === "status") {
    const state = String(payload.state ?? "");
    return result(`Status “${payload.context ?? "check"}” is ${state} for ${String(payload.sha ?? "").slice(0, 7)} in ${repo}`, payload.target_url ?? null, state === "pending" ? null : "github_status", state === "pending", String(payload.description ?? ""));
  }
  if (event === "release") {
    const release = payload.release ?? {};
    return result(`@${actor} published release ${release.tag_name ?? release.name ?? ""} in ${repo}`, release.html_url ?? null, null, action !== "published");
  }
  return result(`GitHub ${event} event in ${repo}`, null, null, true);
}

// -- Team activity ----------------------------------------------------------

/** Recent changes made through Nexus and events from GitHub, newest first. */
export async function listTeamActivity(workspaceId: string, options: { hours?: number; limit?: number } = {}): Promise<TeamActivity[]> {
  const hours = options.hours ?? 24;
  const since = Date.now() - hours * 3_600_000;
  const [confirmed, github] = await Promise.all([
    db.listAuditEvents(workspaceId, { eventType: "action.confirmed", limit: 50 }),
    db.listAuditEvents(workspaceId, { eventType: "github.event", limit: 50 }),
  ]);
  return [...confirmed, ...github]
    .filter((event) => Date.parse(event.createdAt) >= since)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, options.limit ?? 20)
    .map((event) => ({
      id: event.id,
      source: event.eventType === "github.event" ? "github" : "nexus",
      actorName: event.actorName,
      summary: typeof event.metadata.activity === "string" ? event.metadata.activity : event.summary,
      repo: typeof event.metadata.repo === "string" ? event.metadata.repo : null,
      url: typeof event.metadata.url === "string" ? event.metadata.url : null,
      createdAt: event.createdAt,
    }));
}

/** Compact, trusted context for the GitHub agent about what teammates did recently. */
export function formatTeamActivity(activity: TeamActivity[], now = Date.now()): string | null {
  if (!activity.length) return null;
  return activity
    .slice(0, 8)
    .map((item) => `- ${item.summary} (${ago(item.createdAt, now)})`)
    .join("\n");
}
