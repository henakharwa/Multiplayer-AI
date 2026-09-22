"use client";

import { useState } from "react";
import type { PendingAction } from "@mai-chat/shared-types";
import { confirmAction, cancelAction } from "../../lib/api";

// One card per PendingAction the agent has queued but not yet run (see
// services/chat-server/src/actions.ts). Only renders for status "pending"
// -- the parent page filters that -- since a resolved action's outcome is
// already visible as a System chat message.
export default function PendingActionCard({
  workspaceId,
  action,
  actorName,
}: {
  workspaceId: string;
  action: PendingAction;
  actorName: string;
}) {
  const [busy, setBusy] = useState<"confirm" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handle(intent: "confirm" | "cancel") {
    setBusy(intent);
    setError(null);
    try {
      if (intent === "confirm") {
        await confirmAction(workspaceId, action.id, actorName);
      } else {
        await cancelAction(workspaceId, action.id, actorName);
      }
      // No local state update needed on success -- the server broadcasts
      // a pending_action_update over the WebSocket, which is what
      // actually removes this card (via the parent's status === "pending"
      // filter) for everyone in the room, including this tab.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(null);
    }
  }

  return (
    <div className="pending-action" data-testid="pending-action-card">
      <div className="pending-action-label">The agent wants to:</div>
      <div className="pending-action-desc">{action.description}</div>
      {action.preview && <pre className="pending-action-preview">{action.preview}</pre>}
      {error && <div className="pending-action-error">{error}</div>}
      <div className="pending-action-buttons">
        <button className="btn" disabled={busy !== null} onClick={() => handle("confirm")} data-testid="confirm-action-btn">
          {busy === "confirm" ? "Confirming…" : "Confirm"}
        </button>
        <button className="btn secondary" disabled={busy !== null} onClick={() => handle("cancel")} data-testid="cancel-action-btn">
          {busy === "cancel" ? "Cancelling…" : "Cancel"}
        </button>
      </div>
    </div>
  );
}
