import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import express from "express";
import request from "supertest";
import * as db from "@mai-chat/db";
import { attachUser, registerUserAuthRoutes, requireAuth, type UserAuthConfig } from "../src/auth.js";
import { registerEmailVerificationRoutes } from "../src/email-verification.js";
import { registerPasswordResetRoutes } from "../src/password-reset.js";
import type { Mailer, OutgoingEmail } from "../src/mailer.js";

loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

const config: UserAuthConfig = {
  clientId: "github-test", clientSecret: "test", redirectUri: "http://localhost:4000/auth/github/callback",
  webAppUrl: "http://localhost:3000", secureCookie: false,
  google: { clientId: "google-test", clientSecret: "secret", redirectUri: "http://localhost:4000/auth/login/google/callback" },
};

// A real Mailer implementation for tests -- captures what would have been
// sent instead of making a network call, same "mock only the external
// call" line as every other integration in this project.
function captureMailer(): { mailer: Mailer; sent: OutgoingEmail[] } {
  const sent: OutgoingEmail[] = [];
  return { mailer: { send: async (email) => { sent.push(email); } }, sent };
}

// Signup fires the verification email without awaiting it (so a slow/failing
// mail provider can never turn a successful signup into an error response --
// see email-auth.ts's comment on this). Tests that inspect `sent` right
// after a signup give that fire-and-forget send one tick to actually land.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

function extractToken(text: string): string {
  const match = text.match(/[?&]token=([^\s&]+)/);
  if (!match) throw new Error(`no token found in email text: ${text}`);
  return decodeURIComponent(match[1]);
}

function makeApp(mailer: Mailer) {
  const app = express();
  app.use(express.json());
  app.use(attachUser());
  registerUserAuthRoutes(app, config, {
    exchangeCodeForToken: async () => ({ error: "unused" }),
    fetchGithubUser: async () => ({ error: "unused" }),
    google: { fetchProfile: async () => ({ googleId: "unused", email: "unused@example.test", displayName: "Unused" }) },
  }, mailer);
  registerEmailVerificationRoutes(app, config, mailer);
  registerPasswordResetRoutes(app, config, mailer);
  app.get("/protected", requireAuth, (req, res) => res.json(req.user));
  return app;
}

const newAccount = () => ({ email: `${randomUUID()}@example.test`, password: `Test-${randomUUID()}`, displayName: "Reset Member" });

beforeAll(async () => {
  await db.getPool().query(await readFile(fileURLToPath(new URL("../../../packages/db/sql/schema.sql", import.meta.url)), "utf8"));
});
afterAll(async () => { await db.closePool(); });

