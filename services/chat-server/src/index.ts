import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { createChatServer } from "./server.js";
import { closeAllGithubMcpClients } from "./github-mcp-pool.js";

loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
loadEnv();

export { createChatServer, createApp } from "./server.js";
export { runAgentTurn } from "./agent.js";
export * from "./tools.js";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? process.env.CHAT_SERVER_PORT ?? 4000);
  createChatServer().start(port);

  // Each connected workspace's GitHub MCP server (github-mcp-pool.ts) is a
  // real, separate `docker run` container process this one spawned. Without
  // this, `npm run dev:server`'s file-watcher (tsx watch) restarting on
  // every save -- or a plain Ctrl+C -- would leave those containers running
  // in the background instead of exiting with their parent, silently
  // piling up orphaned github-mcp-server containers over a dev session.
  const shutdown = () => {
    void closeAllGithubMcpClients().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
