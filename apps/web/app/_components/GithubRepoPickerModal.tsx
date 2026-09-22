"use client";

// Shown right after a successful GitHub OAuth login (and reachable again
// later from the Integrations settings page as "Change repository") --
// lists every repo the connected account can access and lets the user
// pick the one this workspace's agent should read from.
import { useEffect, useMemo, useState } from "react";
import type { GithubRepoSummary } from "@mai-chat/shared-types";
import { listGithubRepos, selectGithubRepo, ApiError } from "../../lib/api";

export default function GithubRepoPickerModal({
  workspaceId,
  onClose,
  onSelected,
}: {
  workspaceId: string;
  onClose: () => void;
  onSelected: (repo: GithubRepoSummary) => void;
}) {
  const [repos, setRepos] = useState<GithubRepoSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selecting, setSelecting] = useState<string | null>(null); // fullName currently being saved
  const [selectError, setSelectError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listGithubRepos(workspaceId)
      .then((list) => {
        if (!cancelled) setRepos(list);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof ApiError ? err.message : "Could not reach the chat server.");
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const filtered = useMemo(() => {
    if (!repos) return [];
    const q = query.trim().toLowerCase();
    if (!q) return repos;
    return repos.filter((r) => r.fullName.toLowerCase().includes(q));
  }, [repos, query]);

  async function handleSelect(repo: GithubRepoSummary) {
    setSelecting(repo.fullName);
    setSelectError(null);
    try {
      await selectGithubRepo(workspaceId, { owner: repo.owner, repo: repo.name });
      onSelected(repo);
    } catch (err) {
      setSelectError(err instanceof ApiError ? err.message : "Could not reach the chat server.");
    } finally {
      setSelecting(null);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="card repo-picker" onClick={(e) => e.stopPropagation()}>
        <p className="brand">GitHub connected</p>
        <h1 className="title" style={{ marginBottom: 12 }}>
          Choose a repository
        </h1>

        {repos && repos.length > 0 && (
          <input
            className="repo-search"
            data-testid="repo-search-input"
            placeholder="Search repositories…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
            autoComplete="off"
          />
        )}

        {loadError && (
          <p className="error-text" data-testid="repo-list-error">
            {loadError}
          </p>
        )}

        {!repos && !loadError && <p style={{ color: "var(--text-dim)", fontSize: 13 }}>Loading your repositories…</p>}

        {repos && repos.length === 0 && !loadError && (
          <p style={{ color: "var(--text-dim)", fontSize: 13 }}>
            No repositories found for this GitHub account. Make sure you granted access to at least one repo when you logged in.
          </p>
        )}

        <div className="repo-list" data-testid="repo-list">
          {filtered.map((repo) => (
            <button
              key={repo.fullName}
              className="repo-item"
              data-testid="repo-item"
              disabled={selecting !== null}
              onClick={() => handleSelect(repo)}
            >
              <span className="repo-item-main">
                <span className="repo-item-name">{repo.fullName}</span>
                {repo.private && <span className="repo-item-badge">private</span>}
              </span>
              {repo.description && <span className="repo-item-desc">{repo.description}</span>}
              <span className="repo-item-action">{selecting === repo.fullName ? "Connecting…" : "Select"}</span>
            </button>
          ))}
        </div>

        {selectError && (
          <p className="error-text" data-testid="repo-select-error">
            {selectError}
          </p>
        )}

        <button className="btn secondary" style={{ marginTop: 16 }} onClick={onClose} data-testid="repo-picker-cancel">
          I&apos;ll pick later
        </button>
      </div>
    </div>
  );
}