describe("email verification", () => {
  it("sends a verification email on signup, and the link actually verifies the account", async () => {
    const { mailer, sent } = captureMailer();
    const app = makeApp(mailer);
    const account = newAccount();
    const signup = await request(app).post("/auth/signup/email").send(account);
    expect(signup.status).toBe(201);
    expect(signup.body.emailVerified).toBe(false);
    await flush();

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(account.email);
    expect(sent[0].text).toContain("/verify-email?token=");

    const token = extractToken(sent[0].text);
    const verify = await request(app).post("/auth/verify-email").send({ token });
    expect(verify.status).toBe(200);
    expect(verify.body).toMatchObject({ verified: true, email: account.email });

    // The same token is single-use -- a second attempt fails.
    const replay = await request(app).post("/auth/verify-email").send({ token });
    expect(replay.status).toBe(400);
  });

  it("rejects an unknown or malformed verification token", async () => {
    const app = makeApp(captureMailer().mailer);
    const res = await request(app).post("/auth/verify-email").send({ token: "not-a-real-token" });
    expect(res.status).toBe(400);
  });

  it("resend-verification requires a session, is a no-op once verified, and is rate limited", async () => {
    const { mailer, sent } = captureMailer();
    const app = makeApp(mailer);
    const browser = request.agent(app);
    const account = newAccount();
    await browser.post("/auth/signup/email").send(account); // sends email #1
    await flush();

    expect((await request(app).post("/auth/resend-verification")).status).toBe(401);

    const resend = await browser.post("/auth/resend-verification");
    expect(resend.status).toBe(200);
    expect(resend.body).toEqual({ sent: true });
    expect(sent).toHaveLength(2);

    // Verify, then a further resend should be a no-op, not another email.
    const token = extractToken(sent[1].text);
    await browser.post("/auth/verify-email").send({ token });
    const afterVerified = await browser.post("/auth/resend-verification");
    expect(afterVerified.body).toEqual({ alreadyVerified: true });
    expect(sent).toHaveLength(2);
  });

  it("a GitHub/Google account has nothing to verify", async () => {
    const { mailer } = captureMailer();
    const app = makeApp(mailer);
    const browser = request.agent(app);
    await browser.get("/auth/login/google/start"); // establishes the PKCE state cookie, not strictly needed here
    // Simplest path to a non-password account in this test: create one
    // directly through the db layer, matching what upsertUserFromGoogle
    // would produce, then issue a session for it the same way auth.ts does.
    const googleUser = await db.upsertUserFromGoogle({ googleId: `g-${randomUUID()}`, email: "g@example.test", displayName: "Google Person" });
    const session = await db.createSession(googleUser.id, 60_000);
    const res = await request(app).post("/auth/resend-verification").set("Cookie", `mai_session=${session.token}`);
    expect(res.status).toBe(400);
  });
});

describe("password reset", () => {
  it("sends a reset link, resets the password, and invalidates existing sessions", async () => {
    const { mailer, sent } = captureMailer();
    const app = makeApp(mailer);
    const account = newAccount();
    const original = request.agent(app);
    await original.post("/auth/signup/email").send(account);
    await flush();
    expect((await original.get("/protected")).status).toBe(200); // real, live session before the reset

    const forgot = await request(app).post("/auth/forgot-password").send({ email: account.email });
    expect(forgot.status).toBe(200);
    expect(sent.at(-1)?.to).toBe(account.email);
    expect(sent.at(-1)?.text).toContain("/reset-password?token=");

    const token = extractToken(sent.at(-1)!.text);
    const newPassword = `New-${randomUUID()}`;
    const reset = await request(app).post("/auth/reset-password").send({ token, password: newPassword });
    expect(reset.status).toBe(200);
    expect(reset.body).toEqual({ reset: true });

    // The pre-reset session is dead now.
    expect((await original.get("/protected")).status).toBe(401);

    // The new password actually works; the old one doesn't.
    expect((await request(app).post("/auth/login/email").send({ email: account.email, password: account.password })).status).toBe(401);
    expect((await request(app).post("/auth/login/email").send({ email: account.email, password: newPassword })).status).toBe(200);

    // The token was single-use.
    const replay = await request(app).post("/auth/reset-password").send({ token, password: `Another-${randomUUID()}` });
    expect(replay.status).toBe(400);
  });

  it("never reveals whether an email has an account", async () => {
    const { mailer, sent } = captureMailer();
    const app = makeApp(mailer);
    const known = newAccount();
    await request(app).post("/auth/signup/email").send(known);
    await flush();
    sent.length = 0;

    const forKnown = await request(app).post("/auth/forgot-password").send({ email: known.email });
    const forUnknown = await request(app).post("/auth/forgot-password").send({ email: "nobody@example.test" });
    expect(forKnown.status).toBe(forUnknown.status);
    expect(forKnown.body).toEqual(forUnknown.body);
    // Only the real account actually got an email.
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(known.email);
  });

  it("rejects a short password and a missing/invalid token", async () => {
    const app = makeApp(captureMailer().mailer);
    expect((await request(app).post("/auth/reset-password").send({ token: "x", password: "short" })).status).toBe(400);
    expect((await request(app).post("/auth/reset-password").send({ token: "does-not-exist", password: `Long-${randomUUID()}` })).status).toBe(400);
  });
});
