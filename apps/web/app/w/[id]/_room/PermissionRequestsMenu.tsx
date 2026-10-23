"use client";

import { useState } from "react";
import type { PermissionRequest } from "../../../../lib/api";
import { permissionLabel } from "./format";
import { KeyGlyph } from "./glyphs";

// Admin-only: the key icon in the sidebar and the pending permission requests.
export default function PermissionRequestsMenu({
  requests,
  onDecide,
}: {
  requests: PermissionRequest[];
  onDecide: (request: PermissionRequest, decision: "approve" | "reject") => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="workspace-permission-request-wrap">
      <button
        type="button"
        title="Permission requests"
        onClick={() => setOpen((current) => !current)}
        aria-label={`Permission requests${requests.length ? ` (${requests.length} pending)` : ""}`}
      >
        <KeyGlyph />
        {requests.length > 0 && (
          <span className="workspace-notification-badge">{requests.length > 9 ? "9+" : requests.length}</span>
        )}
      </button>
      {open && (
        <section className="workspace-permission-request-panel" aria-label="Pending permission requests">
          <header>
            <div>
              <p>Requests</p>
              <strong>Pending permissions</strong>
            </div>
            <span>{requests.length}</span>
          </header>
          {requests.length ? (
            requests.map((request) => (
              <article key={request.id}>
                <dl>
                  <div>
                    <dt>Requested by</dt>
                    <dd>
                      {request.display_name} <small>@{request.username}</small>
                    </dd>
                  </div>
                  <div>
                    <dt>Capability</dt>
                    <dd>{permissionLabel(request.permission)}</dd>
                  </div>
                  <div>
                    <dt>Reason</dt>
                    <dd>{request.reason}</dd>
                  </div>
                </dl>
                <aside>
                  <button className="btn" onClick={() => onDecide(request, "approve")}>
                    Approve
                  </button>
                  <button className="btn secondary permission-reject" onClick={() => onDecide(request, "reject")}>
                    Reject
                  </button>
                </aside>
              </article>
            ))
          ) : (
            <p className="workspace-notification-empty">No pending permission requests.</p>
          )}
        </section>
      )}
    </div>
  );
}
