import type { WorkspaceArtifactType } from "@mai-chat/shared-types";

export function publicArtifactPath(type: WorkspaceArtifactType, shareToken: string): string {
  if (type === "dashboard") return `/dashboard/${shareToken}`;
  if (type === "release_notes") return `/release-notes/${shareToken}`;
  return `/shared/${shareToken}`;
}

export function normalizeSlackChannel(value: string): string {
  return value.trim().replace(/^#/, "");
}
