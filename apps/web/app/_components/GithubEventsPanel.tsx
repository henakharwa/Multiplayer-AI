"use client";

import { useCallback, useEffect, useState } from "react";
import type { WorkspaceGithubSetup } from "@mai-chat/shared-types";
import { connectGithubEvents, describeError, getGithubSetup, rotateGithubWebhookSecret } from "../../lib/api";
import { useDialog } from "./DialogProvider";

function ago(iso: string | null): string | null {
  if (!iso) return null;
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

/**
 * GitHub events (webhooks) for the repositories this workspace's members
 * work in. Each member works in the one repository chosen for their own
 * GitHub connection; events from those repositories appear live in chat and
 * Activity and start workflows with a GitHub trigger. Admins connect them.
 */
export default function GithubEventsPanel({
  workspaceId,
  isAdmin,
  refreshKey,
}: {
  workspaceId: string;
  isAdmin: boolean;
  // Changes when the viewer's GitHub connection or repository changes.
  refreshKey?: string;
}) {
  const dialog = useDialog();
  const [setup, setSetup] = useState<WorkspaceGithubSetup | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showSecret, setShowSecret] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setSetup(await getGithubSetup(workspaceId));
    } catch (err) {
      setError(describeError(err, "Could not load the GitHub event settings."));
    }
  }, [workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

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

  if (!setup) {
    return error ? <p className="error-text">{error}</p> : null;
  }
  const lastReceived = ago(setup.lastDeliveryAt);

  return (
    <section
      className="integration-panel team-github-panel"
      aria-labelledby="github-events-heading"
      data-testid="github-events"
    >
      <header className="team-github-header">
        <div>
          <h2 id="github-events-heading">GitHub events</h2>
          <p className="hint">
            Everyone works in the one repository they chose for their own GitHub connection. New issues, pull requests
            and CI results from these repositories appear live in chat and Activity, and start workflows with a GitHub
            trigger.
          </p>
        </div>
      </header>

      {setup.repositories.length > 0 ? (
        <ul className="team-github-repos">
          {setup.repositories.map((fullName) => (
            <li key={fullName} className="team-github-repo" data-testid="member-repository">
              <div className="team-github-repo-main">
                <a
                  href={`https://github.com/${fullName}`}
                  target="_blank"
                  rel="noreferrer"
                  className="team-github-repo-name"
                >
                  {fullName}
                </a>
                {setup.myRepository?.toLowerCase() === fullName.toLowerCase() && (
                  <span className="team-github-badge">Yours</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint" data-testid="no-member-repositories">
          No one has chosen a repository yet.
        </p>
      )}

      <p className="team-github-events">
        {lastReceived ? `Last GitHub event ${lastReceived}` : "No GitHub events received yet"}
      </p>

      {isAdmin && (
        <div className="team-github-repo-actions">
          {setup.myRepository ? (
            <button
              type="button"
              className="btn secondary"
              disabled={busy !== null}
              onClick={() =>
                run(
                  "hook",
                  () => connectGithubEvents(workspaceId),
                  `GitHub events connected for ${setup.myRepository}.`,
                )
              }
            >
              {busy === "hook" ? "Connecting…" : `Connect events for ${setup.myRepository}`}
            </button>
          ) : (
            <p className="hint">Choose your repository under GitHub above to connect its events.</p>
          )}
        </div>
      )}

      {error && <p className="error-text">{error}</p>}
      {notice && <p className="team-github-notice">{notice}</p>}

      {isAdmin && (
        <details className="team-github-events-setup">
          <summary>Set up events manually</summary>
          <p className="hint">
            <strong>Connect events</strong> needs admin rights on the repository. Otherwise a repository admin can add a
            webhook in the repository&apos;s Settings → Webhooks with these values and content type{" "}
            <code>application/json</code>.
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
        </details>
      )}
    </section>
  );
}
