"use client";

import { useState } from "react";
import { describeError, requestWorkspacePermission } from "../../lib/api";
import { PERMISSION_LABELS, type WorkspaceAccessState, type WorkspacePermission } from "../../lib/useWorkspaceAccess";

// Shown where a conditional capability is unavailable. Editors can request
// the missing permission from an Admin (an Editor-only capability); for
// Admin-only areas no request is offered.
export function AccessNotice({ workspaceId, access, permission, adminOnly, message }: {
  workspaceId: string;
  access: WorkspaceAccessState;
  permission?: WorkspacePermission;
  adminOnly?: boolean;
  message?: string;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  if (access.loading || !access.role) return null;
  if (adminOnly ? access.isAdmin : !permission || access.can(permission)) return null;
  const label = permission ? PERMISSION_LABELS[permission] : "";
  const text = message ?? (adminOnly ? "Only workspace Admins can change this." : `This requires the “${label}” permission.`);
  async function submit() {
    if (!permission || !reason.trim()) return;
    setBusy(true); setStatus(null);
    try { await requestWorkspacePermission(workspaceId, permission, reason.trim()); setStatus({ ok: true, text: "Request sent to workspace Admins." }); setOpen(false); setReason(""); }
    catch (error) { setStatus({ ok: false, text: describeError(error, "Could not send your request.") }); }
    finally { setBusy(false); }
  }
  return <div className="access-notice" role="note">
    <span>{text}</span>
    {!adminOnly && permission && access.isEditor && !open && <button type="button" className="btn secondary" onClick={() => { setOpen(true); setStatus(null); }}>Request access</button>}
    {open && <div className="access-notice-form"><label>Why do you need this access?<textarea value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} rows={2} placeholder="Describe the work you need to do." /></label><div><button type="button" className="btn" disabled={busy || !reason.trim()} onClick={() => void submit()}>{busy ? "Sending…" : "Send request"}</button><button type="button" className="btn secondary" onClick={() => setOpen(false)}>Cancel</button></div></div>}
    {status && <small className={status.ok ? "success-text" : "error-text"}>{status.text}</small>}
  </div>;
}
