import { describe, expect, it } from "vitest";
import { blockToText, buildNotionTools, parseNotionId, propertiesToValues } from "../src/notion-tools.js";

type Call = { url: string; init: RequestInit };

function fakeFetch(handler: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const { status = 200, body } = handler(String(url), init);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

const text = (content: string) => [{ plain_text: content }];
const tool = (tools: ReturnType<typeof buildNotionTools>, name: string) => {
  const found = tools.find((item) => item.definition.function.name === name);
  if (!found) throw new Error(`missing ${name}`);
  return found;
};

describe("notion-tools", () => {
  it("parses ids from Notion URLs and dashed ids", () => {
    expect(parseNotionId("https://app.notion.com/p/Dark-Mode-Spec-3feae77ea677802cae07e557cb3caca1")).toBe("3feae77ea677802cae07e557cb3caca1");
    expect(parseNotionId("3feae77e-a677-802c-ae07-e557cb3caca1")).toBe("3feae77ea677802cae07e557cb3caca1");
  });

  it("reads a page's text, including nested list items, but not subpages", async () => {
    const { impl, calls } = fakeFetch((url) => {
      if (url.includes("/blocks/page1/children")) {
        return { body: { has_more: false, results: [
          { id: "b1", type: "paragraph", paragraph: { rich_text: text("Goal: ship dark theme by Nov 15.") } },
          { id: "b2", type: "paragraph", paragraph: { rich_text: text("Open question: should the display use a separate dark palette?") } },
          { id: "b3", type: "bulleted_list_item", has_children: true, bulleted_list_item: { rich_text: text("Owner: Hena") } },
          { id: "b4", type: "child_page", has_children: true, child_page: { title: "Team Decisions" } },
        ] } };
      }
      if (url.includes("/blocks/b3/children")) return { body: { has_more: false, results: [{ id: "b5", type: "to_do", to_do: { rich_text: text("Pick palette"), checked: false } }] } };
      throw new Error(`unexpected ${url}`);
    });
    const result = (await tool(buildNotionTools("ntn_x", impl), "notion_get_page_content").execute({ page_id: "page1" })) as { content: string };
    expect(result.content).toBe([
      "Goal: ship dark theme by Nov 15.",
      "Open question: should the display use a separate dark palette?",
      "- Owner: Hena",
      "  - [ ] Pick palette",
      "[Subpage] Team Decisions",
    ].join("\n"));
    expect(calls.some((call) => call.url.includes("/blocks/b4/children"))).toBe(false);
  });

  it("lists database rows as plain values, resolving a database id to its data source", async () => {
    const { impl, calls } = fakeFetch((url) => {
      if (url.endsWith("/data_sources/db1/query")) return { status: 404, body: { message: "Could not find data source" } };
      if (url.endsWith("/databases/db1")) return { body: { data_sources: [{ id: "ds1" }] } };
      if (url.endsWith("/data_sources/ds1/query")) {
        return { body: { has_more: false, results: [{ id: "r1", url: "https://notion.so/r1", properties: {
          Name: { type: "title", title: text("Dark mode") },
          Status: { type: "status", status: { name: "In progress" } },
          Quarter: { type: "select", select: { name: "Q4 2026" } },
          Owner: { type: "people", people: [{ name: "Hena" }] },
        } }] } };
      }
      throw new Error(`unexpected ${url}`);
    });
    const result = await tool(buildNotionTools("ntn_x", impl), "notion_query_database").execute({ database_id: "db1" });
    expect(result).toEqual({ dataSourceId: "ds1", hasMore: false, rows: [{ id: "r1", url: "https://notion.so/r1", Name: "Dark mode", Status: "In progress", Quarter: "Q4 2026", Owner: ["Hena"] }] });
    expect(calls.map((call) => call.init.method ?? "GET")).toEqual(["POST", "GET", "POST"]);
  });

  it("adding text to a page is a write that needs approval", async () => {
    const { impl, calls } = fakeFetch(() => ({ body: { results: [] } }));
    const append = tool(buildNotionTools("ntn_x", impl), "notion_append_text");
    expect(append.mutates).toBe(true);
    await append.execute({ page_id: "page1", text: "Step 6 testing in progress\n\nSecond line" });
    expect(calls[0].init.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0].init.body)).children).toHaveLength(2);
    const reads = buildNotionTools("ntn_x", impl).filter((item) => ["notion_search", "notion_get_page", "notion_get_page_content", "notion_query_database"].includes(item.definition.function.name));
    expect(reads.every((item) => !item.mutates)).toBe(true);
  });

  it("formats common block and property types", () => {
    expect(blockToText({ id: "h", type: "heading_2", heading_2: { rich_text: text("Status") } })).toBe("## Status");
    expect(blockToText({ id: "d", type: "divider", divider: {} })).toBe("---");
    expect(blockToText({ id: "e", type: "paragraph", paragraph: { rich_text: [] } })).toBeNull();
    expect(propertiesToValues({ Done: { type: "checkbox", checkbox: true }, Score: { type: "formula", formula: { type: "number", number: 3 } } })).toEqual({ Done: true, Score: 3 });
  });
});
