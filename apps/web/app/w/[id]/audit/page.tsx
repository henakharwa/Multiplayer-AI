"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import type { AuditEvent, AuditEventType, WorkspaceMemory, WorkspaceTask } from "@mai-chat/shared-types";
import { listAuditEvents, listWorkspaceMemory, listWorkspaceTasks, ApiError } from "../../../../lib/api";

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
  const [tasks, setTasks] = useState<WorkspaceTask[]>([]); const [memories, setMemories] = useState<WorkspaceMemory[]>([]);
  const [live, setLive] = useState(true);
  const [actor, setActor] = useState(""); const [outcome, setOutcome] = useState<"" | "success" | "failure" | "approval">(""); const [range, setRange] = useState<"all" | "today" | "week">("all"); const [agentFilter, setAgentFilter] = useState(""); const [workflowFilter, setWorkflowFilter] = useState(""); const [savedViews, setSavedViews] = useState<Array<{ name: string; search: string; type: AuditEventType | ""; actor: string; outcome: "" | "success" | "failure" | "approval"; range: "all" | "today" | "week" }>>([]);

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
  useEffect(() => { try { setSavedViews(JSON.parse(window.localStorage.getItem(`nexus-activity-views-${workspaceId}`) ?? "[]")); } catch { setSavedViews([]); } }, [workspaceId]);
  useEffect(() => { void Promise.all([listWorkspaceTasks(workspaceId), listWorkspaceMemory(workspaceId)]).then(([workspaceTasks, workspaceMemories]) => { setTasks(workspaceTasks); setMemories(workspaceMemories); }).catch(() => {}); }, [workspaceId]);
  const attention = events.filter((event) => /failed|proposed/i.test(event.eventType));
  const overdueTasks = tasks.filter((task) => task.status !== "done" && task.dueDate && new Date(`${task.dueDate}T23:59:59`).getTime() < Date.now()); const staleMemories = memories.filter((memory) => memory.freshUntil && new Date(memory.freshUntil).getTime() < Date.now());
  const recentEvents = events.filter((event) => Date.now() - new Date(event.createdAt).getTime() < 86400000).length; const previousEvents = events.filter((event) => { const age = Date.now() - new Date(event.createdAt).getTime(); return age >= 86400000 && age < 172800000; }).length; const eventTrend = recentEvents - previousEvents;
  const filteredEvents = useMemo(() => events.filter((event) => { const age = Date.now() - new Date(event.createdAt).getTime(); const within = range === "all" || (range === "today" && age < 86400000) || (range === "week" && age < 604800000); const matchesActor = !actor || event.actorName === actor; const matchesOutcome = !outcome || (outcome === "success" && /completed|confirmed|published/i.test(event.eventType)) || (outcome === "failure" && /failed/i.test(event.eventType)) || (outcome === "approval" && /proposed|confirmed|cancelled/i.test(event.eventType)); return within && matchesActor && matchesOutcome && (!agentFilter || event.summary.toLowerCase().includes(agentFilter.toLowerCase())) && (!workflowFilter || event.summary.toLowerCase().includes(workflowFilter.toLowerCase())); }), [events, actor, outcome, range, agentFilter, workflowFilter]);
  const grouped = useMemo(() => filteredEvents.reduce<Record<string, AuditEvent[]>>((groups, event) => { const day = new Date(event.createdAt); const today = new Date(); const yesterday = new Date(); yesterday.setDate(today.getDate() - 1); const key = day.toDateString() === today.toDateString() ? "Today" : day.toDateString() === yesterday.toDateString() ? "Yesterday" : Date.now() - day.getTime() < 604800000 ? "This week" : "Earlier"; (groups[key] ??= []).push(event); return groups; }, {}), [filteredEvents]);
  const actors = [...new Set(events.map((event) => event.actorName).filter(Boolean))]; const iconFor = (event: AuditEvent) => event.eventType.startsWith("workflow") ? "↻" : event.eventType.startsWith("artifact") ? "▤" : event.eventType.startsWith("agent") ? "✦" : event.eventType.startsWith("memory") ? "▣" : event.eventType.startsWith("action") ? "✓" : event.eventType.startsWith("integration") ? "⌁" : "•";
  function saveView() { const name = window.prompt("Name this activity view"); if (!name) return; const next = [...savedViews, { name, search, type, actor, outcome, range }]; setSavedViews(next); window.localStorage.setItem(`nexus-activity-views-${workspaceId}`, JSON.stringify(next)); }
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
      <section className="activity-summary"><div><span>TODAY</span><strong>{recentEvents}</strong><small>{eventTrend === 0 ? "same as yesterday" : `${eventTrend > 0 ? "+" : ""}${eventTrend} vs yesterday`}</small></div><div><span>NEEDS ATTENTION</span><strong>{attention.length + overdueTasks.length + staleMemories.length}</strong><small>runs, approvals, tasks, memory</small></div><div><span>WORKFLOW HEALTH</span><strong>{events.filter((event) => event.eventType === "workflow.completed").length}</strong><small>completed runs shown</small></div><div><span>LIVE UPDATES</span><button type="button" className={live ? "active" : ""} onClick={() => setLive((value) => !value)}>{live ? "● Live" : "Paused"}</button></div></section>
      {(attention.length > 0 || overdueTasks.length > 0 || staleMemories.length > 0) && <section className="activity-attention"><strong>Needs attention</strong>{attention.slice(0, 3).map((event) => <button type="button" key={event.id} onClick={() => setExpanded(event.id)}>{event.summary}</button>)}{overdueTasks.map((task) => <Link key={task.id} href={`/w/${workspaceId}/tasks`}>Overdue task: {task.title}</Link>)}{staleMemories.map((memory) => <Link key={memory.id} href={`/w/${workspaceId}/memory`}>Memory needs review: {memory.title}</Link>)}</section>}

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
        <select value={actor} onChange={(event) => setActor(event.target.value)} aria-label="Filter by teammate"><option value="">All teammates</option>{actors.map((name) => <option key={name}>{name}</option>)}</select><input value={agentFilter} onChange={(event) => setAgentFilter(event.target.value)} placeholder="Agent name" aria-label="Filter by agent"/><input value={workflowFilter} onChange={(event) => setWorkflowFilter(event.target.value)} placeholder="Workflow name" aria-label="Filter by workflow"/><select value={outcome} onChange={(event) => setOutcome(event.target.value as typeof outcome)} aria-label="Filter by outcome"><option value="">All outcomes</option><option value="success">Completed</option><option value="failure">Failed</option><option value="approval">Approvals</option></select><select value={range} onChange={(event) => setRange(event.target.value as typeof range)} aria-label="Filter by time"><option value="all">All time</option><option value="today">Today</option><option value="week">This week</option></select>
        <button type="button" className="secondary-button" onClick={() => { setSearch(""); setType(""); }}>Clear</button><button type="button" className="secondary-button" onClick={exportCsv}>Export CSV</button>
        <button type="button" className="secondary-button" onClick={saveView}>Save view</button>
      </div>
      {savedViews.length > 0 && <div className="activity-saved-views">{savedViews.map((view) => <button key={view.name} type="button" onClick={() => { setSearch(view.search); setType(view.type); setActor(view.actor); setOutcome(view.outcome); setRange(view.range); }}>{view.name}</button>)}</div>}

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
            <span className={`activity-event-icon ${event.eventType.split(".")[0]}`}>{iconFor(event)}</span>
            <span className={`audit-actor-badge ${event.actorType}`}>{event.actorType}</span>
            <span className="audit-summary">{event.summary}</span>
            <span className="audit-time">{formatTimestamp(event.createdAt)}</span>
            {expanded === event.id && <span className="activity-detail"><b>{EVENT_TYPE_LABELS[event.eventType]}</b><br/>Actor: {event.actorName || event.actorType}. Recorded {formatTimestamp(event.createdAt)}.{Object.keys(event.metadata).length > 0 && <><br/>Context: {Object.entries(event.metadata).map(([key, value]) => `${key}: ${String(value)}`).join(" · ")}</>}<br/><Link href={event.eventType.startsWith("artifact") ? `/w/${workspaceId}/artifacts` : event.eventType.startsWith("workflow") ? `/w/${workspaceId}/workflows` : event.eventType.startsWith("agent") ? `/w/${workspaceId}/agents` : event.eventType.startsWith("memory") ? `/w/${workspaceId}/memory` : `/w/${workspaceId}`}>Open related workspace area →</Link></span>}
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
