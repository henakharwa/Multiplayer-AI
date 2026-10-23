"use client";

import { useState } from "react";
import type { WorkspaceRole } from "@mai-chat/shared-types";
import { describeError, sendWorkspaceInvitation } from "../../../../lib/api";
import { CloseGlyph } from "./glyphs";

// Admin dialog: invite someone by email with a role. Its form starts empty
// each time it opens.
export default function InviteModal({
  workspaceId,
  workspaceName,
  onClose,
}: {
  workspaceId: string;
  workspaceName: string;
  onClose: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("editor");
  const [state, setState] = useState<{ sending: boolean; message: string | null; error: string | null }>({
    sending: false,
    message: null,
    error: null,
  });

  async function send(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!email.trim()) return;
    setState({ sending: true, message: null, error: null });
    try {
      const invitation = await sendWorkspaceInvitation(workspaceId, { email: email.trim(), role });
      setState({
        sending: false,
        message: `Invitation sent to ${invitation.email} as ${invitation.role}.`,
        error: null,
      });
      setEmail("");
    } catch (error) {
      setState({ sending: false, message: null, error: describeError(error, "Could not send the invitation.") });
    }
  }

  return (
    <div className="access-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="access-modal workspace-invite-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="invite-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <p>Workspace access</p>
            <h2 id="invite-title">Invite a teammate</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close">
            <CloseGlyph />
          </button>
        </header>
        <p className="access-modal-intro">
          They will receive an email with a secure link to join {workspaceName}. They must sign in with the invited
          email address.
        </p>
        <form className="workspace-invite-form" onSubmit={(event) => void send(event)}>
          <label htmlFor="invite-email">Email address</label>
          <input
            id="invite-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="teammate@example.com"
            autoComplete="email"
            required
            autoFocus
          />
          <label htmlFor="invite-role">Workspace role</label>
          <select id="invite-role" value={role} onChange={(event) => setRole(event.target.value as WorkspaceRole)}>
            <option value="editor">Editor</option>
            <option value="admin">Admin</option>
          </select>
          <button className="btn" type="submit" disabled={state.sending || !email.trim()}>
            {state.sending ? "Sending…" : "Send invitation"}
          </button>
        </form>
        {state.message && (
          <p className="workspace-invite-success" role="status">
            {state.message}
          </p>
        )}
        {state.error && (
          <p className="error-text" role="alert">
            {state.error}
          </p>
        )}
      </section>
    </div>
  );
}
