"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import type { AuditEvent, AuditEventType } from "@mai-chat/shared-types";
import { listAuditEvents, ApiError } from "../../../../lib/api";

// Matches the AuditEventType union in packages/shared-types -- add a new
// kind there and in services/chat-server/src/actions.ts / server.ts
// together with a label here.
const EVENT_TYPE_LABELS: Record<AuditEventType, string> = {
  "workspace.created": "Workspace created",
  "member.joined": "Member joined",
  "member.left": "Member left",
  "member.invited": "Member invited",
  "integration.connected": "Integration connected",
  "workspace.permissions_updated": "Permissions updated",
  "agent.created": "Agent draft created",
  "agent.updated": "Agent draft updated",
  "agent.deleted": "Agent deleted",
  "agent.published": "Agent published",
  "workflow.created": "Workflow created",
  "workflow.updated": "Workflow updated",
  "workflow.deleted": "Workflow deleted",
  "workflow.started": "Workflow started",
  "workflow.completed": "Workflow completed",
  "workflow.failed": "Workflow failed",
  "memory.created": "Memory saved",
  "memory.updated": "Memory updated",
  "memory.deleted": "Memory deleted",
  "artifact.created": "Artifact created",
  "artifact.updated": "Artifact updated",
  "artifact.deleted": "Artifact deleted",
  "artifact.commented": "Artifact commented on",
  "action.proposed": "Action proposed",
  "action.confirmed": "Action confirmed",
  "action.cancelled": "Action cancelled",
  "action.failed": "Action failed",
  "handoff.directed": "Handed off to a teammate",
};

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

