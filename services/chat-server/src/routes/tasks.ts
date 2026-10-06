// Workspace tasks.
import * as db from "@mai-chat/db";
import { UUID_RE, paramString } from "../http-utils.js";
import type { Request, Response } from "express";
import type { RouteContext } from "./context.js";

export function registerTasksRoutes({ app, requireRole }: RouteContext): void {
  const taskStatuses = ["todo", "in_progress", "review", "done"] as const;
  function taskInput(body: Record<string, unknown>) {
    const dueDate = typeof body.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.dueDate) ? body.dueDate : null;
    return { title: typeof body.title === "string" ? body.title : "", description: typeof body.description === "string" ? body.description : "", status: taskStatuses.includes(body.status as typeof taskStatuses[number]) ? body.status as typeof taskStatuses[number] : undefined, ownerUserId: typeof body.ownerUserId === "string" && UUID_RE.test(body.ownerUserId) ? body.ownerUserId : null, dueDate, sourceConversationId: typeof body.sourceConversationId === "string" && UUID_RE.test(body.sourceConversationId) ? body.sourceConversationId : null };
  }
  app.get("/workspaces/:id/tasks", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    res.json(await db.listWorkspaceTasks(paramString(req.params.id)));
  });
  app.post("/workspaces/:id/tasks", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const input = taskInput(req.body ?? {});
    if (!input.title.trim()) return res.status(400).json({ error: "A task title is required." });
    const task = await db.createWorkspaceTask({ workspaceId: paramString(req.params.id), ...input, createdByUserId: req.user!.id });
    res.status(201).json(task);
  });
  app.patch("/workspaces/:id/tasks/:taskId", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const input = taskInput(req.body ?? {});
    if (typeof req.body?.title === "string" && !input.title.trim()) return res.status(400).json({ error: "A task title is required." });
    const task = await db.updateWorkspaceTask(paramString(req.params.id), paramString(req.params.taskId), input);
    if (!task) return res.status(404).json({ error: "Task not found." });
    res.json(task);
  });
  app.delete("/workspaces/:id/tasks/:taskId", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const task = await db.deleteWorkspaceTask(paramString(req.params.id), paramString(req.params.taskId));
    if (!task) return res.status(404).json({ error: "Task not found." });
    res.status(204).end();
  });
}
