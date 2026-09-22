"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import BrandMark from "../_components/Logo";
import { verifyEmail, ApiError } from "../../lib/api";

function VerifyEmailPageInner() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const [status, setStatus] = useState<"checking" | "verified" | "error">("checking");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setStatus("error");
      setMessage("This verification link is missing its token. Check the link from your email.");
      return;
    }
    let cancelled = false;
    verifyEmail(token)
      .then(() => { if (!cancelled) setStatus("verified"); })
      .catch((error) => {
        if (cancelled) return;
        setStatus("error");
        setMessage(error instanceof ApiError ? error.message : "Couldn't verify your email right now. Please try again.");
      });
    return () => { cancelled = true; };
  }, [token]);

  return (
    <div className="home-shell">
      <nav className="home-nav"><BrandMark /></nav>
      <div className="home-hero" style={{ maxWidth: 460 }}>
        {status === "checking" && <p className="lede">Verifying your email…</p>}
        {status === "verified" && (
          <>
            <h1>Email verified</h1>
            <p className="lede">Your email is confirmed. You&apos;re all set.</p>
            <Link className="btn" href="/">Go to your workspaces</Link>
          </>
        )}
        {status === "error" && (
          <>
            <h1>That link didn&apos;t work</h1>
            <p className="lede">{message}</p>
            <p className="panel-hint">Sign in and use &quot;Resend email&quot; from the banner at the top of the page to get a new link.</p>
            <Link className="btn secondary" href="/">Back to Multiplayer AI</Link>
          </>
        )}
      </div>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={null}>
      <VerifyEmailPageInner />
    </Suspense>
  );
}
