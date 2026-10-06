// Workspace tasks.
import * as db from "@mai-chat/db";
import { UUID_RE, paramString } from "../http-utils.js";
import type { Request, Response } from "express";
import type { RouteContext } from "./context.js";

export function registerTasksRoutes({ app, requireRole }: RouteContext): void {
  const taskStatuses = ["todo", "in_progress", "review", "done"] as const;
  const TASK_TITLE_MAX = 200;
  // A real calendar day in YYYY-MM-DD form (rejects 2026-02-31).
  function isCalendarDate(value: unknown): value is string {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }
  // Reads only the fields the request sent, so a PATCH can change one field
  // or clear an owner / due date (null or "") without touching the rest.
  function taskInput(body: Record<string, unknown>) {
    const input: { title?: string; description?: string; status?: (typeof taskStatuses)[number]; ownerUserId?: string | null; dueDate?: string | null; sourceConversationId?: string | null } = {};
    if (typeof body.title === "string") input.title = body.title;
    if (typeof body.description === "string") input.description = body.description;
    if (taskStatuses.includes(body.status as (typeof taskStatuses)[number])) input.status = body.status as (typeof taskStatuses)[number];
    if ("ownerUserId" in body) input.ownerUserId = typeof body.ownerUserId === "string" && UUID_RE.test(body.ownerUserId) ? body.ownerUserId : null;
    if ("dueDate" in body) input.dueDate = isCalendarDate(body.dueDate) ? body.dueDate : null;
    if ("sourceConversationId" in body) input.sourceConversationId = typeof body.sourceConversationId === "string" && UUID_RE.test(body.sourceConversationId) ? body.sourceConversationId : null;
    return input;
  }
  async function taskInputError(workspaceId: string, body: Record<string, unknown>, input: ReturnType<typeof taskInput>): Promise<string | null> {
    if (input.title !== undefined && input.title.trim().length > TASK_TITLE_MAX) return `Task titles can be up to ${TASK_TITLE_MAX} characters.`;
    if (body.status !== undefined && input.status === undefined) return "Status must be todo, in_progress, review or done.";
    if (typeof body.dueDate === "string" && body.dueDate && input.dueDate === null) return "Due date must be a valid YYYY-MM-DD date.";
    if (input.ownerUserId && !(await db.getWorkspaceRole(workspaceId, input.ownerUserId))) return "Task owner must be a workspace member.";
    return null;
  }
  app.get("/workspaces/:id/tasks", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    res.json(await db.listWorkspaceTasks(paramString(req.params.id)));
  });
  app.post("/workspaces/:id/tasks", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const body = req.body ?? {};
    const input = taskInput(body);
    if (!input.title?.trim()) return res.status(400).json({ error: "A task title is required." });
    const invalid = await taskInputError(paramString(req.params.id), body, input);
    if (invalid) return res.status(400).json({ error: invalid });
    const task = await db.createWorkspaceTask({ workspaceId: paramString(req.params.id), ...input, title: input.title, createdByUserId: req.user!.id });
    res.status(201).json(task);
  });
  app.patch("/workspaces/:id/tasks/:taskId", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const body = req.body ?? {};
    const input = taskInput(body);
    if (input.title !== undefined && !input.title.trim()) return res.status(400).json({ error: "A task title is required." });
    const invalid = await taskInputError(paramString(req.params.id), body, input);
    if (invalid) return res.status(400).json({ error: invalid });
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
