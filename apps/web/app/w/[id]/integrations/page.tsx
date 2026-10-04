"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import type { GithubRepoSummary, IntegrationConfig, WorkspaceAgent, WorkspacePermissionPolicy, WorkspacePermissions, WorkspaceRole } from "@mai-chat/shared-types";
import { describeError, connectGithub, connectRemoteMcp, githubOAuthStartUrl, slackOAuthStartUrl, listIntegrations, listWorkspaceAgents, getWorkspacePermissionPolicy, updateWorkspacePermissionPolicy, requestWorkspacePermission, listPermissionRequests, resolvePermissionRequest, testIntegration, type PermissionRequest } from "../../../../lib/api";
import { useWorkspaceUser } from "../../../_components/WorkspaceAuth";
import GithubRepoPickerModal from "../../../_components/GithubRepoPickerModal";
import { AccessNotice } from "../../../_components/AccessNotice";
import { useWorkspaceAccess } from "../../../../lib/useWorkspaceAccess";

const PERMISSIONS: Array<[keyof WorkspacePermissions, string]> = [["connectTools", "Connect and manage tools"], ["createAgents", "Create agents"], ["publishAgents", "Publish agents"], ["approveActions", "Approve actions"], ["github", "Use GitHub"], ["slack", "Use Slack"], ["linear", "Use Linear"], ["notion", "Use Notion"], ["figma", "Use Figma"]];

