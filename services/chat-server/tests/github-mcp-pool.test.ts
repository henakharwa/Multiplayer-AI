import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mocks the two SDK pieces this module drives directly -- a real
// StdioClientTransport would actually try to spawn `docker`, which these
// unit tests have no business doing (that's what a real Docker Desktop +
// this project's manual setup steps are for). Everything in
// github-mcp-pool.ts *around* those two calls -- the fingerprint/reuse
// logic, and in particular the exact env/args handed to `docker run` --
// is real code under test here.
const connectMock = vi.fn(async () => {});
const closeMock = vi.fn(async () => {});
let lastTransportArgs: { command: string; args: string[]; env: Record<string, string> } | null = null;

// `new Client(...)` / `new StdioClientTransport(...)` in the real source
// require actual constructors -- an arrow function passed to
// vi.fn().mockImplementation() can't be invoked with `new`, so these are
// plain `function` mocks instead.
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn(function Client(this: { connect: typeof connectMock }) {
    this.connect = connectMock;
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  getDefaultEnvironment: () => ({ PATH: "/usr/bin" }),
  StdioClientTransport: vi.fn(function StdioClientTransport(
    this: { close: typeof closeMock },
    params: { command: string; args: string[]; env: Record<string, string> }
  ) {
    lastTransportArgs = params;
    this.close = closeMock;
  }),
}));

const { getGithubMcpClient, closeAllGithubMcpClients, DEFAULT_GITHUB_MCP_IMAGE, DEFAULT_GITHUB_TOOLS } = await import("../src/github-mcp-pool.js");

beforeEach(() => {
  connectMock.mockClear();
  closeMock.mockClear();
  lastTransportArgs = null;
});

afterEach(async () => {
  await closeAllGithubMcpClients();
});

describe("getGithubMcpClient", () => {
  it("includes list_issues in the small default GitHub surface", () => {
    // Regression coverage: the curated list exposed issue details but
    // omitted GitHub's collection-level issue listing tool, so a connected
    // GitHub agent could not answer the most basic "list open issues"
    // request even though the MCP server was healthy.
    expect(DEFAULT_GITHUB_TOOLS.split(",")).toContain("list_issues");
  });

  // Regression test for a real incident found live 2026-09-21: .env's
  // GITHUB_MCP_DOCKER_IMAGE= (present but blank, not commented out) was
  // passed straight through as `image: ""`, and `"" ?? DEFAULT_...`
  // doesn't fall back (`??` only catches null/undefined, not ""), so
  // `docker run` was invoked with an empty image name -- surfaced as
  // `Couldn't start the GitHub MCP server via Docker (image "")`.
  it("falls back to the default image when an empty string is given, not just when it's undefined", async () => {
    await getGithubMcpClient("ws-1", { token: "t", image: "" });
    expect(lastTransportArgs!.command).toBe("docker");
    expect(lastTransportArgs!.args[lastTransportArgs!.args.length - 1]).toBe(DEFAULT_GITHUB_MCP_IMAGE);
  });

  it("passes the token by reference (-e NAME, no value) rather than in argv", async () => {
    await getGithubMcpClient("ws-2", { token: "ghp_supersecret" });
    expect(lastTransportArgs!.args).toContain("GITHUB_PERSONAL_ACCESS_TOKEN");
    expect(lastTransportArgs!.args.join(" ")).not.toContain("ghp_supersecret");
    expect(lastTransportArgs!.env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("ghp_supersecret");
  });

  it("only adds -e flags for toolsets/tools when they're actually set (and not just empty strings)", async () => {
    await getGithubMcpClient("ws-3", { token: "t", toolsets: "", tools: "" });
    expect(lastTransportArgs!.args).not.toContain("GITHUB_TOOLSETS");
    expect(lastTransportArgs!.args).not.toContain("GITHUB_TOOLS");

    await getGithubMcpClient("ws-4", { token: "t", toolsets: "repos,issues" });
    expect(lastTransportArgs!.args).toContain("GITHUB_TOOLSETS");
    expect(lastTransportArgs!.env.GITHUB_TOOLSETS).toBe("repos,issues");
  });

  it("reuses the same client for an unchanged workspace/config instead of starting a second container", async () => {
    const first = await getGithubMcpClient("ws-5", { token: "t" });
    const second = await getGithubMcpClient("ws-5", { token: "t" });
    expect(second).toBe(first);
    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it("replaces the container when the workspace's token changes", async () => {
    await getGithubMcpClient("ws-6", { token: "old-token" });
    await getGithubMcpClient("ws-6", { token: "new-token" });
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(lastTransportArgs!.env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("new-token");
  });
});
