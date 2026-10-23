// Small GitHub REST helpers used by the team features: account login,
// repository access, open issues (duplicate checks) and repository
// webhooks. Injectable through CreateServerDeps.githubTeamApi so tests never
// reach github.com.
import { createHash } from "node:crypto";

export type RepoAccess = "write" | "read" | "none" | "unknown";

export interface GithubTeamApi {
  /** The GitHub username behind a token. */
  getLogin(token: string): Promise<string | null>;
  /** What the token's account can do on a repository. "unknown" when GitHub could not be asked. */
  getRepoAccess(token: string, owner: string, repo: string): Promise<RepoAccess>;
  listOpenIssues(token: string, owner: string, repo: string): Promise<Array<{ number: number; title: string; url: string }>>;
  createRepoWebhook(token: string, owner: string, repo: string, input: { url: string; secret: string; events: string[] }): Promise<{ id: number }>;
}

const API = "https://api.github.com";

/** An API that never calls GitHub: access is "unknown" and there is no login. Used when none is injected (tests). */
export const offlineGithubTeamApi: GithubTeamApi = {
  getLogin: async () => null,
  getRepoAccess: async () => "unknown",
  listOpenIssues: async () => [],
  createRepoWebhook: async () => {
    throw new Error("GitHub is not reachable from this server.");
  },
};

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 24);
}

async function githubRequest(path: string, init: RequestInit & { token?: string; timeoutMs?: number } = {}, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "nexus-multiplayer-ai",
    ...(init.body ? { "content-type": "application/json" } : {}),
  };
  if (init.token) headers.authorization = `token ${init.token}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 8000);
  try {
    return await fetchImpl(`${API}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) }, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function errorText(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as { message?: string; errors?: Array<{ message?: string }> };
  const detail = body.errors?.map((error) => error.message).filter(Boolean).join("; ");
  return [body.message, detail].filter(Boolean).join(": ") || `GitHub returned ${response.status}`;
}

export function createGithubTeamApi(fetchImpl: typeof fetch = fetch): GithubTeamApi {
  const accessCache = new Map<string, { value: RepoAccess; expiresAt: number }>();
  const loginCache = new Map<string, { value: string | null; expiresAt: number }>();
  const ACCESS_TTL_MS = 10 * 60_000;

  return {
    async getLogin(token) {
      const key = tokenFingerprint(token);
      const cached = loginCache.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.value;
      try {
        const response = await githubRequest("/user", { token }, fetchImpl);
        const login = response.ok ? (((await response.json()) as { login?: string }).login ?? null) : null;
        loginCache.set(key, { value: login, expiresAt: Date.now() + 60 * 60_000 });
        return login;
      } catch {
        return null;
      }
    },
    async getRepoAccess(token, owner, repo) {
      const key = `${tokenFingerprint(token)}:${owner}/${repo}`.toLowerCase();
      const cached = accessCache.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.value;
      let value: RepoAccess;
      try {
        const response = await githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, { token }, fetchImpl);
        if (response.status === 404 || response.status === 403) value = "none";
        else if (!response.ok) value = "unknown";
        else {
          const permissions = ((await response.json()) as { permissions?: { push?: boolean; admin?: boolean; maintain?: boolean; pull?: boolean } }).permissions;
          value = !permissions ? "unknown" : permissions.push || permissions.admin || permissions.maintain ? "write" : permissions.pull ? "read" : "none";
        }
      } catch {
        value = "unknown";
      }
      // Do not remember transient failures for long.
      accessCache.set(key, { value, expiresAt: Date.now() + (value === "unknown" ? 30_000 : ACCESS_TTL_MS) });
      return value;
    },
    async listOpenIssues(token, owner, repo) {
      const response = await githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=open&per_page=100`, { token, timeoutMs: 5000 }, fetchImpl);
      if (!response.ok) return [];
      const issues = (await response.json()) as Array<{ number: number; title: string; html_url: string; pull_request?: unknown }>;
      return issues.filter((issue) => !issue.pull_request).map((issue) => ({ number: issue.number, title: issue.title, url: issue.html_url }));
    },
    async createRepoWebhook(token, owner, repo, input) {
      const response = await githubRequest(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks`,
        { method: "POST", token, body: JSON.stringify({ name: "web", active: true, events: input.events, config: { url: input.url, content_type: "json", secret: input.secret, insecure_ssl: "0" } }) },
        fetchImpl
      );
      if (response.status === 404 || response.status === 403) {
        throw new Error(`Your GitHub account needs admin access to ${owner}/${repo} to add a webhook. Ask a repository admin to add it with the URL and secret shown here.`);
      }
      if (!response.ok) {
        const message = await errorText(response);
        if (/already exists/i.test(message)) throw new Error(`A webhook with this URL already exists on ${owner}/${repo}. Update its secret to the one shown here, or delete it and try again.`);
        throw new Error(`GitHub refused the webhook: ${message}`);
      }
      return { id: Number(((await response.json()) as { id: number }).id) };
    },
  };
}
