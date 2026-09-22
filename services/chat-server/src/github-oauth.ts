// GitHub OAuth login for a workspace's GitHub integration -- the "+ Add
// channel -> GitHub" flow in apps/web (see docs/spec.md's Phase 1 note:
// this replaces pasting a personal access token as the primary path; the
// pasted-token form on the Integrations settings page still works as a
// fallback for anyone who'd rather not grant OAuth access).
//
// Flow: GET .../oauth/start redirects the browser to github.com's consent
// screen -> GitHub redirects back to GET /auth/github/callback with a code
// -> we exchange it for a token and store it (encrypted, via
// db.saveGithubOAuthToken) -> redirect the browser back into the app so it
// can show the repo picker (GET .../repos, then POST .../repo in
// server.ts finalizes which one).
import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import * as db from "@mai-chat/db";
import { listRepositoriesForToken as defaultListRepositoriesForToken } from "@mai-chat/integrations";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function paramString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export interface GithubOAuthConfig {
  clientId: string;
  clientSecret: string;
  // Full URL to this server's own /auth/github/callback route -- must
  // match the "Authorization callback URL" registered on the GitHub OAuth
  // App exactly, or GitHub rejects the exchange.
  redirectUri: string;
  // Where to send the browser back to once the flow finishes (success or
  // error) -- the Next.js app's own origin, e.g. http://localhost:3000.
  webAppUrl: string;
}

export interface GithubOAuthDeps {
  // Injectable so tests exercise the real route logic (state handling,
  // storing the token, error redirects) without hitting github.com --
  // same "mock only the external network call" line as every other
  // package in this repo.
  exchangeCodeForToken: (code: string, config: GithubOAuthConfig) => Promise<{ accessToken: string } | { error: string }>;
  listRepositoriesForToken: typeof defaultListRepositoriesForToken;
}

async function defaultExchangeCodeForToken(
  code: string,
  config: GithubOAuthConfig
): Promise<{ accessToken: string } | { error: string }> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    return { error: body.error_description ?? body.error ?? `GitHub token exchange failed (HTTP ${res.status})` };
  }
  return { accessToken: body.access_token };
}

export const defaultGithubOAuthDeps: GithubOAuthDeps = {
  exchangeCodeForToken: defaultExchangeCodeForToken,
  listRepositoriesForToken: defaultListRepositoriesForToken,
};

// One-time-use, short-lived state tokens tying a GitHub redirect back to
// the workspace that started it (also our CSRF protection -- a callback
// with an unrecognized/expired state is refused). In-memory only: fine for
// this single-process dev server, matching this project's other
// deliberately-simple Phase 1 choices. A server restart between clicking
// "Connect GitHub" and finishing the consent screen loses the pending
// state -- the user just clicks Connect GitHub again. Not a durability
// problem worth a database table for a link that's meant to be used
// within minutes.
const STATE_TTL_MS = 10 * 60 * 1000;
const pendingStates = new Map<string, { workspaceId: string; expiresAt: number }>();

function cleanupExpiredStates(now = Date.now()): void {
  for (const [state, entry] of pendingStates) {
    if (entry.expiresAt < now) pendingStates.delete(state);
  }
}

function redirectTarget(
  config: GithubOAuthConfig,
  workspaceId: string | undefined,
  status: "connected" | "error",
  message?: string
): string {
  const url = new URL(workspaceId ? `/w/${workspaceId}` : "/", config.webAppUrl);
  url.searchParams.set("github", status);
  if (message) url.searchParams.set("githubMessage", message);
  return url.toString();
}

export function registerGithubOAuthRoutes(app: Express, config: GithubOAuthConfig, deps: GithubOAuthDeps = defaultGithubOAuthDeps): void {
  app.get("/workspaces/:id/integrations/github/oauth/start", async (req: Request, res: Response) => {
    const workspaceId = paramString(req.params.id);
    if (!UUID_RE.test(workspaceId)) return res.status(400).json({ error: "invalid workspace id" });
    const workspace = await db.getWorkspaceById(workspaceId);
    if (!workspace) return res.status(404).json({ error: "not found" });
    if (!config.clientId || !config.clientSecret) {
      return res
        .status(503)
        .json({ error: "GitHub login isn't configured on this server (GITHUB_OAUTH_CLIENT_ID/GITHUB_OAUTH_CLIENT_SECRET are not set)." });
    }

    cleanupExpiredStates();
    const state = randomUUID();
    pendingStates.set(state, { workspaceId, expiresAt: Date.now() + STATE_TTL_MS });

    const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
    authorizeUrl.searchParams.set("client_id", config.clientId);
    authorizeUrl.searchParams.set("redirect_uri", config.redirectUri);
    authorizeUrl.searchParams.set("scope", "repo");
    authorizeUrl.searchParams.set("state", state);
    res.redirect(authorizeUrl.toString());
  });

  app.get("/auth/github/callback", async (req: Request, res: Response) => {
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const oauthError = typeof req.query.error === "string" ? req.query.error : "";

    cleanupExpiredStates();
    const pending = pendingStates.get(state);
    if (pending) pendingStates.delete(state); // single-use whether this succeeds or not

    if (oauthError) {
      return res.redirect(redirectTarget(config, pending?.workspaceId, "error", `GitHub said: ${oauthError}`));
    }
    if (!pending) {
      return res.redirect(
        redirectTarget(config, undefined, "error", "That GitHub login link expired or was already used -- click Connect GitHub again.")
      );
    }
    if (!code) {
      return res.redirect(redirectTarget(config, pending.workspaceId, "error", "GitHub didn't send back an authorization code."));
    }

    const result = await deps.exchangeCodeForToken(code, config);
    if ("error" in result) {
      return res.redirect(redirectTarget(config, pending.workspaceId, "error", result.error));
    }

    await db.saveGithubOAuthToken({ workspaceId: pending.workspaceId, token: result.accessToken });
    if (req.user) {
      await db.recordAuditEvent({
        workspaceId: pending.workspaceId,
        eventType: "integration.connected",
        actorType: "user",
        actorUserId: req.user.id,
        actorName: req.user.displayName,
        summary: `${req.user.displayName} connected GitHub`,
        metadata: { integration: "github" },
      });
    }
    res.redirect(redirectTarget(config, pending.workspaceId, "connected"));
  });

  app.get("/workspaces/:id/integrations/github/repos", async (req: Request, res: Response) => {
    const workspaceId = paramString(req.params.id);
    if (!UUID_RE.test(workspaceId)) return res.status(400).json({ error: "invalid workspace id" });
    const workspace = await db.getWorkspaceById(workspaceId);
    if (!workspace) return res.status(404).json({ error: "not found" });
    const credential = await db.getIntegrationCredential(workspaceId, "github");
    if (!credential) return res.status(404).json({ error: "GitHub isn't connected for this workspace yet." });
    try {
      const repos = await deps.listRepositoriesForToken(credential.token);
      res.json(repos);
    } catch (err) {
      res.status(502).json({ error: `could not list GitHub repositories: ${err instanceof Error ? err.message : String(err)}` });
    }
  });
}

// Exposed for tests only -- lets a test assert on/clear pending-state
// behavior deterministically instead of racing a real 10-minute TTL.
export const __testing = { pendingStates, cleanupExpiredStates };
