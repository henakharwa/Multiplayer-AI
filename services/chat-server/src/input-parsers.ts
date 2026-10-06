// Request-body parsing and small pure helpers shared by route modules and tests.
import { UUID_RE } from "./http-utils.js";

export function workflowRequestsExternalChange(instructions: string): boolean {
  const text = instructions.toLowerCase();
  // An explicit prohibition wins, even if the sentence names a write tool
  // (for example, "do not send a Slack message").
  if (/\b(?:do not|don't|never)\s+(?:make|create|open|update|edit|delete|merge|close|comment|post|send|publish)\b/.test(text)) return false;
  // Workflows normally review and report. Expose proposal tools only when
  // the saved workflow explicitly requests an external mutation.
  return /\b(?:create|open|update|edit|delete|merge|close|comment|post|send|publish)\b[\s\S]{0,80}\b(?:issue|pull request|pr\b|file|readme|branch|comment|message|slack|release)\b/.test(text);
}

export function parseWorkspaceMemoryInput(body: Record<string, unknown>) {
  const kind = body.kind === "decision" ? "decision" : "knowledge";
  const rawFreshUntil = typeof body.freshUntil === "string" ? body.freshUntil.trim() : "";
  if (rawFreshUntil && Number.isNaN(Date.parse(rawFreshUntil))) throw new Error("Review date must be valid.");
  const sourceUrl = typeof body.sourceUrl === "string" ? body.sourceUrl.trim() : "";
  if (sourceUrl) {
    let parsed: URL;
    try { parsed = new URL(sourceUrl); } catch { throw new Error("Source URL must be a valid http:// or https:// URL."); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Source URL must start with http:// or https://.");
  }
  return {
    kind,
    title: typeof body.title === "string" ? body.title : "",
    content: typeof body.content === "string" ? body.content : "",
    sourceTitle: typeof body.sourceTitle === "string" ? body.sourceTitle : null,
    sourceUrl: sourceUrl || null,
    freshUntil: rawFreshUntil || null,
  } as const;
}

/**
 * Prevent a provider outage from turning a memory-backed workflow into a
 * refusal. A workflow may still need live GitHub data for a complete report,
 * but saved workspace policy is enough to produce a clearly-labelled draft.
 */
export function preferWorkspaceMemoryForRepositoryUnavailableWorkflow(reply: string, workspaceMemory: string, isWorkflow: boolean): string {
  if (!isWorkflow || !workspaceMemory.trim()) return reply;
  const refusesForMissingRepository = /\b(?:can't|cannot|unable|won't)\b[\s\S]{0,650}\b(?:github\s+repository|repository|repo)\b/i.test(reply)
    && /\brelease\s+(?:update|policy)\b/i.test(reply);
  if (!refusesForMissingRepository) return reply;

  return `Live GitHub data is unavailable, so this is a policy-based release update rather than a live repository report.\n\n${workspaceMemory}\n\nUse the saved policy above for the release decision. Connect a repository later to add current pull-request, issue, and CI details.`;
}

export const artifactTypes = ["plan", "report", "release_notes", "dashboard", "task_list"] as const;
export const artifactStatuses = ["draft", "published", "archived"] as const;
export function dashboardData(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const items = <T>(key: string, map: (item: Record<string, unknown>, index: number) => T) => Array.isArray(raw[key]) ? raw[key].slice(0, 20).filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)).map(map) : [];
  const text = (value: unknown, max = 160) => typeof value === "string" ? value.trim().slice(0, max) : "";
  return { health: ["on_track", "at_risk", "off_track"].includes(raw.health as string) ? raw.health as "on_track" | "at_risk" | "off_track" : "on_track",
    metrics: items("metrics", (item, index) => ({ id: text(item.id, 80) || `metric-${index}`, label: text(item.label), value: text(item.value), trend: ["up", "down", "flat"].includes(item.trend as string) ? item.trend as "up" | "down" | "flat" : "flat", target: text(item.target) })),
    milestones: items("milestones", (item, index) => ({ id: text(item.id, 80) || `milestone-${index}`, label: text(item.label), progress: Math.max(0, Math.min(100, Number(item.progress) || 0)) })),
    risks: items("risks", (item, index) => ({ id: text(item.id, 80) || `risk-${index}`, title: text(item.title), severity: ["low", "medium", "high"].includes(item.severity as string) ? item.severity as "low" | "medium" | "high" : "medium", owner: text(item.owner) })),
    decisions: items("decisions", (item, index) => ({ id: text(item.id, 80) || `decision-${index}`, title: text(item.title), owner: text(item.owner), dueDate: text(item.dueDate, 30) })),
    checklist: items("checklist", (item, index) => ({ id: text(item.id, 80) || `check-${index}`, label: text(item.label), done: Boolean(item.done) })),
  };
}
export function parseWorkspaceArtifactInput(body: Record<string, unknown>) {
  return {
    type: artifactTypes.includes(body.type as typeof artifactTypes[number]) ? body.type as typeof artifactTypes[number] : "plan",
    status: artifactStatuses.includes(body.status as typeof artifactStatuses[number]) ? body.status as typeof artifactStatuses[number] : "draft",
    title: typeof body.title === "string" ? body.title.trim() : "",
    summary: typeof body.summary === "string" ? body.summary.trim() : "",
    content: typeof body.content === "string" ? body.content.trim() : "",
    dashboardData: dashboardData(body.dashboardData),
    ownerUserId: typeof body.ownerUserId === "string" && UUID_RE.test(body.ownerUserId) ? body.ownerUserId : null,
    releaseVersion: typeof body.releaseVersion === "string" && body.releaseVersion.trim() ? body.releaseVersion.trim().slice(0, 40) : null,
  };
}
