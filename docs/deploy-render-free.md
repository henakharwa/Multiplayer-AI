# Deploy a free test environment on Render

This uses one public Render service for both the Next.js interface and chat
server. Caddy sends `/api/*` to the chat server and all remaining traffic to
Next.js. One public origin keeps sign-in cookies, OAuth callbacks, and
WebSockets working without buying a custom domain.

## 1. Put the project on GitHub

1. Create an account at [Render](https://render.com/).
2. Create a **private** GitHub repository for this project.
3. Commit and push the current files, including `render.yaml`,
   `Dockerfile.render`, and `Caddyfile`.
4. Do not commit `.env`; it contains secrets and is already ignored.

## 2. Create the free services

1. In Render, select **New** > **Blueprint**.
2. Connect GitHub and select the project repository.
3. Confirm Render found `render.yaml` and will create:
   - `multiplayer-ai` — Web Service — Free
   - `multiplayer-ai-db` — PostgreSQL — Free
4. Click **Apply** and wait for the first deployment.
5. Open `multiplayer-ai` > **Settings** > **Custom Domains** and copy the
   generated `https://...onrender.com` address. Call it `APP_URL` below.

## 3. Configure the application URL

Open `multiplayer-ai` > **Environment** and add these values. Replace
`APP_URL` with the generated address and omit any trailing slash.

```text
WEB_APP_URL=APP_URL
CHAT_SERVER_PUBLIC_URL=APP_URL/api
NEXT_PUBLIC_CHAT_SERVER_URL=APP_URL/api
NEXT_PUBLIC_CHAT_SERVER_WS_URL=<APP_URL with https:// replaced by wss://>/api
```

For example:

```text
WEB_APP_URL=https://multiplayer-ai-example.onrender.com
CHAT_SERVER_PUBLIC_URL=https://multiplayer-ai-example.onrender.com/api
NEXT_PUBLIC_CHAT_SERVER_URL=https://multiplayer-ai-example.onrender.com/api
NEXT_PUBLIC_CHAT_SERVER_WS_URL=wss://multiplayer-ai-example.onrender.com/api
```

Save, then select **Manual Deploy** > **Deploy latest commit**. The two
`NEXT_PUBLIC_*` values are compiled into the Next.js application, so this
redeploy is required.

## 4. Add a hosted LLM

The deployed service cannot reach Ollama running on your computer. In the
same Environment page, add your hosted OpenAI-compatible provider values:

```text
AGENT_LLM_BASE_URL=<provider API base URL>
AGENT_LLM_API_KEY=<provider API key>
AGENT_LLM_MODEL=<provider model name>
AGENT_LLM_MAX_TOKENS=1024
AGENT_LLM_TPM_LIMIT=8192
```

Redeploy after saving. Use an API key with a spending limit.

## 5. Test the shared workspace

1. Open `APP_URL` in an incognito browser and create an email/password user.
2. Create a workspace and conversation.
3. Open the same URL in another browser profile, sign in as a second user,
   and join the workspace.
4. Send messages in both windows and verify live messages, presence, and
   notifications.

## 6. Connect tools after the core test

Add provider credentials in `multiplayer-ai` > **Environment**, then update
the provider's OAuth callback URL. Every callback begins with `APP_URL/api`:

| Provider | Callback URL |
| --- | --- |
| GitHub | `APP_URL/api/auth/github/callback` and `APP_URL/api/auth/login/github/callback` |
| Google | `APP_URL/api/auth/login/google/callback` |
| Slack | `APP_URL/api/auth/slack/callback` |
| Linear | `APP_URL/api/auth/mcp/linear/callback` |
| Notion | `APP_URL/api/auth/mcp/notion/callback` |
| Figma | `APP_URL/api/auth/mcp/figma/callback` |

Redeploy after credential changes, then test each connection from
**Integrations**.

## Free-tier limits

Render suspends an inactive free web service after 15 minutes. The next visit
can take about a minute to wake it. The free Postgres database is limited to
1 GB and expires after 30 days, so export your data before then.
