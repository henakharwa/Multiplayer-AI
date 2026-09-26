import type { AuditEvent, AuditEventType, ChatMessage, Conversation, GithubRepoSummary, IntegrationConfig, PendingAction, Workspace, WorkspaceMember, WorkspaceNotification, WorkspaceRole } from "@mai-chat/shared-types";
import { CHAT_SERVER_URL } from "./config";

function authenticatedFetch(input: RequestInfo | URL, init?: RequestInit) {
  return fetch(input, { ...init, credentials: "include" });
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function parseJsonOrThrow(res: Response): Promise<unknown> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : `request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }
  return body;
}

export async function createWorkspace(name: string): Promise<Workspace> {
  const res = await authenticatedFetch(`${CHAT_SERVER_URL}/workspaces`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return (await parseJsonOrThrow(res)) as Workspace;
}

export async function getWorkspaceByJoinCode(joinCode: string): Promise<Workspace> {
  const res = await authenticatedFetch(`${CHAT_SERVER_URL}/workspaces/by-code/${encodeURIComponent(joinCode)}`);
  return (await parseJsonOrThrow(res)) as Workspace;
}

export async function getWorkspace(id: string): Promise<Workspace> {
  const res = await authenticatedFetch(`${CHAT_SERVER_URL}/workspaces/${encodeURIComponent(id)}`);
  return (await parseJsonOrThrow(res)) as Workspace;
}

export async function listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMember[]> {
  const res = await authenticatedFetch(`${CHAT_SERVER_URL}/workspaces/${encodeURIComponent(workspaceId)}/members`);
  return (await parseJsonOrThrow(res)) as WorkspaceMember[];
}

export async function updateWorkspaceMemberRole(workspaceId: string, userId: string, role: WorkspaceRole): Promise<void> {
  const res = await authenticatedFetch(`${CHAT_SERVER_URL}/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ role }) });
  await parseJsonOrThrow(res);
}

