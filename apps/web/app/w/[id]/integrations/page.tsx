"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import type { GithubRepoSummary, IntegrationConfig } from "@mai-chat/shared-types";
import { connectGithub, githubOAuthStartUrl, slackOAuthStartUrl, listIntegrations, ApiError } from "../../../../lib/api";
import GithubRepoPickerModal from "../../../_components/GithubRepoPickerModal";

export default function IntegrationsPage() {
  const params = useParams<{ id: string }>();
  const workspaceId = params.id;

  const [integrations, setIntegrations] = useState<IntegrationConfig[]>([]);
  const [loading, setLoading] = useState(true);

  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [githubToken, setGithubToken] = useState("");
  const [githubBusy, setGithubBusy] = useState(false);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [githubSuccess, setGithubSuccess] = useState(false);

  const [showRepoPicker, setShowRepoPicker] = useState(false);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  const githubConnected = integrations.find((i): i is Extract<IntegrationConfig, { type: "github" }> => i.type === "github");
  const slackConnected = integrations.find((i): i is Extract<IntegrationConfig, { type: "slack" }> => i.type === "slack");

  async function handleGithubSubmit(e: React.FormEvent) {
    e.preventDefault();
    setGithubBusy(true);
    setGithubError(null);
    setGithubSuccess(false);
    try {
      await connectGithub(workspaceId, { owner: owner.trim(), repo: repo.trim(), token: githubToken.trim() });
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
      <h1 className="title">Integrations</h1>
      <p style={{ color: "var(--text-dim)", fontSize: 13, marginTop: -10, marginBottom: 24, lineHeight: 1.5 }}>
        GitHub reads issues, PRs, commits, and files, and Slack reads channels and message history. Both can also write -- GitHub can
        comment, open a PR, or push a change; Slack can post a message to a channel -- once a human confirms the action from a card in
        the chat.
      </p>

      <div className="integration-panel">
        <h2>
          <span className="channel-icon" aria-hidden style={{ marginRight: 10 }}>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
          </span>
          GitHub
          {githubConnected && (
            <span className="status-pill" data-testid="github-status">
              ● {githubConnected.repo ? `connected to ${githubConnected.owner}/${githubConnected.repo}` : "connected, no repo chosen"}
            </span>
          )}
        </h2>
        {githubConnected && !githubConnected.repo && (
          <p className="hint" data-testid="github-no-repo-hint">
            GitHub is connected, but no repository has been chosen yet.
          </p>
        )}

        <button
          className="btn"
          type="button"
          data-testid="github-oauth-btn"
          onClick={() => {
            window.location.href = githubOAuthStartUrl(workspaceId);
          }}
        >
          {githubConnected ? "Log in with GitHub again" : "Log in with GitHub"}
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
        )}

        <p className="hint" style={{ marginTop: 16 }}>
          Or paste a personal access token with read access to the repo directly. It&apos;s encrypted at rest and never shown again.
        </p>
        <form onSubmit={handleGithubSubmit}>
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
          {githubSuccess && <p className="success-text">GitHub connected.</p>}
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
        <button
          className="btn"
          type="button"
          data-testid="slack-oauth-btn"
          onClick={() => {
            window.location.href = slackOAuthStartUrl(workspaceId);
          }}
        >
          {slackConnected ? "Log in with Slack again" : "Log in with Slack"}
        </button>
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