export default function IntegrationsPage() {
  const params = useParams<{ id: string }>();
  const workspaceId = params.id;
  const user = useWorkspaceUser();
  const access = useWorkspaceAccess(workspaceId);
  const workspaceRole: WorkspaceRole = access.role ?? "editor";
  // Viewing providers and status is shared; connecting, updating, and
  // disconnecting require connectTools (Admins by default).
  const canConnect = access.can("connectTools");
  const [requests, setRequests] = useState<PermissionRequest[]>([]);
  const [requestedPermission, setRequestedPermission] = useState<keyof WorkspacePermissions | null>(null);
  const [requestReason, setRequestReason] = useState("");
  const [requestBusy, setRequestBusy] = useState(false);

  const [integrations, setIntegrations] = useState<IntegrationConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<"connected" | "browse" | "access">("connected");
  const [agents, setAgents] = useState<WorkspaceAgent[]>([]);
  const [diagnostics, setDiagnostics] = useState<Record<string, string>>({});
  const [remoteSetup, setRemoteSetup] = useState<Record<"linear" | "notion" | "figma", { endpoint: string; token: string; busy: boolean; error: string }>>({ linear: { endpoint: "", token: "", busy: false, error: "" }, notion: { endpoint: "", token: "", busy: false, error: "" }, figma: { endpoint: "", token: "", busy: false, error: "" } });
  const [remoteSetupOpen, setRemoteSetupOpen] = useState<"linear" | "notion" | "figma" | null>(null);

  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [githubToken, setGithubToken] = useState("");
  const [connectionName, setConnectionName] = useState("My GitHub");
  const [connectionScope, setConnectionScope] = useState<"shared" | "personal">("personal");
  const [githubBusy, setGithubBusy] = useState(false);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [githubSuccess, setGithubSuccess] = useState(false);

  const [showRepoPicker, setShowRepoPicker] = useState(false);
  const [policy, setPolicy] = useState<WorkspacePermissionPolicy | null>(null);
  const [policyBusy, setPolicyBusy] = useState(false);
  const [policyError, setPolicyError] = useState<string | null>(null);

  async function refresh() {
    try {
      const list = await listIntegrations(workspaceId);
      setIntegrations(list);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    getWorkspacePermissionPolicy(workspaceId).then(setPolicy).catch(() => setPolicy(null));

    if (access.isAdmin) listPermissionRequests(workspaceId).then(setRequests).catch(() => {});
    listWorkspaceAgents(workspaceId).then(setAgents).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, user.id, access.isAdmin]);

  function setPermission(role: "admin" | "editor", permission: keyof WorkspacePermissions, value: boolean) {
    setPolicy((current) => current ? { ...current, [role]: { ...current[role], [permission]: value } } : current);
  }

  async function savePolicy() {
    if (!policy) return;
    setPolicyBusy(true); setPolicyError(null);
    try { setPolicy(await updateWorkspacePermissionPolicy(workspaceId, policy)); }
    catch (error) { setPolicyError(describeError(error, "Could not save workspace permissions.")); }
    finally { setPolicyBusy(false); }
  }

  async function submitPermissionRequest() { if (!requestedPermission || !requestReason.trim()) return; setRequestBusy(true); setPolicyError(null); try { await requestWorkspacePermission(workspaceId, requestedPermission, requestReason.trim()); setRequestedPermission(null); setRequestReason(""); } catch (error) { setPolicyError(describeError(error, "Could not send your request.")); } finally { setRequestBusy(false); } }
  async function decidePermissionRequest(request: PermissionRequest, decision: "approve" | "reject") { try { await resolvePermissionRequest(workspaceId, request.id, decision); setRequests((items) => items.filter((item) => item.id !== request.id)); } catch (error) { setPolicyError(describeError(error, "Could not update the request.")); } }

  const githubConnections = integrations.filter((i): i is Extract<IntegrationConfig, { type: "github" }> => i.type === "github");
  const githubConnected = githubConnections.find((integration) => integration.ownerUserId === user.id);
  const teammateGithubConnections = githubConnections.filter((integration) => integration.ownerUserId !== user.id);
  const slackConnections = integrations.filter((i): i is Extract<IntegrationConfig, { type: "slack" }> => i.type === "slack");
  const slackConnected = slackConnections.find((integration) => integration.ownerUserId === user.id);
  const connectionLabel = (integration: IntegrationConfig) => integration.type === "github" ? (integration.owner && integration.repo ? `${integration.owner}/${integration.repo}` : "Repository not selected") : integration.type === "slack" ? integration.teamName : integration.accountName ?? integration.endpoint;
  const healthAge = (value: string) => { const hours = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 3_600_000)); return hours < 1 ? "Connected less than an hour ago" : hours < 48 ? `Connected ${hours}h ago` : `Connected ${Math.floor(hours / 24)}d ago`; };
  const capabilities = (type: IntegrationConfig["type"]) => ({ github: ["Read issues and pull requests", "Review checks", "Propose changes for approval"], slack: ["Search team conversations", "Draft replies", "Post after approval"], linear: ["Read projects and issues", "Propose task updates"], notion: ["Search pages and databases", "Draft workspace pages"], figma: ["Read design context", "Summarize review feedback"] })[type];
  const setupSteps = (integration: IntegrationConfig) => integration.type === "github" ? ["Account connected", integration.repo ? "Repository selected" : "Choose a repository", "Verify read access"] : integration.type === "slack" ? ["Workspace connected", "Choose relevant channels", "Verify read access"] : ["Connection added", "Choose source scope", "Verify read access"];
  const usingAgents = (type: IntegrationConfig["type"]) => agents.filter((agent) => agent.status === "published" && (agent.baseAgent === type || agent.approvedProviders.includes(type))).map((agent) => agent.name);
  async function diagnose(integration: IntegrationConfig) { const key = integration.id ?? integration.type; setDiagnostics((current) => ({ ...current, [key]: "Checking connection…" })); let message: string; try { const health = await testIntegration(workspaceId, key); message = `${health.status === "ok" ? "Connection verified" : health.status === "needs_setup" ? "Needs setup" : "Connection failed"}: ${health.message}`; } catch (error) { message = `Connection failed: ${describeError(error, "could not reach the chat server.")}`; } setDiagnostics((current) => ({ ...current, [key]: message })); }
  async function connectRemote(provider: "linear" | "notion" | "figma") { const setup = remoteSetup[provider]; setRemoteSetup((current) => ({ ...current, [provider]: { ...current[provider], busy: true, error: "" } })); try { await connectRemoteMcp(workspaceId, provider, { endpoint: setup.endpoint, token: setup.token }); setRemoteSetup((current) => ({ ...current, [provider]: { endpoint: "", token: "", busy: false, error: "" } })); await refresh(); } catch (reason) { setRemoteSetup((current) => ({ ...current, [provider]: { ...current[provider], busy: false, error: describeError(reason, "Could not connect this provider.") } })); } }

  async function handleGithubSubmit(e: React.FormEvent) {
    e.preventDefault();
    setGithubBusy(true);
    setGithubError(null);
    setGithubSuccess(false);
    try {
      await connectGithub(workspaceId, { owner: owner.trim(), repo: repo.trim(), token: githubToken.trim(), connectionName: connectionName.trim(), connectionScope });
      setGithubSuccess(true);
      setGithubToken("");
      await refresh();
    } catch (err) {
      setGithubError(describeError(err, "Could not connect GitHub."));
    } finally {
      setGithubBusy(false);
    }
  }

  return (
    <div className="settings-page">
      <Link className="back-link" href={`/w/${workspaceId}`}>
        ← Back to chat
      </Link>
      <section className="integration-hero">
        <p>Workspace tools</p>
        <h1 className="title">Integrations</h1>
        <span>Connect the systems your team uses. Agents can read context immediately; write actions always require an approval in chat.</span>
        <div className="integration-summary" aria-label="Integration status">
          <strong>{integrations.length} connected</strong>
          <span>•</span>
          <span>{loading ? "Checking connections…" : integrations.length ? "Ready for agent requests" : "Connect your first tool"}</span>
        </div>
      </section>

      <nav className="integration-tabs" aria-label="Integration sections"><button className={activeTab === "connected" ? "active" : ""} onClick={() => setActiveTab("connected")}>Connected <span>{integrations.length}</span></button><button className={activeTab === "browse" ? "active" : ""} onClick={() => setActiveTab("browse")}>Browse integrations</button><button className={activeTab === "access" ? "active" : ""} onClick={() => setActiveTab("access")}>Access & permissions</button></nav>

      {activeTab === "browse" && <section className="integration-catalog"><header><div><p>Browse integrations</p><h2>Bring company context into every workflow</h2></div><span>Choose a provider to begin setup</span></header><div>{[{ name: "GitHub", detail: "Issues, pull requests, checks, and repositories", action: () => { setActiveTab("connected"); document.getElementById("github-integration")?.scrollIntoView({ behavior: "smooth" }); } }, { name: "Slack", detail: "Conversation context and governed replies", action: () => { setActiveTab("connected"); document.getElementById("slack-integration")?.scrollIntoView({ behavior: "smooth" }); } }, { name: "Linear", detail: "Project tracking through a workspace MCP connection", action: () => setActiveTab("connected") }, { name: "Notion", detail: "Pages and databases as grounded knowledge", action: () => setActiveTab("connected") }, { name: "Figma", detail: "Design files and review context", action: () => setActiveTab("connected") }].map((provider) => <article key={provider.name}><span>{provider.name.slice(0, 1)}</span><div><strong>{provider.name}</strong><small>{provider.detail}</small></div><button onClick={provider.action}>{integrations.some((item) => item.type === provider.name.toLowerCase()) ? "Connected" : "Set up"}</button></article>)}</div></section>}

      {activeTab === "connected" && <section className="integration-health-panel" aria-label="Integration health">
        <header><div><p>Connection health</p><h2>Sources available to agents</h2></div><span className={integrations.length ? "healthy" : "empty"}>{integrations.length ? "All connected sources ready" : "No sources connected"}</span></header>
        {loading ? <p className="hint">Checking source availability…</p> : integrations.length ? <div>{integrations.map((integration) => { const key = integration.id ?? integration.type; const agentNames = usingAgents(integration.type); return <article className="integration-health-card" key={key}><span className="integration-health-dot"/><span><strong>{integration.type[0].toUpperCase() + integration.type.slice(1)}</strong><small>{connectionLabel(integration)}</small></span><span><strong>Connected</strong><small>{healthAge(integration.connectedAt)} · {integration.connectionScope} access</small><button type="button" onClick={() => void diagnose(integration)}>Test connection</button></span><div className="integration-card-detail"><section><b>What it enables</b><ul>{capabilities(integration.type).map((item) => <li key={item}>{item}</li>)}</ul></section><section><b>Setup</b><ol>{setupSteps(integration).map((step, index) => <li className={index === 0 || !step.includes("Choose") ? "complete" : ""} key={step}>{step}</li>)}</ol></section><section><b>Used by</b><p>{agentNames.length ? agentNames.join(", ") : "No published agents use this connection yet."}</p></section></div>{diagnostics[key] && <p className="integration-diagnostic">{diagnostics[key]}</p>}</article>; })}</div> : <p className="hint">Connect GitHub, Slack, Linear, Notion, or Figma to make current company context available to agents.</p>}
      </section>}

      {activeTab === "access" && policy && <section className="integration-panel permission-panel">
        <h2>Tool and agent permissions</h2>
        {workspaceRole === "admin" ? <>
          <p className="hint">Admins have access to every capability. Choose the permissions available to Editors.</p>
          <div className="permission-grid" role="table" aria-label="Editor permissions"><div className="permission-row permission-heading" role="row"><span>Capability</span><span>Editors</span></div>{PERMISSIONS.map(([permission, label]) => <div className="permission-row" role="row" key={permission}><span>{label}</span><label className="toggle-switch"><input type="checkbox" checked={policy.editor[permission]} onChange={(event) => setPermission("editor", permission, event.target.checked)} /><span className="toggle-track" aria-hidden="true" /></label></div>)}</div>
          <div className="integration-actions"><button type="button" className="btn" onClick={() => void savePolicy()} disabled={policyBusy}>{policyBusy ? "Saving…" : "Save permissions"}</button></div>

        </> : <>
          <p className="hint">Your available permissions are listed below. Request any capability you need from an Admin.</p>
          <div className="editor-permission-list">{PERMISSIONS.map(([permission, label]) => policy.editor[permission] ? <div key={permission}><span>{label}</span><strong>Allowed</strong></div> : <div key={permission}><span>{label}</span><button className="btn secondary" onClick={() => { setRequestedPermission(permission); setRequestReason(""); }}>Request access</button></div>)}</div>
          {requestedPermission && <section className="permission-request-compose"><h3>Request {PERMISSIONS.find(([key]) => key === requestedPermission)?.[1]}</h3><label>Why do you need this access?<textarea value={requestReason} onChange={(event) => setRequestReason(event.target.value)} maxLength={1000} placeholder="Describe the work you need to do." /></label><aside><button className="btn" disabled={requestBusy || !requestReason.trim()} onClick={() => void submitPermissionRequest()}>{requestBusy ? "Sending…" : "Send request"}</button><button className="btn secondary" onClick={() => setRequestedPermission(null)}>Cancel</button></aside></section>}
        </>}        {policyError && <p className="error-text">{policyError}</p>}
      </section>}

      {activeTab === "connected" && <AccessNotice workspaceId={workspaceId} access={access} permission="connectTools" message="Connecting, updating, or disconnecting GitHub, Slack, Linear, Notion, or Figma requires the “Connect and manage tools” permission. You can still view providers and connection status." />}
      {activeTab === "connected" && <section className="integration-tool-box"><div id="github-integration" className="integration-panel integration-panel-featured">
        <h2>
          <span className="channel-icon" aria-hidden style={{ marginRight: 10 }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
          </span>
          <span className="integration-provider-name">GitHub<span className={`connection-status ${githubConnected ? "connected" : "disconnected"}`} data-testid="github-status"><i aria-hidden />{githubConnected ? "Connected" : "Not connected"}</span></span>
        </h2>
        {githubConnected && !githubConnected.repo && (
          <p className="hint" data-testid="github-no-repo-hint">
            GitHub is connected, but no repository has been chosen yet.
          </p>
        )}

        <div className="integration-actions"><button
          className="btn"
          type="button"
          data-testid="github-oauth-btn"
          disabled={!canConnect}
          onClick={() => {
            window.location.href = githubOAuthStartUrl(workspaceId);
          }}
        >
          Connect GitHub
        </button>

        {githubConnected && (
          <button
            className="btn secondary"
            type="button"
            style={{ marginTop: 10 }}
            data-testid="github-choose-repo-btn"
            disabled={!canConnect}
            onClick={() => setShowRepoPicker(true)}
          >
            {githubConnected.repo ? "Change repository" : "Choose a repository"}
          </button>
        )}</div>

        <p className="hint" style={{ marginTop: 16 }}>
          Link a repository for workspace context.
        </p>
        {teammateGithubConnections.length > 0 && <p className="hint">Also connected by teammates: {teammateGithubConnections.map((integration) => `${integration.connectedByName ?? "Workspace member"} (${integration.owner && integration.repo ? `${integration.owner}/${integration.repo}` : "repository not selected"})`).join(", ")}.</p>}
      </div>

      <div id="slack-integration" className="integration-panel">
        <h2>
          <span className="channel-icon" aria-hidden style={{ marginRight: 10, color: "#611f69" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 15a2 2 0 1 1-2-2h2v2Zm1 0a2 2 0 1 1 4 0v5a2 2 0 1 1-4 0v-5Z" fill="#e01e5a" />
              <path d="M9 6a2 2 0 1 1 2-2v2H9Zm0 1a2 2 0 1 1 0 4H4a2 2 0 1 1 0-4h5Z" fill="#36c5f0" />
              <path d="M18 9a2 2 0 1 1 2 2h-2V9Zm-1 0a2 2 0 1 1-4 0V4a2 2 0 1 1 4 0v5Z" fill="#2eb67d" />
              <path d="M15 18a2 2 0 1 1-2 2v-2h2Zm0-1a2 2 0 1 1 0-4h5a2 2 0 1 1 0 4h-5Z" fill="#ecb22e" />
            </svg>
          </span>
          <span className="integration-provider-name">Slack<span className={`connection-status ${slackConnected ? "connected" : "disconnected"}`} data-testid="slack-status"><i aria-hidden />{slackConnected ? "Connected" : "Not connected"}</span></span>
        </h2>
        <p className="hint">
          Use approved Slack context in chat.
        </p>
        <div className="integration-actions"><button
          className="btn"
          type="button"
          data-testid="slack-oauth-btn"
          disabled={!canConnect}
          onClick={() => {
            window.location.href = slackOAuthStartUrl(workspaceId);
          }}
        >
          Connect Slack
        </button></div>
      </div>

      <>{(["linear", "notion", "figma"] as const).map((provider) => { const setup = remoteSetup[provider]; const connected = integrations.find((item) => item.type === provider); const open = remoteSetupOpen === provider; return <article className="integration-panel remote-integration-card" key={provider}><div className="remote-provider-heading"><span className={`channel-icon provider-icon provider-icon-${provider}`} aria-hidden>{provider === "linear" ? <svg viewBox="0 0 24 24"><path d="m5 7 4-4 10 10-4 4zM3 13l4-4 10 10-4 4zM11 21l4-4 4 4z"/></svg> : provider === "notion" ? <svg viewBox="0 0 24 24"><path d="M5 4 18 3l1 17-13 1z" fill="none" stroke="currentColor" strokeWidth="1.7"/><path d="M8 17V8l7 8V7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"/></svg> : <svg viewBox="0 0 24 24"><circle cx="9" cy="5" r="4" fill="#f24e1e"/><circle cx="9" cy="12" r="4" fill="#a259ff"/><circle cx="9" cy="19" r="4" fill="#0acf83"/><circle cx="15" cy="5" r="4" fill="#ff7262"/><circle cx="15" cy="12" r="4" fill="#1abcfe"/></svg>}</span><div><strong>{provider[0].toUpperCase() + provider.slice(1)}</strong><small className={`connection-status ${connected ? "connected" : "disconnected"}`}><i aria-hidden />{connected ? "Connected" : "Not connected"}</small></div></div><p>{provider === "linear" ? "Use projects and issues in chat." : provider === "notion" ? "Use team pages and databases in chat." : "Use design files in chat."}</p><div className="integration-actions"><button className="btn" type="button" disabled={!canConnect} onClick={() => setRemoteSetupOpen(open ? null : provider)}>{connected ? "Manage connection" : `Connect ${provider[0].toUpperCase() + provider.slice(1)}`}</button></div>{open && canConnect && <form className="remote-advanced-form" onSubmit={(event) => { event.preventDefault(); void connectRemote(provider); }}><label>HTTPS MCP endpoint<input type="url" value={setup.endpoint} onChange={(event) => setRemoteSetup((current) => ({ ...current, [provider]: { ...current[provider], endpoint: event.target.value } }))} placeholder="https://mcp.example.com" required/></label><label>Access token<input type="password" value={setup.token} onChange={(event) => setRemoteSetup((current) => ({ ...current, [provider]: { ...current[provider], token: event.target.value } }))} placeholder="Provider token" required/></label><button className="btn" disabled={setup.busy}>{setup.busy ? "Connecting…" : connected ? "Update connection" : "Save connection"}</button>{setup.error && <p className="error-text">{setup.error}</p>}</form>}</article>; })}</>

      {!loading && integrations.length === 0 && <p style={{ color: "var(--text-dim)", fontSize: 13 }}>No integrations connected yet.</p>}</section>}

      {showRepoPicker && (
        <GithubRepoPickerModal
          workspaceId={workspaceId}
          onClose={() => setShowRepoPicker(false)}
          onSelected={(_selectedRepo: GithubRepoSummary) => {
            setShowRepoPicker(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}
