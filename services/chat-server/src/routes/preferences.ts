// Small per-member settings that follow a person across devices.
import * as db from "@mai-chat/db";
import { paramString } from "../http-utils.js";
import type { Request, Response } from "express";
import type { RouteContext } from "./context.js";

export function registerPreferencesRoutes({ app, requireRole }: RouteContext): void {
  // Small per-member settings that should follow the person across devices.
  const PREFERENCE_KEYS = new Set(["agent-favorites", "activity-views", "notifications-cleared-at"]);
  app.get("/workspaces/:id/preferences/:key", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const key = paramString(req.params.key);
    if (!PREFERENCE_KEYS.has(key)) return res.status(404).json({ error: "Unknown preference." });
    res.json({ value: await db.getUserWorkspacePreference(paramString(req.params.id), req.user!.id, key) });
  });
  app.put("/workspaces/:id/preferences/:key", async (req: Request, res: Response) => {
    if (!(await requireRole(req, res, ["admin", "editor"]))) return;
    const key = paramString(req.params.key);
    if (!PREFERENCE_KEYS.has(key)) return res.status(404).json({ error: "Unknown preference." });
    const value = req.body?.value;
    if (value === undefined || JSON.stringify(value).length > 20_000) return res.status(400).json({ error: "A preference value up to 20 KB is required." });
    await db.setUserWorkspacePreference(paramString(req.params.id), req.user!.id, key, value);
    res.status(204).end();
  });
}
