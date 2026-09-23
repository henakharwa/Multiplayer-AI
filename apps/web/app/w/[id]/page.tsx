"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import type { Conversation, GithubRepoSummary, IntegrationConfig, Workspace, WorkspaceMember, WorkspaceRole } from "@mai-chat/shared-types";
import { createConversation, deleteConversation, getWorkspace, listConversations, listIntegrations, listNotifications, listWorkspaceMembers, markNotificationsRead, updateWorkspaceMemberRole, disconnectIntegration, githubOAuthStartUrl, ApiError } from "../../../lib/api";
import { useWorkspaceChat } from "../../../lib/useWorkspaceChat";
import { colorForName, initialsForName } from "../../../lib/avatar";
import ConnectChannelModal from "../../_components/ConnectChannelModal";
import GithubRepoPickerModal from "../../_components/GithubRepoPickerModal";
import { useWorkspaceUser } from "../../_components/WorkspaceAuth";
import { logout } from "../../../lib/api";
import PendingActionCard from "../../_components/PendingActionCard";
import EmailVerificationBanner from "../../_components/EmailVerificationBanner";
import { renderWithMentions, draftLooksLikeHandoff } from "../../../lib/mentionHighlight";



function roleLabel(role: string): string {
  if (role === "agent") return "Agent";
  if (role === "system") return "System";
  return "";
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

// Small inline "spark" glyph for the agent's avatar -- distinguishes it at
// a glance from a person's colored-initials circle without needing an
// image asset.
function AgentGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2Z" fill="currentColor" />
    </svg>
  );
}

// Same GitHub octocat / Slack four-color marks used on the Integrations
// settings page (apps/web/app/w/[id]/integrations/page.tsx) -- kept as
// their own small components here so the "connected channels" row in the
// sidebar below can show the same glyph a member would recognize from
// that page, without duplicating the two integration types' whole panels.
function GithubIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function SlackIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M6 15a2 2 0 1 1-2-2h2v2Zm1 0a2 2 0 1 1 4 0v5a2 2 0 1 1-4 0v-5Z" fill="#e01e5a" />
      <path d="M9 6a2 2 0 1 1 2-2v2H9Zm0 1a2 2 0 1 1 0 4H4a2 2 0 1 1 0-4h5Z" fill="#36c5f0" />
      <path d="M18 9a2 2 0 1 1 2 2h-2V9Zm-1 0a2 2 0 1 1-4 0V4a2 2 0 1 1 4 0v5Z" fill="#2eb67d" />
      <path d="M15 18a2 2 0 1 1-2 2v-2h2Zm0-1a2 2 0 1 1 0-4h5a2 2 0 1 1 0 4h-5Z" fill="#ecb22e" />
    </svg>
  );
}

// One row of the sidebar's "Connected" list -- a GitHub repo (only once a
// repo has actually been chosen; owner/repo is what makes the row
// meaningful, see GithubIntegrationConfig's doc comment for why those can
// be briefly undefined right after OAuth) or a Slack team.
function connectedChannelLabel(integration: IntegrationConfig): string | null {
  if (integration.type === "github") {
    return integration.owner && integration.repo ? `${integration.owner}/${integration.repo}` : null;
  }
  if (integration.type === "slack") return integration.teamName;
  return integration.accountName ?? `${integration.type[0].toUpperCase()}${integration.type.slice(1)} account`;
}

interface StoredNotification {
  id: string;
  text: string;
  createdAt: string;
  read: boolean;
}

type AgentKind = "project" | "github" | "slack" | "linear" | "notion" | "figma";
const AGENTS: Array<{ id: AgentKind; name: string; description: string }> = [
  { id: "project", name: "Project", description: "Planning and coordination" },
  { id: "github", name: "GitHub", description: "Code, issues, and pull requests" },
  { id: "slack", name: "Slack", description: "Team communication" },
  { id: "linear", name: "Linear", description: "Issues and project planning" },
  { id: "notion", name: "Notion", description: "Knowledge and documents" },
  { id: "figma", name: "Figma", description: "Design context and handoff" },
];

type StarterTemplate = { prompt: string; requiresApproval?: boolean };

const STARTER_TEMPLATES: Record<AgentKind, StarterTemplate[]> = {
  project: [
    { prompt: "Summarize this conversation and list the next steps." },
    { prompt: "Create a simple plan for this project." },
    { prompt: "What should our team decide next?" },
  ],
  github: [
    { prompt: "List the open issues in the connected repository." },
    { prompt: "Summarize the latest pull requests." },
    { prompt: "Create an issue for: [describe the task]", requiresApproval: true },
  ],
  slack: [
    { prompt: "List the channels I can access." },
    { prompt: "Find recent messages about: [topic]" },
    { prompt: "Post an update in #[channel]: [message]", requiresApproval: true },
  ],
  linear: [
    { prompt: "List my active issues." },
    { prompt: "Find issues related to: [topic]" },
    { prompt: "What work is currently blocked?" },
  ],
  notion: [
    { prompt: "Search Notion for: [topic]" },
    { prompt: "Find documents about: [project]" },
    { prompt: "Create a page for [topic] under [parent page].", requiresApproval: true },
  ],
  figma: [
    { prompt: "List the Figma files I can access." },
    { prompt: "Summarize the design in [file name]." },
    { prompt: "Find comments or open design questions in [file name]." },
  ],
};

