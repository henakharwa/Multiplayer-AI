// Real connection checks behind the Integrations page's "Test connection"
// button. Each check makes one cheap, read-only request with the stored
// credential, so a revoked token or a missing repository shows up here
// instead of as an empty tool list in chat.
import * as db from "@mai-chat/db";
import type { IntegrationConfig, RemoteMcpIntegrationConfig } from "@mai-chat/shared-types";
import { errMessage } from "./http-utils.js";
import { getRemoteMcpClient } from "./remote-mcp-pool.js";
import { listMcpToolExecutors } from "./mcp-tools.js";

export type IntegrationHealth = { status: "ok" | "needs_setup" | "failed"; message: string };

const TIMEOUT_MS = 10_000;

async function checkGithub(workspaceId: string, integration: Extract<IntegrationConfig, { type: "github" }>): Promise<IntegrationHealth> {
  const credential = await db.getIntegrationCredential(workspaceId, "github", integration.id);
  if (!credential?.token) return { status: "failed", message: "No GitHub credential is stored for this connection. Reconnect GitHub." };
  if (!credential.owner || !credential.repo) return { status: "needs_setup", message: "GitHub is connected, but no repository is selected. Choose a repository." };
  const res = await fetch(`https://api.github.com/repos/${encodeURIComponent(credential.owner)}/${encodeURIComponent(credential.repo)}`, {
    headers: { authorization: `Bearer ${credential.token}`, accept: "application/vnd.github+json", "user-agent": "nexus-integration-check" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.ok) return { status: "ok", message: `Connected: ${credential.owner}/${credential.repo} is readable.` };
  if (res.status === 401) return { status: "failed", message: "GitHub rejected the stored token. Reconnect GitHub." };
  if (res.status === 403) return { status: "failed", message: "GitHub refused access (rate limit or missing permission). Try again later or reconnect." };
  if (res.status === 404) return { status: "failed", message: `${credential.owner}/${credential.repo} was not found or this token cannot read it. Choose another repository.` };
  return { status: "failed", message: `GitHub returned HTTP ${res.status}.` };
}

async function checkSlack(workspaceId: string, integration: Extract<IntegrationConfig, { type: "slack" }>): Promise<IntegrationHealth> {
  const credential = await db.getIntegrationCredential(workspaceId, "slack", integration.id);
  if (!credential?.token) return { status: "failed", message: "No Slack credential is stored for this connection. Reconnect Slack." };
  const res = await fetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({})) as { ok?: boolean; team?: string; error?: string };
  if (body.ok) return { status: "ok", message: `Connected to the ${body.team ?? "Slack"} workspace.` };
  if (body.error === "invalid_auth" || body.error === "token_revoked" || body.error === "account_inactive") return { status: "failed", message: "Slack rejected the stored token. Reconnect Slack." };
  return { status: "failed", message: `Slack check failed${body.error ? `: ${body.error}` : ` (HTTP ${res.status})`}.` };
}

async function checkNotion(workspaceId: string, integration: IntegrationConfig): Promise<IntegrationHealth> {
  const credential = await db.getIntegrationCredential(workspaceId, "notion", integration.id);
  if (!credential?.token) return { status: "failed", message: "No Notion credential is stored for this connection. Reconnect Notion." };
  const res = await fetch("https://api.notion.com/v1/users/me", {
    headers: { authorization: `Bearer ${credential.token}`, "notion-version": "2022-06-28" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.ok) return { status: "ok", message: "Connected: Notion accepted the stored token." };
  if (res.status === 401) return { status: "failed", message: "Notion rejected the stored token. Reconnect Notion." };
  return { status: "failed", message: `Notion returned HTTP ${res.status}.` };
}

async function checkRemoteMcp(workspaceId: string, integration: RemoteMcpIntegrationConfig): Promise<IntegrationHealth> {
  const credential = await db.getIntegrationCredential(workspaceId, integration.type, integration.id);
  if (!credential?.token || !integration.endpoint) return { status: "failed", message: "This connection is missing its endpoint or token. Update the connection." };
  const client = await getRemoteMcpClient(workspaceId, integration.type, integration.endpoint, credential.token);
  const tools = await listMcpToolExecutors(client);
  return tools.length
    ? { status: "ok", message: `Connected: ${tools.length} tool${tools.length === 1 ? "" : "s"} available.` }
    : { status: "needs_setup", message: "Connected, but the server offered no tools. Check the token's scopes." };
}

export async function testIntegrationConnection(workspaceId: string, integration: IntegrationConfig): Promise<IntegrationHealth> {
  try {
    if (integration.type === "github") return await checkGithub(workspaceId, integration);
    if (integration.type === "slack") return await checkSlack(workspaceId, integration);
    if (integration.type === "notion") return await checkNotion(workspaceId, integration);
    return await checkRemoteMcp(workspaceId, integration);
  } catch (error) {
    const message = errMessage(error);
    return { status: "failed", message: /timeout|aborted/i.test(message) ? "The provider did not respond in time. Try again." : `Could not reach the provider: ${message.slice(0, 200)}` };
  }
}
