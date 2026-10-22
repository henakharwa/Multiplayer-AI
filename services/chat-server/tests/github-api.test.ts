import { describe, expect, it } from "vitest";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { createGithubTeamApi, githubAppJwt } from "../src/github-api.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

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
  it("signs a GitHub App JWT with RS256 that the public key verifies", () => {
    const jwt = githubAppJwt("12345", pem, Date.parse("2026-10-22T00:00:00Z"));
    const [header, payload, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(claims.iss).toBe("12345");
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });

  it("maps repository permissions to write, read or none, and caches the answer", async () => {
    const { impl, calls } = fakeFetch({
      "GET /repos/acme/web": { body: { permissions: { pull: true, push: true } } },
      "GET /repos/acme/docs": { body: { permissions: { pull: true, push: false } } },
    });
    const api = createGithubTeamApi({}, impl);
    expect(await api.getRepoAccess("t", "acme", "web")).toBe("write");
    expect(await api.getRepoAccess("t", "acme", "docs")).toBe("read");
    expect(await api.getRepoAccess("t", "acme", "secret")).toBe("none");
    expect(await api.getRepoAccess("t", "acme", "web")).toBe("write");
    expect(calls.filter((call) => call.url.endsWith("/repos/acme/web"))).toHaveLength(1);
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe("token t");
  });

  it("gets and caches an installation token for a repository when the App is configured", async () => {
    const { impl, calls } = fakeFetch({
      "GET /repos/acme/web/installation": { body: { id: 77 } },
      "POST /app/installations/77/access_tokens": { status: 201, body: { token: "ghs_installation", expires_at: new Date(Date.now() + 3_600_000).toISOString() } },
    });
    const api = createGithubTeamApi({ GITHUB_APP_ID: "12345", GITHUB_APP_SLUG: "nexus", GITHUB_APP_PRIVATE_KEY_BASE64: Buffer.from(pem).toString("base64"), GITHUB_APP_WEBHOOK_SECRET: "s" }, impl);
    expect(api.app.configured()).toBe(true);
    expect(api.app.installUrl()).toBe("https://github.com/apps/nexus/installations/new");
    expect(api.app.botLogin()).toBe("nexus[bot]");
    expect(await api.app.installationToken("acme", "web")).toBe("ghs_installation");
    expect(await api.app.installationToken("acme", "web")).toBe("ghs_installation");
    expect(calls.filter((call) => call.url.includes("access_tokens"))).toHaveLength(1);
    expect((calls[0].init.headers as Record<string, string>).authorization).toMatch(/^Bearer ey/);
    expect(await api.app.installationToken("acme", "elsewhere")).toBeNull();
  });

  it("is unconfigured without App settings and explains webhook permission problems", async () => {
    const { impl } = fakeFetch({ "POST /repos/acme/web/hooks": { status: 404, body: { message: "Not Found" } } });
    const api = createGithubTeamApi({}, impl);
    expect(api.app.configured()).toBe(false);
    await expect(api.createRepoWebhook("t", "acme", "web", { url: "https://x", secret: "s", events: ["issues"] })).rejects.toThrow(/needs admin access to acme\/web/);
  });
});
