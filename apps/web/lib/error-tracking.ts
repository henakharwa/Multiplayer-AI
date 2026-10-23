// Optional browser error tracking with Sentry. Nothing is downloaded or sent
// unless NEXT_PUBLIC_SENTRY_DSN is set when the app is built.
//
//   NEXT_PUBLIC_SENTRY_DSN          the browser project's DSN (enables reporting)
//   NEXT_PUBLIC_SENTRY_ENVIRONMENT  e.g. "production" (defaults to NODE_ENV)
//   NEXT_PUBLIC_SENTRY_RELEASE      e.g. the git commit being deployed
//
// Uncaught errors and unhandled promise rejections are reported
// automatically once it's on; error pages report what they catch through
// reportError. No cookies, headers, query strings or user details are sent.
type SentryBrowser = typeof import("@sentry/browser");

let sentry: SentryBrowser | null = null;
let loading: Promise<void> | null = null;

export function initErrorTracking(): void {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN?.trim();
  if (!dsn || loading || typeof window === "undefined") return;
  loading = import("@sentry/browser")
    .then((loaded) => {
      loaded.init({
        dsn,
        environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV,
        release: process.env.NEXT_PUBLIC_SENTRY_RELEASE || undefined,
        tracesSampleRate: 0,
        dataCollection: {
          userInfo: false,
          cookies: false,
          httpHeaders: false,
          httpBodies: [],
          urlQueryParams: false,
          stackFrameVariables: false,
        },
      });
      sentry = loaded;
    })
    .catch(() => {
      // Never let error reporting break the page.
    });
}

/** Reports an error caught by an error page. Does nothing when tracking is off. */
export function reportError(error: unknown, where: string): void {
  const send = () => {
    try {
      sentry?.captureException(error, { tags: { where } });
    } catch {
      // Ignore: reporting is best-effort.
    }
  };
  if (sentry) send();
  else void loading?.then(send);
}
