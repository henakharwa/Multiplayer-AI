import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolExecutor } from "./tools.js";

// Converts one MCP server's listTools() result into this project's
// ToolExecutor shape, so the agent loop (agent.ts) and the
// confirm-before-write machinery (actions.ts's wrapForProposal) can treat
// an MCP-provided tool exactly like this project's own hand-written ones
// -- neither cares where a tool came from, only its `mutates` flag and
// whether it has describe()/preview().
//
// Mutation classification: GitHub's official MCP server
// (github/github-mcp-server) enforces at the SOURCE level -- a CI-run,
// AST-based check (pkg/toolvalidation/readonlyhint.go, invoked from
// _test.go files in that repo) that fails the build if any registered
// tool omits an explicit annotations.readOnlyHint -- that every tool it
// ships sets this. Verified directly by reading the v1.12.2 release
// source on 2026-09-21 (every `mcp.Tool` literal in pkg/github/*.go has a
// `ReadOnlyHint: true` or `ReadOnlyHint: false`), not assumed from the MCP
// spec alone. So for this specific server, readOnlyHint is a reliable
// signal, not just a hint to eyeball.
//
// Still: the MCP spec itself is explicit that annotations are hints from
// a potentially-untrusted server and clients "should never make tool use
// decisions based on ToolAnnotations" received from one -- see
// https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/.
// This project's confirm-before-write flow is exactly the kind of
// decision that warning is about, so as a fail-safe for any tool that
// omits the hint (a future github-mcp-server regression, or if this
// module is ever pointed at a different/unknown MCP server), a missing
// readOnlyHint defaults to "mutates: true" -- the same fail-safe-to-unsafe
// direction this project's own hand-written GithubToolSpec design always
// used, and safer than silently letting an unclassified tool run
// unconfirmed.
export function mcpToolToExecutor(client: Client, tool: McpTool): ToolExecutor {
  const mutates = tool.annotations?.readOnlyHint !== true;
  return {
    definition: {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description ?? tool.name,
        parameters: tool.inputSchema as Record<string, unknown>,
      },
    },
    mutates,
    // GitHub's MCP server doesn't ship this project's own hand-crafted
    // describe()/preview() text (that only exists for the old Octokit
    // tool specs) -- these generic fallbacks are what the confirmation
    // card shows instead: describe() as the one-line headline, preview()
    // as the fuller "here's exactly what you're about to run" detail.
    describe: mutates ? (args) => describeCall(tool, args) : undefined,
    preview: mutates ? (args) => previewCall(tool, args) : undefined,
    execute: (args) => callMcpTool(client, tool.name, args),
  };
}

/** Fetches this MCP client's full tool list and converts every one of them. */
export async function listMcpToolExecutors(client: Client): Promise<ToolExecutor[]> {
  const { tools } = await client.listTools();
  return tools.map((tool) => mcpToolToExecutor(client, tool as McpTool));
}

function describeCall(tool: McpTool, args: Record<string, unknown>): string {
  const label = tool.name.replace(/_/g, " ");
  // Several of github-mcp-server's tools are "mega-tools" that dispatch on
  // a `method` argument (e.g. issue_write's method can be "create",
  // "update", ...) rather than being one tool per verb the way this
  // project's old Octokit specs were -- surfacing method (when present)
  // is what makes the confirmation card's headline actually specific
  // instead of just repeating the tool's name.
  const method = typeof args.method === "string" && args.method ? ` (${args.method})` : "";
  return `Run "${label}"${method} on GitHub`;
}

function previewCall(tool: McpTool, args: Record<string, unknown>): string {
  const entries = Object.entries(args).filter(([, v]) => v !== undefined && v !== null && v !== "");
  const destructive = tool.annotations?.destructiveHint === true ? "⚠️ This cannot be undone.\n" : "";
  if (entries.length === 0) return `${destructive}${tool.name}: no arguments given.`;
  const lines = entries.map(([key, value]) => {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return `${key}: ${truncate(text, 500)}`;
  });
  return `${destructive}${lines.join("\n")}`;
}

function truncate(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : `${text.slice(0, maxLen)}…`;
}

async function callMcpTool(client: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await client.callTool({ name, arguments: normalizeGithubArguments(name, args) });
  const content = Array.isArray((result as { content?: unknown }).content)
    ? ((result as { content: { type: string; text?: string }[] }).content)
    : [];
  const text = content
    .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
  if ((result as { isError?: boolean }).isError) {
    const error = text || `GitHub MCP tool "${name}" reported an error`;
    // The model receives this error as its tool result, but it may reduce
    // it to a vague apology in the chat. Keep a bounded server-side record
    // so a failed connected-tool request can be diagnosed without logging
    // arguments (which may contain user or repository content).
    console.error(`[mcp] tool "${name}" failed: ${error.slice(0, 500)}`);
    throw new Error(error);
  }
  return text.length > 0 ? text : result;
}

// github-mcp-server's issue_write schema has ordinary top-level fields
// (title, body, labels, etc.) plus issue_fields for *custom* GitHub Issue
// fields. Smaller models occasionally treat the latter as a generic field
// bag and send `{ issue_fields: [{ field_name: "title", value: "…" }] }`.
// GitHub then tries to resolve a custom field literally called "title" and
// rejects the call. Normalize only those well-known standard fields while
// preserving genuine custom-field entries untouched.
const STANDARD_ISSUE_FIELDS = new Set(["title", "body", "labels", "assignees", "milestone", "state", "state_reason"]);

export function normalizeGithubArguments(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name !== "issue_write" || !args.issue_fields) return args;
  const normalized = { ...args };
  const customFields: unknown[] = [];
  const copyStandardField = (field: string, value: unknown) => {
    if (STANDARD_ISSUE_FIELDS.has(field) && normalized[field] === undefined && value !== undefined) normalized[field] = value;
    else customFields.push({ field_name: field, value });
  };

  if (Array.isArray(args.issue_fields)) {
    for (const entry of args.issue_fields) {
      if (!entry || typeof entry !== "object") { customFields.push(entry); continue; }
      const record = entry as Record<string, unknown>;
      const field = typeof record.field_name === "string" ? record.field_name : typeof record.name === "string" ? record.name : "";
      if (field) copyStandardField(field, record.value);
      else customFields.push(entry);
    }
  } else if (typeof args.issue_fields === "object") {
    for (const [field, value] of Object.entries(args.issue_fields as Record<string, unknown>)) copyStandardField(field, value);
  } else {
    return args;
  }

  if (customFields.length) normalized.issue_fields = customFields;
  else delete normalized.issue_fields;
  return normalized;
}
