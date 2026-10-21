import { describe, expect, it } from "vitest";
import { buildFigmaTools, figmaAuthHeaders, parseFigmaFileKey, parseFigmaTeamId, summarizeFigmaFile, verifyFigmaToken } from "../src/figma-tools.js";

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const next = responses.shift() ?? { body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { impl, calls };
}

const tool = (tools: ReturnType<typeof buildFigmaTools>, name: string) => {
  const found = tools.find((item) => item.definition.function.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
};

describe("figma-tools", () => {
  it("uses X-Figma-Token for personal tokens and Bearer for OAuth tokens", () => {
    expect(figmaAuthHeaders("figd_abc")).toEqual({ "X-Figma-Token": "figd_abc" });
    expect(figmaAuthHeaders("oauth-token")).toEqual({ authorization: "Bearer oauth-token" });
  });

  it("parses file keys from URLs and bare keys", () => {
    expect(parseFigmaFileKey("https://www.figma.com/design/AbC123xyz9/Calculator-%E2%80%93-Dark-Mode?node-id=0-1")).toBe("AbC123xyz9");
    expect(parseFigmaFileKey("https://www.figma.com/file/ZZZZZZZZZZ12/Old")).toBe("ZZZZZZZZZZ12");
    expect(parseFigmaFileKey("AbC123xyz9")).toBe("AbC123xyz9");
    expect(() => parseFigmaFileKey("")).toThrow(/required/);
    expect(() => parseFigmaFileKey("not a figma link")).toThrow(/does not look like/);
  });

  it("summarizes pages, frames and the text inside frames", () => {
    const summary = summarizeFigmaFile({
      name: "Calculator – Dark Mode",
      lastModified: "2026-10-19T20:00:00Z",
      document: {
        id: "0:0", name: "Document", type: "DOCUMENT",
        children: [{
          id: "0:1", name: "Page 1", type: "CANVAS",
          children: [
            { id: "1:2", name: "Calculator – Dark", type: "FRAME", children: [{ id: "1:3", name: "Display", type: "TEXT", characters: "0" }] },
            { id: "1:4", name: "Settings", type: "FRAME", children: [{ id: "1:5", name: "Group", type: "GROUP", children: [{ id: "1:6", name: "T", type: "TEXT", characters: "Theme: Light / Dark" }] }] },
          ],
        }],
      },
    });
    expect(summary.pages[0].frames).toEqual([
      { id: "1:2", name: "Calculator – Dark", type: "FRAME", texts: ["0"] },
      { id: "1:4", name: "Settings", type: "FRAME", texts: ["Theme: Light / Dark"] },
    ]);
  });

  it("reads a file and its comments with the stored token", async () => {
    const { impl, calls } = fakeFetch([
      { body: { name: "Calc", document: { id: "0:0", name: "Document", type: "DOCUMENT", children: [] } } },
      { body: { comments: [{ id: "c1", message: "Contrast too low", user: { handle: "hena" }, created_at: "2026-10-19", resolved_at: null, client_meta: { node_id: "1:2" } }] } },
    ]);
    const tools = buildFigmaTools("figd_token", impl);
    const file = await tool(tools, "figma_get_file").execute({ file: "https://www.figma.com/design/AbC123xyz9/Calc" });
    expect(file).toMatchObject({ fileKey: "AbC123xyz9", name: "Calc", pages: [] });
    expect(calls[0].url).toBe("https://api.figma.com/v1/files/AbC123xyz9?depth=4");
    expect((calls[0].init.headers as Record<string, string>)["X-Figma-Token"]).toBe("figd_token");
    const comments = await tool(tools, "figma_list_comments").execute({ file: "AbC123xyz9" });
    expect(comments).toEqual({ fileKey: "AbC123xyz9", comments: [{ id: "c1", message: "Contrast too low", author: "hena", createdAt: "2026-10-19", resolved: false, replyTo: undefined, nodeId: "1:2" }] });
  });

  it("marks posting a comment as a write that needs approval, and posts it on a frame", async () => {
    const { impl, calls } = fakeFetch([{ body: { id: "c9", message: "Looks good", created_at: "2026-10-19" } }]);
    const post = tool(buildFigmaTools("figd_token", impl), "figma_post_comment");
    const readTools = buildFigmaTools("figd_token", impl).filter((item) => item.definition.function.name !== "figma_post_comment");
    expect(post.mutates).toBe(true);
    expect(readTools.every((item) => !item.mutates)).toBe(true);
    expect(post.preview?.({ file: "AbC123xyz9", message: "Looks good", node_id: "1:2" })).toContain("On frame: 1:2");
    await post.execute({ file: "AbC123xyz9", message: "Looks good", node_id: "1:2" });
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ message: "Looks good", client_meta: { node_id: "1:2", node_offset: { x: 0, y: 0 } } });
  });

  it("turns Figma errors into clear messages", async () => {
    const { impl } = fakeFetch([{ status: 403, body: { status: 403, err: "Invalid token" } }]);
    await expect(verifyFigmaToken("figd_bad", impl)).rejects.toThrow(/refused access: Invalid token/);
    const notFound = fakeFetch([{ status: 404, body: { status: 404, err: "Not found" } }]);
    await expect(tool(buildFigmaTools("figd_token", notFound.impl), "figma_get_file").execute({ file: "AbC123xyz9" })).rejects.toThrow(/could not find that file/);
  });

  it("parses team links and numeric team ids", () => {
    expect(parseFigmaTeamId("https://www.figma.com/files/team/1234567890123/project/55/Calc?fuid=1")).toBe("1234567890123");
    expect(parseFigmaTeamId("1234567890123")).toBe("1234567890123");
    expect(() => parseFigmaTeamId("my team")).toThrow(/does not look like/);
  });

  it("finds files by name across the team's folders (and one level of subfolders)", async () => {
    const { impl, calls } = fakeFetch([
      { body: { name: "Hena's team", folders: [{ id: 11, name: "Calculator" }, { id: 12, name: "Website" }] } },
      { body: { folders: [{ id: 21, name: "Archive" }] } },
      { body: { folders: [] } },
      { body: { files: [{ key: "AbC123xyz9", name: "Calculator – Dark Mode", last_modified: "2026-10-19" }, { key: "Zz", name: "Icons" }] } },
      { body: { files: [{ key: "Yy", name: "Landing page" }] } },
      { body: { files: [{ key: "Old", name: "Dark mode v0" }] } },
    ]);
    const result = await tool(buildFigmaTools("figd_token", impl, "999"), "figma_find_files").execute({ name: "dark mode" });
    expect(result).toMatchObject({
      teamId: "999",
      teamName: "Hena's team",
      matches: [
        { key: "AbC123xyz9", name: "Calculator – Dark Mode", project: "Calculator", url: "https://www.figma.com/design/AbC123xyz9" },
        { key: "Old", name: "Dark mode v0", project: "Calculator / Archive" },
      ],
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.figma.com/v2/teams/999/folders",
      "https://api.figma.com/v2/folders/11/folders",
      "https://api.figma.com/v2/folders/12/folders",
      "https://api.figma.com/v2/folders/11/files",
      "https://api.figma.com/v2/folders/12/files",
      "https://api.figma.com/v2/folders/21/files",
    ]);
  });

  it("lists folders and a folder's files", async () => {
    const { impl } = fakeFetch([
      { body: { name: "Team", folders: [{ id: 11, name: "Calculator" }] } },
      { body: { files: [{ key: "AbC123xyz9", name: "Calculator – Dark Mode" }] } },
    ]);
    const tools = buildFigmaTools("figd_token", impl, "999");
    expect(await tool(tools, "figma_list_projects").execute({})).toEqual({ teamId: "999", teamName: "Team", projects: [{ id: "11", name: "Calculator" }] });
    expect(await tool(tools, "figma_list_files").execute({ project_id: 11 })).toEqual({ projectId: "11", files: [{ key: "AbC123xyz9", name: "Calculator – Dark Mode", lastModified: undefined, url: "https://www.figma.com/design/AbC123xyz9" }] });
  });

  it("falls back to the older projects endpoints when the folders endpoints are unavailable", async () => {
    const { impl, calls } = fakeFetch([
      { status: 404, body: { status: 404, err: "Not found" } },
      { body: { name: "Team", projects: [{ id: 11, name: "Calculator" }] } },
    ]);
    expect(await tool(buildFigmaTools("figd_token", impl, "999"), "figma_list_projects").execute({})).toEqual({ teamId: "999", teamName: "Team", projects: [{ id: "11", name: "Calculator" }] });
    expect(calls.map((call) => call.url)).toEqual(["https://api.figma.com/v2/teams/999/folders", "https://api.figma.com/v1/teams/999/projects"]);
  });

  it("explains what to do when no team is set or Figma refuses team listing", async () => {
    const noTeam = buildFigmaTools("figd_token", fakeFetch([]).impl);
    await expect(tool(noTeam, "figma_find_files").execute({ name: "dark" })).rejects.toThrow(/No Figma team is set/);
    const refused = buildFigmaTools("oauth-token", fakeFetch([{ status: 403, body: { status: 403, err: "Invalid scope" } }, { status: 403, body: { status: 403, err: "Invalid scope" } }]).impl, "999");
    await expect(tool(refused, "figma_list_projects").execute({})).rejects.toThrow(/needs the "folders:read" scope/);
  });
});

