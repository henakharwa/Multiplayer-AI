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
  const response = await fetchImpl(`${FIGMA_API}${path}`, {
    ...init,
    headers: { ...figmaAuthHeaders(token), ...(init.body ? { "content-type": "application/json" } : {}), ...((init.headers as Record<string, string>) ?? {}) },
    signal: init.signal ?? AbortSignal.timeout(20_000),
  });
  const body = (await response.json().catch(() => ({}))) as { err?: string; message?: string; status?: number };
  if (!response.ok) {
    const detail = body.err ?? body.message;
    if (response.status === 403 || response.status === 401) throw new Error(`Figma refused access${detail ? `: ${detail}` : ""}. Check the token and that it can open this file.`);
    if (response.status === 404) throw new Error("Figma could not find that file. Check the file link or key.");
    if (response.status === 429) throw new Error("Figma rate limit reached. Try again in a minute.");
    throw new Error(detail ? `Figma request failed: ${detail}` : `Figma request failed (HTTP ${response.status}).`);
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

export function buildFigmaTools(token: string, fetchImpl: FetchLike = fetch): ToolExecutor[] {
  const request = (path: string, init?: RequestInit) => figmaRequest(token, path, init, fetchImpl);
  const fileParam = { type: "string", description: "The Figma file URL (figma.com/design/...) or its file key." };
  return [
    {
      definition: {
        type: "function",
        function: {
          name: "figma_get_file",
          description: "Read a Figma file: its name, last modified time, pages, top-level frames, and the text inside each frame. Ask the user for the file link if you do not have one.",
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
