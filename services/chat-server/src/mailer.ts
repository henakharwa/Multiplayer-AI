// Outbound transactional email (password reset, email verification).
// Same philosophy as llm-client.ts: prefer one well-documented HTTP call
// over an SDK dependency, and make the unconfigured case still *work*
// rather than just fail -- a missing EMAIL_* config logs the message
// (including the real link) to the server's own terminal instead of
// silently dropping it, so local dev/testing never needs a real mail
// provider account just to click a verification/reset link.

export interface MailerConfig {
  // Resend (https://resend.com) -- a plain REST API, free tier, no SDK
  // needed for one endpoint. Leave blank to use the console fallback.
  resendApiKey?: string;
  // "Display Name <address@domain>" or a bare address. Required by
  // Resend's API whenever resendApiKey is set; resend.dev's shared
  // onboarding@resend.dev sender works without verifying your own
  // domain, for testing.
  fromAddress?: string;
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(email: OutgoingEmail): Promise<void>;
}

export function defaultMailerConfig(): MailerConfig {
  return {
    resendApiKey: process.env.RESEND_API_KEY || undefined,
    fromAddress: process.env.EMAIL_FROM_ADDRESS || "Multiplayer AI <onboarding@resend.dev>",
  };
}

async function sendViaResend(config: MailerConfig, email: OutgoingEmail): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${config.resendApiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ from: config.fromAddress, to: [email.to], subject: email.subject, text: email.text }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend couldn't send the email (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }
}

// The always-works default: prints the email (link included) to this
// server's own terminal instead of sending it. Real enough to develop
// and test against without any provider account -- click the printed
// link yourself. A production deployment should set RESEND_API_KEY (or
// swap this file for another provider) instead of relying on this.
function sendViaConsole(email: OutgoingEmail): void {
  console.log(
    `\n[mailer] RESEND_API_KEY not set -- printing this email instead of sending it:\n` +
    `  To: ${email.to}\n  Subject: ${email.subject}\n\n${email.text}\n`
  );
}

export function createMailer(config: MailerConfig = defaultMailerConfig()): Mailer {
  if (config.resendApiKey) {
    return { send: (email) => sendViaResend(config, email) };
  }
  return { send: async (email) => sendViaConsole(email) };
}
