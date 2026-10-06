// Versioned database migrations.
//
// Each file in sql/migrations is applied once, in name order, inside its
// own transaction, and recorded in schema_migrations with a checksum. An
// optional "<name>.down.sql" next to a migration lets `migrate:down` undo
// the most recent one. 0001_baseline.sql is the schema as it stood when
// versioning was introduced; it is written to be safe on databases that
// already have those tables, so existing deployments adopt it in place.
//
// Rules for new changes: add a new numbered file (e.g. 0002_add_x.sql);
// never edit a migration that has already been applied anywhere.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { getPool } from "./pool.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../sql/migrations/", import.meta.url));
const LOCK_KEY = "schema-migrations";

export type MigrationFile = { version: string; name: string; file: string; downFile: string | null };
export type AppliedMigration = { version: string; name: string; checksum: string; appliedAt: string };

export async function listMigrationFiles(dir = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const files = (await readdir(dir)).filter((file) => /^\d{4}_[\w-]+\.sql$/.test(file) && !file.endsWith(".down.sql")).sort();
  return files.map((file) => {
    const version = file.slice(0, 4);
    const name = file.slice(5, -4);
    const down = path.join(dir, `${file.slice(0, -4)}.down.sql`);
    return { version, name, file: path.join(dir, file), downFile: existsSync(down) ? down : null };
  });
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
}

async function withMigrationLock<T>(task: (query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) => Promise<T>): Promise<T> {
  // One dedicated connection holds the advisory lock, so two server
  // processes starting at once never apply the same migration twice.
  const client = await getPool().connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    return await task((sql, params) => client.query(sql, params));
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

export async function listAppliedMigrations(): Promise<AppliedMigration[]> {
  return withMigrationLock(async (query) => {
    const result = await query("SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version");
    return result.rows.map((row) => ({ version: String(row.version), name: String(row.name), checksum: String(row.checksum), appliedAt: (row.applied_at as Date).toISOString() }));
  });
}

/** Applies every pending migration in order. Returns the versions applied. */
export async function runMigrations(options: { log?: (message: string) => void; dir?: string } = {}): Promise<string[]> {
  const log = options.log ?? (() => undefined);
  const files = await listMigrationFiles(options.dir);
  return withMigrationLock(async (query) => {
    const applied = new Map((await query("SELECT version, checksum FROM schema_migrations")).rows.map((row) => [String(row.version), String(row.checksum)]));
    const ran: string[] = [];
    for (const migration of files) {
      const sql = await readFile(migration.file, "utf8");
      const sum = checksum(sql);
      const recorded = applied.get(migration.version);
      if (recorded) {
        if (recorded !== sum) log(`warning: migration ${migration.version}_${migration.name} changed after it was applied; add a new migration instead of editing it`);
        continue;
      }
      await query("BEGIN");
      try {
        await query(sql);
        await query("INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)", [migration.version, migration.name, sum]);
        await query("COMMIT");
      } catch (error) {
        await query("ROLLBACK").catch(() => undefined);
        throw new Error(`migration ${migration.version}_${migration.name} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      log(`applied ${migration.version}_${migration.name}`);
      ran.push(migration.version);
    }
    return ran;
  });
}

/** Undoes the most recently applied migration using its .down.sql file. */
export async function rollbackLastMigration(options: { log?: (message: string) => void; dir?: string } = {}): Promise<string | null> {
  const log = options.log ?? (() => undefined);
  const files = await listMigrationFiles(options.dir);
  return withMigrationLock(async (query) => {
    const last = (await query("SELECT version, name FROM schema_migrations ORDER BY version DESC LIMIT 1")).rows[0];
    if (!last) { log("no migrations have been applied"); return null; }
    const migration = files.find((file) => file.version === String(last.version));
    if (!migration?.downFile) throw new Error(`migration ${String(last.version)}_${String(last.name)} has no .down.sql file, so it cannot be rolled back`);
    const sql = await readFile(migration.downFile, "utf8");
    await query("BEGIN");
    try {
      await query(sql);
      await query("DELETE FROM schema_migrations WHERE version = $1", [migration.version]);
      await query("COMMIT");
    } catch (error) {
      await query("ROLLBACK").catch(() => undefined);
      throw error;
    }
    log(`rolled back ${migration.version}_${migration.name}`);
    return migration.version;
  });
}
