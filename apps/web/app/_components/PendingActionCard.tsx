"use client";

import { useState, type ReactNode } from "react";
import type { PendingAction } from "@mai-chat/shared-types";
import { ApiError, describeError, confirmAction, cancelAction } from "../../lib/api";

// One card per PendingAction the agent has queued but not yet run (see
// services/chat-server/src/actions.ts). Only renders for status "pending"
// -- the parent page filters that -- since a resolved action's outcome is
// already visible as a System chat message.
export default function PendingActionCard({
  workspaceId,
  action,
  actorName,
  canApprove = true,
  onRequestAccess,
}: {
  workspaceId: string;
  action: PendingAction;
  actorName: string;
  // External approvals: Admins by default, Editors with approveActions.
  canApprove?: boolean;
  onRequestAccess?: ReactNode;
}) {
  const [busy, setBusy] = useState<"confirm" | "cancel" | "runAsMe" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Set when the server reports the run-as connection is gone and the
  // approver's own connection can do it instead.
  const [offerRunAsMe, setOfferRunAsMe] = useState(action.runAsAvailable === false);
  // GitHub writes target owner/repo. Slack's MCP tools pass channel_id,
  // older Slack tools passed channel, and Figma tools pass the file link.
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
  const channel = text(action.args.channel) ?? text(action.args.channel_id);
  const target =
    action.target?.label ||
    [action.args.owner, action.args.repo]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join("/") ||
    (channel ? `#${channel.replace(/^#/, "")}` : null) ||
    text(action.args.file) ||
    action.toolName;
  const warnings = action.warnings ?? [];
  const runsAs =
    action.runAsKind === "app"
      ? `Workspace GitHub App${action.runAsAccount ? ` (@${action.runAsAccount})` : ""}`
      : `${action.runAsName ?? action.requestedByName ?? "The requester"}${
          action.runAsAccount
            ? ` (${action.agentKind === "github" || !action.agentKind ? "@" : ""}${action.runAsAccount})`
            : ""
        }`;

  async function handle(intent: "confirm" | "cancel" | "runAsMe") {
    setBusy(intent);
    setError(null);
    try {
      if (intent === "cancel") await cancelAction(workspaceId, action.id, actorName);
      else await confirmAction(workspaceId, action.id, actorName, intent === "runAsMe" ? { runAs: "me" } : {});
      // No local state update needed on success -- the server broadcasts
      // a pending_action_update over the WebSocket, which is what
      // actually removes this card (via the parent's status === "pending"
      // filter) for everyone in the room, including this tab.
    } catch (err) {
      if (err instanceof ApiError && err.code === "run_as_unavailable") setOfferRunAsMe(true);
      setError(describeError(err, "Something went wrong."));
      setBusy(null);
    }
  }

  return (
    <div className="pending-action" data-testid="pending-action-card">
      <div className="pending-action-header">
        <div className="pending-action-label">Approval required</div>
        <span>Nothing has changed yet</span>
      </div>
      <div className="pending-action-desc">{action.description}</div>
      <dl className="pending-action-details">
        <div>
          <dt>Action</dt>
          <dd>{action.toolName.replace(/[_-]/g, " ")}</dd>
        </div>
        <div>
          <dt>Target</dt>
          <dd>{target}</dd>
        </div>
        <div>
          <dt>Requested by</dt>
          <dd>{action.requestedByName ?? "A workspace member"}</dd>
        </div>
        <div>
          <dt>Runs as</dt>
          <dd data-testid="pending-action-runs-as">
            {runsAs}
            {action.runAsAvailable === false && (
              <span className="pending-action-unavailable" title="This connection is no longer available">
                {" "}
                · unavailable
              </span>
            )}
          </dd>
        </div>
      </dl>
      {warnings.length > 0 && (
        <div className="pending-action-warnings" role="note" data-testid="pending-action-warnings">
          <strong>Possible duplicate{warnings.length === 1 ? "" : "s"}</strong>
          <ul>
            {warnings.map((warning, index) => (
              <li key={`${warning.kind}-${index}`}>
                {warning.message}
                {warning.url && (
                  <>
                    {" "}
                    <a href={warning.url} target="_blank" rel="noreferrer">
                      Open
                    </a>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {action.preview && <pre className="pending-action-preview">{action.preview}</pre>}
      {error && <div className="pending-action-error">{error}</div>}
      <p className="pending-action-note">
        {!canApprove
          ? "An Admin or a teammate with the “Approve actions” permission must confirm this action."
          : offerRunAsMe
            ? `${action.runAsName ?? action.requestedByName ?? "The requester"}'s connection can no longer run this. You can run it with your own account instead.`
            : warnings.length
              ? "Check the possible duplicates above before approving."
              : "Review the target and preview, then approve to run this action."}
      </p>
      {!canApprove && onRequestAccess}
      <div className="pending-action-buttons">
        {offerRunAsMe && canApprove ? (
          <button
            className="btn"
            disabled={busy !== null}
            onClick={() => handle("runAsMe")}
            data-testid="run-as-me-btn"
          >
            {busy === "runAsMe" ? "Running…" : "Run as me"}
          </button>
        ) : (
          <button
            className="btn"
            disabled={busy !== null || !canApprove}
            onClick={() => handle("confirm")}
            data-testid="confirm-action-btn"
          >
            {busy === "confirm" ? "Confirming…" : warnings.length ? "Confirm anyway" : "Confirm"}
          </button>
        )}
        <button
          className="btn secondary"
          disabled={busy !== null || !canApprove}
          onClick={() => handle("cancel")}
          data-testid="cancel-action-btn"
        >
          {busy === "cancel" ? "Cancelling…" : "Cancel"}
        </button>
      </div>
    </div>
  );
}
