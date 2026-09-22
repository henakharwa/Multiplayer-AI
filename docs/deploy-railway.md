# Deploy Multiplayer AI to Railway

This deployment uses three Railway services in one project:

| Service | Purpose | Public domain |
| --- | --- | --- |
| Postgres | Persistent application data | No |
| chat-server | Authentication, agents, WebSockets, tool connections | Yes |
| web | Next.js interface | Yes |

The chat-server Docker image includes GitHub's official MCP binary. This is
required on managed hosting because the development-only Docker Desktop
approach cannot start containers inside a running Railway service.

## 1. Put the project in GitHub

Create a private GitHub repository, commit the current project, and push it.
Do not add `.env`; it is already ignored. Railway deploys both application
services from this same repository.

## 2. Create the Railway project and database

1. In Railway, create a new project.
2. Select **New** > **Database** > **PostgreSQL** and name it `Postgres`.
3. Create an empty service named `chat-server`, connect the GitHub repository,
   and set its **Dockerfile Path** to `Dockerfile.chat-server`.
4. In `chat-server` Networking, generate a public domain. Record it as
   `https://YOUR-CHAT-SERVER-DOMAIN`.

Set these `chat-server` variables:

```text
DATABASE_URL=${{Postgres.DATABASE_URL}}
CHAT_SERVER_PUBLIC_URL=https://YOUR-CHAT-SERVER-DOMAIN
INTEGRATION_ENCRYPTION_KEY=<a new random base64 32-byte key>
AGENT_LLM_BASE_URL=<your hosted OpenAI-compatible API base URL>
AGENT_LLM_API_KEY=<your hosted model API key>
AGENT_LLM_MODEL=<your model name>
AGENT_LLM_MAX_TOKENS=1024
AGENT_LLM_TPM_LIMIT=8192
```

Generate the encryption key locally with:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Deploy the `chat-server` once, then set its **Pre-deploy Command** to:

```text
npm run migrate
```

This applies the idempotent database schema before future chat-server deploys.

## 3. Deploy the web interface

1. Create a second empty Railway service named `web` and connect the same
   GitHub repository.
2. Set **Dockerfile Path** to `Dockerfile.web`.
3. Generate a public domain. Record it as `https://YOUR-WEB-DOMAIN`.
4. Set these `web` variables before deploying:

```text
NEXT_PUBLIC_CHAT_SERVER_URL=https://YOUR-CHAT-SERVER-DOMAIN
NEXT_PUBLIC_CHAT_SERVER_WS_URL=wss://YOUR-CHAT-SERVER-DOMAIN
```

After the web service has a domain, return to `chat-server` and add:

```text
WEB_APP_URL=https://YOUR-WEB-DOMAIN
```

Redeploy both services. The web variables are compiled into the Next.js
bundle, so redeploy `web` whenever either public chat-server URL changes.

## 4. Add optional provider credentials to chat-server

Add only the providers you intend to test. All callback URLs must use the
public chat-server domain exactly.

| Provider | Required variables | Callback URL |
| --- | --- | --- |
| GitHub sign-in and repositories | `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET` | `https://YOUR-CHAT-SERVER-DOMAIN/auth/github/callback` and `https://YOUR-CHAT-SERVER-DOMAIN/auth/login/github/callback` |
| Google sign-in | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` | `https://YOUR-CHAT-SERVER-DOMAIN/auth/login/google/callback` |
| Slack | `SLACK_OAUTH_CLIENT_ID`, `SLACK_OAUTH_CLIENT_SECRET` | `https://YOUR-CHAT-SERVER-DOMAIN/auth/slack/callback` |
| Linear | `LINEAR_OAUTH_CLIENT_ID`, `LINEAR_OAUTH_CLIENT_SECRET` | `https://YOUR-CHAT-SERVER-DOMAIN/auth/mcp/linear/callback` |
| Notion | `NOTION_OAUTH_CLIENT_ID`, `NOTION_OAUTH_CLIENT_SECRET` | `https://YOUR-CHAT-SERVER-DOMAIN/auth/mcp/notion/callback` |
| Figma | `FIGMA_OAUTH_CLIENT_ID`, `FIGMA_OAUTH_CLIENT_SECRET`, `FIGMA_MCP_URL=https://mcp.figma.com/mcp` | `https://YOUR-CHAT-SERVER-DOMAIN/auth/mcp/figma/callback` |
| Delivered email | `RESEND_API_KEY`, `EMAIL_FROM_ADDRESS` | None |

In each provider dashboard, replace the old `localhost` callback URL with the
corresponding public URL before testing sign-in or an integration.

## 5. Production smoke test

1. Open the web domain and create an email account.
2. Create a workspace and invite a second tester.
3. Confirm both browsers see the same conversation and presence updates.
4. Connect GitHub and ask the GitHub agent to read an issue or repository.
5. Confirm an Editor's requested write action reaches an Admin for approval.
6. Disconnect and reconnect a tool, then verify the connected account label.
7. Check Railway logs for the chat-server and confirm no authentication,
   database, WebSocket, or MCP connection errors.
