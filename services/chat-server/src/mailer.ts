// Outbound transactional email (password reset, email verification, and
// workspace invitations). Gmail SMTP makes the prototype usable without a
// custom sending domain; Resend remains available for a verified domain.
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
  // A Gmail address with a Google App Password. This is intentionally two
  // separate runtime secrets rather than a password in source control.
  gmailUser?: string;
  gmailAppPassword?: string;
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
    fromAddress: process.env.EMAIL_FROM_ADDRESS || (process.env.GMAIL_SMTP_USER ? `Multiplayer AI <${process.env.GMAIL_SMTP_USER}>` : "Multiplayer AI <onboarding@resend.dev>"),
    gmailUser: process.env.GMAIL_SMTP_USER || undefined,
    gmailAppPassword: process.env.GMAIL_SMTP_APP_PASSWORD || undefined,
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

async function sendViaGmail(config: MailerConfig, email: OutgoingEmail): Promise<void> {
  // Dynamic import keeps local development on the console fallback if Gmail
  // has not been configured. Nodemailer is used only in the server process.
  const nodemailer = await import("nodemailer");
  const transport = nodemailer.createTransport({
    service: "gmail",
    auth: { user: config.gmailUser!, pass: config.gmailAppPassword! },
    // Gmail can reject or block an SMTP connection from a hosting provider.
    // Fail promptly so the invitation dialog can explain that instead of
    // leaving its submit button in a permanent sending state.
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });
  await transport.sendMail({ from: config.fromAddress, to: email.to, subject: email.subject, text: email.text });
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
  if (config.gmailUser && config.gmailAppPassword) {
    return { send: (email) => sendViaGmail(config, email) };
  }
  if (config.resendApiKey) {
    return { send: (email) => sendViaResend(config, email) };
  }
  return { send: async (email) => sendViaConsole(email) };
}
