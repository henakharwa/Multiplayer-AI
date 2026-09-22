"use client";

import { useState } from "react";
import type { User } from "@mai-chat/shared-types";
import { resendVerificationEmail, ApiError } from "../../lib/api";

// Shown wherever a signed-in user is rendered -- only actually renders
// anything for an email+password account (user.email is set) whose
// email hasn't been verified yet. A GitHub/Google account has
// user.email === undefined and this renders nothing for them.
export default function EmailVerificationBanner({ user }: { user: User }) {
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [dismissed, setDismissed] = useState(false);

  if (!user.email || user.emailVerified || dismissed) return null;

  async function resend() {
    setStatus("sending");
    try {
      const result = await resendVerificationEmail();
      setStatus(result.alreadyVerified ? "sent" : "sent");
    } catch (error) {
      setStatus("error");
      console.error(error instanceof ApiError ? error.message : error);
    }
  }

  return (
    <div className="banner warning email-verification-banner" role="status">
      <span>
        {status === "sent"
          ? "Verification email sent. Check your inbox."
          : "Verify your email to finish setting up your account."}
      </span>
      {status !== "sent" && (
        <button type="button" onClick={resend} disabled={status === "sending"}>
          {status === "sending" ? "Sending…" : status === "error" ? "Try again" : "Resend email"}
        </button>
      )}
      <button type="button" className="email-verification-dismiss" onClick={() => setDismissed(true)} aria-label="Dismiss verification reminder">×</button>
    </div>
  );
}
