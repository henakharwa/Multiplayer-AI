// Conversations, message history and the activity (audit) log.
import * as db from "@mai-chat/db";
import { UUID_RE, paramString } from "../http-utils.js";
import type { Request, Response } from "express";
import type { AuditEventType } from "@mai-chat/shared-types";
import type { RouteContext } from "./context.js";

export function registerConversationsRoutes({ app, requireRole }: RouteContext): void {
  app.get("/workspaces/:id/messages", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    if (!UUID_RE.test(paramString(req.params.id))) return res.status(400).json({ error: "invalid workspace id" });
    const workspace = await db.getWorkspaceById(paramString(req.params.id));
    if (!workspace) return res.status(404).json({ error: "not found" });
    const conversationId = typeof req.query.conversationId === "string" ? req.query.conversationId : "";
    if (!UUID_RE.test(conversationId) || !(await db.getConversation(paramString(req.params.id), conversationId))) {
      return res.status(400).json({ error: "valid conversationId is required" });
    }
    res.json(await db.listMessages(paramString(req.params.id), conversationId));
  });

  app.get("/workspaces/:id/conversations", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const workspaceId = paramString(req.params.id);
    if (!UUID_RE.test(workspaceId)) return res.status(400).json({ error: "invalid workspace id" });
    if (!(await db.getWorkspaceById(workspaceId))) return res.status(404).json({ error: "not found" });
    let conversations = await db.listConversations(workspaceId);
    if (conversations.length === 0) conversations = [await db.createConversation({ workspaceId, createdByUserId: req.user!.id })];
    res.json(conversations);
  });

  app.post("/workspaces/:id/conversations", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const workspaceId = paramString(req.params.id);
    if (!UUID_RE.test(workspaceId)) return res.status(400).json({ error: "invalid workspace id" });
    if (!(await db.getWorkspaceById(workspaceId))) return res.status(404).json({ error: "not found" });
    const title = typeof req.body?.title === "string" ? req.body.title : undefined;
    res.status(201).json(await db.createConversation({ workspaceId, title, createdByUserId: req.user!.id }));
  });

  app.patch("/workspaces/:id/conversations/:conversationId", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const workspaceId = paramString(req.params.id);
    const conversationId = paramString(req.params.conversationId);
    if (!UUID_RE.test(workspaceId) || !UUID_RE.test(conversationId)) return res.status(400).json({ error: "invalid conversation id" });
    const title = typeof req.body?.title === "string" ? req.body.title.trim() : null;
    const pinned = typeof req.body?.pinned === "boolean" ? req.body.pinned : null;
    const archived = typeof req.body?.archived === "boolean" ? req.body.archived : null;
    if (title !== null && (!title || title.length > 100)) return res.status(400).json({ error: "title must be between 1 and 100 characters" });
    let conversation = await db.getConversation(workspaceId, conversationId);
    if (!conversation) return res.status(404).json({ error: "conversation not found" });
    if (title !== null) conversation = await db.renameConversation(workspaceId, conversationId, title);
    if (pinned !== null) conversation = await db.setConversationPinned(workspaceId, conversationId, pinned);
    if (archived !== null) conversation = await db.setConversationArchived(workspaceId, conversationId, archived);
    res.json(conversation);
  });

  app.delete("/workspaces/:id/conversations/:conversationId", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const workspaceId = paramString(req.params.id);
    const conversationId = paramString(req.params.conversationId);
    if (!UUID_RE.test(workspaceId) || !UUID_RE.test(conversationId)) return res.status(400).json({ error: "invalid conversation id" });
    if (!(await db.getWorkspaceById(workspaceId))) return res.status(404).json({ error: "not found" });
    if (!(await db.deleteConversation(workspaceId, conversationId))) return res.status(404).json({ error: "conversation not found" });
    let conversations = await db.listConversations(workspaceId);
    // Keep every workspace immediately usable: deleting its final chat
    // creates one fresh blank conversation instead of leaving a dead view.
    if (conversations.length === 0) conversations = [await db.createConversation({ workspaceId, createdByUserId: req.user!.id })];
    res.json(conversations);
  });

  // Action audit trail (docs/spec.md Phase 2: "who asked for what, what
  // the agent did, when") -- see actions.ts / the WebSocket handlers
  // above for where these rows get written, and packages/db's
  // audit_events table for the storage shape. Filters mirror what the
  // Activity panel's search box + type dropdown send: `q` is a
  // case-insensitive substring match against actor name and summary,
  // `type` an exact AuditEventType, `before` an ISO timestamp for
  // "load older" pagination (keyset, not offset -- see listAuditEvents).
  app.get("/workspaces/:id/audit", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    if (!UUID_RE.test(paramString(req.params.id))) return res.status(400).json({ error: "invalid workspace id" });
    const workspaceId = paramString(req.params.id);
    const workspace = await db.getWorkspaceById(workspaceId);
    if (!workspace) return res.status(404).json({ error: "not found" });
    const eventType = typeof req.query.type === "string" && req.query.type ? (req.query.type as AuditEventType) : undefined;
    const search = typeof req.query.q === "string" && req.query.q.trim() ? req.query.q.trim() : undefined;
    const before = typeof req.query.before === "string" && req.query.before ? req.query.before : undefined;
    const limitParam = Number(req.query.limit);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined;
    const events = await db.listAuditEvents(workspaceId, { eventType, search, before, limit });
    res.json({ events, nextBefore: events.length > 0 ? events[events.length - 1].createdAt : null });
  });
}
