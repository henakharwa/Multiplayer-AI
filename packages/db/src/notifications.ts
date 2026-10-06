// In-app notifications, digests and preferences.
import type {
  WorkspaceNotification } from "@mai-chat/shared-types";
import { getPool } from "./pool.js";


export async function notifyWorkspaceMembers(input: { workspaceId: string; conversationId?: string | null; kind: WorkspaceNotification["kind"]; text: string; priority?: WorkspaceNotification["priority"]; groupKey?: string; resourceType?: WorkspaceNotification["resourceType"]; resourceId?: string; excludeUserIds?: string[] }): Promise<void> {
  const pool = getPool();
  const groupKey = input.groupKey ?? `${input.kind}:${input.resourceId ?? input.conversationId ?? input.text.slice(0, 72)}`;
  await pool.query(
    `INSERT INTO workspace_notifications (workspace_id, conversation_id, user_id, kind, text, priority, group_key, resource_type, resource_id)
     SELECT $1, $2, wm.user_id, $3, $4, $5, $6, $7, $8
     FROM workspace_members wm
     LEFT JOIN workspace_notification_preferences p ON p.workspace_id=wm.workspace_id AND p.user_id=wm.user_id
     WHERE wm.workspace_id = $1 AND NOT (wm.user_id = ANY($9::uuid[]))
       AND ($5 = 'high' OR COALESCE(p.browser_enabled, true))
       AND (
         $5 = 'high' OR NOT COALESCE(p.quiet_hours_enabled, false) OR
         CASE
           WHEN p.quiet_hours_start < p.quiet_hours_end THEN NOT (EXTRACT(HOUR FROM now() AT TIME ZONE 'UTC')::int >= p.quiet_hours_start AND EXTRACT(HOUR FROM now() AT TIME ZONE 'UTC')::int < p.quiet_hours_end)
           WHEN p.quiet_hours_start > p.quiet_hours_end THEN NOT (EXTRACT(HOUR FROM now() AT TIME ZONE 'UTC')::int >= p.quiet_hours_start OR EXTRACT(HOUR FROM now() AT TIME ZONE 'UTC')::int < p.quiet_hours_end)
           ELSE false
         END
       )`,
    [input.workspaceId, input.conversationId ?? null, input.kind, input.text, input.priority ?? "normal", groupKey, input.resourceType ?? (input.conversationId ? "conversation" : null), input.resourceId ?? input.conversationId ?? null, input.excludeUserIds ?? []]
  );
}

/**
 * Repairs an inbox if a pending action was created while a recipient was
 * offline or before notification delivery was enabled. The action itself is
 * authoritative, so this insert is idempotent per user and action.
 */
export async function ensurePendingActionNotifications(workspaceId: string): Promise<void> {
  await getPool().query(`INSERT INTO workspace_notifications (workspace_id, conversation_id, user_id, kind, text, priority, group_key, resource_type, resource_id)
    SELECT a.workspace_id, a.conversation_id, wm.user_id, 'decision_needed', 'Decision needed: ' || a.description, 'high', 'decision_needed:' || a.id::text, 'action', a.id::text
    FROM pending_actions a JOIN workspace_members wm ON wm.workspace_id=a.workspace_id
    WHERE a.workspace_id=$1 AND a.status='pending'
      AND NOT EXISTS (SELECT 1 FROM workspace_notifications n WHERE n.user_id=wm.user_id AND n.resource_type='action' AND n.resource_id=a.id::text AND n.kind='decision_needed')`, [workspaceId]);
}

/** Escalate each unresolved decision once, using the recipient's saved delay. */
export async function escalateUnreadDecisionNotifications(): Promise<number> {
  const result = await getPool().query(`WITH due AS (
    UPDATE workspace_notifications n SET escalated_at=now()
    FROM workspace_members wm
    LEFT JOIN workspace_notification_preferences p ON p.workspace_id=wm.workspace_id AND p.user_id=wm.user_id
    WHERE n.workspace_id=wm.workspace_id AND n.user_id=wm.user_id
      AND n.kind IN ('decision_needed','permission_request') AND n.read_at IS NULL AND n.escalated_at IS NULL
      AND n.created_at <= now() - (COALESCE(p.escalation_minutes, 60) * interval '1 minute')
    RETURNING n.workspace_id,n.user_id,n.conversation_id,n.text
  ) INSERT INTO workspace_notifications (workspace_id,user_id,conversation_id,kind,text,priority,group_key)
  SELECT workspace_id,user_id,conversation_id,'decision_needed','Reminder: ' || text,'high','escalation:' || conversation_id::text FROM due`);
  return result.rowCount ?? 0;
}

