// Small GitHub REST helpers used by the team features: account login,
// repository access, open issues (duplicate checks), repository webhooks,
// and the optional workspace GitHub App. Injectable through
// CreateServerDeps.githubTeamApi so tests never reach github.com.
import { createHash, createSign } from "node:crypto";

export type RepoAccess = "write" | "read" | "none" | "unknown";

export interface GithubTeamApi {
  /** The GitHub username behind a token. */
  getLogin(token: string): Promise<string | null>;
  /** What the token's account can do on a repository. "unknown" when GitHub could not be asked. */
  getRepoAccess(token: string, owner: string, repo: string): Promise<RepoAccess>;
  listOpenIssues(token: string, owner: string, repo: string): Promise<Array<{ number: number; title: string; url: string }>>;
  createRepoWebhook(token: string, owner: string, repo: string, input: { url: string; secret: string; events: string[] }): Promise<{ id: number }>;
  app: GithubAppApi;
}

export interface GithubAppApi {
  configured(): boolean;
  installUrl(): string | null;
  /** Secret GitHub signs App webhook deliveries with. */
  webhookSecret(): string | null;
  isInstalled(owner: string, repo: string): Promise<boolean>;
  /** A short-lived installation token for one repository, or null when the App is not installed there. */
  installationToken(owner: string, repo: string): Promise<string | null>;
  /** The App's bot account name, e.g. "nexus-app[bot]". */
  botLogin(): string;
}

const API = "https://api.github.com";

/** An API that never calls GitHub: access is "unknown", no login, no App. Used when none is injected (tests). */
export const offlineGithubTeamApi: GithubTeamApi = {
  getLogin: async () => null,
  getRepoAccess: async () => "unknown",
  listOpenIssues: async () => [],
  createRepoWebhook: async () => {
    throw new Error("GitHub is not reachable from this server.");
  },
  app: {
    configured: () => false,
    installUrl: () => null,
    webhookSecret: () => null,
    isInstalled: async () => false,
    installationToken: async () => null,
    botLogin: () => "nexus[bot]",
  },
};

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 24);
}

async function githubRequest(path: string, init: RequestInit & { token?: string; bearer?: string; timeoutMs?: number } = {}, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "nexus-multiplayer-ai",
    ...(init.body ? { "content-type": "application/json" } : {}),
  };
  if (init.token) headers.authorization = `token ${init.token}`;
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
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

function normalizePrivateKey(raw: string | undefined, base64: string | undefined): string | null {
  if (base64) return Buffer.from(base64, "base64").toString("utf8");
  if (!raw) return null;
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

/** RS256 JWT that authenticates as the GitHub App itself (valid for 9 minutes). */
export function githubAppJwt(appId: string, privateKey: string, now = Date.now()): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const issuedAt = Math.floor(now / 1000) - 60;
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: issuedAt, exp: issuedAt + 540, iss: appId })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey).toString("base64url");
  return `${unsigned}.${signature}`;
}

export function createGithubTeamApi(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): GithubTeamApi {
  const accessCache = new Map<string, { value: RepoAccess; expiresAt: number }>();
  const loginCache = new Map<string, { value: string | null; expiresAt: number }>();
  const ACCESS_TTL_MS = 10 * 60_000;

  const appId = env.GITHUB_APP_ID?.trim() || "";
  const appSlug = env.GITHUB_APP_SLUG?.trim() || "";
  const privateKey = normalizePrivateKey(env.GITHUB_APP_PRIVATE_KEY, env.GITHUB_APP_PRIVATE_KEY_BASE64);
  const appWebhookSecret = env.GITHUB_APP_WEBHOOK_SECRET?.trim() || null;
  const installationCache = new Map<string, { id: number | null; expiresAt: number }>();
  const tokenCache = new Map<number, { token: string; expiresAt: number }>();

  async function installationId(owner: string, repo: string): Promise<number | null> {
    if (!appId || !privateKey) return null;
    const key = `${owner}/${repo}`.toLowerCase();
    const cached = installationCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.id;
    const response = await githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`, { bearer: githubAppJwt(appId, privateKey) }, fetchImpl);
    let id: number | null = null;
    if (response.ok) id = Number(((await response.json()) as { id?: number }).id) || null;
    else if (response.status !== 404) throw new Error(`Could not check the GitHub App installation: ${await errorText(response)}`);
    installationCache.set(key, { id, expiresAt: Date.now() + (id ? 30 * 60_000 : 2 * 60_000) });
    return id;
  }

  const app: GithubAppApi = {
    configured: () => Boolean(appId && privateKey),
    installUrl: () => (appSlug ? `https://github.com/apps/${appSlug}/installations/new` : null),
    webhookSecret: () => appWebhookSecret,
    botLogin: () => (appSlug ? `${appSlug}[bot]` : "nexus[bot]"),
    async isInstalled(owner, repo) {
      return (await installationId(owner, repo).catch(() => null)) !== null;
    },
    async installationToken(owner, repo) {
      const id = await installationId(owner, repo);
      if (!id || !appId || !privateKey) return null;
      const cached = tokenCache.get(id);
      // Installation tokens last an hour; refresh with five minutes to spare.
      if (cached && cached.expiresAt - 5 * 60_000 > Date.now()) return cached.token;
      const response = await githubRequest(`/app/installations/${id}/access_tokens`, { method: "POST", bearer: githubAppJwt(appId, privateKey) }, fetchImpl);
      if (!response.ok) throw new Error(`Could not get a GitHub App token: ${await errorText(response)}`);
      const body = (await response.json()) as { token: string; expires_at: string };
      tokenCache.set(id, { token: body.token, expiresAt: Date.parse(body.expires_at) || Date.now() + 50 * 60_000 });
      return body.token;
    },
  };

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
          // Installation tokens have no per-user permissions object; they can do what the App was granted.
          value = !permissions || permissions.push || permissions.admin || permissions.maintain ? "write" : permissions.pull ? "read" : "none";
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
    app,
  };
}
