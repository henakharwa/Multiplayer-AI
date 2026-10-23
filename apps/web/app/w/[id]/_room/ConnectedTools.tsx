"use client";

import { useState } from "react";
import Link from "next/link";
import type { IntegrationConfig } from "@mai-chat/shared-types";
import { connectedChannelLabel } from "./format";
import { MoreGlyph, ToolIcon } from "./glyphs";

// The sidebar's "Connected tools" list. Members can change or disconnect
// only the connections they own.
export default function ConnectedTools({
  workspaceId,
  integrations,
  currentUserId,
  canConnectTools,
  onConnect,
  onChangeGithub,
  onDisconnect,
}: {
  workspaceId: string;
  integrations: IntegrationConfig[];
  currentUserId: string;
  canConnectTools: boolean;
  onConnect: () => void;
  onChangeGithub: () => void;
  onDisconnect: (integration: IntegrationConfig) => Promise<void>;
}) {
  const [menuFor, setMenuFor] = useState<IntegrationConfig["type"] | null>(null);
  return (
    <div className="workspace-side-section">
      <div className="workspace-side-heading">
        <span>Connected tools</span>
      </div>
      {integrations.map((integration) => {
        const label = connectedChannelLabel(integration);
        if (!label) return null;
        return (
          <div
            className="workspace-tool-row"
            key={integration.id ?? integration.type}
            data-testid={`connected-${integration.type}`}
          >
            <Link className="workspace-tool" href={`/w/${workspaceId}/integrations`}>
              <span className="channel-glyph">
                <ToolIcon tool={integration.type} />
              </span>
              <span>
                {label}
                <small className="tool-connector">
                  Connected by{" "}
                  {integration.ownerUserId === currentUserId
                    ? "You"
                    : (integration.connectedByName ?? "workspace member")}
                </small>
              </span>
              <small className="tool-health connected">Connected</small>
            </Link>
            {canConnectTools && integration.ownerUserId === currentUserId && (
              <div className="workspace-tool-menu">
                <button
                  type="button"
                  className="workspace-tool-more"
                  aria-label={`Manage ${integration.type}`}
                  aria-expanded={menuFor === integration.type}
                  onClick={() => setMenuFor((current) => (current === integration.type ? null : integration.type))}
                >
                  <MoreGlyph />
                </button>
                {menuFor === integration.type && (
                  <div className="workspace-tool-popover">
                    {integration.type === "github" && (
                      <button type="button" onClick={onChangeGithub}>
                        Change
                      </button>
                    )}
                    <button
                      type="button"
                      className="danger"
                      onClick={() => void onDisconnect(integration).finally(() => setMenuFor(null))}
                    >
                      Disconnect
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
      <button className="workspace-empty-tool" onClick={onConnect}>
        Connect your tools +
      </button>
    </div>
  );
}
