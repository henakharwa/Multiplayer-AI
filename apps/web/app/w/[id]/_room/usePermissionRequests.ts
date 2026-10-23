"use client";

import { useEffect, useState } from "react";
import {
  describeError,
  listPermissionRequests,
  resolvePermissionRequest,
  type PermissionRequest,
} from "../../../../lib/api";

// Pending permission requests, refreshed every 15 seconds. Only Admins may
// read them, so nothing is requested until `enabled` (the viewer is an Admin);
// asking as an Editor would just be refused every time.
export function usePermissionRequests(workspaceId: string, enabled: boolean, onError: (message: string) => void) {
  const [requests, setRequests] = useState<PermissionRequest[]>([]);
  useEffect(() => {
    if (!enabled) {
      setRequests([]);
      return;
    }
    let cancelled = false;
    const refresh = () =>
      listPermissionRequests(workspaceId)
        .then((items) => {
          if (!cancelled) setRequests(items);
        })
        .catch(() => {});
    refresh();
    const interval = window.setInterval(refresh, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [workspaceId, enabled]);

  async function decide(request: PermissionRequest, decision: "approve" | "reject") {
    try {
      await resolvePermissionRequest(workspaceId, request.id, decision);
      setRequests((items) => items.filter((item) => item.id !== request.id));
    } catch (error) {
      onError(describeError(error, "Could not update the permission request."));
    }
  }

  return { requests, decide };
}
