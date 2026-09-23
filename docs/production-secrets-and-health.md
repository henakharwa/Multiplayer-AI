# Production secrets and health checks

Keep all credentials in the Render service's **Environment** settings. Do not
place them in source files, Docker build arguments, browser-visible
`NEXT_PUBLIC_*` variables, screenshots, issues, or chat logs. The repository
ignores `.env`; commit only `.env.example`, which must contain blank or local
safe values.

## Render environment groups

Set these as **secret** environment variables in Render:

- `DATABASE_URL` — linked from the Render Postgres database.
- `INTEGRATION_ENCRYPTION_KEY` — Render-generated value; changing it makes
  previously stored integration tokens unreadable, so rotate deliberately.
- `AGENT_LLM_API_KEY` and the matching `AGENT_LLM_BASE_URL` / `AGENT_LLM_MODEL`.
- OAuth client secrets: `GITHUB_OAUTH_CLIENT_SECRET`, `SLACK_OAUTH_CLIENT_SECRET`,
  `GOOGLE_OAUTH_CLIENT_SECRET`, `LINEAR_OAUTH_CLIENT_SECRET`,
  `NOTION_OAUTH_CLIENT_SECRET`, and `FIGMA_OAUTH_CLIENT_SECRET`.
- OAuth client IDs can also be stored as secrets for simpler environment
  management. They are not exposed to the browser by this app.

Set URLs as ordinary environment values:

- `WEB_APP_URL=https://YOUR-SERVICE.onrender.com`
- `CHAT_SERVER_PUBLIC_URL=https://YOUR-SERVICE.onrender.com/api`
- `NEXT_PUBLIC_CHAT_SERVER_URL=https://YOUR-SERVICE.onrender.com/api`
- `NEXT_PUBLIC_CHAT_SERVER_WS_URL=wss://YOUR-SERVICE.onrender.com/api`

Never add a secret value to `render.yaml`; the blueprint links only the
managed database and generates the encryption key.

## Rotation and verification

1. Rotate a provider credential in the provider dashboard if it has ever
   appeared in a committed file, screenshot, or shared chat.
2. Update its Render environment variable and deploy.
3. Reconnect the affected integration in the product if the provider token
   itself was rotated.
4. Confirm `https://YOUR-SERVICE.onrender.com/api/healthz` returns a successful
   liveness response and `/api/readyz` reports `database: "connected"`.

Render now uses `/api/readyz` as its service health check. The application emits
structured JSON log lines only for HTTP failures, unhandled HTTP errors, and
failed readiness checks. These records contain request metadata and error
messages, never request bodies, cookies, tokens, or configured secrets.