export async function sendWorkspaceInvitation(workspaceId: string, email: string): Promise<{ email: string; expiresAt: string }> {
  const res = await authenticatedFetch(`${CHAT_SERVER_URL}/workspaces/${encodeURIComponent(workspaceId)}/invitations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }) });
  return (await parseJsonOrThrow(res)) as { email: string; expiresAt: string };
}

export async function acceptWorkspaceInvitation(token: string): Promise<{ workspaceId: string }> {
  const res = await authenticatedFetch(`${CHAT_SERVER_URL}/workspace-invitations/accept`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  return (await parseJsonOrThrow(res)) as { workspaceId: string };
}

export async function listMessages(workspaceId: string, conversationId: string): Promise<ChatMessage[]> {
  const res = await authenticatedFetch(`${CHAT_SERVER_URL}/workspaces/${encodeURIComponent(workspaceId)}/messages?conversationId=${encodeURIComponent(conversationId)}`);
  return (await parseJsonOrThrow(res)) as ChatMessage[];
}

export async function listConversations(workspaceId: string): Promise<Conversation[]> {
  const res = await authenticatedFetch(`${CHAT_SERVER_URL}/workspaces/${encodeURIComponent(workspaceId)}/conversations`);
  return (await parseJsonOrThrow(res)) as Conversation[];
}

export async function createConversation(workspaceId: string): Promise<Conversation> {
  const res = await authenticatedFetch(`${CHAT_SERVER_URL}/workspaces/${encodeURIComponent(workspaceId)}/conversations`, { method: "POST" });
  return (await parseJsonOrThrow(res)) as Conversation;
}

export async function deleteConversation(workspaceId: string, conversationId: string): Promise<Conversation[]> {
  const res = await authenticatedFetch(`${CHAT_SERVER_URL}/workspaces/${encodeURIComponent(workspaceId)}/conversations/${encodeURIComponent(conversationId)}`, { method: "DELETE" });
  return (await parseJsonOrThrow(res)) as Conversation[];
}

export async function listNotifications(workspaceId: string): Promise<WorkspaceNotification[]> {
  const res = await authenticatedFetch(`${CHAT_SERVER_URL}/notifications?workspaceId=${encodeURIComponent(workspaceId)}`);
  return (await parseJsonOrThrow(res)) as WorkspaceNotification[];
}

export async function markNotificationsRead(workspaceId: string): Promise<void> {
  const res = await authenticatedFetch(`${CHAT_SERVER_URL}/notifications/read`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspaceId }) });
  await parseJsonOrThrow(res);
}

export async function listIntegrations(workspaceId: string): Promise<IntegrationConfig[]> {
  const res = await authenticatedFetch(`${CHAT_SERVER_URL}/workspaces/${encodeURIComponent(workspaceId)}/integrations`);
  return (await parseJsonOrThrow(res)) as IntegrationConfig[];
}

export async function disconnectIntegration(workspaceId: string, provider: IntegrationConfig["type"]): Promise<void> {
  const res = await authenticatedFetch(`${CHAT_SERVER_URL}/workspaces/${encodeURIComponent(workspaceId)}/integrations/${provider}`, { method: "DELETE" });
  if (!res.ok) await parseJsonOrThrow(res);
}

export async function connectGithub(workspaceId: string, input: { owner: string; repo: string; token: string }): Promise<IntegrationConfig> {
  const res = await authenticatedFetch(`${CHAT_SERVER_URL}/workspaces/${encodeURIComponent(workspaceId)}/integrations/github`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return (await parseJsonOrThrow(res)) as IntegrationConfig;
}

export async function connectRemoteMcp(workspaceId: string, provider: "linear" | "notion" | "figma", input: { endpoint: string; token: string }): Promise<IntegrationConfig> {
  const res = await authenticatedFetch(`${CHAT_SERVER_URL}/workspaces/${encodeURIComponent(workspaceId)}/integrations/${provider}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  return (await parseJsonOrThrow(res)) as IntegrationConfig;
}

export function providerOAuthStartUrl(workspaceId: string, provider: "linear" | "notion" | "figma"): string {
  return `${CHAT_SERVER_URL}/workspaces/${encodeURIComponent(workspaceId)}/integrations/${provider}/oauth/start`;
}

// Not a fetch -- this URL is meant to be navigated to directly
// (window.location.href = ...) so the browser follows the redirect chain
// to github.com's consent screen and back. See
// services/chat-server/src/github-oauth.ts for the full flow.
export function githubOAuthStartUrl(workspaceId: string): string {
  return `${CHAT_SERVER_URL}/workspaces/${encodeURIComponent(workspaceId)}/integrations/github/oauth/start`;
}

// Same pattern as githubOAuthStartUrl above -- Slack now connects ONLY
// via this OAuth flow (no pasted-token form anymore; Slack's own official
// MCP server requires a real user access token from this exact flow, see
// services/chat-server/src/slack-oauth.ts's comment for why a pasted
// token could never work here).
export function slackOAuthStartUrl(workspaceId: string): string {
  return `${CHAT_SERVER_URL}/workspaces/${encodeURIComponent(workspaceId)}/integrations/slack/oauth/start`;
}

export async function listGithubRepos(workspaceId: string): Promise<GithubRepoSummary[]> {
  const res = await authenticatedFetch(`${CHAT_SERVER_URL}/workspaces/${encodeURIComponent(workspaceId)}/integrations/github/repos`);
  return (await parseJsonOrThrow(res)) as GithubRepoSummary[];
}

export async function selectGithubRepo(workspaceId: string, input: { owner: string; repo: string }): Promise<IntegrationConfig> {
  const res = await authenticatedFetch(`${CHAT_SERVER_URL}/workspaces/${encodeURIComponent(workspaceId)}/integrations/github/repo`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  return (await parseJsonOrThrow(res)) as IntegrationConfig;
}


// -- Pending write-action confirmation (see services/chat-server/src/actions.ts) --

export async function listPendingActions(workspaceId: string, conversationId: string): Promise<PendingAction[]> {
  const res = await authenticatedFetch(`${CHAT_SERVER_URL}/workspaces/${encodeURIComponent(workspaceId)}/actions?conversationId=${encodeURIComponent(conversationId)}`);
  return (await parseJsonOrThrow(res)) as PendingAction[];
}

export async function confirmAction(workspaceId: string, actionId: string, actorName: string): Promise<PendingAction> {
  const res = await authenticatedFetch(`${CHAT_SERVER_URL}/workspaces/${encodeURIComponent(workspaceId)}/actions/${encodeURIComponent(actionId)}/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actorName }),
  });
  return (await parseJsonOrThrow(res)) as PendingAction;
}

export async function cancelAction(workspaceId: string, actionId: string, actorName: string): Promise<PendingAction> {
  const res = await authenticatedFetch(`${CHAT_SERVER_URL}/workspaces/${encodeURIComponent(workspaceId)}/actions/${encodeURIComponent(actionId)}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actorName }),
  });
  return (await parseJsonOrThrow(res)) as PendingAction;
}

