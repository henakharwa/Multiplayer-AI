import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { closePool } from "./pool.js";
import { listAppliedMigrations, listMigrationFiles, rollbackLastMigration, runMigrations } from "./migrations.js";

// `npm run migrate --workspace=...` sets cwd to this package, not the repo
// root where the real .env lives.
loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
loadEnv();

// Usage: migrate            apply pending migrations
//        migrate status     list applied and pending migrations
//        migrate down       roll back the most recent migration
async function main(command = "up") {
  const log = (message: string) => console.log(message);
  if (command === "up") {
    const ran = await runMigrations({ log });
    console.log(ran.length ? `applied ${ran.length} migration(s)` : "database is up to date");
  } else if (command === "status") {
    const applied = new Map((await listAppliedMigrations()).map((row) => [row.version, row]));
    for (const file of await listMigrationFiles()) {
      const row = applied.get(file.version);
      console.log(`${row ? "applied " : "pending "} ${file.version}_${file.name}${row ? `  (${row.appliedAt})` : ""}`);
    }
  } else if (command === "down") {
    await rollbackLastMigration({ log });
  } else {
    throw new Error(`unknown command "${command}" (use up, status or down)`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv[2])
    .then(() => closePool())
    .catch(async (err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
      await closePool().catch(() => undefined);
    });
}
