"use client";

import { useState } from "react";
import type { PendingAction } from "@mai-chat/shared-types";
import { AccessNotice } from "../../../_components/AccessNotice";
import PendingActionCard from "../../../_components/PendingActionCard";
import type { WorkspaceAccessState } from "../../../../lib/useWorkspaceAccess";

// Approval cards waiting above the composer: the latest one, or all of them.
export default function PendingActionsPanel({
  workspaceId,
  actions,
  actorName,
  currentUserId,
  canApprove,
  access,
}: {
  workspaceId: string;
  actions: PendingAction[];
  actorName: string;
  currentUserId: string;
  canApprove: boolean;
  access: WorkspaceAccessState;
}) {
  const [showAll, setShowAll] = useState(false);
  if (actions.length === 0) return null;
  return (
    <div className="pending-actions-list" data-testid="pending-actions-list">
      <div className="pending-actions-summary">
        <span>
          {actions.length} approval request{actions.length === 1 ? "" : "s"} awaiting review
        </span>
        {actions.length > 1 && (
          <button type="button" onClick={() => setShowAll((current) => !current)}>
            {showAll ? "Show latest" : `Review all (${actions.length})`}
          </button>
        )}
      </div>
      {(showAll ? actions : actions.slice(0, 1)).map((action) => (
        <PendingActionCard
          key={action.id}
          workspaceId={workspaceId}
          action={action}
          actorName={actorName}
          currentUserId={currentUserId}
          canApprove={canApprove}
          onRequestAccess={
            <AccessNotice
              workspaceId={workspaceId}
              access={access}
              permission="approveActions"
              message="You can review this request, but confirming external actions requires the “Approve actions” permission."
            />
          }
        />
      ))}
    </div>
  );
}
