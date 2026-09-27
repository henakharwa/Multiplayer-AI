#!/usr/bin/env node
// Destructive operator command. It keeps the schema and migrations intact
// while removing every workspace, membership, conversation, action, session,
// integration, and user account through Postgres foreign-key cascades.
import { config as loadEnv } from "dotenv";
import { Pool } from "pg";

loadEnv();

if (process.env.CONFIRM_DATABASE_RESET !== "DELETE_ALL_USERS_AND_WORKSPACES") {
  console.error("Refusing to reset. Set CONFIRM_DATABASE_RESET=DELETE_ALL_USERS_AND_WORKSPACES.");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  await pool.query("TRUNCATE TABLE workspaces, users RESTART IDENTITY CASCADE");
  console.log("Database reset complete: all workspaces and user accounts were removed.");
} finally {
  await pool.end();
}
