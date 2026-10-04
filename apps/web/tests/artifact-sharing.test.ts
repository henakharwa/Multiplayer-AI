import { describe, expect, it } from "vitest";
import { normalizeSlackChannel, publicArtifactPath } from "../lib/artifact-sharing";

describe("artifact sharing helpers", () => {
  it("uses the correct public route for each artifact type", () => {
    expect(publicArtifactPath("dashboard", "token")).toBe("/dashboard/token");
    expect(publicArtifactPath("release_notes", "token")).toBe("/release-notes/token");
    expect(publicArtifactPath("plan", "token")).toBe("/shared/token");
    expect(publicArtifactPath("report", "token")).toBe("/shared/token");
    expect(publicArtifactPath("task_list", "token")).toBe("/shared/token");
  });

  it("normalizes Slack channel entries without changing channel names", () => {
    expect(normalizeSlackChannel(" #team-updates ")).toBe("team-updates");
    expect(normalizeSlackChannel("engineering_platform")).toBe("engineering_platform");
    expect(normalizeSlackChannel("   ")).toBe("");
  });
});
