import { describe, it, expect, vi } from "vitest";
import { createGithubClient } from "../src/github.js";

// createGithubClient is now only used to verify a pasted GitHub
// token/owner/repo before saving it (see github.ts's top-of-file comment)
// -- the agent's actual GitHub tool surface comes from GitHub's own MCP
// server instead (github-mcp-pool.ts / mcp-tools.ts). Only the one method
// this client still has (listIssues) is tested here.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createGithubClient", () => {
  it("listIssues filters out pull requests (GitHub's issues endpoint returns both)", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const u = url.toString();
      expect(u).toContain("/repos/octocat/hello-world/issues");
      return jsonResponse([
        {
          number: 1,
          title: "A real issue",
          state: "open",
          user: { login: "alice" },
          html_url: "https://github.com/octocat/hello-world/issues/1",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
          labels: [{ name: "bug" }, "needs-triage"],
        },
        {
          number: 2,
          title: "This is actually a PR",
          state: "open",
          user: { login: "bob" },
          html_url: "https://github.com/octocat/hello-world/pull/2",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
          labels: [],
          pull_request: { url: "https://api.github.com/repos/octocat/hello-world/pulls/2" },
        },
      ]);
    });

    const client = createGithubClient({
      token: "fake-token",
      owner: "octocat",
      repo: "hello-world",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const issues = await client.listIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual({
      number: 1,
      title: "A real issue",
      state: "open",
      author: "alice",
      url: "https://github.com/octocat/hello-world/issues/1",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      labels: ["bug", "needs-triage"],
    });
  });

  it("propagates a real GitHub error (e.g. bad token) instead of swallowing it", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: "Bad credentials" }, 401));
    const client = createGithubClient({
      token: "bad-token",
      owner: "o",
      repo: "r",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(client.listIssues()).rejects.toThrow();
  });
});
