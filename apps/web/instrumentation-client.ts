// Runs in the browser before the app becomes interactive (a Next.js file
// convention). Turns on error tracking when NEXT_PUBLIC_SENTRY_DSN is set.
import { initErrorTracking } from "./lib/error-tracking";

initErrorTracking();
