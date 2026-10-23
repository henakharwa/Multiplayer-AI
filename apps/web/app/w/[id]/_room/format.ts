// Small formatting helpers for the workspace room.
import type { IntegrationConfig } from "@mai-chat/shared-types";

export function roleLabel(role: string): string {
  if (role === "agent") return "Agent";
  if (role === "system") return "System";
  return "";
}

export function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

export function permissionLabel(permission: string): string {
  return (
    (
      {
        connectTools: "Connect and manage tools",
        createAgents: "Create agents",
        publishAgents: "Publish agents",
        manageWorkflows: "Manage workflows",
        manageMemory: "Manage workspace memory",
        manageArtifacts: "Manage artifacts",
        approveActions: "Approve actions",
        github: "Use GitHub",
        slack: "Use Slack",
        linear: "Use Linear",
        notion: "Use Notion",
        figma: "Use Figma",
      } as Record<string, string>
    )[permission] ?? permission
  );
}

// One row of the sidebar's "Connected" list -- a GitHub repo (only once a
// repo has actually been chosen; owner/repo is what makes the row
// meaningful, see GithubIntegrationConfig's doc comment for why those can
// be briefly undefined right after OAuth) or a Slack team.
export function connectedChannelLabel(integration: IntegrationConfig): string | null {
  if (integration.type === "github") {
    return integration.owner && integration.repo ? `${integration.owner}/${integration.repo}` : null;
  }
  if (integration.type === "slack") return integration.teamName;
  return integration.accountName ?? `${integration.type[0].toUpperCase()}${integration.type.slice(1)} account`;
}

export interface StoredNotification {
  id: string;
  text: string;
  createdAt: string;
  read: boolean;
}
