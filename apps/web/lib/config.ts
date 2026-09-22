// Both fall back to localhost defaults so `next dev` works out of the box
// against a locally-running chat-server without requiring env setup first,
// but the real deployment always sets these explicitly (see /.env).
export const CHAT_SERVER_URL = process.env.NEXT_PUBLIC_CHAT_SERVER_URL ?? "http://localhost:4000";
export const CHAT_SERVER_WS_URL = process.env.NEXT_PUBLIC_CHAT_SERVER_WS_URL ?? "ws://localhost:4000";
