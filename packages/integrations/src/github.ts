import { Octokit } from "@octokit/rest";
import type { GithubIssueSummary, GithubRepoSummary } from "@mai-chat/shared-types";

// This file used to be the full GitHub tool surface for the agent (~49
// methods wrapped by services/chat-server/src/tools.ts's buildGithubTools).
// That's been replaced by GitHub's own official MCP server
// (github/github-mcp-server, run locally via Docker -- see
// services/chat-server/src/github-mcp-pool.ts and mcp-tools.ts, and
// README.md's "GitHub tools via MCP server" section) so the agent's tool
// coverage tracks GitHub's own maintained server instead of a hand-rolled
// Octokit wrapper. What's left here is only what the MCP server can't do
// for us:
//
//  - GithubClient / createGithubClient: a minimal, single-purpose client
//    used ONLY to verify a pasted token/owner/repo actually works before
//    saving it (services/chat-server/src/server.ts's POST
//    /integrations/github and /integrations/github/repo routes call
//    `.listIssues("open", 1)` and treat a thrown error as "invalid").
//    Kept as a small real Octokit call (not the MCP server) so that
//    verification doesn't depend on Docker/the GitHub MCP server being
//    configured at all -- connecting an integration and being able to
//    chat with the agent about it are two different capabilities now.
//  - listRepositoriesForToken: account-scoped (not yet tied to one
//    owner/repo), used by github-oauth.ts's repo-picker step right after
//    a GitHub OAuth login. Unrelated to the agent's tool surface.

export interface GithubClientOptions {
  token: string;
  owner: string;
  repo: string;
  // Injectable so tests can intercept the real network call (the one
  // non-deterministic/external part) without mocking this client's own
  // request-shaping/response-parsing logic.
  fetch?: typeof fetch;
}

export interface GithubClient {
  listIssues(state?: "open" | "closed" | "all", limit?: number): Promise<GithubIssueSummary[]>;
}

interface RawIssue {
  number: number;
  title: string;
  state: string;
  user: { login: string } | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  labels: (string | { name?: string })[];
  pull_request?: unknown;
}

function toIssueSummary(issue: RawIssue): GithubIssueSummary {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    author: issue.user?.login ?? "unknown",
    url: issue.html_url,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    labels: issue.labels.map((l) => (typeof l === "string" ? l : l.name ?? "")).filter(Boolean),
  };
}

export function createGithubClient(opts: GithubClientOptions): GithubClient {
  const octokit = new Octokit({
    auth: opts.token,
    ...(opts.fetch ? { request: { fetch: opts.fetch } } : {}),
  });
  const { owner, repo } = opts;

  return {
    async listIssues(state = "open", limit = 20) {
      const { data } = await octokit.issues.listForRepo({ owner, repo, state, per_page: limit });
      // The GitHub REST API returns PRs from this same endpoint (they're
      // "issues" internally); filter them out, matching this method's
      // original behavior back when it was also used as a real tool.
      return (data as unknown as RawIssue[]).filter((i) => !i.pull_request).map(toIssueSummary);
    },
  };
}

interface RawRepo {
  name: string;
  full_name: string;
  private: boolean;
  description: string | null;
  updated_at: string;
  html_url: string;
  owner: { login: string } | null;
}

function toRepoSummary(repo: RawRepo): GithubRepoSummary {
  return {
    owner: repo.owner?.login ?? repo.full_name.split("/")[0] ?? "",
    name: repo.name,
    fullName: repo.full_name,
    private: repo.private,
    description: repo.description,
    updatedAt: repo.updated_at,
    htmlUrl: repo.html_url,
  };
}

// Lists repos the *account behind this token* can access -- used for the
// repo-picker step right after a GitHub OAuth login (there's no owner/repo
// yet at that point, unlike GithubClient above which always operates on
// one already-chosen repo). Deliberately a standalone function rather than
// a GithubClient method: it's account-scoped, not repo-scoped.
export async function listRepositoriesForToken(
  token: string,
  opts?: { fetch?: typeof fetch; perPage?: number }
): Promise<GithubRepoSummary[]> {
  const octokit = new Octokit({
    auth: token,
    ...(opts?.fetch ? { request: { fetch: opts.fetch } } : {}),
  });
  const { data } = await octokit.repos.listForAuthenticatedUser({
    per_page: opts?.perPage ?? 100,
    sort: "updated",
  });
  return (data as unknown as RawRepo[]).map(toRepoSummary);
}
