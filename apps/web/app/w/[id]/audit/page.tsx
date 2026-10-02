"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import type { AuditEvent, AuditEventType, WorkspaceArtifact, WorkspaceMemory, WorkspaceTask } from "@mai-chat/shared-types";
import { listAuditEvents, listWorkspaceArtifacts, listWorkspaceMemory, listWorkspaceTasks, ApiError } from "../../../../lib/api";

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
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [search, setSearch] = useState("");
  const [type, setType] = useState<AuditEventType | "">("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tasks, setTasks] = useState<WorkspaceTask[]>([]); const [memories, setMemories] = useState<WorkspaceMemory[]>([]); const [artifacts, setArtifacts] = useState<WorkspaceArtifact[]>([]);
  const [live, setLive] = useState(true);
  const [actor, setActor] = useState(""); const [outcome, setOutcome] = useState<"" | "success" | "failure" | "approval">(""); const [range, setRange] = useState<"all" | "today" | "week">("all"); const [agentFilter, setAgentFilter] = useState(""); const [workflowFilter, setWorkflowFilter] = useState(""); const [savedViews, setSavedViews] = useState<Array<{ name: string; search: string; type: AuditEventType | ""; actor: string; outcome: "" | "success" | "failure" | "approval"; range: "all" | "today" | "week" }>>([]);

  // Debounced so every keystroke in the search box doesn't fire its own
  // request -- 250ms is short enough to still feel live.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const timeout = setTimeout(() => {
      const loadAllEvents = async () => {
        const all: AuditEvent[] = [];
        let before: string | undefined;
        do {
          const { events: batch } = await listAuditEvents(workspaceId, { q: search.trim() || undefined, type: type || undefined, before, limit: 200 });
          all.push(...batch);
          before = batch.length === 200 ? batch[batch.length - 1]?.createdAt : undefined;
        } while (before);
        return all;
      };
      loadAllEvents()
        .then((list) => {
          if (cancelled) return;
          setEvents(list);
          setPage(1);
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
  }, [workspaceId, search, type, reload]);
  useEffect(() => { if (!live) return; const timer = window.setInterval(() => setReload((value) => value + 1), 30000); return () => window.clearInterval(timer); }, [live]);
  useEffect(() => { try { setSavedViews(JSON.parse(window.localStorage.getItem(`nexus-activity-views-${workspaceId}`) ?? "[]")); } catch { setSavedViews([]); } }, [workspaceId]);
  useEffect(() => { void Promise.all([listWorkspaceTasks(workspaceId), listWorkspaceMemory(workspaceId), listWorkspaceArtifacts(workspaceId)]).then(([workspaceTasks, workspaceMemories, workspaceArtifacts]) => { setTasks(workspaceTasks); setMemories(workspaceMemories); setArtifacts(workspaceArtifacts); }).catch(() => {}); }, [workspaceId]);
  const attention = events.filter((event) => /failed/i.test(event.eventType));
  const overdueTasks = tasks.filter((task) => task.status !== "done" && task.dueDate && new Date(`${task.dueDate}T23:59:59`).getTime() < Date.now()); const staleMemories = memories.filter((memory) => memory.freshUntil && new Date(memory.freshUntil).getTime() < Date.now());
  const recentEvents = events.filter((event) => Date.now() - new Date(event.createdAt).getTime() < 86400000).length; const previousEvents = events.filter((event) => { const age = Date.now() - new Date(event.createdAt).getTime(); return age >= 86400000 && age < 172800000; }).length; const eventTrend = recentEvents - previousEvents;
  const workflowFinished = events.filter((event) => event.eventType === "workflow.completed" || event.eventType === "workflow.failed");
  const workflowSuccessRate = workflowFinished.length ? Math.round((events.filter((event) => event.eventType === "workflow.completed").length / workflowFinished.length) * 100) : null;
  const approvalsCompleted = events.filter((event) => event.eventType === "action.confirmed").length;
  const artifactsPublished = artifacts.filter((artifact) => artifact.status === "published").length;
  const completedTasks = tasks.filter((task) => task.status === "done").length;
  const completedToday = tasks.filter((task) => task.status === "done" && Date.now() - new Date(task.updatedAt).getTime() < 86400000).length;
  const completedYesterday = tasks.filter((task) => { const age = Date.now() - new Date(task.updatedAt).getTime(); return task.status === "done" && age >= 86400000 && age < 172800000; }).length;
  const taskThroughputTrend = completedToday - completedYesterday;
  const workflowStarts = new Map(events.filter((event) => event.eventType === "workflow.started" && event.metadata.runId).map((event) => [String(event.metadata.runId), new Date(event.createdAt).getTime()]));
  const workflowDurations = events.filter((event) => event.eventType === "workflow.completed").map((event) => { const startedAt = workflowStarts.get(String(event.metadata.runId)); return startedAt ? new Date(event.createdAt).getTime() - startedAt : null; }).filter((duration): duration is number => duration !== null && duration >= 0);
  const averageWorkflowDuration = workflowDurations.length ? Math.round(workflowDurations.reduce((total, duration) => total + duration, 0) / workflowDurations.length / 1000) : null;
  const filteredEvents = useMemo(() => events.filter((event) => { const age = Date.now() - new Date(event.createdAt).getTime(); const within = range === "all" || (range === "today" && age < 86400000) || (range === "week" && age < 604800000); const matchesActor = !actor || event.actorName === actor; const matchesOutcome = !outcome || (outcome === "success" && /completed|confirmed|published/i.test(event.eventType)) || (outcome === "failure" && /failed/i.test(event.eventType)) || (outcome === "approval" && /proposed|confirmed|cancelled/i.test(event.eventType)); return within && matchesActor && matchesOutcome && (!agentFilter || event.summary.toLowerCase().includes(agentFilter.toLowerCase())) && (!workflowFilter || event.summary.toLowerCase().includes(workflowFilter.toLowerCase())); }), [events, actor, outcome, range, agentFilter, workflowFilter]);
  const pageSize = 10;
  const pageCount = Math.max(1, Math.ceil(filteredEvents.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pagedEvents = filteredEvents.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const grouped = useMemo(() => pagedEvents.reduce<Record<string, AuditEvent[]>>((groups, event) => { const day = new Date(event.createdAt); const today = new Date(); const yesterday = new Date(); yesterday.setDate(today.getDate() - 1); const key = day.toDateString() === today.toDateString() ? "Today" : day.toDateString() === yesterday.toDateString() ? "Yesterday" : Date.now() - day.getTime() < 604800000 ? "This week" : "Earlier"; (groups[key] ??= []).push(event); return groups; }, {}), [pagedEvents]);
  useEffect(() => { setPage(1); }, [search, type, actor, agentFilter, workflowFilter, outcome, range]);
  const actors = [...new Set(events.map((event) => event.actorName).filter(Boolean))]; const iconFor = (event: AuditEvent) => event.eventType.startsWith("workflow") ? "↻" : event.eventType.startsWith("artifact") ? "▤" : event.eventType.startsWith("agent") ? "✦" : event.eventType.startsWith("memory") ? "▣" : event.eventType.startsWith("action") ? "✓" : event.eventType.startsWith("integration") ? "⌁" : "•";
  function saveView() { const name = window.prompt("Name this activity view"); if (!name) return; const next = [...savedViews, { name, search, type, actor, outcome, range }]; setSavedViews(next); window.localStorage.setItem(`nexus-activity-views-${workspaceId}`, JSON.stringify(next)); }
  function exportCsv() { const rows = [["Time", "Type", "Actor", "Activity"], ...filteredEvents.map((event) => [event.createdAt, EVENT_TYPE_LABELS[event.eventType], event.actorName || event.actorType, event.summary])]; const blob = new Blob(["\ufeff", rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }); const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = "workspace-activity.csv"; anchor.style.display = "none"; document.body.appendChild(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 0); }

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
      <section className="activity-analytics"><div><span>WORKFLOW SUCCESS</span><strong>{workflowSuccessRate === null ? "—" : `${workflowSuccessRate}%`}</strong><small>{workflowFinished.length} completed or failed runs</small></div><div><span>APPROVALS COMPLETED</span><strong>{approvalsCompleted}</strong><small>confirmed governed actions</small></div><div><span>ARTIFACTS PUBLISHED</span><strong>{artifactsPublished}</strong><small>currently published artifacts</small></div><div><span>TASK THROUGHPUT</span><strong>{completedTasks}/{tasks.length}</strong><small>{taskThroughputTrend === 0 ? `${completedToday} completed today` : `${taskThroughputTrend > 0 ? "+" : ""}${taskThroughputTrend} vs yesterday`}</small></div><div><span>AVG WORKFLOW TIME</span><strong>{averageWorkflowDuration === null ? "—" : `${averageWorkflowDuration}s`}</strong><small>{averageWorkflowDuration === null ? "no matching run history" : "start-to-finish average"}</small></div></section>
      {(attention.length > 0 || overdueTasks.length > 0 || staleMemories.length > 0) && <section className="activity-attention"><strong>Needs attention</strong>{attention.slice(0, 3).map((event) => <button type="button" key={event.id} onClick={() => setExpanded(event.id)}>{event.summary}</button>)}{overdueTasks.map((task) => <Link key={task.id} href={`/w/${workspaceId}/tasks`}>Overdue task: {task.title}</Link>)}{staleMemories.map((memory) => <Link key={memory.id} href={`/w/${workspaceId}/memory`}>Memory needs review: {memory.title}</Link>)}</section>}

      <div className="audit-toolbar">
        <div className="audit-filter-row">
          <div className="audit-text-filters"><input
          className="audit-search"
          type="text"
          placeholder="Search by person or action…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          data-testid="audit-search"
          aria-label="Search activity"
        />
          <input value={agentFilter} onChange={(event) => setAgentFilter(event.target.value)} placeholder="Agent name" aria-label="Filter by agent"/><input value={workflowFilter} onChange={(event) => setWorkflowFilter(event.target.value)} placeholder="Workflow name" aria-label="Filter by workflow"/></div>
          <div className="audit-select-filters"><select
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
        <select value={actor} onChange={(event) => setActor(event.target.value)} aria-label="Filter by teammate"><option value="">All teammates</option>{actors.map((name) => <option key={name}>{name}</option>)}</select><select value={outcome} onChange={(event) => setOutcome(event.target.value as typeof outcome)} aria-label="Filter by outcome"><option value="">All outcomes</option><option value="success">Completed</option><option value="failure">Failed</option><option value="approval">Approvals</option></select><select value={range} onChange={(event) => setRange(event.target.value as typeof range)} aria-label="Filter by time"><option value="all">All time</option><option value="today">Today</option><option value="week">This week</option></select>
        <button type="button" className="secondary-button" onClick={() => { setSearch(""); setType(""); setActor(""); setAgentFilter(""); setWorkflowFilter(""); setOutcome(""); setRange("all"); }}>Clear</button>
        </div></div>
        <div className="audit-action-row"><button type="button" className="secondary-button" onClick={exportCsv}>Export CSV</button><button type="button" className="secondary-button" onClick={saveView}>Save view</button></div>
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

      {filteredEvents.length > 0 && <nav className="audit-pagination" aria-label="Activity pages"><span>Showing {(currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, filteredEvents.length)} of {filteredEvents.length}</span><div><button type="button" onClick={() => setPage(1)} disabled={currentPage === 1} aria-label="First page">«</button><button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={currentPage === 1} aria-label="Previous page">‹</button><strong>{currentPage}</strong><span>of {pageCount}</span><button type="button" onClick={() => setPage((value) => Math.min(pageCount, value + 1))} disabled={currentPage === pageCount} aria-label="Next page">›</button><button type="button" onClick={() => setPage(pageCount)} disabled={currentPage === pageCount} aria-label="Last page">»</button></div></nav>}
    </div>
  );
}
