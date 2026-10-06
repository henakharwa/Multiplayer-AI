import { Client, Pool } from "pg";

let pool: Pool | undefined;
// Long-lived LISTEN connections (see realtime.ts). They are separate from
// the pool so they never hold a pooled connection, and closePool ends them.
const listeners = new Set<Client>();

function connectionString(): string {
  const value = process.env.DATABASE_URL;
  if (!value) throw new Error("DATABASE_URL is not set");
  return value;
}

export function getPool(): Pool {
  if (!pool) pool = new Pool({ connectionString: connectionString() });
  return pool;
}

/** Opens a dedicated connection for LISTEN/NOTIFY. */
export async function openListenerConnection(): Promise<Client> {
  const client = new Client({ connectionString: connectionString() });
  await client.connect();
  listeners.add(client);
  client.on("end", () => listeners.delete(client));
  return client;
}

export async function closeListenerConnection(client: Client): Promise<void> {
  listeners.delete(client);
  await client.end().catch(() => undefined);
}

export async function closePool(): Promise<void> {
  await Promise.all([...listeners].map((client) => closeListenerConnection(client)));
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