export default function AuditPage() {
  const params = useParams<{ id: string }>();
  const workspaceId = params.id;

  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [type, setType] = useState<AuditEventType | "">("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [live, setLive] = useState(true);

  // Debounced so every keystroke in the search box doesn't fire its own
  // request -- 250ms is short enough to still feel live.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const timeout = setTimeout(() => {
      listAuditEvents(workspaceId, { q: search.trim() || undefined, type: type || undefined })
        .then(({ events: list, nextBefore: next }) => {
          if (cancelled) return;
          setEvents(list);
          setNextBefore(next);
        })
        .catch((err) => {
          if (cancelled) return;
          setError(err instanceof ApiError ? err.message : "Could not reach the chat server.");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [workspaceId, search, type]);
  useEffect(() => { if (!live) return; const timer = window.setInterval(() => { listAuditEvents(workspaceId, { q: search.trim() || undefined, type: type || undefined }).then(({ events: list, nextBefore: next }) => { setEvents(list); setNextBefore(next); }).catch(() => {}); }, 30000); return () => window.clearInterval(timer); }, [workspaceId, search, type, live]);
  const attention = events.filter((event) => /failed|proposed/i.test(event.eventType));
  const grouped = useMemo(() => events.reduce<Record<string, AuditEvent[]>>((groups, event) => { const day = new Date(event.createdAt); const today = new Date(); const yesterday = new Date(); yesterday.setDate(today.getDate() - 1); const key = day.toDateString() === today.toDateString() ? "Today" : day.toDateString() === yesterday.toDateString() ? "Yesterday" : "Earlier"; (groups[key] ??= []).push(event); return groups; }, {}), [events]);
  function exportCsv() { const rows = [["Time", "Type", "Actor", "Activity"], ...events.map((event) => [event.createdAt, EVENT_TYPE_LABELS[event.eventType], event.actorType, event.summary])]; const blob = new Blob([rows.map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(",")).join("\n")], { type: "text/csv" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = "workspace-activity.csv"; anchor.click(); URL.revokeObjectURL(url); }

  async function loadMore() {
    if (!nextBefore) return;
    setLoadingMore(true);
    try {
      const { events: more, nextBefore: next } = await listAuditEvents(workspaceId, {
        q: search.trim() || undefined,
        type: type || undefined,
        before: nextBefore,
      });
      setEvents((prev) => [...prev, ...more]);
      // Fewer rows than asked for is this page's "no more history" signal
      // -- stop offering "Load older" once a page comes back short.
      setNextBefore(more.length > 0 ? next : null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the chat server.");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="audit-page">
      <Link className="back-link" href={`/w/${workspaceId}`}>
        ← Back to chat
      </Link>
      <h1 className="title">Activity</h1>
      <p style={{ color: "var(--text-dim)", fontSize: 13, marginTop: -10, marginBottom: 24, lineHeight: 1.5 }}>
        Who asked for what, what the agent did, and when -- every workspace creation, membership, integration, and agent action in
        this workspace.
      </p>
      <section className="activity-summary"><div><span>TODAY</span><strong>{events.filter((event) => new Date(event.createdAt).toDateString() === new Date().toDateString()).length}</strong><small>events recorded</small></div><div><span>NEEDS ATTENTION</span><strong>{attention.length}</strong><small>failed runs or approvals</small></div><div><span>WORKFLOW HEALTH</span><strong>{events.filter((event) => event.eventType === "workflow.completed").length}</strong><small>completed runs shown</small></div><div><span>LIVE UPDATES</span><button type="button" className={live ? "active" : ""} onClick={() => setLive((value) => !value)}>{live ? "● Live" : "Paused"}</button></div></section>
      {attention.length > 0 && <section className="activity-attention"><strong>Needs attention</strong>{attention.slice(0, 3).map((event) => <button type="button" key={event.id} onClick={() => setExpanded(event.id)}>{event.summary}</button>)}</section>}

      <div className="audit-toolbar">
        <input
          className="audit-search"
          type="text"
          placeholder="Search by person or action…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          data-testid="audit-search"
          aria-label="Search activity"
        />
        <select
          className="audit-type-select"
          value={type}
          onChange={(e) => setType(e.target.value as AuditEventType | "")}
          data-testid="audit-type-filter"
          aria-label="Filter by event type"
        >
          <option value="">All event types</option>
          {(Object.keys(EVENT_TYPE_LABELS) as AuditEventType[]).map((t) => (
            <option key={t} value={t}>
              {EVENT_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <button type="button" className="secondary-button" onClick={() => { setSearch(""); setType(""); }}>Clear</button><button type="button" className="secondary-button" onClick={exportCsv}>Export CSV</button>
      </div>

      {error && <p className="error-text" style={{ marginBottom: 16 }}>{error}</p>}

      <div className="audit-table activity-timeline" data-testid="audit-table">
        {loading && events.length === 0 && <div className="audit-empty">Loading…</div>}
        {!loading && events.length === 0 && !error && (
          <div className="audit-empty" data-testid="audit-empty">
            {search || type ? "No activity matches these filters." : "No activity yet."}
          </div>
        )}
        {Object.entries(grouped).map(([day, items]) => <section key={day}><h2>{day}</h2>{items.map((event) => (
          <button type="button" className={`audit-row ${expanded === event.id ? "expanded" : ""}`} key={event.id} onClick={() => setExpanded(expanded === event.id ? null : event.id)} data-testid="audit-row">
            <span className={`audit-actor-badge ${event.actorType}`}>{event.actorType}</span>
            <span className="audit-summary">{event.summary}</span>
            <span className="audit-time">{formatTimestamp(event.createdAt)}</span>
            {expanded === event.id && <span className="activity-detail"><b>{EVENT_TYPE_LABELS[event.eventType]}</b><br/>Actor: {event.actorType}. Recorded {formatTimestamp(event.createdAt)}.</span>}
          </button>
        ))}</section>)}
      </div>

      {nextBefore && events.length > 0 && (
        <button className="btn secondary audit-load-more" type="button" onClick={loadMore} disabled={loadingMore} data-testid="audit-load-more">
          {loadingMore ? "Loading…" : "Load older activity"}
        </button>
      )}
    </div>
  );
}
