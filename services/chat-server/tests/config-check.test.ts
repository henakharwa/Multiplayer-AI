import { describe, it, expect } from "vitest";
import { checkProductionConfig } from "../src/config-check.js";

const base = { NODE_ENV: "production", DATABASE_URL: "postgres://db", INTEGRATION_ENCRYPTION_KEY: "key", WEB_APP_URL: "https://app.example.com", CHAT_SERVER_PUBLIC_URL: "https://app.example.com/api" };

describe("production config check", () => {
  it("passes a complete production configuration", () => {
    expect(checkProductionConfig(base)).toEqual([]);
  });
  it("is silent in development", () => {
    expect(checkProductionConfig({ NODE_ENV: "development" })).toEqual([]);
  });
  it("treats missing core settings and a localhost web origin as fatal", () => {
    const problems = checkProductionConfig({ NODE_ENV: "production", WEB_APP_URL: "http://localhost:3000" });
    expect(problems.filter((p) => p.fatal).map((p) => p.name).sort()).toEqual(["DATABASE_URL", "INTEGRATION_ENCRYPTION_KEY", "WEB_APP_URL"]);
  });
  it("warns, without stopping, when the public URL is missing", () => {
    const { CHAT_SERVER_PUBLIC_URL: _omit, ...rest } = base;
    const problems = checkProductionConfig(rest);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ name: "CHAT_SERVER_PUBLIC_URL", fatal: false });
  });
});
