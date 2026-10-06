// Workspace memory entries.
import * as db from "@mai-chat/db";
import { errMessage, paramString } from "../http-utils.js";
import { parseWorkspaceMemoryInput } from "../input-parsers.js";
import type { Request, Response } from "express";
import type { RouteContext } from "./context.js";

export function registerMemoryRoutes({ app, requireRole }: RouteContext): void {
  async function canManageMemory(req: Request, memoryId: string) {
    const workspaceId = paramString(req.params.id);
    const memory = await db.getWorkspaceMemory(workspaceId, memoryId);
    if (!memory) return { memory: null, allowed: false };
    // Memory is a shared capability: Admins and Editors can view, create,
    // edit, and manage every workspace memory entry.
    const role = await db.getWorkspaceRole(workspaceId, req.user!.id);
    return { memory, allowed: role === "admin" || role === "editor" };
  }
  app.get("/workspaces/:id/memory", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    res.json(await db.listWorkspaceMemory(paramString(req.params.id)));
  });
  app.post("/workspaces/:id/memory", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    let input;
    try { input = parseWorkspaceMemoryInput(req.body ?? {}); } catch (error) { return res.status(400).json({ error: errMessage(error) }); }
    if (!input.title.trim() || !input.content.trim()) return res.status(400).json({ error: "A memory title and content are required." });
    if (input.title.length > 200 || input.content.length > 20_000) return res.status(400).json({ error: "Memory titles can be up to 200 characters and content up to 20,000." });
    const memory = await db.createWorkspaceMemory({ workspaceId: paramString(req.params.id), ...input, createdByUserId: req.user!.id });
    await db.recordAuditEvent({ workspaceId: memory.workspaceId, eventType: "memory.created", actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} saved ${memory.kind} memory ${memory.title}` });
    res.status(201).json(memory);
  });
  app.patch("/workspaces/:id/memory/:memoryId", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const access = await canManageMemory(req, paramString(req.params.memoryId));
    if (!access.memory) return res.status(404).json({ error: "Memory not found." });
    if (!access.allowed) return res.status(403).json({ error: "Only workspace members can edit this entry." });
    let input;
    try { input = parseWorkspaceMemoryInput(req.body ?? {}); } catch (error) { return res.status(400).json({ error: errMessage(error) }); }
    if (!input.title.trim() || !input.content.trim()) return res.status(400).json({ error: "A memory title and content are required." });
    if (input.title.length > 200 || input.content.length > 20_000) return res.status(400).json({ error: "Memory titles can be up to 200 characters and content up to 20,000." });
    const memory = await db.updateWorkspaceMemory(paramString(req.params.id), paramString(req.params.memoryId), input);
    if (!memory) return res.status(404).json({ error: "Memory not found." });
    await db.recordAuditEvent({ workspaceId: memory.workspaceId, eventType: "memory.updated", actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} updated memory ${memory.title}` });
    res.json(memory);
  });
  app.delete("/workspaces/:id/memory/:memoryId", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const access = await canManageMemory(req, paramString(req.params.memoryId));
    if (!access.memory) return res.status(404).json({ error: "Memory not found." });
    if (!access.allowed) return res.status(403).json({ error: "Only workspace members can delete this entry." });
    const memory = await db.deleteWorkspaceMemory(paramString(req.params.id), paramString(req.params.memoryId));
    if (!memory) return res.status(404).json({ error: "Memory not found." });
    await db.recordAuditEvent({ workspaceId: memory.workspaceId, eventType: "memory.deleted", actorType: "user", actorUserId: req.user!.id, actorName: req.user!.displayName, summary: `${req.user!.displayName} deleted memory ${memory.title}` });
    res.status(204).end();
  });
}
