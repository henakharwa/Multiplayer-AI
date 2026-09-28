import { describe, expect, it } from "vitest";
import { workflowRequestsExternalChange } from "../src/server.js";

describe("workflow write policy", () => {
  it.each([
    "Review the reported CI status. Explain whether the team is blocked and list the next action.",
    "Summarize the request and provide a concise next step. Do not send a Slack message.",
    "Review open pull requests and release blockers. Do not make external changes.",
    "Do not create an issue; only summarize the incoming request.",
  ])("keeps review workflows read-only: %s", (instructions) => {
    expect(workflowRequestsExternalChange(instructions)).toBe(false);
  });

  it.each([
    "Create a GitHub issue titled Workflow approval test with the body Created by a governed workflow.",
    "Update the README file with the approved release notes.",
    "Post a Slack message with the incident summary.",
    "Open a pull request for the prepared release branch.",
  ])("permits governed proposals only for explicit external changes: %s", (instructions) => {
    expect(workflowRequestsExternalChange(instructions)).toBe(true);
  });
});
