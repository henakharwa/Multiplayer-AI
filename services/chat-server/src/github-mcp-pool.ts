import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

// Runs GitHub's own official MCP server (github/github-mcp-server) as a
// local Docker container over stdio -- this project's replacement for the
// hand-rolled Octokit tool surface that used to live in
// packages/integrations/src/github.ts + this package's tools.ts. Uses
// GitHub's own published image (ghcr.io/github/github-mcp-server) via
// `docker run -i --rm ...`, GitHub's primary supported distribution of
// this server -- see README.md's "GitHub tools via MCP server" section
// for the one-time setup (Docker Desktop installed and running) this
// assumes.
//
// One long-lived container + client PER WORKSPACE, not one shared
// globally: github-mcp-server reads GITHUB_PERSONAL_ACCESS_TOKEN once, at
// container-start time, from its environment -- there's no way to hand it
// a different token per request. This app is multi-tenant (each workspace
// connects its own GitHub account), so a single shared container would
// leak one workspace's GitHub access to every other workspace's chat.
// Keying the pool by workspaceId, and re-spawning whenever that
// workspace's fingerprint (token + configured toolsets/tools) changes,
// keeps each workspace's MCP server bound to exactly the credentials it
// connected.
export interface GithubMcpOptions {
  token: string;
  /** ghcr.io/github/github-mcp-server by default -- override to pin a specific tag/digest. */
  image?: string;
  /** GITHUB_TOOLSETS value, e.g. "context,repos,issues,pull_requests". Comma-separated toolset names, or "all". */
  toolsets?: string;
  /** GITHUB_TOOLS value -- an explicit allow-list of individual tool names, additive with toolsets. */
  tools?: string;
}

export const DEFAULT_GITHUB_MCP_IMAGE = "ghcr.io/github/github-mcp-server";

interface PoolEntry {
  fingerprint: string;
  client: Client;
  close: () => Promise<void>;
}

const pool = new Map<string, PoolEntry>();

// `??` alone doesn't help when a value is a present-but-empty string, and
// that's exactly what a `.env` line left as `KEY=` (rather than omitted
// or commented out) loads as -- this project has hit that same gap once
// before (see llm-client.ts's firstNonEmpty). Applied here to every
// env-sourced field on GithubMcpOptions so a blank GITHUB_MCP_DOCKER_IMAGE
// / GITHUB_TOOLSETS / GITHUB_TOOLS behaves the same as leaving it unset,
// instead of silently trying to `docker run` an empty image name (a real
// incident, found live 2026-09-21: "Couldn't start the GitHub MCP server
// via Docker (image \"\")").
function nonEmpty(value: string | undefined): string | undefined {
  return value ? value : undefined;
}

function fingerprintOf(opts: GithubMcpOptions): string {
  return JSON.stringify({
    image: nonEmpty(opts.image) ?? DEFAULT_GITHUB_MCP_IMAGE,
    token: opts.token,
    toolsets: nonEmpty(opts.toolsets) ?? "",
    tools: nonEmpty(opts.tools) ?? "",
  });
}

