"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import type { GithubRepoSummary, IntegrationConfig, WorkspacePermissionPolicy, WorkspacePermissions, WorkspaceRole } from "@mai-chat/shared-types";
import { connectGithub, githubOAuthStartUrl, slackOAuthStartUrl, listIntegrations, getWorkspacePermissionPolicy, updateWorkspacePermissionPolicy, listWorkspaceMembers, requestWorkspacePermission, listPermissionRequests, resolvePermissionRequest, type PermissionRequest, ApiError } from "../../../../lib/api";
import { useWorkspaceUser } from "../../../_components/WorkspaceAuth";
import GithubRepoPickerModal from "../../../_components/GithubRepoPickerModal";

const PERMISSIONS: Array<[keyof WorkspacePermissions, string]> = [["connectTools", "Connect and manage tools"], ["createAgents", "Create agents"], ["publishAgents", "Publish agents"], ["approveActions", "Approve actions"], ["github", "Use GitHub"], ["slack", "Use Slack"], ["linear", "Use Linear"], ["notion", "Use Notion"], ["figma", "Use Figma"]];

export default function IntegrationsPage() {
  const params = useParams<{ id: string }>();
  const workspaceId = params.id;
  const user = useWorkspaceUser();
  const [workspaceRole, setWorkspaceRole] = useState<WorkspaceRole>("editor");
  const [requests, setRequests] = useState<PermissionRequest[]>([]);
  const [requestedPermission, setRequestedPermission] = useState<keyof WorkspacePermissions | null>(null);
  const [requestReason, setRequestReason] = useState("");
  const [requestBusy, setRequestBusy] = useState(false);

  const [integrations, setIntegrations] = useState<IntegrationConfig[]>([]);
  const [loading, setLoading] = useState(true);

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
    listWorkspaceMembers(workspaceId).then((members) => setWorkspaceRole(members.find((member) => member.id === user.id)?.role ?? "editor")).catch(() => {});
    listPermissionRequests(workspaceId).then(setRequests).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, user.id]);

  function setPermission(role: "admin" | "editor", permission: keyof WorkspacePermissions, value: boolean) {
    setPolicy((current) => current ? { ...current, [role]: { ...current[role], [permission]: value } } : current);
  }

  async function savePolicy() {
    if (!policy) return;
    setPolicyBusy(true); setPolicyError(null);
    try { setPolicy(await updateWorkspacePermissionPolicy(workspaceId, policy)); }
    catch (error) { setPolicyError(error instanceof ApiError ? error.message : "Could not save workspace permissions."); }
    finally { setPolicyBusy(false); }
  }

  async function submitPermissionRequest() { if (!requestedPermission || !requestReason.trim()) return; setRequestBusy(true); setPolicyError(null); try { await requestWorkspacePermission(workspaceId, requestedPermission, requestReason.trim()); setRequestedPermission(null); setRequestReason(""); } catch (error) { setPolicyError(error instanceof ApiError ? error.message : "Could not send your request."); } finally { setRequestBusy(false); } }
  async function decidePermissionRequest(request: PermissionRequest, decision: "approve" | "reject") { try { await resolvePermissionRequest(workspaceId, request.id, decision); setRequests((items) => items.filter((item) => item.id !== request.id)); } catch (error) { setPolicyError(error instanceof ApiError ? error.message : "Could not update the request."); } }

  const githubConnections = integrations.filter((i): i is Extract<IntegrationConfig, { type: "github" }> => i.type === "github");
  const githubConnected = githubConnections.find((integration) => integration.ownerUserId === user.id);
  const teammateGithubConnections = githubConnections.filter((integration) => integration.ownerUserId !== user.id);
  const slackConnections = integrations.filter((i): i is Extract<IntegrationConfig, { type: "slack" }> => i.type === "slack");
  const slackConnected = slackConnections.find((integration) => integration.ownerUserId === user.id);

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
      setGithubError(err instanceof ApiError ? err.message : "Could not reach the chat server.");
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

      {policy && <section className="integration-panel permission-panel">
        <h2>Tool and agent permissions</h2>
        {workspaceRole === "admin" ? <>
          <p className="hint">Admins have access to every capability. Choose the permissions available to Editors.</p>
          <div className="permission-grid" role="table" aria-label="Editor permissions"><div className="permission-row permission-heading" role="row"><span>Capability</span><span>Editors</span></div>{PERMISSIONS.map(([permission, label]) => <div className="permission-row" role="row" key={permission}><span>{label}</span><label className="toggle-switch"><input type="checkbox" checked={policy.editor[permission]} onChange={(event) => setPermission("editor", permission, event.target.checked)} /><span className="toggle-track" aria-hidden="true" /></label></div>)}</div>
          <div className="integration-actions"><button type="button" className="btn" onClick={() => void savePolicy()} disabled={policyBusy}>{policyBusy ? "Saving…" : "Save permissions"}</button></div>
          <section className="permission-request-list"><h3>Permission requests</h3>{requests.length ? requests.map((request) => <article key={request.id}><strong>{request.display_name}</strong><span> requested <b>{PERMISSIONS.find(([key]) => key === request.permission)?.[1] ?? request.permission}</b></span><p>{request.reason}</p><small>{new Date(request.created_at).toLocaleString()}</small><aside><button className="btn" onClick={() => void decidePermissionRequest(request, "approve")}>Approve</button><button className="btn secondary" onClick={() => void decidePermissionRequest(request, "reject")}>Reject</button></aside></article>) : <p>No pending permission requests.</p>}</section>
        </> : <>
          <p className="hint">Your available permissions are listed below. Request any capability you need from an Admin.</p>
          <div className="editor-permission-list">{PERMISSIONS.map(([permission, label]) => policy.editor[permission] ? <div key={permission}><span>{label}</span><strong>Allowed</strong></div> : <div key={permission}><span>{label}</span><button className="btn secondary" onClick={() => { setRequestedPermission(permission); setRequestReason(""); }}>Request access</button></div>)}</div>
          {requestedPermission && <section className="permission-request-compose"><h3>Request {PERMISSIONS.find(([key]) => key === requestedPermission)?.[1]}</h3><label>Why do you need this access?<textarea value={requestReason} onChange={(event) => setRequestReason(event.target.value)} maxLength={1000} placeholder="Describe the work you need to do." /></label><aside><button className="btn" disabled={requestBusy || !requestReason.trim()} onClick={() => void submitPermissionRequest()}>{requestBusy ? "Sending…" : "Send request"}</button><button className="btn secondary" onClick={() => setRequestedPermission(null)}>Cancel</button></aside></section>}
        </>}        {policyError && <p className="error-text">{policyError}</p>}
      </section>}

      <div className="integration-panel integration-panel-featured">
        <h2>
          <span className="channel-icon" aria-hidden style={{ marginRight: 10 }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
          </span>
          GitHub
          {githubConnected && (
            <span className="status-pill" data-testid="github-status">
              ● You: {githubConnected.repo ? `connected to ${githubConnected.owner}/${githubConnected.repo}` : "connected, no repo chosen"}
            </span>
          )}
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
          onClick={() => {
            window.location.href = githubOAuthStartUrl(workspaceId);
          }}
        >
          {githubConnected ? "Reconnect your GitHub" : "Connect your GitHub"}
        </button>

        {githubConnected && (
          <button
            className="btn secondary"
            type="button"
            style={{ marginTop: 10 }}
            data-testid="github-choose-repo-btn"
            onClick={() => setShowRepoPicker(true)}
          >
            {githubConnected.repo ? "Change repository" : "Choose a repository"}
          </button>
        )}</div>

        <p className="hint" style={{ marginTop: 16 }}>
          Connect your own GitHub account and choose the repository you will work with. Your token is encrypted at rest and never shown again.
        </p>
        {teammateGithubConnections.length > 0 && <p className="hint">Also connected by teammates: {teammateGithubConnections.map((integration) => `${integration.connectedByName ?? "Workspace member"} (${integration.owner && integration.repo ? `${integration.owner}/${integration.repo}` : "repository not selected"})`).join(", ")}.</p>}
        <form onSubmit={handleGithubSubmit}>
          <div className="field"><label htmlFor="gh-connection-name">Connection name</label><input id="gh-connection-name" value={connectionName} onChange={(e) => setConnectionName(e.target.value)} placeholder="Engineering GitHub" autoComplete="off" /></div>
          <div className="field"><label htmlFor="gh-connection-scope">Account access</label><select id="gh-connection-scope" value={connectionScope} onChange={(e) => setConnectionScope(e.target.value as "shared" | "personal")}><option value="shared">Shared with this workspace</option><option value="personal">Personal to me</option></select></div>
          <div className="field">
            <label htmlFor="gh-owner">Owner</label>
            <input id="gh-owner" data-testid="github-owner-input" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="octocat" autoComplete="off" />
          </div>
          <div className="field">
            <label htmlFor="gh-repo">Repository</label>
            <input id="gh-repo" data-testid="github-repo-input" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="hello-world" autoComplete="off" />
          </div>
          <div className="field">
            <label htmlFor="gh-token">Personal access token</label>
            <input
              id="gh-token"
              data-testid="github-token-input"
              type="password"
              value={githubToken}
              onChange={(e) => setGithubToken(e.target.value)}
              placeholder="ghp_…"
              autoComplete="off"
            />
          </div>
          <button className="btn" type="submit" data-testid="github-connect-btn" disabled={githubBusy || !owner.trim() || !repo.trim() || !githubToken.trim()}>
            {githubBusy ? "Verifying…" : githubConnected ? "Reconnect" : "Connect GitHub"}
          </button>
          {githubError && (
            <p className="error-text" data-testid="github-error">
              {githubError}
            </p>
          )}
          {githubSuccess && <p className="success-text">Your GitHub repository is connected.</p>}
        </form>
      </div>

      <div className="integration-panel">
        <h2>
          <span className="channel-icon" aria-hidden style={{ marginRight: 10, color: "#611f69" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 15a2 2 0 1 1-2-2h2v2Zm1 0a2 2 0 1 1 4 0v5a2 2 0 1 1-4 0v-5Z" fill="#e01e5a" />
              <path d="M9 6a2 2 0 1 1 2-2v2H9Zm0 1a2 2 0 1 1 0 4H4a2 2 0 1 1 0-4h5Z" fill="#36c5f0" />
              <path d="M18 9a2 2 0 1 1 2 2h-2V9Zm-1 0a2 2 0 1 1-4 0V4a2 2 0 1 1 4 0v5Z" fill="#2eb67d" />
              <path d="M15 18a2 2 0 1 1-2 2v-2h2Zm0-1a2 2 0 1 1 0-4h5a2 2 0 1 1 0 4h-5Z" fill="#ecb22e" />
            </svg>
          </span>
          Slack
          {slackConnected && (
            <span className="status-pill" data-testid="slack-status">
              ● connected to {slackConnected.teamName}
            </span>
          )}
        </h2>
        <p className="hint">
          Slack&apos;s own official MCP server needs a real login, not a pasted token -- your Slack account&apos;s own read/write
          access is what the agent uses (see the chat for exactly what it&apos;s about to do before anything happens).
        </p>
        <div className="integration-actions"><button
          className="btn"
          type="button"
          data-testid="slack-oauth-btn"
          onClick={() => {
            window.location.href = slackOAuthStartUrl(workspaceId);
          }}
        >
          {slackConnected ? "Reconnect your Slack" : "Connect your Slack"}
        </button></div>
      </div>

      {!loading && integrations.length === 0 && <p style={{ color: "var(--text-dim)", fontSize: 13 }}>No integrations connected yet.</p>}

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
