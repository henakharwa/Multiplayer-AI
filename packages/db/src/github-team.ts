// Team GitHub: webhook secrets and deliveries, and the GitHub username
// behind each member's connection.
import { randomBytes } from "node:crypto";
import { getPool } from "./pool.js";
import { encryptToken, decryptToken } from "./crypto.js";

export async function getOrCreateWorkspaceWebhookSecret(workspaceId: string): Promise<string> {
  const existing = await getWorkspaceWebhookSecret(workspaceId);
  if (existing) return existing;
  const secret = randomBytes(24).toString("hex");
  await getPool().query(
    "INSERT INTO workspace_github_webhooks (workspace_id, encrypted_secret) VALUES ($1, $2) ON CONFLICT (workspace_id) DO NOTHING",
    [workspaceId, encryptToken(secret)]
  );
  // A concurrent first request may have won the insert; always return the stored one.
  return (await getWorkspaceWebhookSecret(workspaceId)) ?? secret;
}

export async function getWorkspaceWebhookSecret(workspaceId: string): Promise<string | null> {
  const result = await getPool().query("SELECT encrypted_secret FROM workspace_github_webhooks WHERE workspace_id = $1", [workspaceId]);
  return result.rows[0] ? decryptToken(result.rows[0].encrypted_secret) : null;
}

/** Replaces the workspace's webhook secret (repository webhooks must then be updated). */
export async function rotateWorkspaceWebhookSecret(workspaceId: string): Promise<string> {
  const secret = randomBytes(24).toString("hex");
  await getPool().query(
    `INSERT INTO workspace_github_webhooks (workspace_id, encrypted_secret) VALUES ($1, $2)
     ON CONFLICT (workspace_id) DO UPDATE SET encrypted_secret = EXCLUDED.encrypted_secret`,
    [workspaceId, encryptToken(secret)]
  );
  return secret;
}

export async function getWorkspaceWebhookStatus(workspaceId: string): Promise<{ lastDeliveryAt: string | null; lastEvent: string | null }> {
  const result = await getPool().query("SELECT last_delivery_at, last_event FROM workspace_github_webhooks WHERE workspace_id = $1", [workspaceId]);
  const row = result.rows[0];
  return { lastDeliveryAt: row?.last_delivery_at ? row.last_delivery_at.toISOString() : null, lastEvent: row?.last_event ?? null };
}

/**
 * Records a webhook delivery for a workspace. Returns false when this
 * delivery was already processed (GitHub retries deliveries).
 */
export async function recordWebhookDelivery(workspaceId: string, deliveryId: string, event: string): Promise<boolean> {
  const pool = getPool();
  const inserted = await pool.query(
    "INSERT INTO github_webhook_deliveries (workspace_id, delivery_id, event) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING delivery_id",
    [workspaceId, deliveryId, event]
  );
  await pool.query(
    `INSERT INTO workspace_github_webhooks (workspace_id, encrypted_secret, last_delivery_at, last_event)
     VALUES ($1, $2, now(), $3)
     ON CONFLICT (workspace_id) DO UPDATE SET last_delivery_at = now(), last_event = EXCLUDED.last_event`,
    [workspaceId, encryptToken(randomBytes(24).toString("hex")), event]
  );
  // Keep the de-duplication log small.
  if (Math.random() < 0.05) await pool.query("DELETE FROM github_webhook_deliveries WHERE received_at < now() - interval '7 days'");
  return Boolean(inserted.rows[0]);
}

/** Saves the GitHub username behind a connection. */
export async function setIntegrationAccountLogin(integrationId: string, login: string): Promise<void> {
  await getPool().query("UPDATE integrations SET account_login = $2 WHERE id = $1", [integrationId, login]);
}
