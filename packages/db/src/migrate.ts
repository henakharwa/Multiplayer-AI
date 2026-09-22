import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { getPool, closePool } from "./pool.js";

// Mirrors the repo-root-.env-loading pattern this project has used since
// its first Postgres-backed package: `npm run migrate --workspace=...`
// sets cwd to this package's own directory, not the repo root where the
// real .env lives.
loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
loadEnv();

async function migrate() {
  const schemaPath = path.join(fileURLToPath(new URL("../sql/schema.sql", import.meta.url)));
  const sql = await readFile(schemaPath, "utf8");
  const pool = getPool();
  await pool.query(sql);
  console.log("migration applied");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate()
    .then(() => closePool())
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
