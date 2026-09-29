import type { CSSProperties } from "react";
import type { WorkspaceArtifactDashboard, WorkspaceArtifactVersion } from "@mai-chat/shared-types";

// Read-only rendering of a Dashboard artifact's live snapshot. Pulled out
// of apps/web/app/w/[id]/artifacts/page.tsx so the same view can be
// reused both inside the workspace (ArtifactsPage) and on the
// unauthenticated public share link (app/dashboard/[token]/page.tsx) --
// see server.ts's GET /public/dashboards/:token. There's deliberately no
// editing here anymore: a dashboard's numbers come from the workspace's
// connected tools, workflows, and audit trail (services/chat-server/src
// /server.ts's workspaceDashboardSnapshot), so a hand-typed override
// would just get silently discarded the next time someone hits "Refresh
// live data" -- see the removal note in artifacts/page.tsx.
export function DashboardCanvas({ value, versions, updatedAt }: { value: WorkspaceArtifactDashboard; versions: WorkspaceArtifactVersion[]; updatedAt: string }) {
  const health = value.health === "on_track" ? { label: "On track", color: "#168451", progress: 82 } : value.health === "at_risk" ? { label: "At risk", color: "#c27b00", progress: 52 } : { label: "Off track", color: "#c43831", progress: 24 };
  const history = versions.slice(0, 8).reverse().map((version) => version.dashboardData?.milestones[0]?.progress ?? 0);
  const points = history.length > 1 ? history.map((point, index) => `${(index / (history.length - 1)) * 180 + 10},${90 - point * .7}`).join(" ") : "10,90 190,90";
  return (
    <section className="dashboard-canvas">
      <div className="dashboard-canvas-head">
        <div><p>PROJECT HEALTH</p><h2>{health.label}</h2></div>
        <div className="health-gauge" style={{ "--health": `${health.progress}%`, "--health-color": health.color } as CSSProperties}><span>{health.progress}</span><small>/100</small></div>
      </div>
      <p className="dashboard-freshness">Live workspace snapshot · refreshed {new Date(updatedAt).toLocaleString()}</p>
      <div className="dashboard-chart-grid">
        <section className="dashboard-visual-card">
          <h3>Key metrics</h3>
          <div className="visual-metrics">{value.metrics.map((metric) => <article key={metric.id}><span>{metric.label}</span><strong>{metric.value || "—"}</strong><small>Target {metric.target || "—"}</small></article>)}</div>
        </section>
        <section className="dashboard-visual-card">
          <h3>Readiness trend</h3>
          <svg className="dashboard-trend" viewBox="0 0 200 100" role="img" aria-label="Readiness history"><polyline points={points} /></svg>
          <small>{history.length > 1 ? `${history.length} saved dashboard snapshots` : "Refresh the dashboard again to build trend history"}</small>
        </section>
      </div>
      <div className="dashboard-chart-grid">
        <section className="dashboard-visual-card">
          <h3>Milestone progress</h3>
          <div className="bar-chart">{value.milestones.map((milestone) => <div key={milestone.id}><span>{milestone.label}</span><div><i style={{ width: `${milestone.progress}%` }} /></div><b>{milestone.progress}%</b></div>)}</div>
        </section>
      </div>
      <div className="dashboard-chart-grid">
        <section className="dashboard-visual-card risks">
          <h3>Risks and blockers</h3>
          {value.risks.filter((risk) => risk.title).length ? value.risks.filter((risk) => risk.title).map((risk) => <div key={risk.id}><span className={`risk-dot ${risk.severity}`} />{risk.title}<b>{risk.severity}</b></div>) : <p>No active risks</p>}
        </section>
        <section className="dashboard-visual-card decisions">
          <h3>Decisions needed</h3>
          {value.decisions.filter((decision) => decision.title).length ? value.decisions.filter((decision) => decision.title).map((decision) => <div key={decision.id}><strong>{decision.title}</strong><small>{decision.dueDate ? `Due ${decision.dueDate}` : "No due date"}</small></div>) : <p>No open decisions</p>}
        </section>
      </div>
      <section className="dashboard-visual-card checklist-chart">
        <h3>Launch readiness</h3>
        <div className="readiness-number">{value.checklist.filter((item) => item.done).length}<span>/{value.checklist.length} complete</span></div>
        <div className="readiness-track"><i style={{ width: `${value.checklist.length ? (value.checklist.filter((item) => item.done).length / value.checklist.length) * 100 : 0}%` }} /></div>
        {value.checklist.map((item) => <span key={item.id} className={item.done ? "done" : ""}>{item.done ? "✓" : "○"} {item.label}</span>)}
      </section>
    </section>
  );
}
