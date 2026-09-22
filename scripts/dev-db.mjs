#!/usr/bin/env node
// Starts a real local Postgres for development, with no system install or
// admin rights required (uses the `embedded-postgres` package, which spawns
// a genuine Postgres binary -- not a mock or an in-memory shim). Only
// needed if you don't already have a Postgres server reachable at the
// DATABASE_URL in .env; if you do (Docker, a system install, a hosted
// instance), skip this and just run `npm run migrate` against that instead.
import EmbeddedPostgres from "embedded-postgres";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, "..", ".pgdata");

// embedded-postgres's `initialise()` always runs `initdb` unconditionally --
// it has no built-in check for an already-initialized data directory, and
// `initdb` refuses to run against a non-empty directory. So on every run
// after the first, we need to skip `initialise()` ourselves and go straight
// to `start()`. PG_VERSION is the marker file Postgres itself writes once
// initdb has completed successfully.
const alreadyInitialised = existsSync(join(dataDir, "PG_VERSION"));

// Force UTF-8 (via the locale-independent "C" collation) regardless of the
// host OS's default locale/codepage. Without this, `initdb` on a US-English
// Windows machine defaults to encoding "WIN1252", which then throws a real
// runtime error ("character ... has no equivalent in encoding WIN1252")
// the first time the agent's reply contains an ordinary Unicode character
// (curly quotes, em/en dashes, non-English text, etc.) that Windows-1252
// can't represent -- found live 2026-09-20 testing the chat feature.
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: "postgres",
  password: "postgres",
  port: 55432,
  persistent: true,
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
});

async function main() {
  console.log(`Starting local Postgres in ${dataDir} (first run initializes it; may take a few seconds) ...`);
  if (!alreadyInitialised) {
    await pg.initialise();
  }
  await pg.start();
  try {
    await pg.createDatabase("mai_chat");
    console.log("Created database 'mai_chat'.");
  } catch (err) {
    // Already exists on every run after the first -- not an error.
    if (!String(err?.message ?? err).toLowerCase().includes("already exists")) throw err;
  }
  console.log("Postgres is ready on postgres://postgres:postgres@localhost:55432/mai_chat");
  console.log("Run `npm run migrate` once, then `npm run dev` (in another terminal) to start the app.");
  console.log("Press Ctrl+C to stop this database.");

  const shutdown = async () => {
    console.log("\nStopping Postgres...");
    await pg.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Failed to start local Postgres:", err);
  process.exit(1);
});
