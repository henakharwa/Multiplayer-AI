import type { ToolExecutor } from "./tools.js";

// Figma's hosted MCP server (mcp.figma.com) only accepts tokens minted by its
// own OAuth flow for approved clients -- a personal access token gets a 401.
// Figma's REST API accepts both personal access tokens and OAuth tokens, so,
// like the Notion adapter, these tools call the REST API directly with the
// stored token instead of going through a remote MCP server.
export const FIGMA_API = "https://api.figma.com/v1";

type FetchLike = typeof fetch;

/** Personal access tokens use X-Figma-Token; OAuth access tokens use Bearer. */
export function figmaAuthHeaders(token: string): Record<string, string> {
  return token.startsWith("figd_") ? { "X-Figma-Token": token } : { authorization: `Bearer ${token}` };
}

export async function figmaRequest(token: string, path: string, init: RequestInit = {}, fetchImpl: FetchLike = fetch): Promise<unknown> {
  // Paths are relative to /v1 unless they name another API version.
  const url = path.startsWith("/v2/") ? `https://api.figma.com${path}` : `${FIGMA_API}${path}`;
  const response = await fetchImpl(url, {
    ...init,
    headers: { ...figmaAuthHeaders(token), ...(init.body ? { "content-type": "application/json" } : {}), ...((init.headers as Record<string, string>) ?? {}) },
    signal: init.signal ?? AbortSignal.timeout(20_000),
  });
  const body = (await response.json().catch(() => ({}))) as { err?: string; message?: string; status?: number };
  if (!response.ok) {
    const detail = body.err ?? body.message;
    const fail = (message: string): never => {
      throw Object.assign(new Error(message), { status: response.status });
    };
    if (response.status === 403 || response.status === 401) fail(`Figma refused access${detail ? `: ${detail}` : ""}. Check the token and that it can open this file.`);
    if (response.status === 404) fail("Figma could not find that file. Check the file link or key.");
    if (response.status === 429) fail("Figma rate limit reached. Try again in a minute.");
    fail(detail ? `Figma request failed: ${detail}` : `Figma request failed (HTTP ${response.status}).`);
  }
  return body;
}

/** Accepts a bare file key or any figma.com file/design/board/proto URL. */
export function parseFigmaFileKey(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("file is required: pass a Figma file URL or file key.");
  const input = value.trim();
  const match = input.match(/figma\.com\/(?:file|design|board|proto|slides|deck)\/([A-Za-z0-9]+)/);
  if (match) return match[1];
  if (/^[A-Za-z0-9]{10,}$/.test(input)) return input;
  throw new Error("That does not look like a Figma file URL or file key.");
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value.trim();
}

interface FigmaNode { id: string; name: string; type: string; characters?: string; children?: FigmaNode[] }

const MAX_TEXTS_PER_FRAME = 40;
const MAX_TEXT_LENGTH = 300;

function collectTexts(node: FigmaNode, out: string[]): void {
  if (out.length >= MAX_TEXTS_PER_FRAME) return;
  if (node.type === "TEXT" && typeof node.characters === "string" && node.characters.trim()) {
    out.push(node.characters.trim().slice(0, MAX_TEXT_LENGTH));
  }
  for (const child of node.children ?? []) collectTexts(child, out);
}

/** Compact view of a file: pages, their top-level frames, and the text inside each. */
export function summarizeFigmaFile(file: { name?: string; lastModified?: string; editorType?: string; document?: FigmaNode }) {
  const pages = (file.document?.children ?? []).map((page) => ({
    id: page.id,
    name: page.name,
    frames: (page.children ?? []).map((frame) => {
      const texts: string[] = [];
      collectTexts(frame, texts);
      return { id: frame.id, name: frame.name, type: frame.type, texts };
    }),
  }));
  return { name: file.name, lastModified: file.lastModified, editorType: file.editorType, pages };
}

