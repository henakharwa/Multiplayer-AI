"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import BrandMark from "../_components/Logo";
import { resetPassword, ApiError } from "../../lib/api";

function ResetPasswordPageInner() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get("token") ?? "";
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!token) { setError("This reset link is missing its token. Check the link from your email."); return; }
    setBusy(true); setError(null);
    try {
      await resetPassword(token, password);
      setDone(true);
      setTimeout(() => router.push("/"), 1500);
    } catch (error) {
      setError(error instanceof ApiError ? error.message : "Couldn't reset your password right now. Please try again.");
      setBusy(false);
    }
  }

  return (
    <div className="home-shell">
      <nav className="home-nav"><BrandMark /></nav>
      <div className="home-hero" style={{ maxWidth: 460 }}>
        <div className="auth-form" style={{ margin: 0 }}>
          <h1>Choose a new password</h1>
          {done ? (
            <p className="lede">Password updated. Taking you back to Multiplayer AI…</p>
          ) : (
            <form onSubmit={submit}>
              <div className="field">
                <label htmlFor="new-password">New password</label>
                <input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  maxLength={128}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy}
                  aria-describedby="new-password-hint"
                />
                <p className="hint" id="new-password-hint">Use at least 12 characters.</p>
              </div>
              {error && <p className="error-text auth-error" role="alert">{error}</p>}
              <button className="btn auth-submit" type="submit" disabled={busy || !token}>
                {busy ? "Resetting…" : "Reset password"}
              </button>
            </form>
          )}
          {!token && !done && <p className="panel-hint">This link is missing its token — request a new one from the sign-in screen&apos;s &quot;Forgot password?&quot; link.</p>}
          <p className="auth-switch"><Link href="/">Back to Multiplayer AI</Link></p>
        </div>
      </div>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordPageInner />
    </Suspense>
  );
}