function identityForAgentMessage(authorName: string): { kind: AgentKind; name: string } {
  const knownAgents: Record<string, { kind: AgentKind; name: string }> = {
    "Project Agent": { kind: "project", name: "Project" },
    "GitHub Agent": { kind: "github", name: "GitHub" },
    "Slack Agent": { kind: "slack", name: "Slack" },
    "Linear Agent": { kind: "linear", name: "Linear" },
    "Notion Agent": { kind: "notion", name: "Notion" },
    "Figma Agent": { kind: "figma", name: "Figma" },
  };
  return knownAgents[authorName] ?? { kind: "project", name: authorName.replace(/\s+Agent$/, "").trim() || "Project" };
}

export default function WorkspaceRoomPage() {
  const params = useParams<{ id: string }>();
  const workspaceId = params.id;

  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const user = useWorkspaceUser();
  const displayName = user.displayName;
  const greetingName = (displayName || user.username || "there").trim().split(/\s+/)[0] || "there";

  const [draft, setDraft] = useState("");
  const [conversationSearch, setConversationSearch] = useState("");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationsOpen, setConversationsOpen] = useState(true);
  const [conversationMenu, setConversationMenu] = useState<string | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [selectedAgent, setSelectedAgent] = useState<AgentKind>("project");
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [workspaceMembers, setWorkspaceMembers] = useState<WorkspaceMember[]>([]);
  const [showAccessManager, setShowAccessManager] = useState(false);
  const [notifications, setNotifications] = useState<StoredNotification[]>([]);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const composerInputRef = useRef<HTMLInputElement | null>(null);
  const knownMessageIds = useRef(new Set<string>());
  const knownActionIds = useRef(new Set<string>());
  const initializedConversation = useRef<string | null>(null);

  const router = useRouter();
  const [showConnectModal, setShowConnectModal] = useState(false);
  const [showRepoPicker, setShowRepoPicker] = useState(false);
  const [githubNotice, setGithubNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [slackNotice, setSlackNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [integrations, setIntegrations] = useState<IntegrationConfig[]>([]);
  const [toolMenu, setToolMenu] = useState<IntegrationConfig["type"] | null>(null);

  // Lands here right after the GitHub or Slack OAuth redirect
  // (services/chat-server/src/github-oauth.ts / slack-oauth.ts always
  // send the browser back to /w/:id, whether the "+" flow or the
  // Integrations settings page's "Log in with ..." button started it).
  // Reads window.location directly (rather than next/navigation's
  // useSearchParams) so this page doesn't need a Suspense boundary just
  // for a one-time redirect check. Strips the query params afterward so a
  // page refresh doesn't re-trigger this.
  // Best-effort -- if this fails, the sidebar's "Connected" row just stays
  // empty or stale; the rest of the room (chat, presence) doesn't depend
  // on it, so a network hiccup here shouldn't be treated as fatal.
  function refreshIntegrations() {
    listIntegrations(workspaceId)
      .then(setIntegrations)
      .catch(() => {});
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const github = params.get("github");
    const slack = params.get("slack");
    if (!github && !slack) return;
    if (github === "connected") {
      setShowRepoPicker(true);
    } else if (github === "error") {
      setGithubNotice({ kind: "error", text: params.get("githubMessage") ?? "GitHub login failed." });
    }
    if (slack === "connected") {
      setSlackNotice({ kind: "success", text: "Slack connected -- the agent can now read and post to it." });
      refreshIntegrations();
    } else if (slack === "error") {
      setSlackNotice({ kind: "error", text: params.get("slackMessage") ?? "Slack login failed." });
    }
    router.replace(`/w/${workspaceId}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleRepoSelected(repo: GithubRepoSummary) {
    setShowRepoPicker(false);
    refreshIntegrations();
  }

  function changeGithubConnection() {
    window.location.href = githubOAuthStartUrl(workspaceId);
  }

  async function removeIntegration(provider: IntegrationConfig["type"]) {
    try {
      await disconnectIntegration(workspaceId, provider);
      setIntegrations((current) => current.filter((item) => item.type !== provider));
    } catch (err) {
      setGithubNotice({ kind: "error", text: err instanceof Error ? err.message : "Could not disconnect this tool." });
    } finally {
      setToolMenu(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    getWorkspace(workspaceId)
      .then((ws) => {
        if (!cancelled) setWorkspace(ws);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof ApiError && err.status === 404 ? "Workspace not found." : "Could not reach the chat server.");
      });
    listIntegrations(workspaceId)
      .then((list) => {
        if (!cancelled) setIntegrations(list);
      })
      .catch(() => {});
    listConversations(workspaceId)
      .then((list) => {
        if (cancelled) return;
        setConversations(list);
        const requested = new URLSearchParams(window.location.search).get("conversation");
        setSelectedConversationId(list.some((item) => item.id === requested) ? requested : (list[0]?.id ?? null));
      })
      .catch(() => {});
    listWorkspaceMembers(workspaceId).then((members) => { if (!cancelled) setWorkspaceMembers(members); }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // Polls rather than pushing over the WebSocket -- a teammate connecting
  // GitHub or Slack doesn't (yet) broadcast a room event the way a chat
  // message does, so this is how everyone else's sidebar picks it up. 20s
  // keeps it feeling reasonably live without hammering the chat server;
  // the person who actually did the connecting still sees it instantly via
  // the direct refreshIntegrations() calls above.
  useEffect(() => {
    const interval = setInterval(() => {
      listIntegrations(workspaceId)
        .then(setIntegrations)
        .catch(() => {});
    }, 20_000);
    return () => clearInterval(interval);
  }, [workspaceId]);

  const chat = useWorkspaceChat(workspace ? workspaceId : null, selectedConversationId, displayName);

  const notificationKey = `mai:notifications:${workspaceId}`;
  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(notificationKey) ?? "[]") as StoredNotification[];
      setNotifications(saved.slice(0, 30));
    } catch {
      setNotifications([]);
    }
  }, [notificationKey]);

  useEffect(() => {
    window.localStorage.setItem(notificationKey, JSON.stringify(notifications.slice(0, 30)));
  }, [notificationKey, notifications]);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => listNotifications(workspaceId).then((serverNotifications) => {
      if (cancelled) return;
      setNotifications(serverNotifications.map((notification) => ({ id: notification.id, text: notification.text, createdAt: notification.createdAt, read: Boolean(notification.readAt) })));
    }).catch(() => {});
    refresh();
    const interval = window.setInterval(refresh, 15_000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [workspaceId]);

  function addNotification(text: string): void {
    setNotifications((current) => [{ id: crypto.randomUUID(), text, createdAt: new Date().toISOString(), read: false }, ...current].slice(0, 30));
  }

  useEffect(() => {
    if (!chat.historyLoaded) return;
    if (initializedConversation.current !== selectedConversationId) {
      initializedConversation.current = selectedConversationId;
      chat.messages.forEach((message) => knownMessageIds.current.add(message.id));
      chat.pendingActions.forEach((action) => knownActionIds.current.add(action.id));
      return;
    }
    for (const message of chat.messages) {
      if (knownMessageIds.current.has(message.id)) continue;
      knownMessageIds.current.add(message.id);
      if (message.role === "agent") addNotification(`Agent replied in ${conversations.find((item) => item.id === selectedConversationId)?.title ?? "this conversation"}`);
      if (message.role === "system") addNotification(message.content);
    }
  // Chat history fills the set on a new conversation; only later messages create notifications.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.historyLoaded, chat.messages]);

  useEffect(() => {
    if (!chat.historyLoaded) return;
    for (const action of chat.pendingActions) {
      if (knownActionIds.current.has(action.id)) continue;
      knownActionIds.current.add(action.id);
      if (action.status === "pending") addNotification(`Approval needed: ${action.description}`);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.historyLoaded, chat.pendingActions]);

  const unreadNotifications = notifications.filter((notification) => !notification.read).length;

  async function startNewConversation(): Promise<void> {
    try {
      const conversation = await createConversation(workspaceId);
      setConversations((current) => [conversation, ...current]);
      setSelectedConversationId(conversation.id);
      setConversationSearch("");
      setDraft("");
      window.history.replaceState(null, "", `/w/${workspaceId}?conversation=${conversation.id}`);
      window.setTimeout(() => composerInputRef.current?.focus(), 0);
    } catch {
      setLoadError("Could not create a new conversation.");
    }
  }

  function selectConversation(conversationId: string): void {
    setSelectedConversationId(conversationId);
    setConversationSearch("");
    setDraft("");
    window.history.replaceState(null, "", `/w/${workspaceId}?conversation=${conversationId}`);
  }

  async function removeConversation(conversation: Conversation): Promise<void> {
    if (!window.confirm(`Delete “${conversation.title}”? This permanently removes its messages and pending approvals.`)) return;
    try {
      const remaining = await deleteConversation(workspaceId, conversation.id);
      setConversations(remaining);
      setConversationMenu(null);
      const nextConversation = remaining.find((item) => item.id !== conversation.id) ?? remaining[0];
      if (nextConversation) selectConversation(nextConversation.id);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not delete this conversation.");
    }
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat.messages.length]);



  // See draftLooksLikeHandoff's own comment -- a draft that's clearly
  // @-mentioning only a teammate is exempt from the "wait for the agent"
  // gate, both here and in the composer's disabled state above, since the
  // server itself never blocks a handoff on the agent being busy.
  const draftIsHandoff = draftLooksLikeHandoff(
    draft,
    chat.participants.map((p) => p.displayName)
  );

  function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim() || (chat.agentBusy && !draftIsHandoff)) return;
    if (selectedConversationId) {
      const title = draft.trim().slice(0, 80);
      setConversations((current) => current.map((conversation) =>
        conversation.id === selectedConversationId && conversation.title === "New conversation"
          ? { ...conversation, title }
          : conversation
      ));
    }
    chat.sendMessage(draft, selectedAgent);
    setDraft("");
  }

  async function copyInvite(): Promise<void> {
    if (!workspace) return;
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/?joinCode=${encodeURIComponent(workspace.joinCode)}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  const visibleMessages = conversationSearch.trim()
    ? chat.messages.filter((message) => `${message.authorName} ${message.content}`.toLowerCase().includes(conversationSearch.trim().toLowerCase()))
    : chat.messages;
  const isNewWorkspaceConversation = chat.messages.length === 0;
  const selectedAgentInfo = AGENTS.find((agent) => agent.id === selectedAgent) ?? AGENTS[0];
  const workspaceRole = workspaceMembers.find((member) => member.id === user.id)?.role ?? "admin";
  const canEdit = workspaceRole === "admin" || workspaceRole === "editor";
  const selectedAgentConnected = selectedAgent === "project" || integrations.some((integration) => integration.type === selectedAgent);
  const notificationsToday = notifications.filter((notification) => new Date(notification.createdAt).toDateString() === new Date().toDateString());
  const notificationsEarlier = notifications.filter((notification) => !notificationsToday.includes(notification));

  function useStarterTemplate(prompt: string): void {
    setDraft(prompt);
    window.setTimeout(() => composerInputRef.current?.focus(), 0);
  }

  if (loadError) {
    return (
      <div className="page">
        <div className="card">
          <p className="error-text" data-testid="room-load-error">
            {loadError}
          </p>
          <Link className="btn secondary" href="/" style={{ display: "block", textAlign: "center", marginTop: 14 }}>
            Back home
          </Link>
        </div>
      </div>
    );
  }

  if (!workspace) {
    return (
      <div className="page">
        <p style={{ color: "var(--text-dim)" }}>Loading workspace…</p>
      </div>
    );
  }



  return (
    <div className="workspace-shell">
      <EmailVerificationBanner user={user} />
      {(chat.status === "closed" || chat.reconnecting || githubNotice || slackNotice) && <div className="workspace-toast-stack" aria-live="polite">
        {chat.reconnecting && <div className="workspace-toast reconnecting" data-testid="reconnecting-notice"><span>Reconnecting to the workspace…</span><button disabled>Reconnecting</button></div>}
        {chat.status === "closed" && chat.closeReason && (
          <div className="workspace-toast error" data-testid="disconnect-banner">
            <span>{chat.closeReason}</span>
            <button onClick={chat.reconnect} disabled={chat.reconnecting}>{chat.reconnecting ? "Reconnecting" : "Reconnect"}</button>
          </div>
        )}
        {githubNotice && (
          <div className={`workspace-toast ${githubNotice.kind === "success" ? "success" : "error"}`} data-testid="github-notice">
            <span>{githubNotice.text}</span>
            <button onClick={() => setGithubNotice(null)}>Dismiss</button>
          </div>
        )}
        {slackNotice && (
          <div className={`workspace-toast ${slackNotice.kind === "success" ? "success" : "error"}`} data-testid="slack-notice">
            <span>{slackNotice.text}</span>
            <button onClick={() => setSlackNotice(null)}>Dismiss</button>
          </div>
        )}
      </div>}

      {showConnectModal && <ConnectChannelModal workspaceId={workspaceId} onClose={() => setShowConnectModal(false)} />}
      {showRepoPicker && (
        <GithubRepoPickerModal workspaceId={workspaceId} onClose={() => setShowRepoPicker(false)} onSelected={handleRepoSelected} />
      )}

      <aside className="workspace-sidebar">
        <div className="workspace-sidebar-top">
          <Link href="/" className="workspace-brand" aria-label="Multiplayer AI home"><BrandGlyph /><span>Work</span></Link>
          <div className="workspace-sidebar-icons">
            <div className="workspace-notification-wrap">
              <button type="button" title="Notifications" onClick={() => { setNotificationsOpen((open) => !open); setNotifications((current) => current.map((item) => ({ ...item, read: true }))); void markNotificationsRead(workspaceId); }} aria-label={`Notifications${unreadNotifications ? ` (${unreadNotifications} unread)` : ""}`}><BellGlyph />{unreadNotifications > 0 && <span className="workspace-notification-badge">{unreadNotifications > 9 ? "9+" : unreadNotifications}</span>}</button>
              {notificationsOpen && <section className="workspace-notification-panel" aria-label="Notifications">
                <div><strong>Notifications</strong><button type="button" onClick={() => setNotifications([])}>Clear</button></div>
                {notifications.length ? <>{notificationsToday.length > 0 && <NotificationGroup label="Today" notifications={notificationsToday} />}{notificationsEarlier.length > 0 && <NotificationGroup label="Earlier" notifications={notificationsEarlier} />}</> : <div className="workspace-notification-empty"><strong>You&apos;re all caught up</strong><span>Updates from teammates and approved actions will appear here.</span></div>}
              </section>}
            </div>
            {canEdit && <button type="button" title="Workspace integrations" onClick={() => setShowConnectModal(true)} aria-label="Add integration"><PlugGlyph /></button>}
            <Link href={`/w/${workspaceId}/integrations`} title="Workspace settings" aria-label="Workspace settings"><GearGlyph /></Link>
          </div>
        </div>
        <div className="workspace-search"><SearchGlyph /><input value={conversationSearch} onChange={(event) => setConversationSearch(event.target.value)} placeholder="Search this conversation" aria-label="Search this conversation" /></div>
        <button
          className="workspace-new"
          onClick={startNewConversation}
        >
          <PlusGlyph /> New chat
        </button>

        <nav className="workspace-nav" aria-label="Workspace navigation">
          <a className="active" href="#conversation"><ChatGlyph /> Conversation</a>
          <Link href={`/w/${workspaceId}/audit`}><ActivityGlyph /> Activity</Link>
          <Link href={`/w/${workspaceId}/integrations`}><GridGlyph /> Integrations</Link>
        </nav>

        <div className="workspace-conversations" aria-label="Conversations">
          <button type="button" className="workspace-conversation-toggle" aria-expanded={conversationsOpen} onClick={() => setConversationsOpen((open) => !open)}>
            <span>Conversations</span><ChevronGlyph direction={conversationsOpen ? "up" : "down"} />
          </button>
          {conversationsOpen && conversations.map((conversation) => (
            <div className={`workspace-conversation-row${conversation.id === selectedConversationId ? " active" : ""}`} key={conversation.id}>
              <button type="button" className="workspace-conversation-item" onClick={() => selectConversation(conversation.id)} title={conversation.title}>
                <span>{conversation.title}</span>{chat.unreadConversationIds.includes(conversation.id) && <i className="workspace-unread-dot" aria-label="Unread messages" />}
              </button>
              {canEdit && <div className="workspace-conversation-menu"><button type="button" className="workspace-conversation-more" aria-label={`More options for ${conversation.title}`} aria-expanded={conversationMenu === conversation.id} onClick={() => setConversationMenu((current) => current === conversation.id ? null : conversation.id)}><MoreGlyph /></button>{conversationMenu === conversation.id && <div className="workspace-conversation-popover"><button type="button" onClick={() => void removeConversation(conversation)}>Delete chat</button></div>}</div>}
            </div>
          ))}
        </div>

        <div className="workspace-side-section">
          <div className="workspace-side-heading"><span>Connected tools</span><button onClick={() => setShowConnectModal(true)} aria-label="Add connected tool"><PlusGlyph /></button></div>
          {integrations.length > 0 && integrations.some((i) => connectedChannelLabel(i)) ? integrations.map((integration) => {
            const label = connectedChannelLabel(integration);
            if (!label) return null;
            return <div className="workspace-tool-row" key={integration.type} data-testid={`connected-${integration.type}`}>
              <Link className="workspace-tool" href={`/w/${workspaceId}/integrations`}><span className="channel-glyph"><ToolIcon tool={integration.type} /></span><span>{label}</span><small className="tool-health connected">Connected</small></Link>
              {canEdit && <div className="workspace-tool-menu"><button type="button" className="workspace-tool-more" aria-label={`Manage ${integration.type}`} aria-expanded={toolMenu === integration.type} onClick={() => setToolMenu((current) => current === integration.type ? null : integration.type)}><MoreGlyph /></button>{toolMenu === integration.type && <div className="workspace-tool-popover">{integration.type === "github" && <button type="button" onClick={changeGithubConnection}>Change</button>}<button type="button" className="danger" onClick={() => void removeIntegration(integration.type)}>Disconnect</button></div>}</div>}
            </div>;
          }) : <button className="workspace-empty-tool" onClick={() => setShowConnectModal(true)}><PlusGlyph /> Connect GitHub or Slack</button>}
          <div className="workspace-tool-health-list">{AGENTS.filter((agent) => agent.id !== "project" && !integrations.some((integration) => integration.type === agent.id)).map((agent) => <button key={agent.id} type="button" className="workspace-tool-health-row" onClick={() => setShowConnectModal(true)}><AgentIcon agent={agent.id} /><span>{agent.name}</span><small>Needs connection</small></button>)}</div>
        </div>

        <div className="workspace-side-section workspace-members">
          <div className="workspace-side-heading"><span>In this workspace</span>{workspaceRole === "admin" ? <button className="workspace-manage-members" onClick={() => setShowAccessManager(true)}>Manage</button> : <span>{workspaceRole}</span>}</div>
          {chat.workspaceParticipants.map((p) => (
            <div className="participant" key={p.clientId} data-testid="participant">
              <span className="avatar" style={{ background: colorForName(p.displayName) }}>{initialsForName(p.displayName)}</span>
              <span>{p.displayName}{p.displayName === displayName ? " (you)" : ""}{p.activeConversationId && p.activeConversationId !== selectedConversationId ? <small> · viewing another chat</small> : ""}</span>
              {p.activeConversationId && p.activeConversationId !== selectedConversationId && <button className="workspace-follow" onClick={() => selectConversation(p.activeConversationId!)}>Follow</button>}<span className="dot" />
            </div>
          ))}
        </div>

        <div className="workspace-account">
          <span className="workspace-account-avatar" style={{ background: colorForName(displayName) }}>{initialsForName(displayName)}</span>
          <span><strong>{displayName}</strong><small>{user.username}</small></span>
          <button onClick={async () => { await logout(); window.location.href = "/"; }} aria-label="Sign out" title="Sign out"><SignOutGlyph /></button>
        </div>
      </aside>

      <main className="workspace-main" id="conversation">
        <header className="workspace-main-header">
          <div><p className="workspace-kicker">Shared workspace</p><h1>{workspace.name}</h1></div>
          <div className="workspace-header-actions">
            <button className="workspace-invite" onClick={copyInvite}><LinkGlyph /> {copied ? "Invite link copied" : "Invite teammates"}</button>
            {workspaceRole === "admin" && <button className="workspace-invite" onClick={() => setShowAccessManager(true)}>Manage access</button>}
          </div>
        </header>

        <div className="workspace-chat-scroll" data-testid="message-list">
          {isNewWorkspaceConversation ? (
            <section className="workspace-empty-state">
              <h2>What&apos;s next, {greetingName}?</h2>
              <form className="workspace-hero-composer" onSubmit={handleSend}>
                <input
                  ref={composerInputRef}
                  data-testid="chat-input"
                  placeholder="Get work done"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  disabled={chat.status !== "open" || !canEdit}
                  autoComplete="off"
                />
                <div className="workspace-hero-composer-footer">
                  <AgentSelector selected={selectedAgent} selectedName={selectedAgentInfo.name} open={agentPickerOpen} onToggle={() => setAgentPickerOpen((open) => !open)} onSelect={(agent) => { setSelectedAgent(agent); setAgentPickerOpen(false); }} />
                  <button type="submit" data-testid="send-btn" disabled={chat.status !== "open" || !canEdit || !draft.trim()} aria-label="Start chat"><ArrowGlyph /></button>
                </div>
              </form>
              <StarterPrompts
                agent={selectedAgent}
                agentName={selectedAgentInfo.name}
                connected={selectedAgentConnected}
                canEdit={canEdit}
                chatOpen={chat.status === "open"}
                onChoose={useStarterTemplate}
                onConnect={() => setShowConnectModal(true)}
              />
            </section>
          ) : visibleMessages.map((m) => {
            if (m.role === "system") {
              return (
                <div className="msg system" key={m.id} data-testid="chat-message">
                  <div className="bubble">{m.content}</div>
                </div>
              );
            }
            const isAgent = m.role === "agent";
            const agentIdentity = isAgent ? identityForAgentMessage(m.authorName) : null;
            // @-mention / handoff mechanics (docs/spec.md Phase 2): a
            // 'user' message that @-mentioned only a teammate (never the
            // agent) never triggered a turn -- see server.ts's WebSocket
            // handler -- so it's marked here as handed off instead of
            // looking like an ordinary message the agent silently ignored.
            // Defensive: mentionsAgent/mentionedUserIds are only present
            // once the chat-server is running the build that added them
            // (see the migration + rebuild steps this feature needs) --
            // fall back to "not a handoff, mentions nobody" rather than
            // crash the whole message list on a stale/partial response.
            const isHandoff = m.role === "user" && m.mentionsAgent === false;
            const mentionsCurrentUser = (m.mentionedUserIds ?? []).includes(user.id);
            // Prefer the immutable user id. The name fallback keeps older messages aligned for their author.
            const isCurrentUserMessage = m.role === "user" && (m.authorUserId ? m.authorUserId === user.id : m.authorName === displayName);
            return (
              <div className={`msg${isCurrentUserMessage ? " own" : ""}${mentionsCurrentUser ? " mentions-you" : ""}`} key={m.id} data-testid="chat-message">
                <span className={`avatar ${isAgent ? "agent" : ""}`} style={isAgent ? undefined : { background: colorForName(m.authorName) }}>
                  {isAgent && agentIdentity ? <AgentIcon agent={agentIdentity.kind} /> : initialsForName(m.authorName)}
                </span>
                <div className="msg-body">
                  <div className="meta">
                    <span className={`author ${isAgent ? "agent" : ""}`}>{agentIdentity?.name ?? (m.authorName || roleLabel(m.role))}</span>
                    <span>· {formatTime(m.createdAt)}</span>
                    {isHandoff && (
                      <span className="handoff-badge" data-testid="handoff-badge" title="Directed at a teammate -- the agent didn't see this as a request">
                        handed off
                      </span>
                    )}
                  </div>
                  <div className="bubble">{renderWithMentions(m.content, chat.participants.map((p) => p.displayName))}</div>
                </div>
              </div>
            );
          })}
          {conversationSearch && visibleMessages.length === 0 && <p className="workspace-no-results">No messages match “{conversationSearch}”.</p>}
          <div ref={messagesEndRef} />
        </div>

        {chat.pendingActions.some((a) => a.status === "pending") && (
          <div className="pending-actions-list" data-testid="pending-actions-list">
            {chat.pendingActions
              .filter((a) => a.status === "pending")
              .map((a) => (
                <PendingActionCard key={a.id} workspaceId={workspaceId} action={a} actorName={displayName} />
              ))}
          </div>
        )}

        {chat.agentBusy && (
          <div className="agent-busy-note" data-testid="agent-busy-note">
            The agent is working on the previous request…
          </div>
        )}
        {chat.sendError && (
          <div className="agent-busy-note error" data-testid="send-error-note">
            {chat.sendError}
          </div>
        )}

        {!isNewWorkspaceConversation && <div className="workspace-composer-wrap">
        <StarterPrompts
          compact
          agent={selectedAgent}
          agentName={selectedAgentInfo.name}
          connected={selectedAgentConnected}
          canEdit={canEdit}
          chatOpen={chat.status === "open"}
          onChoose={useStarterTemplate}
          onConnect={() => setShowConnectModal(true)}
        />
        <form className="composer" onSubmit={handleSend}>
          <input
            ref={composerInputRef}
            data-testid="chat-input"
            placeholder={
              chat.status !== "open"
                ? "Connecting…"
                : chat.agentBusy && !draftIsHandoff
                  ? "Waiting for the agent to finish… (or @mention a teammate to hand this off now)"
                  : "Message the workspace… (@mention the agent or a teammate)"
            }
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={chat.status !== "open" || !canEdit || (chat.agentBusy && !draftIsHandoff)}
            autoComplete="off"
          />
          <AgentSelector selected={selectedAgent} selectedName={selectedAgentInfo.name} open={agentPickerOpen} onToggle={() => setAgentPickerOpen((open) => !open)} onSelect={(agent) => { setSelectedAgent(agent); setAgentPickerOpen(false); }} compact />
          <button className="composer-send"
            type="submit"
            data-testid="send-btn"
            disabled={chat.status !== "open" || !canEdit || (chat.agentBusy && !draftIsHandoff) || !draft.trim()}
          >
            <ArrowGlyph />
          </button>
        </form>
        <p className="workspace-composer-note">Messages are shared with everyone in {workspace.name}. Use @agent or @mention a teammate to direct the next step.</p>
        </div>}
        {showAccessManager && <AccessManager workspaceId={workspaceId} members={workspaceMembers} onClose={() => setShowAccessManager(false)} onChanged={setWorkspaceMembers} />}
      </main>
    </div>
  );
}

function BrandGlyph() { return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="12" height="12" rx="3" fill="none" stroke="currentColor" strokeWidth="2"/><rect x="9" y="9" width="12" height="12" rx="3" fill="none" stroke="currentColor" strokeWidth="2"/></svg>; }
function AgentSelector({ selected, selectedName, open, onToggle, onSelect, compact = false }: { selected: AgentKind; selectedName: string; open: boolean; onToggle: () => void; onSelect: (agent: AgentKind) => void; compact?: boolean }) {
  const [query, setQuery] = useState("");
  const [pickerPlacement, setPickerPlacement] = useState<"above" | "below">("above");
  const [pickerMaxHeight, setPickerMaxHeight] = useState(330);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const matchingAgents = AGENTS.filter((agent) => `${agent.name} ${agent.description}`.toLowerCase().includes(query.trim().toLowerCase()));
  function togglePicker() {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const above = rect.top - 12;
      const below = window.innerHeight - rect.bottom - 12;
      const placement = above >= below ? "above" : "below";
      setPickerPlacement(placement);
      setPickerMaxHeight(Math.max(96, Math.min(330, placement === "above" ? above : below)));
    }
    onToggle();
  }
  return <div className={`agent-selector${compact ? " compact" : ""}`}>
    <button ref={triggerRef} type="button" className="workspace-agent-chip" onClick={togglePicker} title={`Select agent: ${selectedName}`} aria-label={`Select agent: ${selectedName}`}><AgentIcon agent={selected} /></button>
    {open && <div className={`agent-picker ${pickerPlacement}`} style={{ maxHeight: pickerMaxHeight }} role="menu"><div className="agent-picker-toolbar"><label><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Agents" aria-label="Search agents" /><SearchGlyph /></label></div><div className="agent-picker-list">{matchingAgents.map((agent) => <button type="button" key={agent.id} className={agent.id === selected ? "selected" : ""} onClick={() => onSelect(agent.id)}><span><AgentIcon agent={agent.id} /></span><strong>{agent.name}</strong><small>{agent.description}</small>{agent.id === selected && <b>✓</b>}</button>)}{matchingAgents.length === 0 && <p>No agents match your search.</p>}</div></div>}
  </div>;
}
function StarterPrompts({ agent, agentName, connected, canEdit, chatOpen, onChoose, onConnect, compact = false }: {
  agent: AgentKind;
  agentName: string;
  connected: boolean;
  canEdit: boolean;
  chatOpen: boolean;
  onChoose: (prompt: string) => void;
  onConnect: () => void;
  compact?: boolean;
}) {
  return <section className={`workspace-starter-prompts${compact ? " compact" : ""}`} aria-label={`${agentName} starter prompts`}>
    <p>Try {agentName}</p>
    <div>
      {connected ? STARTER_TEMPLATES[agent].map((template) => (
        <button key={template.prompt} type="button" onClick={() => onChoose(template.prompt)} disabled={!canEdit || !chatOpen}>
          <span>{template.prompt}</span>{template.requiresApproval && <small>Requires approval</small>}
        </button>
      )) : (
        <button type="button" onClick={onConnect} disabled={!canEdit}><span>Connect {agentName} to get started</span></button>
      )}
    </div>
  </section>;
}
function NotificationGroup({ label, notifications }: { label: string; notifications: StoredNotification[] }) {
  return <section className="workspace-notification-group"><p>{label}</p>{notifications.map((notification) => <article key={notification.id}><p>{notification.text}</p><time>{formatTime(notification.createdAt)}</time></article>)}</section>;
}
function LinearIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 5.2 5.2 4 20 18.8 18.8 20 4 5.2Zm0 6.7L5.2 10.7 13.3 18.8 12.1 20 4 11.9Zm6.7-7.9L12 2.8 20 10.7l-1.2 1.2L10.7 4Z" /></svg>; }
function NotionIcon() { return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5.2 4.5 18.8 3.4l1.5 1.8v14.1l-1.7 1.2-13.4-.9-1.5-1.7V6.2l1.5-1.7Z" stroke="currentColor" strokeWidth="1.8" /><path d="M8 8.4v7.1m0-7.1 7.8 7.1m0-7.1v7.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>; }
function FigmaIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#F24E1E" d="M8 2h4v4H8a2 2 0 1 1 0-4Z" /><path fill="#FF7262" d="M12 2h4a2 2 0 1 1 0 4h-4V2Z" /><path fill="#A259FF" d="M8 6h4v4H8a2 2 0 1 1 0-4Z" /><path fill="#1ABCFE" d="M12 6h4a2 2 0 1 1 0 4h-4V6Z" /><path fill="#0ACF83" d="M8 10h4v4a2 2 0 1 1-4 0v-4Z" /></svg>; }
function ToolIcon({ tool }: { tool: Exclude<IntegrationConfig["type"], "project"> }) { return tool === "github" ? <GithubIcon /> : tool === "slack" ? <SlackIcon /> : tool === "linear" ? <LinearIcon /> : tool === "notion" ? <NotionIcon /> : <FigmaIcon />; }
function AgentIcon({ agent }: { agent: AgentKind }) { return <span className={`agent-logo ${agent}`}>{agent === "project" ? <AgentGlyph /> : <ToolIcon tool={agent} />}</span>; }
function AccessManager({ workspaceId, members, onClose, onChanged }: { workspaceId: string; members: WorkspaceMember[]; onClose: () => void; onChanged: (members: WorkspaceMember[]) => void }) {
  const [error, setError] = useState<string | null>(null);
  async function changeRole(member: WorkspaceMember, role: WorkspaceRole) {
    try {
      await updateWorkspaceMemberRole(workspaceId, member.id, role);
      onChanged(members.map((item) => item.id === member.id ? { ...item, role } : item));
    } catch (err) { setError(err instanceof Error ? err.message : "Could not change role."); }
  }
  return <div className="access-modal-backdrop" role="presentation"><section className="access-modal" role="dialog" aria-modal="true" aria-label="Manage workspace access"><header><div><p>Workspace access</p><h2>Members and roles</h2></div><button onClick={onClose} aria-label="Close">×</button></header><p className="access-modal-intro">Admins manage access and approve write actions. Editors can connect tools and work with agents.</p>{error && <p className="error-text">{error}</p>}<div className="access-member-list">{members.map((member) => <div className="access-member" key={member.id}><span className="avatar" style={{ background: colorForName(member.displayName) }}>{initialsForName(member.displayName)}</span><strong>{member.displayName}<small>{member.email ?? member.username}</small></strong><select value={member.role} onChange={(event) => void changeRole(member, event.target.value as WorkspaceRole)} aria-label={`Role for ${member.displayName}`}><option value="admin">Admin</option><option value="editor">Editor</option></select></div>)}</div></section></div>;
}
function SearchGlyph() { return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6" fill="none" stroke="currentColor" strokeWidth="2"/><path d="m16 16 4 4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>; }
function PlusGlyph() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>; }
function MoreGlyph() { return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="19" cy="12" r="1.7" fill="currentColor"/></svg>; }
function PlugGlyph() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3v6m8-6v6M6 9h12v2a6 6 0 0 1-12 0V9Zm6 8v4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>; }
function GearGlyph() { return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="2"/><path d="M19 13.5v-3l-2-.6a6 6 0 0 0-.8-1.8l1-1.8-2.1-2.1-1.8 1.1a6 6 0 0 0-1.8-.8L11 2.5H8v2.1a6 6 0 0 0-1.8.8L4.4 4.3 2.3 6.4l1.1 1.8a6 6 0 0 0-.8 1.8l-2 .5v3l2 .6a6 6 0 0 0 .8 1.8l-1.1 1.8 2.1 2.1 1.8-1.1a6 6 0 0 0 1.8.8L8 21.5h3v-2.1a6 6 0 0 0 1.8-.8l1.8 1.1 2.1-2.1-1.1-1.8a6 6 0 0 0 .8-1.8l1.6-.5Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/></svg>; }
function ChatGlyph() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H8l-4 3V5Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"/></svg>; }
function ActivityGlyph() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h4l2-6 4 12 2-6h4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function GridGlyph() { return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="6" height="6" rx="1" fill="none" stroke="currentColor" strokeWidth="2"/><rect x="14" y="4" width="6" height="6" rx="1" fill="none" stroke="currentColor" strokeWidth="2"/><rect x="4" y="14" width="6" height="6" rx="1" fill="none" stroke="currentColor" strokeWidth="2"/><rect x="14" y="14" width="6" height="6" rx="1" fill="none" stroke="currentColor" strokeWidth="2"/></svg>; }
function ChevronGlyph({ direction }: { direction: "up" | "down" }) { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={direction === "up" ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function LinkGlyph() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1L11 5m3 6a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 19.9L13 19" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>; }
function ArrowGlyph() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13m-5-5 5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function SignOutGlyph() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 5H5v14h5m4-4 5-3-5-3m5 3H9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
function BellGlyph() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 10a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 22h4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>; }
