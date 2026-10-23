// Optional error tracking with Sentry. Nothing is loaded or sent unless
// SENTRY_DSN is set, so local development and tests are unaffected.
//
//   SENTRY_DSN          the project's DSN from sentry.io (enables reporting)
//   SENTRY_ENVIRONMENT  e.g. "production" or "staging" (defaults to NODE_ENV)
//   SENTRY_RELEASE      e.g. the git commit being deployed
//
// Reports carry the error, where it happened and ids (workspace, request),
// never cookies, authorization headers, request bodies or chat content.
type SentryModule = typeof import("@sentry/node");

let sentry: SentryModule | null = null;

const SENSITIVE_HEADERS = ["cookie", "authorization", "x-hub-signature-256", "x-slack-signature"];

// `overrides` exists for tests (e.g. a transport that records events).
export async function initErrorTracking(overrides: Partial<import("@sentry/node").NodeOptions> = {}): Promise<boolean> {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn || sentry) return Boolean(sentry);
  const loaded = await import("@sentry/node");
  loaded.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development",
    release: process.env.SENTRY_RELEASE || undefined,
    // Errors only; no performance tracing.
    tracesSampleRate: 0,
    // Collect nothing that could hold personal data or secrets: OAuth codes
    // travel in query strings, tokens can sit in local variables, and chat
    // content passes through the LLM calls.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      stackFrameVariables: false,
    },
    beforeSend(event) {
      if (event.request) {
        delete event.request.cookies;
        delete event.request.data;
        if (event.request.headers) {
          for (const header of Object.keys(event.request.headers)) {
            if (SENSITIVE_HEADERS.includes(header.toLowerCase())) delete event.request.headers[header];
          }
        }
      }
      return event;
    },
    ...overrides,
  });
  sentry = loaded;
  console.log("[error-tracking] Sentry error reporting is on");
  return true;
}

/** Reports an unexpected error. Does nothing when error tracking is off. */
export function captureError(error: unknown, context: { where: string } & Record<string, string | number | boolean | null | undefined>): void {
  if (!sentry) return;
  try {
    const { where, ...extra } = context;
    sentry.captureException(error, { tags: { where }, extra });
  } catch {
    // Error reporting must never cause an error of its own.
  }
}

/** Waits briefly for queued reports to be sent, e.g. before the process exits. */
export async function flushErrorTracking(timeoutMs = 2000): Promise<void> {
  if (!sentry) return;
  await sentry.flush(timeoutMs).catch(() => false);
}