interface FigmaComment {
  id: string;
  message?: string;
  created_at?: string;
  resolved_at?: string | null;
  parent_id?: string;
  user?: { handle?: string };
  client_meta?: { node_id?: string } | null;
}

/** Accepts a team ID or a figma.com/files/team/<id>/... link. */
export function parseFigmaTeamId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("A Figma team link or team ID is required.");
  const input = value.trim();
  const match = input.match(/\/team\/(\d+)/) ?? input.match(/^(\d{5,})$/);
  if (!match) throw new Error("That does not look like a Figma team link (figma.com/files/team/<id>/...) or a numeric team ID.");
  return match[1];
}

interface FigmaFolder { id: string | number; name?: string }
interface FigmaProjectFile { key: string; name: string; last_modified?: string }
type Listed<T> = T[];

// Figma's folders endpoints (folders:read, the scope new personal access
// tokens offer) replace the deprecated projects endpoints (projects:read,
// no longer offered for new tokens). Their response fields are not yet
// documented, so accept the list under any of the likely keys.
function pickList<T>(body: unknown, keys: string[]): Listed<T> {
  if (Array.isArray(body)) return body as T[];
  for (const key of keys) {
    const value = (body as Record<string, unknown> | null)?.[key];
    if (Array.isArray(value)) return value as T[];
  }
  return [];
}

const isAccessOrMissing = (error: unknown) => [400, 401, 403, 404].includes((error as { status?: number }).status ?? 0);

/** Tries the folders endpoint first, then the deprecated projects endpoint. */
async function foldersThenProjects<T>(primary: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
  try {
    return await primary();
  } catch (error) {
    if (!isAccessOrMissing(error)) throw error;
    try {
      return await fallback();
    } catch (fallbackError) {
      if (isAccessOrMissing(fallbackError)) {
        throw Object.assign(
          new Error('Figma refused to list this team\'s folders. The Figma connection needs the "folders:read" scope (enable it in the Figma app\'s OAuth settings, then reconnect Figma), and the team link must be one you can open. Files can still be opened by pasting their link.'),
          { status: (fallbackError as { status?: number }).status },
        );
      }
      throw fallbackError;
    }
  }
}

const toFolder = (folder: FigmaFolder) => ({ id: String(folder.id), name: folder.name ?? String(folder.id) });

/** Lists a team's top-level folders (projects); also proves the token can see that team. */
export async function listFigmaTeamProjects(token: string, teamId: string, fetchImpl: FetchLike = fetch): Promise<{ teamName?: string; projects: { id: string; name: string }[] }> {
  const team = encodeURIComponent(teamId);
  return foldersThenProjects(
    async () => {
      const body = (await figmaRequest(token, `/v2/teams/${team}/folders`, {}, fetchImpl)) as { name?: string; team?: { name?: string } };
      return { teamName: body.name ?? body.team?.name, projects: pickList<FigmaFolder>(body, ["folders", "projects", "results"]).map(toFolder) };
    },
    async () => {
      const body = (await figmaRequest(token, `/teams/${team}/projects`, {}, fetchImpl)) as { name?: string };
      return { teamName: body.name, projects: pickList<FigmaFolder>(body, ["projects", "folders"]).map(toFolder) };
    },
  );
}

const fileLink = (key: string) => `https://www.figma.com/design/${key}`;

async function listFolderFiles(token: string, folderId: string, fetchImpl: FetchLike) {
  const folder = encodeURIComponent(folderId);
  const files = await foldersThenProjects(
    async () => pickList<FigmaProjectFile>(await figmaRequest(token, `/v2/folders/${folder}/files`, {}, fetchImpl), ["files", "results"]),
    async () => pickList<FigmaProjectFile>(await figmaRequest(token, `/projects/${folder}/files`, {}, fetchImpl), ["files"]),
  );
  return files.map((file) => ({ key: file.key, name: file.name, lastModified: file.last_modified, url: fileLink(file.key) }));
}