/** Creates one in-app digest per opted-in user at their saved UTC hour. */
export async function createDailyNotificationDigests(): Promise<number> {
  const result = await getPool().query(`WITH due AS (
    SELECT p.workspace_id,p.user_id FROM workspace_notification_preferences p
    WHERE p.daily_summary_enabled AND p.browser_enabled
      AND p.digest_hour <= EXTRACT(HOUR FROM now() AT TIME ZONE 'UTC')::int
      AND (p.digest_sent_on IS NULL OR p.digest_sent_on < (now() AT TIME ZONE 'UTC')::date)
      AND (
        NOT p.quiet_hours_enabled OR
        CASE
          WHEN p.quiet_hours_start < p.quiet_hours_end THEN NOT (EXTRACT(HOUR FROM now() AT TIME ZONE 'UTC')::int >= p.quiet_hours_start AND EXTRACT(HOUR FROM now() AT TIME ZONE 'UTC')::int < p.quiet_hours_end)
          WHEN p.quiet_hours_start > p.quiet_hours_end THEN NOT (EXTRACT(HOUR FROM now() AT TIME ZONE 'UTC')::int >= p.quiet_hours_start OR EXTRACT(HOUR FROM now() AT TIME ZONE 'UTC')::int < p.quiet_hours_end)
          ELSE false
        END
      )
  ), inserted AS (
    INSERT INTO workspace_notifications (workspace_id,user_id,kind,text,priority,group_key)
    SELECT d.workspace_id,d.user_id,'agent_completed',
      'Daily digest: ' || count(n.id) || ' workspace updates in the last 24 hours.', 'normal','daily-digest:' || (now() AT TIME ZONE 'UTC')::date::text
    FROM due d LEFT JOIN workspace_notifications n ON n.workspace_id=d.workspace_id AND n.user_id=d.user_id AND n.created_at >= now() - interval '24 hours'
    GROUP BY d.workspace_id,d.user_id RETURNING workspace_id,user_id
  ) UPDATE workspace_notification_preferences p SET digest_sent_on=(now() AT TIME ZONE 'UTC')::date,updated_at=now() FROM inserted i WHERE p.workspace_id=i.workspace_id AND p.user_id=i.user_id RETURNING p.workspace_id`);
  return result.rowCount ?? 0;
}

export async function listNotifications(userId: string, options: { workspaceId?: string; limit?: number; before?: string } = {}): Promise<WorkspaceNotification[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const clauses = ["n.user_id = $1"];
  const values: unknown[] = [userId];
  if (options.workspaceId) { values.push(options.workspaceId); clauses.push(`n.workspace_id = $${values.length}`); }
  if (options.before) { values.push(options.before); clauses.push(`n.created_at < $${values.length}`); }
  values.push(limit);
  const result = await getPool().query(
    `SELECT n.id, n.workspace_id, n.conversation_id, n.kind, n.text, n.priority, n.group_key, n.resource_type, n.resource_id, n.created_at, n.read_at
     FROM workspace_notifications n
     LEFT JOIN workspace_notification_preferences p ON p.workspace_id=n.workspace_id AND p.user_id=n.user_id
     WHERE ${clauses.join(" AND ")} AND (
       n.priority = 'high' OR n.kind = 'workflow_alert' OR (
         COALESCE(p.browser_enabled, true) AND (
           NOT COALESCE(p.quiet_hours_enabled, false) OR
           CASE
             WHEN p.quiet_hours_start < p.quiet_hours_end THEN NOT (EXTRACT(HOUR FROM now() AT TIME ZONE 'UTC')::int >= p.quiet_hours_start AND EXTRACT(HOUR FROM now() AT TIME ZONE 'UTC')::int < p.quiet_hours_end)
             WHEN p.quiet_hours_start > p.quiet_hours_end THEN NOT (EXTRACT(HOUR FROM now() AT TIME ZONE 'UTC')::int >= p.quiet_hours_start OR EXTRACT(HOUR FROM now() AT TIME ZONE 'UTC')::int < p.quiet_hours_end)
             ELSE false
           END
         )
       )
     ) ORDER BY n.created_at DESC LIMIT $${values.length}`,
    values
  );
  return result.rows.map((row) => ({ id: row.id, workspaceId: row.workspace_id, conversationId: row.conversation_id, kind: row.kind, text: row.text, priority: row.kind === "workflow_alert" ? "high" : row.priority, groupKey: row.group_key, resourceType: row.resource_type, resourceId: row.resource_id, createdAt: row.created_at.toISOString(), readAt: row.read_at ? row.read_at.toISOString() : null }));
}

export async function markNotificationsRead(userId: string, workspaceId: string): Promise<void> {
  await getPool().query(`UPDATE workspace_notifications SET read_at = now() WHERE user_id = $1 AND workspace_id = $2 AND read_at IS NULL`, [userId, workspaceId]);
}

export async function markNotificationSelectionRead(userId: string, workspaceId: string, ids: string[]): Promise<void> {
  await getPool().query("UPDATE workspace_notifications SET read_at=now() WHERE user_id=$1 AND workspace_id=$2 AND id = ANY($3::uuid[])", [userId, workspaceId, ids]);
}

