#!/usr/bin/env node
// Runs the complete test suite against a disposable local PostgreSQL
// instance, so contributors and CI do not need a manually configured
// DATABASE_URL. The database is stopped whether tests pass or fail.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import os, { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";

// embedded-postgres calls os.userInfo().uid even though Windows has no POSIX
// uid. On some Windows hosts Node throws ENOMEM from that call before Postgres
// starts. Supply the non-root Windows equivalent before loading the library.
if (process.platform === "win32") {
  os.userInfo = () => ({ uid: 1, gid: 1, username: "postgres", homedir: process.env.USERPROFILE ?? "", shell: "" });
  syncBuiltinESMExports();
}
const { default: EmbeddedPostgres } = await import("embedded-postgres");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
// Keep PostgreSQL's data path out of the repository and away from Windows
// paths containing spaces; initdb does not reliably quote those paths.
const dataDir = join(tmpdir(), "mai-chat-pgdata-test");
const port = 55433;
const database = "mai_chat_test";
const connectionString = `postgres://postgres:postgres@localhost:${port}/${database}`;
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: "postgres",
  password: "postgres",
  port,
  persistent: false,
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
});

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit", shell: process.platform === "win32" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`test command exited with ${code}`)));
  });
}

try {
  if (!existsSync(join(dataDir, "PG_VERSION"))) await pg.initialise();
  await pg.start();
  try { await pg.createDatabase(database); } catch (error) {
    if (!String(error?.message ?? error).toLowerCase().includes("already exists")) throw error;
  }
  const env = { ...process.env, DATABASE_URL: connectionString };
  // Apply the versioned migrations exactly as a deploy does, then run every
  // workspace's tests against that database.
  await run(npm, ["run", "migrate", "--workspace=packages/db"], env);
  await run(npm, ["run", "test", "--workspaces", "--if-present"], env);
} finally {
  await pg.stop().catch(() => undefined);
}
