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
  const [range, setRange] = useState<"24h" | "7d" | "30d" | "all">("7d");
  const [selectedRun, setSelectedRun] = useState<RunWithWorkflow | null>(null);
  const [compareRunId, setCompareRunId] = useState("");
  const [failureThreshold, setFailureThreshold] = useState(3);
  const [retentionDays, setRetentionDays] = useState(30);

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

  useEffect(() => { try { const stored = JSON.parse(window.localStorage.getItem(`mai:observability:${workspaceId}`) ?? "{}"); setFailureThreshold(stored.failureThreshold ?? 3); setRetentionDays(stored.retentionDays ?? 30); } catch {} }, [workspaceId]);
  function saveControls(next: { failureThreshold?: number; retentionDays?: number }) { const values = { failureThreshold: next.failureThreshold ?? failureThreshold, retentionDays: next.retentionDays ?? retentionDays }; setFailureThreshold(values.failureThreshold); setRetentionDays(values.retentionDays); window.localStorage.setItem(`mai:observability:${workspaceId}`, JSON.stringify(values)); }
  const filtered = useMemo(() => { const hours = range === "24h" ? 24 : range === "7d" ? 168 : range === "30d" ? 720 : Infinity; const cutoff = Date.now() - hours * 3600000; return { runs: runs.filter((run) => new Date(run.startedAt).getTime() >= cutoff), events: events.filter((event) => new Date(event.createdAt).getTime() >= cutoff) }; }, [events, range, runs]);
  const metrics = useMemo(() => {
    const completed = filtered.runs.filter((run) => run.status !== "running");
    const succeeded = completed.filter((run) => run.status === "succeeded");
    const failed = completed.filter((run) => run.status === "failed");
    const elapsed = completed.filter((run) => run.completedAt).map((run) => new Date(run.completedAt!).getTime() - new Date(run.startedAt).getTime());
    const averageSeconds = elapsed.length ? Math.round(elapsed.reduce((sum, value) => sum + value, 0) / elapsed.length / 1000) : null;
    const toolEvents = filtered.events.filter((event) => event.eventType.startsWith("action.") || event.eventType === "integration.connected");
    const estimatedTokens = filtered.runs.reduce((total, run) => total + run.estimatedTokens, 0);
    const estimatedCostUsd = filtered.runs.reduce((total, run) => total + run.estimatedCostUsd, 0);
    return { completed, succeeded, failed, averageSeconds, toolEvents, estimatedTokens, estimatedCostUsd };
  }, [filtered]);
  const errors = useMemo(() => [...metrics.failed.map((run) => run.detail || "Workflow execution failed"), ...filtered.events.filter((event) => event.eventType.endsWith("failed")).map((event) => event.summary)].reduce<Record<string, number>>((all, item) => { all[item] = (all[item] ?? 0) + 1; return all; }, {}), [filtered.events, metrics.failed]);
  const comparison = runs.find((run) => run.id === compareRunId) ?? null;
  function exportIncident() { const lines = ["Operational incident report", `Range,${range}`, `Runs,${metrics.completed.length}`, `Failures,${metrics.failed.length}`, `Average latency,${metrics.averageSeconds ?? "n/a"}s`, "", "Errors", ...Object.entries(errors).map(([message, count]) => `${count},\"${message.replaceAll('"', '""')}\"`)]; const blob = new Blob([lines.join("\n")], { type: "text/plain" }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = "workspace-incident-report.txt"; document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url); }

  return <main className="observability-page">
    <header className="observability-header"><div><p className="eyebrow">ADMIN OBSERVABILITY</p><h1>Operations console</h1><span>Monitor runs, governed tool activity, source health, latency, errors, and the workspace budget guard.</span></div><div className="observability-actions"><select value={range} onChange={(event) => setRange(event.target.value as typeof range)} aria-label="Observability time range"><option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option><option value="all">All time</option></select><button className="secondary-button" onClick={exportIncident}>Export incident</button><Link className="secondary-button" href={`/w/${workspaceId}/audit`}>Open activity log</Link></div></header>
    {error && <p className="error-text">{error}</p>}
    <section className="observability-metrics" aria-label="Operational health"><article><span>Run success</span><strong>{metrics.completed.length ? `${Math.round(metrics.succeeded.length / metrics.completed.length * 100)}%` : "—"}</strong><small>{metrics.succeeded.length} succeeded · {metrics.failed.length} failed</small></article><article><span>Average latency</span><strong>{metrics.averageSeconds === null ? "—" : `${metrics.averageSeconds}s`}</strong><small>completed workflow runs</small></article><article><span>Tool activity</span><strong>{filtered.runs.reduce((total, run) => total + run.toolCalls, 0)}</strong><small>recorded workflow tool calls</small></article><article><span>Usage and cost</span><strong>{metrics.estimatedTokens.toLocaleString()}</strong><small>${metrics.estimatedCostUsd.toFixed(4)} estimated workflow cost</small></article></section>
    <div className="observability-grid">
      <section className="observability-card observability-runs"><header><div><p>Run timelines</p><h2>Recent workflow executions</h2></div><Link href={`/w/${workspaceId}/workflows`}>Manage workflows</Link></header>{loading ? <p>Loading run history…</p> : filtered.runs.length ? <div className="run-timeline">{filtered.runs.slice(0, 12).map((run) => <button type="button" key={run.id} onClick={() => setSelectedRun(run)}><span className={`run-dot ${run.status}`} /><div><strong>{run.workflowName}</strong><small>{run.trigger.replaceAll("_", " ")} · {relativeTime(run.startedAt)}</small>{run.detail && <em>{run.detail}</em>}</div><b>{duration(run)}</b></button>)}</div> : <div className="observability-empty">No workflow runs in this time range.</div>}</section>
      <section className="observability-card observability-traces"><header><div><p>Tool call tracing</p><h2>Governed tool activity</h2></div><Link href={`/w/${workspaceId}/audit?type=action.proposed`}>View all</Link></header>{metrics.toolEvents.length ? <div className="trace-list">{metrics.toolEvents.slice(0, 8).map((event) => <article key={event.id}><span className={`trace-state ${event.eventType.endsWith("failed") ? "failed" : event.eventType.endsWith("confirmed") ? "success" : "neutral"}`} /><div><strong>{event.eventType.replaceAll(".", " ")}</strong><small>{event.summary}</small></div><time>{relativeTime(event.createdAt)}</time></article>)}</div> : <div className="observability-empty">No governed tool calls have been recorded.</div>}</section>
      <section className="observability-card observability-health"><header><div><p>Integration health</p><h2>Source availability</h2></div><Link href={`/w/${workspaceId}/integrations`}>Manage sources</Link></header><div className="source-health">{providers.map((provider) => { const connected = integrations.some((integration) => integration.type === provider); return <div key={provider}><span className={connected ? "healthy" : "offline"} /><strong>{provider}</strong><small>{connected ? "Connected" : "Not connected"}</small></div>; })}</div></section>
      <section className="observability-card observability-budget"><header><div><p>Budgets and errors</p><h2>Runtime guardrails</h2></div></header><div className="budget-list"><div><span>Per-turn token guard</span><strong>8,192 tokens</strong><small>Default server guard; protects a turn from exhausting the provider rate limit.</small></div><div><span>Failed workflow runs</span><strong>{metrics.failed.length}</strong><small>{metrics.failed.length ? "Review failures in the run timeline or Activity." : "No failed completed runs recorded."}</small></div><div><span>Enabled workflows</span><strong>{workflows.filter((workflow) => workflow.enabled).length}</strong><small>{workflows.length} total workflows are configured in this workspace.</small></div></div></section>
      <section className="observability-card"><header><div><p>Error grouping</p><h2>Root causes in this range</h2></div></header><div className="error-groups">{Object.keys(errors).length ? Object.entries(errors).slice(0, 5).map(([message, count]) => <div key={message}><b>{count}</b><span>{message}</span></div>) : <p className="observability-empty">No errors recorded in this range.</p>}</div></section>
      <section className="observability-card"><header><div><p>Alert rules</p><h2>Escalate repeated failures</h2></div></header><label className="observability-control">Alert after<select value={failureThreshold} onChange={(event) => saveControls({ failureThreshold: Number(event.target.value) })}><option value={1}>1 failed run</option><option value={3}>3 failed runs</option><option value={5}>5 failed runs</option></select></label><p className="observability-empty">{metrics.failed.length >= failureThreshold ? "Alert threshold reached. Review the grouped errors above." : `${failureThreshold - metrics.failed.length} more failed run${failureThreshold - metrics.failed.length === 1 ? "" : "s"} before this alert triggers.`}</p></section>
      <section className="observability-card"><header><div><p>Usage trends</p><h2>Runs and tool activity</h2></div></header><div className="trend-bars"><span style={{ height: `${Math.max(12, Math.min(100, filtered.runs.length * 12))}%` }}><b>{filtered.runs.length}</b><small>runs</small></span><span style={{ height: `${Math.max(12, Math.min(100, metrics.toolEvents.length * 12))}%` }}><b>{metrics.toolEvents.length}</b><small>calls</small></span><span style={{ height: `${Math.max(12, Math.min(100, metrics.failed.length * 25))}%` }}><b>{metrics.failed.length}</b><small>errors</small></span></div></section>
      <section className="observability-card"><header><div><p>Run comparison</p><h2>Compare with selected run</h2></div></header><select className="observability-compare" value={compareRunId} onChange={(event) => setCompareRunId(event.target.value)}><option value="">Choose a prior run</option>{runs.slice(0, 30).map((run) => <option key={run.id} value={run.id}>{run.workflowName} · {relativeTime(run.startedAt)}</option>)}</select>{selectedRun && comparison && <div className="comparison"><span>Selected: <b>{duration(selectedRun)}</b> · {selectedRun.status}</span><span>Compared: <b>{duration(comparison)}</b> · {comparison.status}</span></div>}<p className="observability-empty">Open a run from the timeline, then select another run to compare latency and outcome.</p></section>
      <section className="observability-card"><header><div><p>Data retention</p><h2>Trace retention policy</h2></div></header><label className="observability-control">Keep run traces for<select value={retentionDays} onChange={(event) => saveControls({ retentionDays: Number(event.target.value) })}><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option><option value={365}>1 year</option></select></label><p className="observability-empty">This workspace preference documents the intended retention period for operational data.</p></section>
    </div>
    {selectedRun && <section className="run-detail" role="dialog" aria-label="Workflow run details"><header><div><p>Run detail</p><h2>{selectedRun.workflowName}</h2></div><button onClick={() => setSelectedRun(null)}>Close</button></header><dl><div><dt>Status</dt><dd>{selectedRun.status}</dd></div><div><dt>Started</dt><dd>{new Date(selectedRun.startedAt).toLocaleString()}</dd></div><div><dt>Latency</dt><dd>{duration(selectedRun)}</dd></div><div><dt>Tool calls</dt><dd>{selectedRun.toolCalls}</dd></div><div><dt>Usage</dt><dd>{selectedRun.estimatedTokens.toLocaleString()} tokens · ${selectedRun.estimatedCostUsd.toFixed(4)}</dd></div><div><dt>Trigger</dt><dd>{selectedRun.trigger.replaceAll("_", " ")}</dd></div></dl><p>{selectedRun.detail || "The workflow completed without a recorded error detail."}</p>{selectedRun.outputExcerpt && <pre>{selectedRun.outputExcerpt}</pre>}<Link href={`/w/${workspaceId}/workflows`}>Open workflow →</Link></section>}
  </main>;
}
