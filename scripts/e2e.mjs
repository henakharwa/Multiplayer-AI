#!/usr/bin/env node
// Runs the browser tests (e2e/) end to end:
//   1. uses DATABASE_URL when it is set (CI), otherwise starts a throwaway
//      local PostgreSQL the same way test-with-db.mjs does;
//   2. applies the migrations;
//   3. builds the app with the web pages pointed at the test servers, into
//      apps/web/.next-e2e so the regular build is left alone;
//   4. runs Playwright, which starts the mock LLM, chat server and web app.
// Extra arguments go to Playwright, e.g. `npm run test:e2e -- --headed`.
// Set E2E_SKIP_BUILD=1 to reuse the previous build while iterating.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import os, { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit", shell: process.platform === "win32" });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited with ${code}`))));
  });
}

let pg;
let databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  // Same Windows workaround as test-with-db.mjs.
  if (process.platform === "win32") {
    os.userInfo = () => ({ uid: 1, gid: 1, username: "postgres", homedir: process.env.USERPROFILE ?? "", shell: "" });
    syncBuiltinESMExports();
  }
  const { default: EmbeddedPostgres } = await import("embedded-postgres");
  const port = 55434;
  const dataDir = join(tmpdir(), "mai-chat-pgdata-e2e");
  pg = new EmbeddedPostgres({ databaseDir: dataDir, user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"] });
  if (!existsSync(join(dataDir, "PG_VERSION"))) await pg.initialise();
  await pg.start();
  try {
    await pg.createDatabase("mai_chat_e2e");
  } catch (error) {
    if (!String(error?.message ?? error).toLowerCase().includes("already exists")) throw error;
  }
  databaseUrl = `postgres://postgres:postgres@localhost:${port}/mai_chat_e2e`;
}

const env = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  INTEGRATION_ENCRYPTION_KEY: process.env.INTEGRATION_ENCRYPTION_KEY || randomBytes(32).toString("base64"),
};

try {
  await run(npm, ["run", "migrate", "--workspace=packages/db"], env);
  if (process.env.E2E_SKIP_BUILD !== "1") {
    // `next build` rewrites the tracked apps/web/next-env.d.ts to point at
    // whichever build folder it used. Put the original back afterwards so a
    // test run never leaves a change to commit.
    const nextEnvPath = join(root, "apps", "web", "next-env.d.ts");
    const nextEnv = existsSync(nextEnvPath) ? readFileSync(nextEnvPath) : null;
    try {
      await run(npm, ["run", "build"], {
        ...env,
        NEXT_DIST_DIR: ".next-e2e",
        NEXT_PUBLIC_CHAT_SERVER_URL: "http://localhost:4910",
        NEXT_PUBLIC_CHAT_SERVER_WS_URL: "ws://localhost:4910",
      });
    } finally {
      if (nextEnv) writeFileSync(nextEnvPath, nextEnv);
    }
  }
  await run(npx, ["playwright", "test", ...process.argv.slice(2)], env);
} finally {
  await pg?.stop().catch(() => undefined);
}
