import { describe, expect, it } from "vitest";
import { wrapForProposal } from "../src/actions.js";
import { RoomRegistry } from "../src/rooms.js";
import type { ToolExecutor } from "../src/tools.js";

function tool(name: string, mutates: boolean): ToolExecutor {
  return {
    definition: { type: "function", function: { name, description: name, parameters: { type: "object", properties: {} } } },
    mutates,
    execute: async () => ({ ok: true }),
  };
}

describe("workflow read-only tool surface", () => {
  it("removes mutating tools before an automated review reaches the model", () => {
    const tools = wrapForProposal(
      [tool("list_workflow_runs", false), tool("create_or_update_file", true)],
      "workspace-id",
      "conversation-id",
      new RoomRegistry(),
      undefined,
      "github",
      { readOnly: true }
    );
    expect(tools.map((item) => item.definition.function.name)).toEqual(["list_workflow_runs"]);
  });

  it("keeps a mutating tool available for a workflow that will propose an approved change", () => {
    const tools = wrapForProposal(
      [tool("list_issues", false), tool("issue_write", true)],
      "workspace-id",
      "conversation-id",
      new RoomRegistry(),
      undefined,
      "github"
    );
    expect(tools.map((item) => item.definition.function.name)).toEqual(["list_issues", "issue_write"]);
  });
});
