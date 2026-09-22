import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Slack's own official MCP server -- this project's replacement for the
// hand-rolled Slack tool surface that used to live in
// packages/integrations/src/slack.ts + this package's tools.ts (see
// docs.slack.dev/ai/slack-mcp-server/, launched 2026-02-17, GA). Unlike
// GitHub's MCP server (a local Docker container this process spawns over
// stdio -- see github-mcp-pool.ts), Slack's is a REMOTE service Slack
// itself hosts: there's no process to start here, just an authenticated
// HTTP connection to Slack's own endpoint.
//
// Auth is a bearer access token from slack-oauth.ts's OAuth flow (a real
// Slack *user* token, not a bot token -- Slack's MCP server requires this;
// see slack-oauth.ts's own comment for why a pasted bot token, which is
// what this project used before this switch, can never work here). One
// client per workspace, keyed and re-connected on token change, same
// pooling shape as github-mcp-pool.ts, for the same reason: this app is
// multi-tenant, so a shared client would leak one workspace's Slack
// access into another's chat.
export const DEFAULT_SLACK_MCP_URL = "https://mcp.slack.com/mcp";

export interface SlackMcpOptions {
  accessToken: string;
  /** https://mcp.slack.com/mcp by default -- override for testing against a local stand-in. */
  serverUrl?: string;
}

interface PoolEntry {
  fingerprint: string;
  client: Client;
  close: () => Promise<void>;
}

const pool = new Map<string, PoolEntry>();

function fingerprintOf(opts: SlackMcpOptions): string {
  return JSON.stringify({ url: opts.serverUrl ?? DEFAULT_SLACK_MCP_URL, token: opts.accessToken });
}

// Returns a connected MCP client for this workspace's Slack access,
// reusing the existing connection unless the access token (or server URL
// override) has changed since the last call -- e.g. someone disconnected
// and reconnected Slack, or a token refresh rotated it. An unchanged
// fingerprint reuses the existing client rather than reconnecting to
// Slack's server on every single chat turn.
export async function getSlackMcpClient(workspaceId: string, opts: SlackMcpOptions): Promise<Client> {
  const fingerprint = fingerprintOf(opts);
  const existing = pool.get(workspaceId);
  if (existing && existing.fingerprint === fingerprint) return existing.client;
  if (existing) {
    pool.delete(workspaceId);
    await existing.close().catch(() => {});
  }

  const url = new URL(opts.serverUrl ?? DEFAULT_SLACK_MCP_URL);
  const transport = new StreamableHTTPClientTransport(url, {
    // The token is attached as a plain Authorization header rather than
    // via the SDK's own OAuthClientProvider mechanism -- this process
    // already holds a real access token from slack-oauth.ts's own
    // authorization-code exchange, so there's no browser redirect for the
    // SDK to orchestrate here; it just needs to send the token on every
    // request, which requestInit's headers do directly.
    requestInit: { headers: { authorization: `Bearer ${opts.accessToken}` } },
  });
  const client = new Client({ name: "multiplayer-ai-chat-server", version: "0.1.0" });

  const connectStart = Date.now();
  try {
    await client.connect(transport);
  } catch (err) {
    await transport.close().catch(() => {});
    throw new Error(
      `Couldn't connect to Slack's MCP server (${url}): ${err instanceof Error ? err.message : String(err)}. ` +
        `This usually means the stored Slack access token is missing, expired, or was revoked -- try disconnecting ` +
        `and reconnecting Slack (Log in with Slack) for this workspace.`
    );
  }
  console.log(`[timing] Slack MCP connect took ${Date.now() - connectStart}ms`);

  pool.set(workspaceId, { fingerprint, client, close: () => transport.close() });
  return client;
}

/** Closes and forgets one workspace's Slack MCP connection, if it has one. */
export async function closeSlackMcpClient(workspaceId: string): Promise<void> {
  const existing = pool.get(workspaceId);
  if (!existing) return;
  pool.delete(workspaceId);
  await existing.close().catch(() => {});
}

/** Closes every pooled Slack MCP connection -- for graceful shutdown and test teardown. */
export async function closeAllSlackMcpClients(): Promise<void> {
  const entries = [...pool.values()];
  pool.clear();
  await Promise.all(entries.map((e) => e.close().catch(() => {})));
}
