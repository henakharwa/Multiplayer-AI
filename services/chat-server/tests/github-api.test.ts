import { describe, expect, it } from "vitest";
import { createGithubTeamApi } from "../src/github-api.js";

function fakeFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const path = String(url).replace("https://api.github.com", "");
    const route = routes[`${init.method ?? "GET"} ${path}`] ?? { status: 404, body: { message: "Not Found" } };
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

describe("github-api", () => {
  it("maps repository permissions to write, read or none, and caches the answer", async () => {
    const { impl, calls } = fakeFetch({
      "GET /repos/acme/web": { body: { permissions: { pull: true, push: true } } },
      "GET /repos/acme/docs": { body: { permissions: { pull: true, push: false } } },
      "GET /repos/acme/odd": { body: {} },
    });
    const api = createGithubTeamApi(impl);
    expect(await api.getRepoAccess("t", "acme", "web")).toBe("write");
    expect(await api.getRepoAccess("t", "acme", "docs")).toBe("read");
    expect(await api.getRepoAccess("t", "acme", "secret")).toBe("none");
    // No permissions in the reply: don't guess.
    expect(await api.getRepoAccess("t", "acme", "odd")).toBe("unknown");
    expect(await api.getRepoAccess("t", "acme", "web")).toBe("write");
    expect(calls.filter((call) => call.url.endsWith("/repos/acme/web"))).toHaveLength(1);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("token t");
  });

  it("explains webhook permission problems", async () => {
    const { impl } = fakeFetch({ "POST /repos/acme/web/hooks": { status: 404, body: { message: "Not Found" } } });
    const api = createGithubTeamApi(impl);
    await expect(api.createRepoWebhook("t", "acme", "web", { url: "https://x", secret: "s", events: ["issues"] })).rejects.toThrow(/needs admin access to acme\/web/);
  });
});