// -- Action audit trail (services/chat-server/src/server.ts's GET
// /workspaces/:id/audit, see actions.ts for where the rows come from) --

export async function listAuditEvents(
  workspaceId: string,
  options: { type?: AuditEventType; q?: string; before?: string } = {}
): Promise<{ events: AuditEvent[]; nextBefore: string | null }> {
  const url = new URL(`${CHAT_SERVER_URL}/workspaces/${encodeURIComponent(workspaceId)}/audit`);
  if (options.type) url.searchParams.set("type", options.type);
  if (options.q) url.searchParams.set("q", options.q);
  if (options.before) url.searchParams.set("before", options.before);
  const res = await authenticatedFetch(url.toString());
  return (await parseJsonOrThrow(res)) as { events: AuditEvent[]; nextBefore: string | null };
}

// -- Auth ("Sign in with GitHub", see services/chat-server/src/auth.ts) --
//
// A full top-level navigation, not a fetch -- the browser needs to follow
// the redirect to github.com's consent screen and back. returnTo is a
// same-origin relative path (e.g. the room the person was trying to open)
// to land on after signing in; auth.ts validates it server-side too
// (never trusts this as anything more than a hint).
export function loginWithGithubUrl(returnTo?: string): string {
  const url = new URL(`${CHAT_SERVER_URL}/auth/login/github/start`);
  if (returnTo) url.searchParams.set("returnTo", returnTo);
  return url.toString();
}

// Resolves to the signed-in User, or throws an ApiError with status 401
// if there isn't one.
export async function getCurrentUser(): Promise<import("@mai-chat/shared-types").User> {
  const res = await authenticatedFetch(`${CHAT_SERVER_URL}/auth/me`, { credentials: "include" });
  return (await parseJsonOrThrow(res)) as import("@mai-chat/shared-types").User;
}

export async function logout(): Promise<void> {
  await authenticatedFetch(`${CHAT_SERVER_URL}/auth/logout`, { method: "POST", credentials: "include" });
}

export function loginWithGoogleUrl(returnTo?: string): string {
  const url = new URL(`${CHAT_SERVER_URL}/auth/login/google/start`);
  if (returnTo) url.searchParams.set("returnTo", returnTo);
  return url.toString();
}

export async function getAuthProviders(): Promise<{ email: boolean; google: boolean; github: boolean }> {
  return await parseJsonOrThrow(await authenticatedFetch(`${CHAT_SERVER_URL}/auth/providers`)) as { email: boolean; google: boolean; github: boolean };
}

export async function authenticateWithEmail(mode: "signin" | "signup", input: { email: string; password: string; displayName?: string }): Promise<void> {
  await parseJsonOrThrow(await authenticatedFetch(`${CHAT_SERVER_URL}/auth/${mode === "signup" ? "signup" : "login"}/email`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  }));
}

// -- Email verification / password reset (services/chat-server/src/
// email-verification.ts, password-reset.ts) --

export async function resendVerificationEmail(): Promise<{ sent?: boolean; alreadyVerified?: boolean }> {
  return (await parseJsonOrThrow(await authenticatedFetch(`${CHAT_SERVER_URL}/auth/resend-verification`, { method: "POST" }))) as {
    sent?: boolean;
    alreadyVerified?: boolean;
  };
}

export async function verifyEmail(token: string): Promise<{ verified: true; email: string | null }> {
  return (await parseJsonOrThrow(await authenticatedFetch(`${CHAT_SERVER_URL}/auth/verify-email`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }),
  }))) as { verified: true; email: string | null };
}

// Always resolves (never throws for an unknown email -- the server
// deliberately gives the same response either way, see password-reset.ts).
export async function requestPasswordReset(email: string): Promise<{ message: string }> {
  return (await parseJsonOrThrow(await authenticatedFetch(`${CHAT_SERVER_URL}/auth/forgot-password`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email }),
  }))) as { message: string };
}

export async function resetPassword(token: string, password: string): Promise<{ reset: true }> {
  return (await parseJsonOrThrow(await authenticatedFetch(`${CHAT_SERVER_URL}/auth/reset-password`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, password }),
  }))) as { reset: true };
}
