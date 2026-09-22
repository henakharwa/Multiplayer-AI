import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

interface Entry { fingerprint: string; client: Client; close: () => Promise<void>; }
const pool = new Map<string, Entry>();

// Remote MCP services such as Linear, Notion, and Figma are isolated by
// workspace + provider. Their bearer tokens stay server-side; the browser
// only ever receives connection metadata.
export async function getRemoteMcpClient(workspaceId: string, provider: string, endpoint: string, token: string): Promise<Client> {
  const key = `${workspaceId}:${provider}`;
  const fingerprint = JSON.stringify({ endpoint, token });
  const existing = pool.get(key);
  if (existing?.fingerprint === fingerprint) return existing.client;
  if (existing) { pool.delete(key); await existing.close().catch(() => {}); }
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  const client = new Client({ name: "multiplayer-ai-chat-server", version: "0.1.0" });
  try { await client.connect(transport); } catch (error) { await transport.close().catch(() => {}); throw error; }
  pool.set(key, { fingerprint, client, close: () => transport.close() });
  return client;
}
