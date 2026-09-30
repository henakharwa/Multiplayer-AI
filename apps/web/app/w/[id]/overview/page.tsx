"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { AuditEvent, IntegrationConfig, WorkspaceAgent, WorkspaceArtifact, WorkspaceMemory, WorkspaceWorkflow } from "@mai-chat/shared-types";
import { listAuditEvents, listIntegrations, listWorkspaceAgents, listWorkspaceArtifacts, listWorkspaceMemory, listWorkspaceWorkflows } from "../../../../lib/api";

type HubData = { agents: WorkspaceAgent[]; artifacts: WorkspaceArtifact[]; integrations: IntegrationConfig[]; memory: WorkspaceMemory[]; workflows: WorkspaceWorkflow[]; activity: AuditEvent[] };

function formatDate(value: string | null) {
  if (!value) return "Not scheduled";
  try { return new Date(value).toLocaleDateString([], { month: "short", day: "numeric" }); } catch { return value; }
}

function relativeTime(value: string) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}

const empty: HubData = { agents: [], artifacts: [], integrations: [], memory: [], workflows: [], activity: [] };

export default function WorkspaceOverviewPage() {
  const { id: workspaceId } = useParams<{ id: string }>();
  const [data, setData] = useState<HubData>(empty);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      listWorkspaceAgents(workspaceId), listWorkspaceArtifacts(workspaceId), listIntegrations(workspaceId),
      listWorkspaceMemory(workspaceId), listWorkspaceWorkflows(workspaceId), listAuditEvents(workspaceId),
    ]).then(([agents, artifacts, integrations, memory, workflows, audit]) => {
      if (!cancelled) setData({ agents, artifacts, integrations, memory, workflows, activity: audit.events });
    }).catch((reason: Error) => { if (!cancelled) setError(reason.message || "Could not load the workspace overview."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workspaceId]);

  const summary = useMemo(() => {
    const published = data.artifacts.filter((artifact) => artifact.status === "published").length;
    const activeWorkflows = data.workflows.filter((workflow) => workflow.enabled);
    const failedWorkflows = activeWorkflows.filter((workflow) => workflow.lastRunStatus === "failed");
    const upcoming = activeWorkflows.filter((workflow) => workflow.nextRunAt).sort((a, b) => (a.nextRunAt ?? "").localeCompare(b.nextRunAt ?? ""));
    return { published, activeWorkflows, failedWorkflows, upcoming, publishedAgents: data.agents.filter((agent) => agent.status === "published") };
  }, [data]);

  const nextAction = summary.failedWorkflows[0]
    ? `Review the failed “${summary.failedWorkflows[0].name}” workflow before its next run.`
    : summary.upcoming[0]
      ? `Review “${summary.upcoming[0].name}” before it runs ${formatDate(summary.upcoming[0].nextRunAt)}.`
      : data.integrations.length === 0
        ? "Connect a source so agents can work from current company context."
        : data.memory.length === 0
          ? "Capture a decision or note to give your agents durable context."
          : "Your workspace is ready. Start a focused conversation or create a reusable workflow.";

  return <main className="workspace-overview-page">
    <header className="workspace-hub-header">
      <div><p className="eyebrow">PROJECT HUB</p><h1>Work, context, and execution</h1><p>See what needs attention and move from discussion to an owned outcome.</p></div>
      <div className="workspace-hub-actions"><Link href={`/w/${workspaceId}`} className="primary-button">Ask an agent</Link><Link href={`/w/${workspaceId}/artifacts`} className="secondary-button">Create artifact</Link></div>
    </header>

    {error && <p className="error-text">{error}</p>}
    <section className="workspace-hub-metrics" aria-label="Workspace health">
      <article><span>Connected sources</span><strong>{data.integrations.length + data.memory.length}</strong><small>{data.integrations.length} tools · {data.memory.length} saved context</small></article>
      <article><span>Active execution</span><strong>{summary.activeWorkflows.length}</strong><small>{summary.failedWorkflows.length ? `${summary.failedWorkflows.length} need attention` : "Workflows are healthy"}</small></article>
      <article><span>Published outputs</span><strong>{summary.published}</strong><small>Plans, reports, releases, and dashboards</small></article>
      <article><span>Agent team</span><strong>{summary.publishedAgents.length}</strong><small>{data.agents.length - summary.publishedAgents.length} draft agents</small></article>
    </section>

    <section className="workspace-hub-next"><div><p>Next action</p><strong>{nextAction}</strong></div><Link href={summary.failedWorkflows.length ? `/w/${workspaceId}/workflows` : `/w/${workspaceId}/integrations`}>Open {summary.failedWorkflows.length ? "workflows" : "sources"} →</Link></section>

    <div className="workspace-hub-grid">
      <section className="workspace-hub-card workspace-hub-execution"><header><div><p>Execution</p><h2>Automations and ownership</h2></div><Link href={`/w/${workspaceId}/workflows`}>Manage</Link></header>
        {loading ? <p className="muted">Loading execution status…</p> : summary.activeWorkflows.length ? <div className="workspace-hub-list">{summary.activeWorkflows.slice(0, 4).map((workflow) => <Link key={workflow.id} href={`/w/${workspaceId}/workflows`}><span className={`hub-status ${workflow.lastRunStatus ?? "idle"}`} /><span><strong>{workflow.name}</strong><small>{workflow.trigger === "schedule" ? `Scheduled · ${formatDate(workflow.nextRunAt)}` : `${workflow.trigger.replace("_", " ")} trigger`}</small></span><em>{workflow.lastRunStatus ?? "Ready"}</em></Link>)}</div> : <div className="workspace-hub-empty"><strong>No active workflows</strong><span>Automate a repeatable update, review, or handoff.</span><Link href={`/w/${workspaceId}/workflows`}>Build a workflow</Link></div>}
      </section>

      <section className="workspace-hub-card"><header><div><p>Shared context</p><h2>What agents can use</h2></div><Link href={`/w/${workspaceId}/memory`}>Manage</Link></header>
        <div className="workspace-hub-context-summary"><span><b>{data.integrations.length}</b> live tools</span><span><b>{data.memory.length}</b> saved memories</span></div>
        {data.memory.slice(0, 3).map((memory) => <Link className="workspace-hub-source" key={memory.id} href={`/w/${workspaceId}/memory`}><span className="hub-source-icon">{memory.kind === "decision" ? "◆" : "▤"}</span><span><strong>{memory.title}</strong><small>{memory.sourceTitle ? `Source: ${memory.sourceTitle}` : "Workspace memory"}</small></span></Link>)}
        {!data.memory.length && !loading && <div className="workspace-hub-empty"><strong>Context is empty</strong><span>Save a decision, policy, or reference so agents can cite it.</span></div>}
      </section>

      <section className="workspace-hub-card"><header><div><p>Agent directory</p><h2>Specialists ready to work</h2></div><Link href={`/w/${workspaceId}/agents`}>Browse agents</Link></header>
        <div className="workspace-hub-agent-list">{summary.publishedAgents.slice(0, 4).map((agent) => <Link href={`/w/${workspaceId}?agentId=${agent.id}`} key={agent.id}><span className="hub-agent-avatar">{agent.name.slice(0, 1).toUpperCase()}</span><span><strong>{agent.name}</strong><small>{agent.approvedProviders.length ? `${agent.approvedProviders.join(", ")} enabled` : "Workspace context enabled"}</small></span><em>Use →</em></Link>)}</div>
        {!summary.publishedAgents.length && !loading && <div className="workspace-hub-empty"><strong>No published specialists</strong><span>Publish a custom agent for repeatable team work.</span><Link href={`/w/${workspaceId}/agents`}>Build an agent</Link></div>}
      </section>

      <section className="workspace-hub-card"><header><div><p>Recent activity</p><h2>Transparent work trail</h2></div><Link href={`/w/${workspaceId}/audit`}>View all</Link></header>
        <div className="workspace-hub-activity">{data.activity.slice(0, 5).map((event) => <Link href={`/w/${workspaceId}/audit`} key={event.id}><span className="hub-activity-dot" /><span><strong>{event.actorName}</strong> {event.summary}</span><time>{relativeTime(event.createdAt)}</time></Link>)}</div>
        {!data.activity.length && !loading && <p className="muted">Activity from people and agents will appear here.</p>}
      </section>

      <section className="workspace-hub-card workspace-hub-output"><header><div><p>Team deliverables</p><h2>Published artifacts</h2></div><Link href={`/w/${workspaceId}/artifacts`}>Open library</Link></header>
        <div className="workspace-hub-artifacts">{data.artifacts.filter((artifact) => artifact.status === "published").slice(0, 4).map((artifact) => <Link href={`/w/${workspaceId}/artifacts`} key={artifact.id}><span className={`hub-artifact-type ${artifact.type}`}>{artifact.type.replace("_", " ")}</span><strong>{artifact.title}</strong><small>{artifact.ownerName ?? "Unassigned"} · Updated {relativeTime(artifact.updatedAt)}</small></Link>)}</div>
        {!summary.published && !loading && <div className="workspace-hub-empty"><strong>No published output</strong><span>Turn team context into a plan, report, release note, dashboard, or task list.</span><Link href={`/w/${workspaceId}/artifacts`}>Create an artifact</Link></div>}
      </section>
    </div>
  </main>;
}
