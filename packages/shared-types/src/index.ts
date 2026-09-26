// Shared types for the Multiplayer AI chat product: a shared team workspace
// where members read GitHub/Slack through one live group chat with an LLM
// agent. Deliberately small -- this is the whole Phase 1 contract, not a
// speculative superset.

export interface Workspace {
  id: string; // uuid
  name: string;
  joinCode: string; // short, shareable code (part of the join link)
  createdAt: string; // ISO
}

export type WorkspaceRole = "admin" | "editor";

export interface WorkspaceMember extends User {
  role: WorkspaceRole;
  joinedAt: string;
}

export interface Conversation {
  id: string;
  workspaceId: string;
  title: string;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceNotification {
  id: string;
  workspaceId: string;
  conversationId: string | null;
  kind: "agent_completed" | "decision_needed" | "action_completed";
  text: string;
  createdAt: string;
  readAt: string | null;
}

// A real account -- "Sign in with GitHub" (services/chat-server/src/auth.ts)
// is the only way to get one; there's no separate password to manage.
// Replaces the old model where anyone with a workspace's join code typed
// an arbitrary, unverified display name (see docs/spec.md's Phase 2 note:
// "real user accounts, replacing join-by-link workspaces"). githubId is
// GitHub's own numeric user id (stable even if the person renames their
// GitHub account, unlike username) -- the actual identity key; username
// and displayName are just what GitHub reported at last login.
export interface User {
  id: string; // uuid
  githubId: string | null;
  username: string; // GitHub login, e.g. "octocat"
  displayName: string; // GitHub's "name" field, falls back to username if unset
  avatarUrl: string | null;
  createdAt: string; // ISO
  // Only present for an email+password account (packages/db's
  // password_credentials table) -- undefined for a GitHub/Google login,
  // which has no password and nothing here to verify/reset.
  email?: string;
  emailVerified?: boolean;
}

export type MessageRole = "user" | "agent" | "system";

export interface ChatMessage {
  id: string; // uuid
  workspaceId: string;
  conversationId: string;
  role: MessageRole;
  authorName: string; // display name for "user" messages, "Agent" for agent replies, "System" for system
  // Immutable provenance lets clients identify the signed-in user even when names match.
  authorUserId?: string;
  content: string;
  createdAt: string; // ISO
  // @-mention / handoff mechanics (docs/spec.md Phase 2) -- computed once
  // server-side when a 'user' message is sent (see
  // services/chat-server/src/mentions.ts). mentionsAgent is true for any
  // message with no @-mention at all (the agent's default audience) or
  // one that explicitly @-mentions the agent; it's false only when the
  // message @-mentions one or more teammates and NOT the agent -- that's
  // what "hands off" the message instead of triggering an agent turn.
  // Always true/empty for 'agent'/'system' messages, which don't parse
  // mentions.
  mentionsAgent: boolean;
  mentionedUserIds: string[];
}

export type IntegrationType = "github" | "slack" | "linear" | "notion" | "figma";

export interface GithubIntegrationConfig {
  type: "github";
  workspaceId: string;
  // Both are undefined right after a GitHub OAuth login completes but
  // before a repository has been chosen (see the OAuth flow in
  // services/chat-server/src/github-oauth.ts) -- `connected` is true as
  // soon as we have a working token, `repo`/`owner` land once the user
  // picks one from GithubRepoPickerModal. The pasted-token flow (still
  // supported, apps/web/app/w/[id]/integrations/page.tsx) sets all three
  // at once instead.
  owner?: string;
  repo?: string;
  // The token itself is never returned to the client after it's saved --
  // packages/db's read APIs omit it; only the server-side agent/integration
  // code ever sees the real value.
  connected: boolean;
  connectedAt: string;
}

export interface SlackIntegrationConfig {
  type: "slack";
  workspaceId: string;
  teamName: string;
  connected: boolean;
  connectedAt: string;
}

export interface RemoteMcpIntegrationConfig {
  type: "linear" | "notion" | "figma";
  workspaceId: string;
  endpoint: string;
  accountName?: string;
  connected: boolean;
  connectedAt: string;
}

export type IntegrationConfig = GithubIntegrationConfig | SlackIntegrationConfig | RemoteMcpIntegrationConfig;

// A live participant in a workspace's shared chat (ephemeral presence, not
// persisted -- who's currently connected via WebSocket). displayName
// comes from the connected socket's authenticated User (see auth.ts) --
// no longer a client-typed string a browser could claim to be anything.
export interface Participant {
  clientId: string;
  userId?: string;
  displayName: string;
  connectedAt: string;
  activeConversationId?: string;
}

// -- Agent tool-calling contract (packages/integrations implements these,
// services/chat-server's agent loop calls them) --------------------------

export interface GithubIssueSummary {
  number: number;
  title: string;
  state: string;
  author: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  labels: string[];
}

export interface GithubPullRequestSummary {
  number: number;
  title: string;
  state: string;
  author: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  merged: boolean;
  draft: boolean;
}

export interface GithubCommitSummary {
  sha: string;
  message: string;
  author: string;
  url: string;
  date: string;
}

// One repo the authenticated GitHub user/token can access -- returned by
// GET /workspaces/:id/integrations/github/repos (packages/integrations'
// listRepositoriesForToken) for the repo-picker UI, distinct from the
// deeper GithubIssueSummary/PullRequestSummary/CommitSummary shapes above
// (which describe content *inside* an already-chosen repo).
export interface GithubRepoSummary {
  owner: string;
  name: string;
  fullName: string; // "owner/name"
  private: boolean;
  description: string | null;
  updatedAt: string;
  htmlUrl: string;
}

export interface SlackChannelSummary {
  id: string;
  name: string;
  topic: string;
  memberCount: number;
}

export interface SlackMessageSummary {
  ts: string;
  user: string;
  text: string;
  permalink?: string;
}

// Returned by SlackClient.postMessage (packages/integrations/src/slack.ts)
// -- the write counterpart to SlackMessageSummary above. permalink is
// best-effort (chat.getPermalink needs its own scope/lookup beyond plain
// chat:write, so a bot token that can post but not fetch a permalink
// still succeeds here, just without one) -- callers should treat its
// absence as normal, not a failure.
export interface SlackPostedMessage {
  channel: string;
  ts: string;
  permalink?: string;
}

// -- Extended GitHub tool-calling contracts (full-coverage phase: code,
// branches, commits, releases, Actions/CI, labels, milestones,
// collaborators -- not just issues/PRs/commits like the original MVP
// slice above) --------------------------------------------------------

export interface GithubRepoInfo {
  fullName: string;
  description: string | null;
  defaultBranch: string;
  private: boolean;
  htmlUrl: string;
  stargazersCount: number;
  openIssuesCount: number;
}

export interface GithubFileContent {
  path: string;
  sha: string;
  content: string; // decoded utf-8 text when possible, base64 for binary files
  encoding: "utf-8" | "base64";
  size: number;
  htmlUrl: string;
}

export interface GithubTreeEntry {
  path: string;
  type: "file" | "dir" | "submodule" | "symlink";
  sha: string;
  size?: number;
}

export interface GithubBranchSummary {
  name: string;
  sha: string;
  protected: boolean;
}

export interface GithubLabelSummary {
  name: string;
  color: string;
  description: string | null;
}

export interface GithubMilestoneSummary {
  number: number;
  title: string;
  state: string;
  dueOn: string | null;
}

export interface GithubCollaboratorSummary {
  login: string;
  permission: string; // "admin" | "maintain" | "write" | "triage" | "read"
}

export interface GithubReleaseSummary {
  id: number;
  tagName: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  htmlUrl: string;
  createdAt: string;
}

export interface GithubWorkflowSummary {
  id: number;
  name: string;
  path: string;
  state: string;
}

export interface GithubWorkflowRunSummary {
  id: number;
  name: string | null;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  headBranch: string;
  createdAt: string;
}

export interface GithubPullRequestFileSummary {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

export interface GithubIssueCommentSummary {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  url: string;
}

export interface GithubCommitDetail {
  sha: string;
  message: string;
  author: string;
  url: string;
  date: string;
  filesChanged: number;
  additions: number;
  deletions: number;
}

// -- Pending write-action confirmation --------------------------------
// The agent can propose a repo-changing GitHub action (commit, PR merge,
// branch delete, etc.), but never performs it itself -- it queues one of
// these, a human sees it as a card in the chat UI, and only a Confirm
// click actually runs it (services/chat-server/src/actions.ts).

export type PendingActionStatus = "pending" | "confirmed" | "cancelled" | "failed";

export interface PendingAction {
  id: string;
  workspaceId: string;
  conversationId: string;
  toolName: string;
  description: string;
  // A slightly longer, more specific look at what will actually happen --
  // e.g. the real file content being committed, the full issue/PR body,
  // the reviewers being requested -- shown alongside the Confirm/Cancel
  // buttons so approving isn't a leap of faith based on the one-line
  // description alone. Null for a tool that has nothing more useful to
  // show beyond its description.
  preview: string | null;
  args: Record<string, unknown>;
  status: PendingActionStatus;
  result: string | null;
  createdAt: string;
  resolvedAt: string | null;
  // Whoever's chat message triggered the agent turn that proposed this
  // action, if known -- see schema.sql's comment on these two columns.
  requestedByUserId?: string | null;
  requestedByName?: string | null;
  agentKind?: "project" | "github" | "slack" | "linear" | "notion" | "figma" | null;
}

// -- Action audit trail (docs/spec.md Phase 2: "who asked for what, what
// the agent did, when") -----------------------------------------------
// A single append-only log of notable workspace events -- who did what
// and when, across both humans and the agent. See
// services/chat-server/src/audit.ts for how these get written and
// packages/db's audit_events table/schema comment for the storage shape.

export type AuditActorType = "user" | "agent" | "system";

// Kept as a plain string union rather than a generic `string` so the
// frontend's type filter dropdown and any future event type stay in sync
// with what the backend actually writes -- add a new kind here and in
// audit.ts's EVENT_TYPES list together.
export type AuditEventType =
  | "workspace.created"
  | "member.joined"
  | "member.invited"
  | "integration.connected"
  | "action.proposed"
  | "action.confirmed"
  | "action.cancelled"
  | "action.failed"
  // Logged whenever a message @-mentions one or more teammates without
  // also @-mentioning the agent -- see mentions_agent's schema.sql
  // comment. Gives "who's driving this" a durable, searchable trail
  // (docs/spec.md: "so who's driving this stays visible"), on top of the
  // handoff message itself being visible live in the chat.
  | "handoff.directed";

export interface AuditEvent {
  id: string;
  workspaceId: string;
  eventType: AuditEventType;
  actorType: AuditActorType;
  actorUserId: string | null;
  actorName: string;
  // A one-line, already-formatted human description of what happened --
  // e.g. "Dhaval confirmed: open a PR to fix the failing test" -- so the
  // UI can just render it, the same "denormalize for display" choice
  // messages.author_name and pending_actions.description already make.
  summary: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}
