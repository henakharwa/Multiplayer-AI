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

type FetchLike = typeof fetch;

async function notion(token: string, path: string, init: RequestInit | undefined, fetchImpl: FetchLike): Promise<unknown> {
  const response = await fetchImpl(`${NOTION_API}${path}`, {
    ...init,
    headers: { ...headers(token, Boolean(init?.body)), ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error((body as { message?: string }).message ?? `Notion request failed (${response.status})`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return body;
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}

/** Accepts a bare Notion id (with or without dashes) or a notion.so / notion.com page URL. */
export function parseNotionId(value: string): string {
  const compact = value.trim().match(/([0-9a-f]{32})(?:[?#].*)?$/i) ?? value.replace(/-/g, "").match(/([0-9a-f]{32})/i);
  return compact ? compact[1] : value.trim();
}

type RichText = { plain_text?: string }[];
type NotionBlock = { id: string; type: string; has_children?: boolean; [key: string]: unknown };

const plain = (rich: unknown): string => (Array.isArray(rich) ? (rich as RichText).map((part) => part.plain_text ?? "").join("") : "");

/** One readable line per block, or null for blocks with no text worth showing. */
export function blockToText(block: NotionBlock): string | null {
  const data = (block[block.type] ?? {}) as { rich_text?: unknown; title?: string; checked?: boolean; language?: string; url?: string };
  const text = plain(data.rich_text);
  switch (block.type) {
    case "heading_1": return `# ${text}`;
    case "heading_2": return `## ${text}`;
    case "heading_3": return `### ${text}`;
    case "bulleted_list_item": return `- ${text}`;
    case "numbered_list_item": return `1. ${text}`;
    case "to_do": return `- [${data.checked ? "x" : " "}] ${text}`;
    case "quote": return `> ${text}`;
    case "callout": return `> ${text}`;
    case "code": return `\`\`\`${data.language ?? ""}\n${text}\n\`\`\``;
    case "child_page": return `[Subpage] ${data.title ?? ""}`;
    case "child_database": return `[Database] ${data.title ?? ""}`;
    case "bookmark":
    case "embed":
    case "link_preview": return data.url ? `[Link] ${data.url}` : null;
    case "divider": return "---";
    default: return text || null;
  }
}

const MAX_BLOCKS = 200;
const MAX_DEPTH = 2;

async function readBlocks(token: string, blockId: string, fetchImpl: FetchLike, depth: number, lines: string[], seen: { count: number }): Promise<void> {
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ page_size: "100" });
    if (cursor) query.set("start_cursor", cursor);
    const page = (await notion(token, `/blocks/${encodeURIComponent(blockId)}/children?${query}`, undefined, fetchImpl)) as { results?: NotionBlock[]; has_more?: boolean; next_cursor?: string | null };
    for (const block of page.results ?? []) {
      if (seen.count >= MAX_BLOCKS) return;
      seen.count++;
      const line = blockToText(block);
      if (line !== null) lines.push(`${"  ".repeat(depth)}${line}`);
      // Subpages and databases are separate documents; read them on request.
      if (block.has_children && depth < MAX_DEPTH && block.type !== "child_page" && block.type !== "child_database") {
        await readBlocks(token, block.id, fetchImpl, depth + 1, lines, seen);
      }
    }
    cursor = page.has_more ? page.next_cursor ?? undefined : undefined;
  } while (cursor && seen.count < MAX_BLOCKS);
}

/** Flattens a Notion page's properties into plain values ("Status": "In progress"). */
export function propertiesToValues(properties: Record<string, Record<string, unknown>> | undefined): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [name, property] of Object.entries(properties ?? {})) {
    const type = property.type as string;
    const value = property[type] as unknown;
    if (type === "title" || type === "rich_text") values[name] = plain(value);
    else if (type === "select" || type === "status") values[name] = (value as { name?: string } | null)?.name ?? null;
    else if (type === "multi_select") values[name] = Array.isArray(value) ? value.map((item: { name?: string }) => item.name) : [];
    else if (type === "people") values[name] = Array.isArray(value) ? value.map((person: { name?: string; id?: string }) => person.name ?? person.id) : [];
    else if (type === "date") values[name] = (value as { start?: string; end?: string | null } | null)?.start ?? null;
    else if (["number", "checkbox", "url", "email", "phone_number"].includes(type)) values[name] = value ?? null;
    else if (type === "formula" && value && typeof value === "object") {
      const formula = value as { type?: string; [key: string]: unknown };
      values[name] = formula.type ? formula[formula.type] ?? null : null;
    }
  }
  return values;
}

export function buildNotionTools(token: string, fetchImpl: FetchLike = fetch): ToolExecutor[] {
  const call = (path: string, init?: RequestInit) => notion(token, path, init, fetchImpl);
  return [
    {
      definition: { type: "function", function: { name: "notion_search", description: "Search the connected Notion pages and databases (data sources) that were shared with this integration. Returns titles, ids and URLs, not page text.", parameters: { type: "object", properties: { query: { type: "string", description: "Words to search for." } }, required: ["query"] } } },
      execute: (args) => call("/search", { method: "POST", body: JSON.stringify({ query: stringArg(args, "query"), page_size: 20 }) }),
    },
    {
      definition: { type: "function", function: { name: "notion_get_page", description: "Read a Notion page's properties and metadata by its page ID. Use notion_get_page_content for the text written on the page.", parameters: { type: "object", properties: { page_id: { type: "string", description: "The Notion page ID." } }, required: ["page_id"] } } },
      execute: (args) => call(`/pages/${encodeURIComponent(parseNotionId(stringArg(args, "page_id")))}`),
    },
    {
      definition: { type: "function", function: { name: "notion_get_page_content", description: "Read the text written on a Notion page (paragraphs, headings, lists, to-dos, quotes, code), by page ID or page URL. Use this to answer questions about what a page says.", parameters: { type: "object", properties: { page_id: { type: "string", description: "The Notion page ID or URL." } }, required: ["page_id"] } } },
      execute: async (args) => {
        const pageId = parseNotionId(stringArg(args, "page_id"));
        const lines: string[] = [];
        const seen = { count: 0 };
        await readBlocks(token, pageId, fetchImpl, 0, lines, seen);
        return { pageId, content: lines.join("\n") || "(This page has no text content.)", truncated: seen.count >= MAX_BLOCKS };
      },
    },
    {
      definition: { type: "function", function: { name: "notion_query_database", description: "List the rows (entries) of a Notion database / data source, with each row's property values such as Name, Status, Owner and dates. Pass the database or data source ID from notion_search.", parameters: { type: "object", properties: { database_id: { type: "string", description: "The Notion database or data source ID." } }, required: ["database_id"] } } },
      execute: async (args) => {
        const requested = parseNotionId(stringArg(args, "database_id"));
        const query = (id: string) => call(`/data_sources/${encodeURIComponent(id)}/query`, { method: "POST", body: JSON.stringify({ page_size: 50 }) }) as Promise<{ results?: { id: string; url?: string; properties?: Record<string, Record<string, unknown>> }[]; has_more?: boolean }>;
        let dataSourceId = requested;
        let result: Awaited<ReturnType<typeof query>>;
        try {
          result = await query(requested);
        } catch (error) {
          // A database id is not a data source id; resolve its first data source.
          if ((error as { status?: number }).status !== 404 && (error as { status?: number }).status !== 400) throw error;
          const database = (await call(`/databases/${encodeURIComponent(requested)}`)) as { data_sources?: { id: string }[] };
          const first = database.data_sources?.[0]?.id;
          if (!first) throw error;
          dataSourceId = first;
          result = await query(first);
        }
        return {
          dataSourceId,
          rows: (result.results ?? []).map((row) => ({ id: row.id, url: row.url, ...propertiesToValues(row.properties) })),
          hasMore: Boolean(result.has_more),
        };
      },
    },
    {
      definition: { type: "function", function: { name: "notion_create_page", description: "Create a page in a shared Notion parent page or data source.", parameters: { type: "object", properties: { parent: { type: "object", description: "Notion parent object, such as { page_id: \"...\" } or { data_source_id: \"...\" }." }, properties: { type: "object", description: "Page properties using Notion's API format." }, children: { type: "array", description: "Optional Notion block children using Notion's API format." } }, required: ["parent", "properties"] } } },
      mutates: true,
      describe: () => "Create a page in Notion",
      preview: (args) => JSON.stringify(args, null, 2),
      execute: (args) => call("/pages", { method: "POST", body: JSON.stringify(args) }),
    },
    {
      definition: { type: "function", function: { name: "notion_append_text", description: "Add paragraphs of text to the end of an existing Notion page.", parameters: { type: "object", properties: { page_id: { type: "string", description: "The Notion page ID or URL." }, text: { type: "string", description: "The text to add. Each line becomes its own paragraph." } }, required: ["page_id", "text"] } } },
      mutates: true,
      describe: (args) => `Add text to Notion page ${typeof args.page_id === "string" ? args.page_id : ""}`.trim(),
      preview: (args) => (typeof args.text === "string" ? args.text : ""),
      execute: (args) => {
        const pageId = parseNotionId(stringArg(args, "page_id"));
        const children = stringArg(args, "text")
          .split(/\r?\n/)
          .filter((line) => line.trim())
          .map((line) => ({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: line.slice(0, 2000) } }] } }));
        return call(`/blocks/${encodeURIComponent(pageId)}/children`, { method: "PATCH", body: JSON.stringify({ children }) });
      },
    },
    {
      definition: { type: "function", function: { name: "notion_update_page", description: "Update properties or archive status of a shared Notion page.", parameters: { type: "object", properties: { page_id: { type: "string", description: "The Notion page ID." }, properties: { type: "object", description: "Properties to update using Notion's API format." }, archived: { type: "boolean", description: "Whether to archive the page." } }, required: ["page_id"] } } },
      mutates: true,
      describe: (args) => `Update Notion page ${typeof args.page_id === "string" ? args.page_id : ""}`,
      preview: (args) => JSON.stringify(args, null, 2),
      execute: (args) => {
        const { page_id, ...patch } = args;
        return call(`/pages/${encodeURIComponent(parseNotionId(stringArg({ page_id }, "page_id")))}`, { method: "PATCH", body: JSON.stringify(patch) });
      },
    },
  ];
}
