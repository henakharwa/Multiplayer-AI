import type { Participant, WorkspaceRole } from "@mai-chat/shared-types";
import { colorForName, initialsForName } from "../../../../lib/avatar";

// "In this workspace": who is online, which chat they're viewing, and the
// viewer's own role.
export default function MembersPanel({
  participants,
  displayName,
  selectedConversationId,
  role,
  onManage,
  onFollow,
}: {
  participants: Participant[];
  displayName: string;
  selectedConversationId: string | null;
  role: WorkspaceRole | null;
  onManage: () => void;
  onFollow: (conversationId: string) => void;
}) {
  return (
    <div className="workspace-side-section workspace-members">
      <div className="workspace-side-heading">
        <span>In this workspace</span>
        <span className="workspace-side-heading-actions">
          {role && (
            <span
              className={`workspace-role-badge ${role}`}
              data-testid="workspace-role-badge"
              title={`Your role: ${role === "admin" ? "Admin" : "Editor"}`}
            >
              {role === "admin" ? "Admin" : "Editor"}
            </span>
          )}
          {role === "admin" && (
            <button className="workspace-manage-members" onClick={onManage}>
              Manage
            </button>
          )}
        </span>
      </div>
      {participants.map((p) => {
        const elsewhere = p.activeConversationId && p.activeConversationId !== selectedConversationId;
        return (
          <div className="participant" key={p.clientId} data-testid="participant">
            <span className="avatar" style={{ background: colorForName(p.displayName) }}>
              {initialsForName(p.displayName)}
            </span>
            <span>
              {p.displayName}
              {p.displayName === displayName ? " (you)" : ""}
              {elsewhere ? <small> · viewing another chat</small> : ""}
            </span>
            {elsewhere && (
              <button className="workspace-follow" onClick={() => onFollow(p.activeConversationId!)}>
                Follow
              </button>
            )}
            <span className="dot" />
          </div>
        );
      })}
    </div>
  );
}
