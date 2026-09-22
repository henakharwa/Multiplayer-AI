import type { ToolExecutor } from "./tools.js";

// Notion's OAuth flow grants a REST API token. Unlike Linear's hosted MCP
// server, it does not give an application a per-user MCP endpoint to connect
// to, so keep this adapter local and use the token directly.
const NOTION_API = "https://api.notion.com/v1";
const headers = (token: string, contentType = false): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  "Notion-Version": "2026-03-11",
  ...(contentType ? { "content-type": "application/json" } : {}),
});

async function notion(token: string, path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${NOTION_API}${path}`, {
    ...init,
    headers: { ...headers(token, Boolean(init?.body)), ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((body as { message?: string }).message ?? `Notion request failed (${response.status})`);
  return body;
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}

export function buildNotionTools(token: string): ToolExecutor[] {
  return [
    {
      definition: { type: "function", function: { name: "notion_search", description: "Search the connected Notion pages and data sources that were shared with this integration.", parameters: { type: "object", properties: { query: { type: "string", description: "Words to search for." } }, required: ["query"] } } },
      execute: (args) => notion(token, "/search", { method: "POST", body: JSON.stringify({ query: stringArg(args, "query"), page_size: 20 }) }),
    },
    {
      definition: { type: "function", function: { name: "notion_get_page", description: "Read a Notion page's properties and metadata by its page ID.", parameters: { type: "object", properties: { page_id: { type: "string", description: "The Notion page ID." } }, required: ["page_id"] } } },
      execute: (args) => notion(token, `/pages/${encodeURIComponent(stringArg(args, "page_id"))}`),
    },
    {
      definition: { type: "function", function: { name: "notion_create_page", description: "Create a page in a shared Notion parent page or data source.", parameters: { type: "object", properties: { parent: { type: "object", description: "Notion parent object, such as { page_id: \"...\" } or { data_source_id: \"...\" }." }, properties: { type: "object", description: "Page properties using Notion's API format." }, children: { type: "array", description: "Optional Notion block children using Notion's API format." } }, required: ["parent", "properties"] } } },
      mutates: true,
      describe: () => "Create a page in Notion",
      preview: (args) => JSON.stringify(args, null, 2),
      execute: (args) => notion(token, "/pages", { method: "POST", body: JSON.stringify(args) }),
    },
    {
      definition: { type: "function", function: { name: "notion_update_page", description: "Update properties or archive status of a shared Notion page.", parameters: { type: "object", properties: { page_id: { type: "string", description: "The Notion page ID." }, properties: { type: "object", description: "Properties to update using Notion's API format." }, archived: { type: "boolean", description: "Whether to archive the page." } }, required: ["page_id"] } } },
      mutates: true,
      describe: (args) => `Update Notion page ${typeof args.page_id === "string" ? args.page_id : ""}`,
      preview: (args) => JSON.stringify(args, null, 2),
      execute: (args) => {
        const { page_id, ...patch } = args;
        return notion(token, `/pages/${encodeURIComponent(stringArg({ page_id }, "page_id"))}`, { method: "PATCH", body: JSON.stringify(patch) });
      },
    },
  ];
}