// Returns a connected MCP client for this workspace, starting a
// github-mcp-server container if there isn't one yet, or replacing it if
// the workspace's image/token/toolsets/tools have changed since the last
// call (e.g. someone disconnected and reconnected GitHub with a different
// account). An unchanged fingerprint reuses the existing
// container/client as-is -- starting a fresh container on every single
// chat turn would make every reply pay for `docker run`'s own startup
// (plus a first-time image pull) instead of just once per credential
// change.
export async function getGithubMcpClient(workspaceId: string, opts: GithubMcpOptions): Promise<Client> {
  const fingerprint = fingerprintOf(opts);
  const existing = pool.get(workspaceId);
  if (existing && existing.fingerprint === fingerprint) return existing.client;
  if (existing) {
    pool.delete(workspaceId);
    await existing.close().catch(() => {});
  }

  const image = nonEmpty(opts.image) ?? DEFAULT_GITHUB_MCP_IMAGE;
  // In production images, use GitHub's official MCP binary directly. Local
  // development continues to use Docker Desktop by leaving this unset.
  const directCommand = nonEmpty(process.env.GITHUB_MCP_COMMAND);

  // Values are handed to `docker run` by REFERENCE (`-e NAME`, no
  // `=value`), not written into argv (`-e NAME=value`) -- the token/config
  // are set on the *docker CLI's own* spawned-process environment below,
  // and `-e NAME` tells docker to forward that var from its own
  // environment into the container. This keeps the token out of the
  // command line (visible to any other process/tool that can list this
  // machine's running processes and their arguments), the same property
  // the previous downloaded-binary approach had by only ever passing the
  // token via environment, never a CLI argument.
  const env: Record<string, string> = {
    ...getDefaultEnvironment(),
    GITHUB_PERSONAL_ACCESS_TOKEN: opts.token,
  };
  const args = directCommand ? ["stdio"] : ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN"];
  if (opts.toolsets) {
    env.GITHUB_TOOLSETS = opts.toolsets;
    if (directCommand) args.push("--toolsets", opts.toolsets);
    else args.push("-e", "GITHUB_TOOLSETS");
  }
  if (opts.tools) {
    env.GITHUB_TOOLS = opts.tools;
    if (directCommand) args.push("--tools", opts.tools);
    else args.push("-e", "GITHUB_TOOLS");
  }
  if (!directCommand) args.push(image);

  const transport = new StdioClientTransport({
    command: directCommand ?? "docker",
    args,
    env,
  });
  const client = new Client({ name: "multiplayer-ai-chat-server", version: "0.1.0" });

  // Diagnostic timing (temporary, 2026-09-21): a fresh container start
  // here is a real, one-time-per-credential-change cost -- `docker run`
  // has to start a new container (and pull the image the very first
  // time), which can take several seconds even though it has nothing to
  // do with the LLM. Reused connections (same fingerprint) skip this
  // entirely -- see getGithubMcpClient's cache check above.
  const connectStart = Date.now();
  try {
    await client.connect(transport);
  } catch (err) {
    await transport.close().catch(() => {});
    throw new Error(
      directCommand
        ? `Couldn't start the GitHub MCP server command "${directCommand}": ${err instanceof Error ? err.message : String(err)}.`
        : `Couldn't start the GitHub MCP server via Docker (image "${image}"): ${err instanceof Error ? err.message : String(err)}. ` +
          `Make sure Docker Desktop is installed AND RUNNING, and that "docker" is on this process's PATH -- see README.md's ` +
          `"GitHub tools via MCP server" section. The first run also needs network access to pull the image.`
    );
  }
  console.log(`[timing] GitHub MCP container start (docker run, image "${image}") took ${Date.now() - connectStart}ms`);

  pool.set(workspaceId, { fingerprint, client, close: () => transport.close() });
  return client;
}

/** Closes and forgets one workspace's MCP server container, if it has one. */
export async function closeGithubMcpClient(workspaceId: string): Promise<void> {
  const existing = pool.get(workspaceId);
  if (!existing) return;
  pool.delete(workspaceId);
  await existing.close().catch(() => {});
}

/** Closes every pooled MCP server container -- for graceful shutdown and test teardown. */
export async function closeAllGithubMcpClients(): Promise<void> {
  const entries = [...pool.values()];
  pool.clear();
  await Promise.all(entries.map((e) => e.close().catch(() => {})));
}

// A deliberately small default GITHUB_TOOLS list rather than a whole
// GITHUB_TOOLSETS category (e.g. the server's own "default" toolset --
// context+repos+issues+pull_requests+users -- measures out to roughly
// 8-12k tokens of tool-schema JSON by itself, verified 2026-09-21 against
// the actual v1.12.2 tool descriptions: already at or past this project's
// entire local-Ollama context window of 8192 tokens, before the system
// prompt, Slack's tools, or a single word of conversation history are
// added). These 14 cover the core "read/act on issues, PRs, files,
// commits, branches" workflow this project's chat is built around, sized
// to leave real room for history -- agent.ts logs the actual measured
// token cost of whatever tool set ends up configured every turn, so this
// can be widened (via the GITHUB_TOOLS or GITHUB_TOOLSETS env vars -- see
// README.md) once you can see the real numbers for your setup.
export const DEFAULT_GITHUB_TOOLS =
  "get_me,issue_read,issue_write,add_issue_comment,pull_request_read,list_pull_requests," +
  "create_pull_request,merge_pull_request,get_file_contents,create_or_update_file," +
  "create_branch,list_commits,list_branches,search_code";
