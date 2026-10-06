// Where the browser reaches the chat server.
//
// Set NEXT_PUBLIC_CHAT_SERVER_URL / NEXT_PUBLIC_CHAT_SERVER_WS_URL at build
// time to point anywhere. Without them:
// - in development, the chat server is assumed at localhost:4000;
// - in a production build, the app uses its own origin under /api, which
//   is how the bundled Caddy proxy (Caddyfile) routes requests. It never
//   silently falls back to localhost in production.
function sameOriginApi(): { http: string; ws: string } | null {
  if (process.env.NODE_ENV !== "production" || typeof window === "undefined") return null;
  const { protocol, host, origin } = window.location;
  return { http: `${origin}/api`, ws: `${protocol === "https:" ? "wss:" : "ws:"}//${host}/api` };
}

const sameOrigin = sameOriginApi();

export const CHAT_SERVER_URL = process.env.NEXT_PUBLIC_CHAT_SERVER_URL || sameOrigin?.http || "http://localhost:4000";
export const CHAT_SERVER_WS_URL = process.env.NEXT_PUBLIC_CHAT_SERVER_WS_URL || sameOrigin?.ws || "ws://localhost:4000";