export async function getNotificationPreferences(workspaceId: string, userId: string): Promise<import("@mai-chat/shared-types").WorkspaceNotificationPreferences> {
  const result = await getPool().query("SELECT workspace_id,user_id,browser_enabled,escalation_minutes,daily_summary_enabled,quiet_hours_enabled,quiet_hours_start,quiet_hours_end,digest_hour,updated_at FROM workspace_notification_preferences WHERE workspace_id=$1 AND user_id=$2", [workspaceId, userId]);
  const row = result.rows[0];
  return { workspaceId, browserEnabled: row?.browser_enabled ?? true, escalationMinutes: row?.escalation_minutes ?? 60, dailySummaryEnabled: row?.daily_summary_enabled ?? true, quietHoursEnabled: row?.quiet_hours_enabled ?? false, quietHoursStart: row?.quiet_hours_start ?? 20, quietHoursEnd: row?.quiet_hours_end ?? 8, digestHour: row?.digest_hour ?? 9, updatedAt: row?.updated_at ? row.updated_at.toISOString() : null };
}

export async function updateNotificationPreferences(workspaceId: string, userId: string, input: Partial<import("@mai-chat/shared-types").WorkspaceNotificationPreferences>): Promise<import("@mai-chat/shared-types").WorkspaceNotificationPreferences> {
  const current = await getNotificationPreferences(workspaceId, userId);
  const escalationMinutes = [15, 30, 60, 240, 1440].includes(input.escalationMinutes ?? current.escalationMinutes) ? input.escalationMinutes ?? current.escalationMinutes : current.escalationMinutes;
  const quietHoursStart = Number.isInteger(input.quietHoursStart) && input.quietHoursStart! >= 0 && input.quietHoursStart! <= 23 ? input.quietHoursStart : current.quietHoursStart;
  const quietHoursEnd = Number.isInteger(input.quietHoursEnd) && input.quietHoursEnd! >= 0 && input.quietHoursEnd! <= 23 ? input.quietHoursEnd : current.quietHoursEnd;
  const digestHour = Number.isInteger(input.digestHour) && input.digestHour! >= 0 && input.digestHour! <= 23 ? input.digestHour : current.digestHour;
  const result = await getPool().query(`INSERT INTO workspace_notification_preferences (workspace_id,user_id,browser_enabled,escalation_minutes,daily_summary_enabled,quiet_hours_enabled,quiet_hours_start,quiet_hours_end,digest_hour)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (workspace_id,user_id) DO UPDATE SET browser_enabled=EXCLUDED.browser_enabled,escalation_minutes=EXCLUDED.escalation_minutes,daily_summary_enabled=EXCLUDED.daily_summary_enabled,quiet_hours_enabled=EXCLUDED.quiet_hours_enabled,quiet_hours_start=EXCLUDED.quiet_hours_start,quiet_hours_end=EXCLUDED.quiet_hours_end,digest_hour=EXCLUDED.digest_hour,updated_at=now() RETURNING *`,
    [workspaceId, userId, input.browserEnabled ?? current.browserEnabled, escalationMinutes, input.dailySummaryEnabled ?? current.dailySummaryEnabled, input.quietHoursEnabled ?? current.quietHoursEnabled, quietHoursStart, quietHoursEnd, digestHour]);
  const row = result.rows[0];
  return { workspaceId, browserEnabled: row.browser_enabled, escalationMinutes: row.escalation_minutes, dailySummaryEnabled: row.daily_summary_enabled, quietHoursEnabled: row.quiet_hours_enabled, quietHoursStart: row.quiet_hours_start, quietHoursEnd: row.quiet_hours_end, digestHour: row.digest_hour, updatedAt: row.updated_at.toISOString() };
}

export async function notifyWorkspaceUser(input: { workspaceId: string; userId: string; kind: WorkspaceNotification["kind"]; text: string; priority?: WorkspaceNotification["priority"] }): Promise<void> {
  await getPool().query(
    `INSERT INTO workspace_notifications (workspace_id, user_id, kind, text, priority)
     SELECT $1, $2, $3, $4, $5
     FROM (VALUES ($1::uuid, $2::uuid)) AS recipient(workspace_id, user_id)
     LEFT JOIN workspace_notification_preferences p ON p.workspace_id=recipient.workspace_id AND p.user_id=recipient.user_id
     WHERE ($5 = 'high' OR COALESCE(p.browser_enabled, true))
       AND (
         $5 = 'high' OR NOT COALESCE(p.quiet_hours_enabled, false) OR
         CASE
           WHEN p.quiet_hours_start < p.quiet_hours_end THEN NOT (EXTRACT(HOUR FROM now() AT TIME ZONE 'UTC')::int >= p.quiet_hours_start AND EXTRACT(HOUR FROM now() AT TIME ZONE 'UTC')::int < p.quiet_hours_end)
           WHEN p.quiet_hours_start > p.quiet_hours_end THEN NOT (EXTRACT(HOUR FROM now() AT TIME ZONE 'UTC')::int >= p.quiet_hours_start OR EXTRACT(HOUR FROM now() AT TIME ZONE 'UTC')::int < p.quiet_hours_end)
           ELSE false
         END
       )`,
    [input.workspaceId, input.userId, input.kind, input.text, input.priority ?? "normal"]
  );
}
