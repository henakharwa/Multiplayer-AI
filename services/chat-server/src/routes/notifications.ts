// Per-user notification list, read state and preferences.
import * as db from "@mai-chat/db";
import { UUID_RE } from "../http-utils.js";
import { requireAuth } from "../auth.js";
import type { Request, Response } from "express";
import type { RouteContext } from "./context.js";

export function registerNotificationsRoutes({ app }: RouteContext): void {
  // Notification settings and lists are per workspace; only members may
  // read or change them for a given workspace.
  async function notMember(req: Request, res: Response, workspaceId: string): Promise<boolean> {
    if (await db.getWorkspaceRole(workspaceId, req.user!.id)) return false;
    res.status(403).json({ error: "You are not a member of this workspace." });
    return true;
  }

  app.get("/notifications", requireAuth, async (req: Request, res: Response) => {
    const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : null;
    if (workspaceId && UUID_RE.test(workspaceId)) {
      if (await notMember(req, res, workspaceId)) return;
      await db.ensurePendingActionNotifications(workspaceId);
    }
    const parsedLimit = Number(req.query.limit);
    const limit = Number.isFinite(parsedLimit) ? parsedLimit : 50;
    const before = typeof req.query.before === "string" && !Number.isNaN(Date.parse(req.query.before)) ? req.query.before : undefined;
    res.json(await db.listNotifications(req.user!.id, { workspaceId: workspaceId && UUID_RE.test(workspaceId) ? workspaceId : undefined, limit, before }));
  });

  app.post("/notifications/read", requireAuth, async (req: Request, res: Response) => {
    const workspaceId = typeof req.body?.workspaceId === "string" ? req.body.workspaceId : "";
    if (!UUID_RE.test(workspaceId)) return res.status(400).json({ error: "valid workspaceId is required" });
    if (await notMember(req, res, workspaceId)) return;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id: unknown): id is string => typeof id === "string" && UUID_RE.test(id)) : [];
    if (ids.length) await db.markNotificationSelectionRead(req.user!.id, workspaceId, ids);
    else await db.markNotificationsRead(req.user!.id, workspaceId);
    res.status(204).end();
  });

  app.get("/notifications/preferences", requireAuth, async (req: Request, res: Response) => {
    const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : "";
    if (!UUID_RE.test(workspaceId)) return res.status(400).json({ error: "valid workspaceId is required" });
    if (await notMember(req, res, workspaceId)) return;
    res.json(await db.getNotificationPreferences(workspaceId, req.user!.id));
  });

  app.put("/notifications/preferences", requireAuth, async (req: Request, res: Response) => {
    const workspaceId = typeof req.body?.workspaceId === "string" ? req.body.workspaceId : "";
    if (!UUID_RE.test(workspaceId)) return res.status(400).json({ error: "valid workspaceId is required" });
    if (await notMember(req, res, workspaceId)) return;
    res.json(await db.updateNotificationPreferences(workspaceId, req.user!.id, req.body ?? {}));
  });
}
