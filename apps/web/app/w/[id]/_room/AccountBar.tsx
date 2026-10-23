import type { WorkspaceRole } from "@mai-chat/shared-types";
import { logout } from "../../../../lib/api";
import { colorForName, initialsForName } from "../../../../lib/avatar";
import { SignOutGlyph } from "./glyphs";

// The signed-in member at the bottom of the sidebar, with sign-out.
export default function AccountBar({
  displayName,
  username,
  role,
}: {
  displayName: string;
  username: string;
  role: WorkspaceRole | null;
}) {
  return (
    <div className="workspace-account">
      <span className="workspace-account-avatar" style={{ background: colorForName(displayName) }}>
        {initialsForName(displayName)}
      </span>
      <span>
        <strong>
          {displayName}
          {role && (
            <span className={`workspace-role-badge ${role}`} data-testid="account-role-badge">
              {role === "admin" ? "Admin" : "Editor"}
            </span>
          )}
        </strong>
        <small>{username}</small>
      </span>
      <button
        onClick={async () => {
          await logout();
          window.location.href = "/";
        }}
        aria-label="Sign out"
        title="Sign out"
      >
        <SignOutGlyph />
      </button>
    </div>
  );
}
