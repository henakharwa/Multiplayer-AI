"use client";

import { useCallback, useEffect, useState } from "react";
import type { WorkspacePermissions, WorkspaceRole } from "@mai-chat/shared-types";
import { getWorkspaceAccess } from "./api";

export type WorkspacePermission = keyof WorkspacePermissions;

export const PERMISSION_LABELS: Record<WorkspacePermission, string> = {
  connectTools: "Connect and manage tools",
  createAgents: "Create agents and workflows",
  publishAgents: "Publish agents",
  approveActions: "Approve actions",
  github: "Use GitHub",
  slack: "Use Slack",
  linear: "Use Linear",
  notion: "Use Notion",
  figma: "Use Figma",
};

export interface WorkspaceAccessState {
  loading: boolean;
  role: WorkspaceRole | null;
  isAdmin: boolean;
  isEditor: boolean;
  /** True when the member currently holds the permission (Admins hold all). */
  can: (permission: WorkspacePermission) => boolean;
  refresh: () => void;
}

// Single source of truth for role-based UI states. Until access has loaded
// nothing privileged is enabled, so an Editor never briefly sees Admin
// controls; the server enforces the same rules regardless.
export function useWorkspaceAccess(workspaceId: string): WorkspaceAccessState {
  const [role, setRole] = useState<WorkspaceRole | null>(null);
  const [permissions, setPermissions] = useState<WorkspacePermissions | null>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    getWorkspaceAccess(workspaceId)
      .then((access) => { if (!cancelled) { setRole(access.role); setPermissions(access.permissions); } })
      .catch(() => { if (!cancelled) { setRole(null); setPermissions(null); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workspaceId, version]);
  const can = useCallback((permission: WorkspacePermission) => role === "admin" || Boolean(permissions?.[permission]), [permissions, role]);
  const refresh = useCallback(() => setVersion((value) => value + 1), []);
  return { loading, role, isAdmin: role === "admin", isEditor: role === "editor", can, refresh };
}