/** Direct subfolders (plans with nested folders); empty where unsupported. */
async function listSubfolders(token: string, folderId: string, fetchImpl: FetchLike) {
  try {
    return pickList<FigmaFolder>(await figmaRequest(token, `/v2/folders/${encodeURIComponent(folderId)}/folders`, {}, fetchImpl), ["folders", "subfolders", "results"]).map(toFolder);
  } catch {
    return [];
  }
}

const MAX_PROJECTS_SCANNED = 25;

export function buildFigmaTools(token: string, fetchImpl: FetchLike = fetch, teamId?: string): ToolExecutor[] {
  const request = (path: string, init?: RequestInit) => figmaRequest(token, path, init, fetchImpl);
  const fileParam = { type: "string", description: "The Figma file URL (figma.com/design/...) or its file key." };
  const teamFor = (args: Record<string, unknown>) => {
    if (args.team !== undefined && args.team !== "") return parseFigmaTeamId(args.team);
    if (teamId) return teamId;
    throw new Error("No Figma team is set for this connection. Set one in Integrations → Figma → Team, or paste the file link (files in Drafts can only be opened by link).");
  };
  const listFiles = (projectId: string) => listFolderFiles(token, projectId, fetchImpl);
  const teamParam = { type: "string", description: "Optional Figma team link or ID. Leave empty to use the team set for this connection." };
  return [
    {
      definition: {
        type: "function",
        function: {
          name: "figma_list_projects",
          description: "List the projects (top-level folders) in the connected Figma team. Use figma_list_files to see a project's files, or figma_find_files to look a file up by name.",
          parameters: { type: "object", properties: { team: teamParam } },
        },
      },
      execute: async (args) => {
        const team = teamFor(args);
        return { teamId: team, ...(await listFigmaTeamProjects(token, team, fetchImpl)) };
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "figma_list_files",
          description: "List the design files in one Figma project or folder, with each file's name, link and last modified time.",
          parameters: { type: "object", properties: { project_id: { type: "string", description: "The project or folder id from figma_list_projects." } }, required: ["project_id"] },
        },
      },
      execute: async (args) => {
        const projectId = typeof args.project_id === "string" || typeof args.project_id === "number" ? String(args.project_id).trim() : "";
        if (!projectId) throw new Error("project_id is required");
        return { projectId, files: await listFiles(projectId) };
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "figma_find_files",
          description: "Find Figma files by name across all projects in the connected Figma team. Use this when the user names a file instead of pasting its link; pass the returned link to figma_get_file or figma_list_comments.",
          parameters: { type: "object", properties: { name: { type: "string", description: "Part of the file name, e.g. \"dark mode\"." }, team: teamParam }, required: ["name"] },
        },
      },
      execute: async (args) => {
        const query = typeof args.name === "string" ? args.name.trim().toLowerCase() : "";
        if (!query) throw new Error("name is required");
        const team = teamFor(args);
        const { teamName, projects: topLevel } = await listFigmaTeamProjects(token, team, fetchImpl);
        const words = query.split(/[^a-z0-9]+/).filter(Boolean);
        const matches: Array<{ key: string; name: string; lastModified?: string; url: string; project: string }> = [];
        // Include one level of subfolders where the plan has nested folders.
        const projects = [...topLevel];
        for (const folder of topLevel.slice(0, MAX_PROJECTS_SCANNED)) {
          if (projects.length >= MAX_PROJECTS_SCANNED) break;
          for (const sub of await listSubfolders(token, folder.id, fetchImpl)) projects.push({ id: sub.id, name: `${folder.name} / ${sub.name}` });
        }
        for (const project of projects.slice(0, MAX_PROJECTS_SCANNED)) {
          for (const file of await listFiles(project.id)) {
            const name = file.name.toLowerCase();
            if (name.includes(query) || (words.length > 0 && words.every((word) => name.includes(word)))) matches.push({ ...file, project: project.name });
          }
        }
        return { teamId: team, teamName, matches, projectsScanned: Math.min(projects.length, MAX_PROJECTS_SCANNED), note: "Files in personal Drafts are not part of a team and cannot be found this way." };
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "figma_get_file",
          description: "Read a Figma file: its name, last modified time, pages, top-level frames, and the text inside each frame. If you only know the file's name, find its link with figma_find_files first; ask for the link only if that finds nothing.",
          parameters: { type: "object", properties: { file: fileParam }, required: ["file"] },
        },
      },
      execute: async (args) => {
        const key = parseFigmaFileKey(args.file);
        const file = (await request(`/files/${encodeURIComponent(key)}?depth=4`)) as Parameters<typeof summarizeFigmaFile>[0];
        return { fileKey: key, ...summarizeFigmaFile(file) };
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "figma_list_comments",
          description: "List the comments on a Figma file, including who wrote them, when, whether they are resolved, and which frame (node_id) they are attached to.",
          parameters: { type: "object", properties: { file: fileParam }, required: ["file"] },
        },
      },
      execute: async (args) => {
        const key = parseFigmaFileKey(args.file);
        const body = (await request(`/files/${encodeURIComponent(key)}/comments`)) as { comments?: FigmaComment[] };
        return {
          fileKey: key,
          comments: (body.comments ?? []).map((comment) => ({
            id: comment.id,
            message: comment.message,
            author: comment.user?.handle,
            createdAt: comment.created_at,
            resolved: Boolean(comment.resolved_at),
            replyTo: comment.parent_id || undefined,
            nodeId: comment.client_meta?.node_id,
          })),
        };
      },
    },
    {
      definition: {
        type: "function",
        function: {
          name: "figma_post_comment",
          description: "Post a comment on a Figma file. Optionally attach it to a frame (node_id from figma_get_file) or reply to an existing comment (comment_id from figma_list_comments).",
          parameters: {
            type: "object",
            properties: {
              file: fileParam,
              message: { type: "string", description: "The comment text." },
              node_id: { type: "string", description: "Optional frame or node id to attach the comment to." },
              comment_id: { type: "string", description: "Optional id of a comment to reply to." },
            },
            required: ["file", "message"],
          },
        },
      },
      mutates: true,
      describe: (args) => `Post a comment on Figma file ${typeof args.file === "string" ? args.file : ""}`.trim(),
      preview: (args) => {
        const lines = [`Comment: ${typeof args.message === "string" ? args.message : ""}`];
        if (typeof args.node_id === "string" && args.node_id) lines.push(`On frame: ${args.node_id}`);
        if (typeof args.comment_id === "string" && args.comment_id) lines.push(`Reply to comment: ${args.comment_id}`);
        return lines.join("\n");
      },
      execute: async (args) => {
        const key = parseFigmaFileKey(args.file);
        const payload: Record<string, unknown> = { message: stringArg(args, "message") };
        if (typeof args.comment_id === "string" && args.comment_id.trim()) payload.comment_id = args.comment_id.trim();
        else if (typeof args.node_id === "string" && args.node_id.trim()) payload.client_meta = { node_id: args.node_id.trim(), node_offset: { x: 0, y: 0 } };
        const comment = (await request(`/files/${encodeURIComponent(key)}/comments`, { method: "POST", body: JSON.stringify(payload) })) as FigmaComment;
        return { id: comment.id, message: comment.message, createdAt: comment.created_at };
      },
    },
  ];
}

/** Cheap read-only check of a stored token; returns the account handle. */
export async function verifyFigmaToken(token: string, fetchImpl: FetchLike = fetch): Promise<{ handle?: string; email?: string }> {
  return (await figmaRequest(token, "/me", { signal: AbortSignal.timeout(10_000) }, fetchImpl)) as { handle?: string; email?: string };
}
