import type { ToolDefinition } from "./llm-client.js";

export interface ToolExecutor {
  definition: ToolDefinition;
  // Read tools (mutates falsy) run immediately from the agent loop. Write
  // tools (mutates: true) are never called directly by the agent loop --
  // services/chat-server/src/actions.ts's wrapForProposal() swaps their
  // `execute` for one that queues a PendingAction instead, and only the
  // human-confirmed path ever invokes the real `execute` below.
  mutates?: boolean;
  // Human-readable one-liner for what a *mutating* tool call is about to
  // do, shown as the confirmation card's headline. Not needed (and not
  // called) for read tools.
  describe?: (args: Record<string, unknown>) => string;
  // A longer, more specific look at the actual payload -- shown on the
  // card alongside describe() so approving isn't a leap of faith based on
  // the one-liner alone. Optional -- not every mutating tool has more
  // useful detail to show than describe() already says.
  preview?: (args: Record<string, unknown>) => string;
  execute: (args: Record<string, unknown>) => Promise<unknown>;
}

// This file used to hand-roll both connectors' tool surfaces directly:
// GitHub's (~49 Octokit-backed tool specs) was replaced first by GitHub's
// own official MCP server (see github-mcp-pool.ts + mcp-tools.ts), and
// Slack's (list_slack_channels / get_slack_channel_history /
// post_slack_message, backed by packages/integrations/src/slack.ts) was
// replaced the same way by Slack's own official MCP server (see
// slack-mcp-pool.ts, launched 2026-02-17) once Slack shipped one --
// there's nothing hand-written left to build here. Both connectors'
// tools now go through the exact same path: a per-workspace MCP client
// (github-mcp-pool.ts / slack-mcp-pool.ts) plus mcp-tools.ts's generic
// conversion into the ToolExecutor shape above, wired in by
// services/chat-server/src/actions.ts's buildToolsForWorkspace. This
// file is kept around only for the ToolExecutor type itself, which both
// of those still depend on.
