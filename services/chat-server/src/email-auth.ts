import type { Express } from "express";
import * as db from "@mai-chat/db";
import { hashPassword, verifyPassword } from "./passwords.js";
import { issueSession, type UserAuthConfig } from "./auth.js";
import { sendVerificationEmail } from "./email-verification.js";
import { createMailer, defaultMailerConfig, type Mailer } from "./mailer.js";

export function registerEmailAuthRoutes(app: Express, config: UserAuthConfig, mailer: Mailer = createMailer(defaultMailerConfig())): void {
  const attempts = new Map<string, { count: number; expiresAt: number }>();
  app.post(["/auth/signup/email", "/auth/login/email"], async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    // JSON and same-origin requests only, including login-CSRF protection.
    if (!req.is("application/json") || (req.headers.origin && req.headers.origin !== config.webAppUrl)) {
      return res.status(403).json({ error: "Invalid sign-in request." });
    }
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const signup = req.path === "/auth/signup/email";
    const displayName = typeof req.body?.displayName === "string" ? req.body.displayName.trim() : "";
    const now = Date.now();
    for (const [key, value] of attempts) if (value.expiresAt <= now) attempts.delete(key);
    // Bound expensive password work per IP and per account on this server.
    const limits: [string, number][] = [[`ip:${req.ip}`, 30], [`email:${email}`, 10]];
    if (limits.some(([key, max]) => (attempts.get(key)?.count ?? 0) >= max)) {
      res.setHeader("Retry-After", "900");
      return res.status(429).json({ error: "Too many sign-in attempts. Try again in 15 minutes." });
    }
    for (const [key] of limits) {
      const entry = attempts.get(key) ?? { count: 0, expiresAt: now + 15 * 60 * 1000 };
      entry.count++; attempts.set(key, entry);
    }
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password || password.length > 128) {
      return res.status(400).json({ error: "Enter a valid email and a password of at most 128 characters." });
    }
    if (signup && (password.length < 12 || !displayName || displayName.length > 80)) {
      return res.status(400).json({ error: "Enter your name (up to 80 characters) and a password of at least 12 characters." });
    }
    try {
      let user;
      if (signup && config.emailVerificationEnabled) {
        user = await db.createPasswordUser({
          email,
          displayName,
          passwordHash: await hashPassword(password),
          // When verification is deliberately disabled, do not leave new
          // accounts in a misleading permanently-unverified state.
          emailVerified: !config.emailVerificationEnabled,
        });
      } else {
        const credential = await db.getPasswordCredential(email);
        const matches = await verifyPassword(password, credential?.passwordHash ?? null);
        if (!matches || !credential) return res.status(401).json({ error: "Incorrect email or password." });
        user = await db.getUserById(credential.userId);
      }
      if (!user) return res.status(401).json({ error: "Incorrect email or password." });
      await issueSession(res, user.id, config);
      res.status(signup ? 201 : 200).json(user);
      if (signup) {
        // Fire-and-forget from the response's point of view -- signup
        // already succeeded and the session is already issued; a slow or
        // failing mail provider shouldn't turn a successful signup into
        // an error response. Failures are logged, not surfaced to the
        // client (they can always ask for a resend from the app once
        // signed in).
        void sendVerificationEmail(user, email, config, mailer).catch((error) => {
          console.error(`[email-auth] couldn't send the verification email to a new signup:`, error);
        });
      }
    } catch (error) {
      if (signup && (error as { code?: string }).code === "23505") {
        return res.status(409).json({ error: "Unable to create an account with this email. Try signing in." });
      }
      res.status(503).json({ error: "Sign-in is temporarily unavailable. Please try again." });
    }
  });
}
