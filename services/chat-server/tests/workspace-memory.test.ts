import { describe, expect, it } from "vitest";
import { formatWorkspaceMemoryContext } from "@mai-chat/db";
import { parseWorkspaceArtifactInput, parseWorkspaceMemoryInput, preferWorkspaceMemoryForRepositoryUnavailableWorkflow } from "../src/server.js";
import type { WorkspaceMemory } from "@mai-chat/shared-types";

function memory(overrides: Partial<WorkspaceMemory> = {}): WorkspaceMemory {
  return {
    id: "memory-1", workspaceId: "workspace-1", kind: "knowledge", title: "Release policy", content: "Release from main only.",
    sourceTitle: null, sourceUrl: null, freshUntil: null, createdByUserId: "user-1", createdByName: "Hena",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...overrides,
  };
}

describe("workspace memory", () => {
  it("formats current, stale, cited, and uncited memories for the agent", () => {
    const context = formatWorkspaceMemoryContext([
      memory({ kind: "decision", title: "Release rule", content: "Ship only from main.", sourceTitle: "Release plan", sourceUrl: "https://example.com/release", freshUntil: "2099-12-31T00:00:00.000Z" }),
      memory({ id: "memory-2", title: "Old ownership", content: "The old on-call rotation.", freshUntil: "2020-01-01T00:00:00.000Z" }),
    ]);
    expect(context).toContain("[Memory: Release rule] (decision; current through 2099-12-31)");
    expect(context).toContain("Source: Release plan (https://example.com/release).");
    expect(context).toContain("[Memory: Old ownership] (knowledge; STALE — verify before relying on it)");
  });

  it("limits entries and caps context size", () => {
    const entries = Array.from({ length: 14 }, (_, index) => memory({ id: `memory-${index}`, title: `Entry ${index}`, content: "x".repeat(2_000) }));
    const context = formatWorkspaceMemoryContext(entries, 2);
    expect(context).toContain("Entry 0");
    expect(context).toContain("Entry 1");
    expect(context).not.toContain("Entry 2");
    expect(context.length).toBeLessThanOrEqual(12_000);
  });

  it("parses valid saved-memory input and rejects unsafe source metadata", () => {
    expect(parseWorkspaceMemoryInput({ kind: "decision", title: "Use main", content: "Reason", sourceTitle: "Plan", sourceUrl: "https://example.com/plan", freshUntil: "2026-12-01" })).toMatchObject({ kind: "decision", sourceUrl: "https://example.com/plan", freshUntil: "2026-12-01" });
    expect(() => parseWorkspaceMemoryInput({ sourceUrl: "ftp://example.com/file" })).toThrow("Source URL must start");
    expect(() => parseWorkspaceMemoryInput({ sourceUrl: "https://" })).toThrow("Source URL must be a valid");
    expect(() => parseWorkspaceMemoryInput({ freshUntil: "not-a-date" })).toThrow("Review date must be valid");
  });

  it("turns a repository-blocked release workflow into a memory-based draft", () => {
    const reply = preferWorkspaceMemoryForRepositoryUnavailableWorkflow(
      "I can't create the release update because no GitHub repository is connected, so I can't access the release policy.",
      "[Memory: Release policy] (decision; no freshness date)\nRelease from main only.",
      true,
    );
    expect(reply).toContain("policy-based release update");
    expect(reply).toContain("[Memory: Release policy]");
    expect(reply).toContain("Live GitHub data is unavailable");
  });

  it("does not replace ordinary responses or responses without saved memory", () => {
    expect(preferWorkspaceMemoryForRepositoryUnavailableWorkflow("A release update is ready.", "[Memory: Release policy]", true)).toBe("A release update is ready.");
    expect(preferWorkspaceMemoryForRepositoryUnavailableWorkflow("I can't create the release update because no repository is connected.", "", true)).toContain("can't create");
  });

  it("parses collaboration artifact input into safe workspace values", () => {
    expect(parseWorkspaceArtifactInput({ type: "release_notes", status: "published", title: "v1", summary: "Ready", content: "Shipped", ownerUserId: "not-a-uuid" })).toEqual({ type: "release_notes", status: "published", title: "v1", summary: "Ready", content: "Shipped", ownerUserId: null, dashboardData: null, releaseVersion: null });
    expect(parseWorkspaceArtifactInput({ type: "unknown", status: "unknown" })).toMatchObject({ type: "plan", status: "draft", title: "", content: "" });
  });
});
