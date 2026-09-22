import { createHash, randomBytes } from "node:crypto";
import type { Express } from "express";
import * as db from "@mai-chat/db";
import { issueSession, safeReturnTo, type UserAuthConfig } from "./auth.js";

export interface GoogleAuthConfig { clientId: string; clientSecret: string; redirectUri: string; }
export interface GoogleProfile { googleId: string; email: string; displayName: string; avatarUrl?: string; }
export interface GoogleAuthDeps {
  fetchProfile: (code: string, verifier: string, config: GoogleAuthConfig) => Promise<GoogleProfile>;
}

export const defaultGoogleAuthDeps: GoogleAuthDeps = {
  async fetchProfile(code, verifier, config) {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: config.clientId, client_secret: config.clientSecret,
        redirect_uri: config.redirectUri, grant_type: "authorization_code", code_verifier: verifier }),
      signal: AbortSignal.timeout(15000),
    });
    const token = await response.json() as { access_token?: string };
    if (!response.ok || !token.access_token) throw new Error("Google couldn't complete sign-in. Please try again.");
    // Obtain identity from Google's authenticated HTTPS UserInfo endpoint.
    // Never decode and trust an unverified ID token, or use email as the ID.
    const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(15000),
    });
    const profile = await profileResponse.json() as { sub?: string; email?: string; email_verified?: boolean; name?: string; picture?: string };
    if (!profileResponse.ok || !profile.sub || !profile.email || profile.email_verified !== true) {
      throw new Error("Google couldn't verify your account. Please try another sign-in method.");
    }
    return { googleId: profile.sub, email: profile.email, displayName: profile.name || profile.email, avatarUrl: profile.picture };
  },
};

export function registerGoogleAuthRoutes(app: Express, authConfig: UserAuthConfig, deps: GoogleAuthDeps = defaultGoogleAuthDeps): void {
  const states = new Map<string, { returnTo: string; browserToken: string; verifier: string; expiresAt: number }>();
  const ttl = 10 * 60 * 1000;
  const cookieOptions = { httpOnly: true, sameSite: "lax" as const, secure: authConfig.secureCookie, path: "/auth/login/google" };
  function cleanup() { for (const [key, value] of states) if (value.expiresAt <= Date.now()) states.delete(key); }
  app.get("/auth/login/google/start", (req, res) => {
    const config = authConfig.google;
    const returnTo = safeReturnTo(req.query.returnTo);
    if (!config?.clientId || !config.clientSecret) {
      const url = new URL(returnTo, authConfig.webAppUrl);
      url.searchParams.set("loginError", "Google sign-in isn't configured yet. Use email or GitHub for now.");
      return res.redirect(url.toString());
    }
    cleanup();
    const state = randomBytes(32).toString("base64url");
    const browserToken = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    states.set(state, { returnTo, browserToken, verifier, expiresAt: Date.now() + ttl });
    res.cookie("mai_google_state", browserToken, { ...cookieOptions, maxAge: ttl });
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri,
      response_type: "code", scope: "openid email profile", state, prompt: "select_account",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString();
    res.redirect(url.toString());
  });
  app.get("/auth/login/google/callback", async (req, res) => {
    cleanup();
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const pending = states.get(state);
    states.delete(state);
    const browserToken = req.headers.cookie?.split(";").map(v => v.trim()).find(v => v.startsWith("mai_google_state="))?.slice("mai_google_state=".length);
    res.clearCookie("mai_google_state", cookieOptions);
    function fail(message: string) {
      const url = new URL(pending?.returnTo ?? "/", authConfig.webAppUrl);
      url.searchParams.set("loginError", message);
      return res.redirect(url.toString());
    }
    if (!pending || browserToken !== pending.browserToken) return fail("That sign-in link expired. Please start Google sign-in again.");
    if (req.query.error) return fail("Google sign-in was cancelled. You can try again or use another method.");
    if (typeof req.query.code !== "string" || !req.query.code || !authConfig.google) return fail("Google didn't complete sign-in. Please try again.");
    try {
      const profile = await deps.fetchProfile(req.query.code, pending.verifier, authConfig.google);
      const user = await db.upsertUserFromGoogle(profile);
      await issueSession(res, user.id, authConfig);
      res.redirect(new URL(pending.returnTo, authConfig.webAppUrl).toString());
    } catch {
      fail("Google sign-in couldn't be completed. Please try again or use another method.");
    }
  });
}
