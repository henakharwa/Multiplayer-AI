// Team GitHub: the workspace repository list, webhook secrets and
// deliveries, and recent team activity used by the agent and the chat.
import { randomBytes } from "node:crypto";
import type { WorkspaceRepository } from "@mai-chat/shared-types";
import { getPool } from "./pool.js";
import { encryptToken, decryptToken } from "./crypto.js";

type RepositoryRow = {
  id: string;
  workspace_id: string;
  owner: string;
  repo: string;
  is_default: boolean;
  added_by_user_id: string | null;
  added_by_name: string | null;
  webhook_id: string | number | null;
  last_event_at: Date | null;
  created_at: Date;
};

const REPOSITORY_SELECT = `SELECT r.id, r.workspace_id, r.owner, r.repo, r.is_default, r.added_by_user_id, u.display_name AS added_by_name,
  r.webhook_id, r.last_event_at, r.created_at
  FROM workspace_repositories r LEFT JOIN users u ON u.id = r.added_by_user_id`;

function toRepository(row: RepositoryRow): WorkspaceRepository {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    owner: row.owner,
    repo: row.repo,
    fullName: `${row.owner}/${row.repo}`,
    isDefault: row.is_default,
    addedByUserId: row.added_by_user_id,
    addedByName: row.added_by_name,
    webhookId: row.webhook_id === null ? null : Number(row.webhook_id),
    lastEventAt: row.last_event_at ? row.last_event_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

/** The workspace's repositories, default first. */
export async function listWorkspaceRepositories(workspaceId: string): Promise<WorkspaceRepository[]> {
  const result = await getPool().query(
    `${REPOSITORY_SELECT} WHERE r.workspace_id = $1 ORDER BY r.is_default DESC, r.created_at ASC`,
    [workspaceId]
  );
  return result.rows.map(toRepository);
}

export async function getWorkspaceRepository(workspaceId: string, id: string): Promise<WorkspaceRepository | null> {
  const result = await getPool().query(`${REPOSITORY_SELECT} WHERE r.workspace_id = $1 AND r.id = $2`, [workspaceId, id]);
  return result.rows[0] ? toRepository(result.rows[0]) : null;
}

/**
 * Adds a repository (case-insensitive, so "Acme/Web" and "acme/web" are one
 * entry). The first repository becomes the default. Returns null when it is
 * already on the list.
 */
export async function addWorkspaceRepository(input: { workspaceId: string; owner: string; repo: string; addedByUserId?: string | null }): Promise<WorkspaceRepository | null> {
  const pool = getPool();
  const inserted = await pool.query(
    `INSERT INTO workspace_repositories (workspace_id, owner, repo, is_default, added_by_user_id)
     VALUES ($1, $2, $3, NOT EXISTS (SELECT 1 FROM workspace_repositories WHERE workspace_id = $1), $4)
     ON CONFLICT DO NOTHING RETURNING id`,
    [input.workspaceId, input.owner.trim(), input.repo.trim(), input.addedByUserId ?? null]
  );
  if (!inserted.rows[0]) return null;
  return getWorkspaceRepository(input.workspaceId, inserted.rows[0].id);
}

/** Removes a repository; if it was the default, the oldest remaining one becomes the default. */
export async function removeWorkspaceRepository(workspaceId: string, id: string): Promise<WorkspaceRepository | null> {
  const pool = getPool();
  const existing = await getWorkspaceRepository(workspaceId, id);
  if (!existing) return null;
  await pool.query("DELETE FROM workspace_repositories WHERE workspace_id = $1 AND id = $2", [workspaceId, id]);
  if (existing.isDefault) {
    await pool.query(
      `UPDATE workspace_repositories SET is_default = true WHERE id = (
         SELECT id FROM workspace_repositories WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC LIMIT 1)`,
      [workspaceId]
    );
  }
  return existing;
}

export async function setDefaultWorkspaceRepository(workspaceId: string, id: string): Promise<WorkspaceRepository | null> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query("SELECT id FROM workspace_repositories WHERE workspace_id = $1 AND id = $2 FOR UPDATE", [workspaceId, id]);
    if (!found.rows[0]) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query("UPDATE workspace_repositories SET is_default = (id = $2) WHERE workspace_id = $1", [workspaceId, id]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return getWorkspaceRepository(workspaceId, id);
}

export async function setRepositoryWebhookId(workspaceId: string, id: string, webhookId: number | null): Promise<void> {
  await getPool().query("UPDATE workspace_repositories SET webhook_id = $3 WHERE workspace_id = $1 AND id = $2", [workspaceId, id, webhookId]);
}

/** Every workspace that has this repository on its list (GitHub App deliveries). */
export async function findWorkspacesForRepository(owner: string, repo: string): Promise<Array<{ workspaceId: string; repositoryId: string }>> {
  const result = await getPool().query(
    "SELECT workspace_id, id FROM workspace_repositories WHERE lower(owner) = lower($1) AND lower(repo) = lower($2)",
    [owner, repo]
  );
  return result.rows.map((row) => ({ workspaceId: row.workspace_id, repositoryId: row.id }));
}

export async function touchRepositoryEvent(repositoryId: string): Promise<void> {
  await getPool().query("UPDATE workspace_repositories SET last_event_at = now() WHERE id = $1", [repositoryId]);
}

/** The workspace's webhook secret, created on first use. */
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
 * delivery was already processed (a GitHub retry, or the same event arriving
 * through both a repository webhook and the GitHub App).
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
