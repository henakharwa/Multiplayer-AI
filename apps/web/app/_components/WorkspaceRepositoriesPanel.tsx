"use client";

import { useCallback, useEffect, useState } from "react";
import type { WorkspaceGithubSetup, WorkspaceRepository } from "@mai-chat/shared-types";
import {
  addWorkspaceRepository,
  connectRepositoryEvents,
  describeError,
  getGithubSetup,
  listWorkspaceRepositories,
  removeWorkspaceRepository,
  rotateGithubWebhookSecret,
  setDefaultWorkspaceRepository,
} from "../../lib/api";
import { useDialog } from "./DialogProvider";

const ACCESS_LABELS: Record<NonNullable<WorkspaceRepository["myAccess"]>, string> = {
  write: "Your account can make changes",
  read: "Your account can read only",
  none: "Your account can't access this",
  not_connected: "Connect GitHub to use it",
  unknown: "Access not confirmed",
};

function ago(iso: string | null): string | null {
  if (!iso) return null;
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

/**
 * The repositories the whole workspace works on. Every member's agent uses
 * them through that member's own GitHub account; Admins manage the list and
 * connect GitHub events (webhooks) so activity and event workflows are live.
 */
export default function WorkspaceRepositoriesPanel({
  workspaceId,
  isAdmin,
  onRepositoriesChange,
}: {
  workspaceId: string;
  isAdmin: boolean;
  onRepositoriesChange?: (repositories: WorkspaceRepository[]) => void;
}) {
  const dialog = useDialog();
  const [repositories, setRepositories] = useState<WorkspaceRepository[]>([]);
  const [setup, setSetup] = useState<WorkspaceGithubSetup | null>(null);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [list, githubSetup] = await Promise.all([
        listWorkspaceRepositories(workspaceId),
        getGithubSetup(workspaceId),
      ]);
      setRepositories(list);
      setSetup(githubSetup);
      onRepositoriesChange?.(list);
    } catch (err) {
      setError(describeError(err, "Could not load the workspace repositories."));
    } finally {
      setLoading(false);
    }
  }, [workspaceId, onRepositoriesChange]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(key: string, task: () => Promise<unknown>, success?: string) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await task();
      if (success) setNotice(success);
      await refresh();
    } catch (err) {
      setError(describeError(err, "That didn't work. Try again."));
    } finally {
      setBusy(null);
    }
  }

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(`${label} copied.`);
    } catch {
      setNotice(`Select the ${label.toLowerCase()} and copy it manually.`);
    }
  }

  return (
    <section
      className="integration-panel team-github-panel"
      aria-labelledby="workspace-repositories-heading"
      data-testid="workspace-repositories"
    >
      <header className="team-github-header">
        <div>
          <h2 id="workspace-repositories-heading">Workspace repositories</h2>
          <p className="hint">
            Everyone&apos;s GitHub agent works on these repositories through their own GitHub account, so each person
            only sees what their account can open. Replies and approval cards show whose account was used.
          </p>
        </div>
      </header>

      {loading && <p className="hint">Loading…</p>}
      {!loading && repositories.length === 0 && (
        <p className="hint" data-testid="no-workspace-repositories">
          No repositories yet.{" "}
          {isAdmin
            ? "Add the repositories your team works on."
            : "An Admin can add the repositories your team works on."}
        </p>
      )}

      {repositories.length > 0 && (
        <ul className="team-github-repos">
          {repositories.map((repository) => {
            const lastEvent = ago(repository.lastEventAt);
            return (
              <li key={repository.id} className="team-github-repo" data-testid="workspace-repository">
                <div className="team-github-repo-main">
                  <a
                    href={`https://github.com/${repository.fullName}`}
                    target="_blank"
                    rel="noreferrer"
                    className="team-github-repo-name"
                  >
                    {repository.fullName}
                  </a>
                  {repository.isDefault && <span className="team-github-badge">Default</span>}
                  <span className={`team-github-access ${repository.myAccess ?? "unknown"}`}>
                    {ACCESS_LABELS[repository.myAccess ?? "unknown"]}
                  </span>
                  {repository.appInstalled !== null && repository.appInstalled !== undefined && (
                    <span className={`team-github-access ${repository.appInstalled ? "write" : "none"}`}>
                      {repository.appInstalled ? "GitHub App installed" : "GitHub App not installed"}
                    </span>
                  )}
                  <span className="team-github-events">
                    {lastEvent
                      ? `Last GitHub event ${lastEvent}`
                      : repository.webhookId
                        ? "Events connected"
                        : "No GitHub events yet"}
                  </span>
                </div>
                {isAdmin && (
                  <div className="team-github-repo-actions">
                    {!repository.isDefault && (
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy !== null}
                        onClick={() =>
                          run(`default-${repository.id}`, () =>
                            setDefaultWorkspaceRepository(workspaceId, repository.id),
                          )
                        }
                      >
                        Make default
                      </button>
                    )}
                    {!repository.webhookId && (
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy !== null}
                        onClick={() =>
                          run(
                            `hook-${repository.id}`,
                            () => connectRepositoryEvents(workspaceId, repository.id),
                            `GitHub events connected for ${repository.fullName}.`,
                          )
                        }
                      >
                        {busy === `hook-${repository.id}` ? "Connecting…" : "Connect events"}
                      </button>
                    )}
                    <button
                      type="button"
                      className="text-button danger"
                      disabled={busy !== null}
                      onClick={async () => {
                        if (
                          !(await dialog.confirm({
                            title: `Remove ${repository.fullName}?`,
                            message:
                              "Agents stop using this repository and its GitHub events are ignored. Nothing changes on GitHub.",
                            confirmLabel: "Remove repository",
                            danger: true,
                          }))
                        )
                          return;
                        await run(`remove-${repository.id}`, () =>
                          removeWorkspaceRepository(workspaceId, repository.id),
                        );
                      }}
                    >
                      Remove
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {isAdmin && (
        <form
          className="team-github-add"
          onSubmit={(event) => {
            event.preventDefault();
            const value = draft.trim();
            if (!value) return;
            void run(
              "add",
              async () => {
                await addWorkspaceRepository(workspaceId, value);
                setDraft("");
              },
              `${value.replace(/^https?:\/\/github\.com\//, "")} added.`,
            );
          }}
        >
          <label htmlFor="workspace-repository-input" className="sr-only">
            Repository
          </label>
          <input
            id="workspace-repository-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="owner/repository or GitHub link"
            autoComplete="off"
          />
          <button className="btn" type="submit" disabled={busy !== null || !draft.trim()}>
            {busy === "add" ? "Adding…" : "Add repository"}
          </button>
        </form>
      )}

      {error && <p className="error-text">{error}</p>}
      {notice && <p className="team-github-notice">{notice}</p>}

      {setup && (
        <details className="team-github-events-setup">
          <summary>
            GitHub events
            {setup.lastDeliveryAt ? ` · last received ${ago(setup.lastDeliveryAt)}` : " · not receiving yet"}
          </summary>
          <p className="hint">
            When GitHub sends events (new issues, pull requests, CI results), they appear live in chat and in Activity,
            and start workflows with a GitHub trigger. Use <strong>Connect events</strong> above (needs admin rights on
            the repository), or add a webhook in the repository&apos;s Settings → Webhooks with these values and content
            type <code>application/json</code>.
          </p>
          <dl className="team-github-setup-values">
            <div>
              <dt>Payload URL</dt>
              <dd>
                <code>{setup.webhookUrl}</code>
                <button type="button" className="text-button" onClick={() => copy(setup.webhookUrl, "Payload URL")}>
                  Copy
                </button>
              </dd>
            </div>
            {setup.webhookSecret && (
              <div>
                <dt>Secret</dt>
                <dd>
                  <code>{showSecret ? setup.webhookSecret : "•".repeat(24)}</code>
                  <button type="button" className="text-button" onClick={() => setShowSecret((value) => !value)}>
                    {showSecret ? "Hide" : "Show"}
                  </button>
                  <button type="button" className="text-button" onClick={() => copy(setup.webhookSecret!, "Secret")}>
                    Copy
                  </button>
                  <button
                    type="button"
                    className="text-button danger"
                    disabled={busy !== null}
                    onClick={async () => {
                      if (
                        !(await dialog.confirm({
                          title: "Replace the webhook secret?",
                          message:
                            "Existing repository webhooks stop working until you update their secret on GitHub to the new one.",
                          confirmLabel: "Replace secret",
                          danger: true,
                        }))
                      )
                        return;
                      await run("rotate", () => rotateGithubWebhookSecret(workspaceId), "Webhook secret replaced.");
                      setShowSecret(true);
                    }}
                  >
                    Replace
                  </button>
                </dd>
              </div>
            )}
            <div>
              <dt>Events</dt>
              <dd>{setup.events.join(", ")}</dd>
            </div>
          </dl>
          {setup.app.configured ? (
            <p className="hint">
              The workspace GitHub App is set up on this server. Install it on your repositories so events arrive
              without per-repository webhooks and workflows keep running if their owner leaves.{" "}
              {setup.app.installUrl && (
                <a href={setup.app.installUrl} target="_blank" rel="noreferrer">
                  Install the GitHub App
                </a>
              )}
            </p>
          ) : (
            <p className="hint">
              Optional: a server administrator can configure a GitHub App (GITHUB_APP_* settings) so workflows keep
              running when their owner leaves the workspace.
            </p>
          )}
        </details>
      )}
    </section>
  );
}
