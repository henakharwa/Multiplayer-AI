import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mocks the two SDK pieces this module drives directly -- a real
// StreamableHTTPClientTransport would actually try to reach
// mcp.slack.com, which these unit tests have no business doing. Same
// "mock only the external network call" line github-mcp-pool.test.ts
// draws for its own Docker/stdio equivalent -- the fingerprint/reuse
// logic, and in particular the exact URL/headers handed to the
// transport, is real code under test here.
const connectMock = vi.fn(async () => {});
const closeMock = vi.fn(async () => {});
let lastTransportArgs: { url: URL; opts: { requestInit?: { headers?: Record<string, string> } } } | null = null;

// `new Client(...)` / `new StreamableHTTPClientTransport(...)` in the real
// source require actual constructors -- an arrow function passed to
// vi.fn().mockImplementation() can't be invoked with `new`, so these are
// plain `function` mocks instead (same pattern github-mcp-pool.test.ts
// uses for the same reason).
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn(function Client(this: { connect: typeof connectMock }) {
    this.connect = connectMock;
  }),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn(function StreamableHTTPClientTransport(
    this: { close: typeof closeMock },
    url: URL,
    opts: { requestInit?: { headers?: Record<string, string> } }
  ) {
    lastTransportArgs = { url, opts };
    this.close = closeMock;
  }),
}));

const { getSlackMcpClient, closeAllSlackMcpClients, DEFAULT_SLACK_MCP_URL } = await import("../src/slack-mcp-pool.js");

beforeEach(() => {
  connectMock.mockClear();
  closeMock.mockClear();
  lastTransportArgs = null;
});

afterEach(async () => {
  await closeAllSlackMcpClients();
});

describe("getSlackMcpClient", () => {
  it("connects to Slack's real MCP endpoint by default, with the access token as a Bearer header", async () => {
    await getSlackMcpClient("ws-1", { accessToken: "xoxp-supersecret" });
    expect(lastTransportArgs!.url.toString()).toBe(DEFAULT_SLACK_MCP_URL);
    expect(lastTransportArgs!.opts.requestInit?.headers?.authorization).toBe("Bearer xoxp-supersecret");
    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it("honors a serverUrl override (e.g. a local stand-in for testing)", async () => {
    await getSlackMcpClient("ws-2", { accessToken: "t", serverUrl: "http://localhost:9999/mcp" });
    expect(lastTransportArgs!.url.toString()).toBe("http://localhost:9999/mcp");
  });

  it("reuses the same client for an unchanged workspace/token instead of reconnecting", async () => {
    const first = await getSlackMcpClient("ws-3", { accessToken: "t" });
    const second = await getSlackMcpClient("ws-3", { accessToken: "t" });
    expect(second).toBe(first);
    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it("reconnects when the workspace's access token changes (e.g. a reconnect/refresh)", async () => {
    await getSlackMcpClient("ws-4", { accessToken: "old-token" });
    await getSlackMcpClient("ws-4", { accessToken: "new-token" });
    expect(connectMock).toHaveBeenCalledTimes(2);
    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(lastTransportArgs!.opts.requestInit?.headers?.authorization).toBe("Bearer new-token");
  });

  it("wraps a connection failure with a clear, actionable error instead of the raw SDK error", async () => {
    connectMock.mockRejectedValueOnce(new Error("401 Unauthorized"));
    await expect(getSlackMcpClient("ws-5", { accessToken: "expired" })).rejects.toThrow(/Couldn't connect to Slack's MCP server/);
  });
});
