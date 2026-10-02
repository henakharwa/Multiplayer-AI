"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { AuditEvent, IntegrationConfig, WorkflowRun, WorkspaceWorkflow } from "@mai-chat/shared-types";
import { listAuditEvents, listIntegrations, listWorkflowRuns, listWorkspaceWorkflows } from "../../../../lib/api";

type RunWithWorkflow = WorkflowRun & { workflowName: string };
const providers = ["github", "slack", "linear", "notion", "figma"] as const;

function relativeTime(value: string) { const minutes = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 60_000)); return minutes < 1 ? "Just now" : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`; }
function duration(run: WorkflowRun) { if (!run.completedAt) return "Running"; const seconds = Math.max(0, Math.round((new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000)); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`; }

export default function ObservabilityPage() {
  const { id: workspaceId } = useParams<{ id: string }>();
  const [workflows, setWorkflows] = useState<WorkspaceWorkflow[]>([]);
  const [runs, setRuns] = useState<RunWithWorkflow[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.all([listWorkspaceWorkflows(workspaceId), listAuditEvents(workspaceId, { limit: 200 }), listIntegrations(workspaceId)])
      .then(async ([workflowList, audit, integrationList]) => {
        const runLists = await Promise.all(workflowList.map(async (workflow) => (await listWorkflowRuns(workspaceId, workflow.id)).map((run) => ({ ...run, workflowName: workflow.name }))));
        if (!cancelled) { setWorkflows(workflowList); setRuns(runLists.flat().sort((a, b) => b.startedAt.localeCompare(a.startedAt))); setEvents(audit.events); setIntegrations(integrationList); }
      })
      .catch((reason: Error) => { if (!cancelled) setError(reason.message || "Could not load observability data."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workspaceId]);

  const metrics = useMemo(() => {
    const completed = runs.filter((run) => run.status !== "running");
    const succeeded = completed.filter((run) => run.status === "succeeded");
    const failed = completed.filter((run) => run.status === "failed");
    const elapsed = completed.filter((run) => run.completedAt).map((run) => new Date(run.completedAt!).getTime() - new Date(run.startedAt).getTime());
    const averageSeconds = elapsed.length ? Math.round(elapsed.reduce((sum, value) => sum + value, 0) / elapsed.length / 1000) : null;
    const toolEvents = events.filter((event) => event.eventType.startsWith("action.") || event.eventType === "integration.connected");
    return { completed, succeeded, failed, averageSeconds, toolEvents };
  }, [events, runs]);

  return <main className="observability-page">
    <header className="observability-header"><div><p className="eyebrow">ADMIN OBSERVABILITY</p><h1>Operations console</h1><span>Monitor runs, governed tool activity, source health, latency, errors, and the workspace budget guard.</span></div><Link className="secondary-button" href={`/w/${workspaceId}/audit`}>Open activity log</Link></header>
    {error && <p className="error-text">{error}</p>}
    <section className="observability-metrics" aria-label="Operational health"><article><span>Run success</span><strong>{metrics.completed.length ? `${Math.round(metrics.succeeded.length / metrics.completed.length * 100)}%` : "—"}</strong><small>{metrics.succeeded.length} succeeded · {metrics.failed.length} failed</small></article><article><span>Average latency</span><strong>{metrics.averageSeconds === null ? "—" : `${metrics.averageSeconds}s`}</strong><small>completed workflow runs</small></article><article><span>Tool activity</span><strong>{metrics.toolEvents.length}</strong><small>governed calls in activity history</small></article><article><span>Sources healthy</span><strong>{integrations.length}/{providers.length}</strong><small>connected workspace integrations</small></article></section>
    <div className="observability-grid">
      <section className="observability-card observability-runs"><header><div><p>Run timelines</p><h2>Recent workflow executions</h2></div><Link href={`/w/${workspaceId}/workflows`}>Manage workflows</Link></header>{loading ? <p>Loading run history…</p> : runs.length ? <div className="run-timeline">{runs.slice(0, 12).map((run) => <article key={run.id}><span className={`run-dot ${run.status}`} /><div><strong>{run.workflowName}</strong><small>{run.trigger.replaceAll("_", " ")} · {relativeTime(run.startedAt)}</small>{run.detail && <em>{run.detail}</em>}</div><b>{duration(run)}</b></article>)}</div> : <div className="observability-empty">No workflow runs yet. Run a workflow to populate its timeline.</div>}</section>
      <section className="observability-card observability-traces"><header><div><p>Tool call tracing</p><h2>Governed tool activity</h2></div><Link href={`/w/${workspaceId}/audit?type=action.proposed`}>View all</Link></header>{metrics.toolEvents.length ? <div className="trace-list">{metrics.toolEvents.slice(0, 8).map((event) => <article key={event.id}><span className={`trace-state ${event.eventType.endsWith("failed") ? "failed" : event.eventType.endsWith("confirmed") ? "success" : "neutral"}`} /><div><strong>{event.eventType.replaceAll(".", " ")}</strong><small>{event.summary}</small></div><time>{relativeTime(event.createdAt)}</time></article>)}</div> : <div className="observability-empty">No governed tool calls have been recorded.</div>}</section>
      <section className="observability-card observability-health"><header><div><p>Integration health</p><h2>Source availability</h2></div><Link href={`/w/${workspaceId}/integrations`}>Manage sources</Link></header><div className="source-health">{providers.map((provider) => { const connected = integrations.some((integration) => integration.type === provider); return <div key={provider}><span className={connected ? "healthy" : "offline"} /><strong>{provider}</strong><small>{connected ? "Connected" : "Not connected"}</small></div>; })}</div></section>
      <section className="observability-card observability-budget"><header><div><p>Budgets and errors</p><h2>Runtime guardrails</h2></div></header><div className="budget-list"><div><span>Per-turn token guard</span><strong>8,192 tokens</strong><small>Default server guard; protects a turn from exhausting the provider rate limit.</small></div><div><span>Failed workflow runs</span><strong>{metrics.failed.length}</strong><small>{metrics.failed.length ? "Review failures in the run timeline or Activity." : "No failed completed runs recorded."}</small></div><div><span>Enabled workflows</span><strong>{workflows.filter((workflow) => workflow.enabled).length}</strong><small>{workflows.length} total workflows are configured in this workspace.</small></div></div></section>
    </div>
  </main>;
}
