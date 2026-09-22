# Multiplayer AI — Product Spec (current direction)

This replaces `docs/archive/Multiplayer AI — Problem Statement, Scope & Feature Spec.pdf`,
which described the earlier CRDT/live-co-editing VS Code extension prototype. That
prototype has been retired; this repo is the from-scratch rebuild described in the root
`README.md`.

## The idea
An agentic system that connects a team's collaborative tools — GitHub, Slack — and lets
the team work with them together through one shared LLM chat. The workspace is shared by
every member of a group: everyone works inside the same conversation and the same
connected tools, not separate private chats.

## What's actually built (Phase 1 -- MVP complete)
Matches the root `README.md` exactly — see that file for how to run it:

1. **Chat core with tool-calling** (`services/chat-server`) — one agent, one shared
   WebSocket room per workspace, real-time message delivery and history.
2. **GitHub connector, read + write** (`packages/integrations/src/github.ts`, GitHub's
   official MCP server) — reads issues, PRs, commits, files, branches; can also
   comment/open a PR/push a commit/create a branch or issue, gated behind a
   confirmation card a human must approve (`services/chat-server/src/actions.ts`).
   Connects via a real OAuth login, or a pasted personal access token.
3. **Slack connector, read + write** (Slack's official MCP server, see
   `services/chat-server/src/slack-mcp-pool.ts`) — reads channels and message history,
   searches across them, and can post a message to a channel, gated behind the same
   confirmation-card flow as GitHub's writes. Connects via a real OAuth login only (no
   pasted-token fallback -- Slack's MCP server only accepts a user token minted by that
   exact flow, see `services/chat-server/src/slack-oauth.ts`). One behavioral tradeoff
   worth calling out: Slack's MCP server authenticates as the connecting human's own
   Slack identity, not a separate bot user, so the agent's Slack reads/posts show up as
   whoever logged in.
4. **Shared group workspace** (`packages/db`, `apps/web`) — create or join through a shared link/code after signing in with GitHub. The landing page is public, with Sign Up and Sign In controls. First login creates the account; all workspace APIs and live chat require a session. Everyone shares the same conversation, integrations and presence.

This matches the MVP as scoped: one shared chat, an agent that can act on GitHub and
Slack through that chat with a human always confirming the write, and no earlier
GitHub-only/read-only asymmetry between the two connectors.

## Phase 2 — deferred
- More connectors (Linear, Jira, Notion, Drive/Calendar, email) on a generalized
  connector framework.
- Role-based / fine-grained permissions.
- Action audit trail (who asked for what, what the agent did, when).
- Notifications for members not actively watching.
- Handoff and @-mention mechanics.
- Multiple/specialized agents instead of one general agent.
- Enterprise governance (SSO, SOC 2/HIPAA, cross-org sharing).
- Usage analytics.

