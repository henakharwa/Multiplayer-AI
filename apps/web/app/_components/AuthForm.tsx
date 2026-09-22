"use client";

import { useEffect, useState } from "react";
import { authenticateWithEmail, getAuthProviders, loginWithGithubUrl, loginWithGoogleUrl, requestPasswordReset } from "../../lib/api";

export default function AuthForm({ initialMode = "signin", returnTo = "/", initialError }: {
  initialMode?: "signin" | "signup"; returnTo?: string; initialError?: string | null;
}) {
  const [mode, setMode] = useState<"signin" | "signup" | "forgot">(initialMode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError ?? null);
  const [providers, setProviders] = useState<{ google: boolean; github: boolean } | null>(null);
  const [forgotSent, setForgotSent] = useState(false);
  const signup = mode === "signup";
  const forgot = mode === "forgot";

  useEffect(() => {
    let active = true;
    getAuthProviders().then(value => { if (active) setProviders(value); }).catch(() => {
      if (active) setError("Could not reach the sign-in service. Please try again.");
    });
    const loginError = new URLSearchParams(window.location.search).get("loginError");
    if (loginError) setError(loginError);
    return () => { active = false; };
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      await authenticateWithEmail(signup ? "signup" : "signin", { email: email.trim(), password, ...(signup ? { displayName: displayName.trim() } : {}) });
      window.location.assign(returnTo.startsWith("/") && !returnTo.startsWith("//") && !returnTo.includes("\\") ? returnTo : "/");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Sign-in failed. Please try again.");
      setBusy(false);
    }
  }
  async function submitForgot(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      await requestPasswordReset(email.trim());
      setForgotSent(true);
    } catch (error) {
      // requestPasswordReset never throws for an unknown email (the server
      // gives the same response either way -- see password-reset.ts) --
      // this only fires for a real network/server problem.
      setError(error instanceof Error ? error.message : "Couldn't reach the sign-in service. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  function social(provider: "google" | "github") {
    if (!providers?.[provider]) {
      setError(`${provider === "google" ? "Google" : "GitHub"} sign-in isn't configured yet. Please use another method for now.`);
      return;
    }
    window.location.assign(provider === "google" ? loginWithGoogleUrl(returnTo) : loginWithGithubUrl(returnTo));
  }

  if (forgot) {
    return <div className="auth-form">
      <span className="eyebrow">Multiplayer AI</span>
      <h2 id="auth-title">Reset your password</h2>
      {forgotSent
        ? <p className="auth-description">If an account exists for <strong>{email.trim()}</strong>, we&apos;ve sent a link to reset its password. Check your inbox.</p>
        : <>
          <p className="auth-description">Enter the email on your account and we&apos;ll send you a link to reset your password.</p>
          <form onSubmit={submitForgot}>
            <div className="field"><label htmlFor="auth-email">Email address</label><input id="auth-email" type="email" autoComplete="email" placeholder="you@example.com" required maxLength={254} value={email} onChange={e => setEmail(e.target.value)} disabled={busy} /></div>
            {error && <p className="error-text auth-error" role="alert">{error}</p>}
            <button className="btn auth-submit" type="submit" disabled={busy}>{busy ? "Sending…" : "Send reset link"}</button>
          </form>
        </>}
      <p className="auth-switch"><button type="button" disabled={busy} onClick={() => { setMode("signin"); setForgotSent(false); setError(null); }}>Back to sign in</button></p>
    </div>;
  }

  return <div className="auth-form">
    <span className="eyebrow">Multiplayer AI</span>
    <h2 id="auth-title">{signup ? "Create your account" : "Welcome back"}</h2>
    <p className="auth-description">{signup ? "A shared workspace starts with you." : "Sign in to create a workspace or join your team."}</p>
    <form onSubmit={submit}>
      {signup && <div className="field"><label htmlFor="auth-name">Your name</label><input id="auth-name" autoComplete="name" required maxLength={80} value={displayName} onChange={e => setDisplayName(e.target.value)} disabled={busy} /></div>}
      <div className="field"><label htmlFor="auth-email">Email address</label><input id="auth-email" type="email" autoComplete="email" placeholder="you@example.com" required maxLength={254} value={email} onChange={e => setEmail(e.target.value)} disabled={busy} /></div>
      <div className="field"><label htmlFor="auth-password">Password</label>
        <div className="auth-password-field"><input id="auth-password" type={showPassword ? "text" : "password"} autoComplete={signup ? "new-password" : "current-password"} required minLength={signup ? 12 : 1} maxLength={128} value={password} onChange={e => setPassword(e.target.value)} disabled={busy} aria-describedby={signup ? "password-hint" : undefined} />
          <button type="button" className="password-toggle" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? "Hide password" : "Show password"}>{showPassword ? "Hide" : "Show"}</button></div>
        {signup && <p className="hint" id="password-hint">Use at least 12 characters.</p>}
        {!signup && <p className="hint"><button type="button" className="auth-forgot-link" disabled={busy} onClick={() => { setMode("forgot"); setError(null); }}>Forgot password?</button></p>}
      </div>
      {error && <p className="error-text auth-error" role="alert">{error}</p>}
      <button className="btn auth-submit" type="submit" disabled={busy}>{busy ? (signup ? "Creating account…" : "Signing in…") : (signup ? "Create account" : "Sign In")}</button>
    </form>
    <div className="auth-divider"><span>or continue with</span></div>
    <div className="auth-providers">
      <button type="button" className="provider-button" data-testid="login-google-btn" disabled={busy || !providers} onClick={() => social("google")}><span className="google-g" aria-hidden="true">G</span>Google</button>
      <button type="button" className="provider-button" data-testid="login-github-btn" disabled={busy || !providers} onClick={() => social("github")}><svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>GitHub</button>
    </div>
    <p className="auth-switch">{signup ? "Already have an account?" : "New to Multiplayer AI?"} <button type="button" disabled={busy} onClick={() => { setMode(signup ? "signin" : "signup"); setPassword(""); setError(null); }}>{signup ? "Sign In" : "Sign Up"}</button></p>
  </div>;
}
