"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import type { WorkspaceArtifact, WorkspaceArtifactComment, WorkspaceArtifactDashboard, WorkspaceArtifactVersion, WorkspaceMember } from "@mai-chat/shared-types";
import { ApiError, createWorkspaceArtifact, createWorkspaceArtifactComment, deleteWorkspaceArtifact, generateReleaseNotes, generateReport, listWorkspaceArtifactComments, listWorkspaceArtifactVersions, listWorkspaceArtifacts, listWorkspaceMembers, notifyDashboardHealthChange, pingDashboardPresence, refreshWorkspaceDashboard, restoreWorkspaceArtifactVersion, revokeWorkspaceArtifactShare, shareArtifactToSlack, shareWorkspaceArtifact, updateWorkspaceArtifact, type WorkspaceArtifactInput } from "../../../../lib/api";
import { DashboardCanvas } from "../../../_components/DashboardCanvas";

const empty: WorkspaceArtifactInput = { type: "plan", status: "draft", title: "", summary: "", content: "", ownerUserId: null };
// Placeholder shown only until a freshly-created dashboard gets its first
// "Refresh live data" -- there's no manual editor anymore (see the note
// below), so this is never hand-edited, just a starting point.
const newDashboard = (): WorkspaceArtifactDashboard => ({ health: "on_track", metrics: [], milestones: [], risks: [{ id: "risk", title: "No active risks", severity: "low", owner: "" }], decisions: [{ id: "decision", title: "No decisions needed", owner: "", dueDate: "" }], checklist: [] });
const labels = { plan: "Plan", report: "Report", release_notes: "Release notes", dashboard: "Dashboard", task_list: "Task list" } as const;
const templates: Array<{ type: WorkspaceArtifactInput["type"];
 title: string; summary: string; content: string }> = [
  { type: "plan", title: "Project plan", summary: "Goals, milestones, and owners.", content: "## Goal\n\n## Milestones\n- [ ]\n\n## Risks\n\n## Next step" },
  { type: "report", title: "Weekly team update", summary: "Progress, risks, and the next step.", content: "## Progress\n\n## Risks\n\n## Next step" },
  { type: "release_notes", title: "Release notes", summary: "What shipped and what teams need to know.", content: "## Highlights\n\n## Fixes\n\n## Known issues" },
  { type: "dashboard", title: "Project health", summary: "A live view of connected-tool activity, workflow health, and the audit trail.", content: "Auto-generated from this workspace's connected tools, workflows, and audit trail. Hit \"Refresh live data\" any time to pull the latest." },
  { type: "task_list", title: "Launch checklist", summary: "The work required before launch.", content: "- [ ] Confirm owner\n- [ ] Complete review\n- [ ] Publish update" },
];

const blockSuggestions: Partial<Record<WorkspaceArtifactInput["type"], Array<{ label: string; content: string }>>> = {
  plan: [
    { label: "+ Goal", content: "## Goal\nDescribe the outcome and why it matters." },
    { label: "+ Workstream", content: "## Workstream\n**Owner:** \n**Outcome:** \n**Target date:** " },
    { label: "+ Milestone", content: "## Milestone\n- [ ] Deliverable — Owner:  — Due: " },
    { label: "+ Risk", content: "## Risk\n**Risk:** \n**Mitigation:** \n**Owner:** " },
    { label: "+ Success metric", content: "## Success metric\n**Metric:** \n**Current:** \n**Target:** " },
  ],
  report: [
    { label: "+ Highlight", content: "## Highlight\nWhat changed, and why it matters." },
    { label: "+ Metric", content: "## Metric\n**Metric:** \n**Current:** \n**Target:** \n**Trend:** " },
    { label: "+ Blocker", content: "## Blocker\n**Blocker:** \n**Owner:** \n**Next action:** " },
    { label: "+ Decision", content: "## Decision needed\n**Decision:** \n**Owner:** \n**Due:** " },
  ],
  release_notes: [
    { label: "+ Shipped", content: "## Shipped\n- " },
    { label: "+ Fix", content: "## Fixed\n- " },
    { label: "+ Breaking change", content: "## Breaking changes\n- " },
    { label: "+ Rollout step", content: "## Rollout\n- [ ] " },
  ],
  task_list: [
    { label: "+ Task", content: "- [ ] New task — Owner:  — Due: " },
    { label: "+ Priority task", content: "- [ ] **High priority:** New task — Owner:  — Due: " },
    { label: "+ Dependency", content: "## Dependency\n- [ ] Waiting for: \n  - Owner: \n  - Needed by: " },
    { label: "+ Review step", content: "- [ ] Review and approve — Owner:  — Due: " },
  ],
};

export default function ArtifactsPage() {
  const { id: workspaceId } = useParams<{ id: string }>();
  const [artifacts, setArtifacts] = useState<WorkspaceArtifact[]>([]); const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [selected, setSelected] = useState<WorkspaceArtifact | null>(null); const [draft, setDraft] = useState<WorkspaceArtifactInput>(empty);
  const [comments, setComments] = useState<WorkspaceArtifactComment[]>([]); const [versions, setVersions] = useState<WorkspaceArtifactVersion[]>([]); const [comment, setComment] = useState(""); const [filter, setFilter] = useState<"all" | WorkspaceArtifactInput["type"]>("all"); const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [saving, setSaving] = useState(false);
  const [viewers, setViewers] = useState<{ userId: string; name: string }[]>([]);
  const refresh = async () => setArtifacts(await listWorkspaceArtifacts(workspaceId));
  useEffect(() => { void Promise.all([refresh(), listWorkspaceMembers(workspaceId)]).then(([, team]) => setMembers(team)).catch((err: Error) => setError(err.message)); }, [workspaceId]);

  // Live presence: "who else is looking at this dashboard right now" --
  // a lightweight heartbeat (services/chat-server's POST .../presence),
  // not a WebSocket, since a dashboard's data only changes on an explicit
  // refresh. Only runs while a Dashboard artifact is selected.
  useEffect(() => {
    if (!selected || selected.type !== "dashboard") { setViewers([]); return; }
    let cancelled = false;
    const ping = () => { void pingDashboardPresence(workspaceId, selected.id).then((list) => { if (!cancelled) setViewers(list); }).catch(() => {}); };
    ping();
    const interval = setInterval(ping, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [workspaceId, selected]);

  async function select(item: WorkspaceArtifact) { setSelected(item); setDraft({ type: item.type, status: item.status, title: item.title, summary: item.summary, content: item.content, dashboardData: item.dashboardData, ownerUserId: item.ownerUserId, releaseVersion: item.releaseVersion }); const [artifactComments, artifactVersions] = await Promise.all([listWorkspaceArtifactComments(workspaceId, item.id), listWorkspaceArtifactVersions(workspaceId, item.id)]); setComments(artifactComments); setVersions(artifactVersions); setError(""); setNotice(""); }
  async function save() { setSaving(true); setError(""); try { const saved = selected ? await updateWorkspaceArtifact(workspaceId, selected.id, draft) : await createWorkspaceArtifact(workspaceId, draft); await refresh(); await select(saved); setNotice(selected ? "Artifact updated." : "Artifact saved for the workspace."); } catch (err) { setError(err instanceof ApiError ? err.message : "Could not save artifact."); } finally { setSaving(false); } }
  async function remove() { if (!selected || !window.confirm(`Delete ${selected.title}?`)) return; setSaving(true); try { await deleteWorkspaceArtifact(workspaceId, selected.id); setSelected(null); setDraft(empty); setComments([]); await refresh(); } catch (err) { setError(err instanceof Error ? err.message : "Could not delete artifact."); } finally { setSaving(false); } }
  const visibleArtifacts = artifacts.filter((item) => filter === "all" || item.type === filter);
  function useTemplate(template: typeof templates[number]) { setSelected(null); setComments([]); setDraft({ ...empty, type: template.type, title: template.title, summary: template.summary, content: template.content, dashboardData: template.type === "dashboard" ? newDashboard() : null, releaseVersion: null }); setError(""); setNotice(""); }
  async function restore(version: WorkspaceArtifactVersion) { if (!selected || !window.confirm(`Restore version ${version.version}?`)) return; try { const restored = await restoreWorkspaceArtifactVersion(workspaceId, selected.id, version.id); await refresh(); await select(restored); setNotice(`Restored version ${version.version}.`); } catch (err) { setError(err instanceof Error ? err.message : "Could not restore version."); } }
  async function publishDashboard() { if (!selected) return; setSaving(true); try { const published = await updateWorkspaceArtifact(workspaceId, selected.id, { ...draft, status: "published" }); await refresh(); await select(published); setNotice("Dashboard published."); } catch (err) { setError(err instanceof Error ? err.message : "Could not publish dashboard."); } finally { setSaving(false); } }
  async function refreshDashboard() {
    if (!selected) return;
    setSaving(true);
    const previousHealth = selected.dashboardData?.health ?? null;
    try {
      const refreshed = await refreshWorkspaceDashboard(workspaceId, selected.id);
      await refresh(); await select(refreshed);
      setNotice("Dashboard refreshed with current workspace data.");
      const nextHealth = refreshed.dashboardData?.health ?? null;
      // Push a live notice to the workspace's chat only when the health
      // signal actually moved -- not on every routine refresh.
      if (previousHealth && nextHealth && previousHealth !== nextHealth) {
        void notifyDashboardHealthChange(workspaceId, selected.id, previousHealth, nextHealth);
      }
    } catch (err) { setError(err instanceof Error ? err.message : "Could not refresh dashboard."); } finally { setSaving(false); }
  }
  // Every artifact type can now carry a public link. Dashboard and
  // Release notes each render distinctly enough to keep their own public
  // pages (app/dashboard/[token], app/release-notes/[token]); Plan,
  // Report, and Task list share plain title/summary/content, so they all
  // point at the one generic page (app/shared/[token]).
  function publicUrlFor(item: WorkspaceArtifact) { const path = item.type === "dashboard" ? "dashboard" : item.type === "release_notes" ? "release-notes" : "shared"; return `${window.location.origin}/${path}/${item.shareToken}`; }
  async function createShareLink() {
    if (!selected) return;
    setSaving(true);
    try {
      const updated = await shareWorkspaceArtifact(workspaceId, selected.id);
      await refresh(); await select(updated);
      const url = publicUrlFor(updated);
      await navigator.clipboard.writeText(url).catch(() => {});
      setNotice(`Public link copied to your clipboard: ${url}`);
    } catch (err) { setError(err instanceof Error ? err.message : "Could not create a share link."); } finally { setSaving(false); }
  }
  async function copyShareLink() {
    if (!selected?.shareToken) return;
    const url = publicUrlFor(selected);
    await navigator.clipboard.writeText(url).catch(() => {});
    setNotice(`Public link copied to your clipboard: ${url}`);
  }
  async function revokeShareLink() {
    if (!selected) return;
    setSaving(true);
    try { const updated = await revokeWorkspaceArtifactShare(workspaceId, selected.id); await refresh(); await select(updated); setNotice("Public link revoked."); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not revoke the share link."); } finally { setSaving(false); }
  }
  async function generateFromGithub() {
    if (!selected) return;
    setSaving(true);
    try { const generated = await generateReleaseNotes(workspaceId, selected.id); await refresh(); await select(generated); setNotice("Drafted from GitHub activity -- review before publishing."); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not generate release notes."); } finally { setSaving(false); }
  }
  async function shareToSlack() {
    if (!selected) return;
    const channel = window.prompt("Which Slack channel? (e.g. #product-updates or a channel ID)");
    if (!channel) return;
    setSaving(true);
    try { await shareArtifactToSlack(workspaceId, selected.id, channel.replace(/^#/, "")); setNotice(`Posted to Slack (#${channel.replace(/^#/, "")}).`); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not share to Slack."); } finally { setSaving(false); }
  }
  async function generateFromAuditTrail() {
    if (!selected) return;
    setSaving(true);
    try { const generated = await generateReport(workspaceId, selected.id); await refresh(); await select(generated); setNotice("Drafted from this workspace's activity -- review before publishing."); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not generate report."); } finally { setSaving(false); }
  }
  async function addComment() { if (!selected || !comment.trim()) return; try { const created = await createWorkspaceArtifactComment(workspaceId, selected.id, comment); setComments((items) => [...items, created]); setComment(""); } catch (err) { setError(err instanceof Error ? err.message : "Could not add comment."); } }  function addSuggestedBlock(content: string) {
    setDraft((current) => ({ ...current, content: current.content.trim() ? `${current.content.trim()}\n\n${content}` : content }));
    setNotice("Added a structured block. Fill in its details below.");
  }
  // Shared across every artifact type that can have a public link (see
  // publicUrlFor above -- that's all five now).
  const shareControls = selected ? (selected.shareToken ? <>
    <button type="button" className="secondary-button" onClick={() => void copyShareLink()}>Copy public link</button>
    <button type="button" className="secondary-button" disabled={saving} onClick={() => void revokeShareLink()}>Revoke public link</button>
  </> : <button type="button" className="secondary-button" disabled={saving} onClick={() => void createShareLink()}>Create public link</button>) : null;
  // Plan and Task list use the same "- [ ] / - [x]" checklist convention
  // as the templates above -- parse it client-side for a quick progress
  // readout; no backend change needed since it's just counting markdown.
  function checklistProgress(content: string): { done: number; total: number } | null {
    const items = content.match(/^- \[[ xX]\]/gm);
    if (!items || !items.length) return null;
    return { done: items.filter((item) => /\[[xX]\]/.test(item)).length, total: items.length };
  }
  return <main className="workspace-settings-page artifacts-page"><header><p className="eyebrow">COLLABORATION ARTIFACTS</p><h1>Turn team work into shared artifacts</h1><p>Create plans, reports, release notes, dashboards, and task lists that teammates can own, review, and discuss.</p></header><section className="artifact-overview"><div><strong>{artifacts.length}</strong><span>Shared artifacts</span></div><div><strong>{artifacts.filter((item) => item.status === "published").length}</strong><span>Published</span></div><div><strong>{artifacts.reduce((total, item) => total + (item.status === "draft" ? 1 : 0), 0)}</strong><span>In draft</span></div></section><section className="artifact-templates"><div><p className="eyebrow">START FROM A TEMPLATE</p><h2>Build a useful team artifact faster</h2></div><div className="template-grid">{templates.map((template) => <button key={template.type} className={`template-card ${template.type}`} onClick={() => useTemplate(template)}><span>{labels[template.type]}</span><strong>{template.title}</strong><small>{template.summary}</small></button>)}</div></section><div className="artifacts-layout">
    <section className="artifacts-list"><div className="section-heading"><h2>Artifacts</h2><button onClick={() => { setSelected(null); setDraft(empty); setComments([]); setError(""); setNotice(""); }}>New artifact</button></div><div className="artifact-filter"><button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>All</button>{Object.entries(labels).map(([type, label]) => <button key={type} className={filter === type ? "active" : ""} onClick={() => setFilter(type as WorkspaceArtifactInput["type"])}>{label}</button>)}</div>{visibleArtifacts.length ? visibleArtifacts.map((item) => <button key={item.id} className={`artifact-card ${item.type} ${selected?.id === item.id ? "selected" : ""}`} onClick={() => void select(item)}><span className={`artifact-status ${item.status}`}>{item.status}</span><strong>{item.title}</strong><small>{labels[item.type]}{item.releaseVersion ? ` · ${item.releaseVersion}` : ""} · {item.ownerName ?? "Unassigned"}</small></button>) : <p className="muted">No artifacts yet. Save the next useful team output here.</p>}</section>
    <section className="artifact-form"><div className="section-heading"><h2>{selected ? selected.title : "New artifact"}</h2><span className="artifact-type-label">{labels[draft.type]}</span></div><div className="artifact-two-columns"><label>Type<select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as WorkspaceArtifactInput["type"] })}>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Status<select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as WorkspaceArtifactInput["status"] })}><option value="draft">Draft</option><option value="published" disabled={draft.type === "dashboard"}>Published</option><option value="archived">Archived</option></select></label></div><label>Title<input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Release readiness plan" /></label><label>Summary<input value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} placeholder="A concise description for the workspace" /></label><label>Owner<select value={draft.ownerUserId ?? ""} onChange={(e) => setDraft({ ...draft, ownerUserId: e.target.value || null })}><option value="">Unassigned</option>{members.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select></label>
      {draft.type !== "dashboard" && blockSuggestions[draft.type] && <section className="artifact-guided-builder"><div><p className="eyebrow">GUIDED BUILDER</p><h3>{labels[draft.type]} building blocks</h3><p>Add a structured section, then fill in its details in the artifact below.</p></div><div>{blockSuggestions[draft.type]!.map((block) => <button type="button" key={block.label} onClick={() => addSuggestedBlock(block.content)}>{block.label}</button>)}</div></section>}      {draft.type === "dashboard" ? <>
        {/* A dashboard's numbers come from the workspace itself (connected
            tools, workflows, and the audit trail -- see
            workspaceDashboardSnapshot in services/chat-server/src/server.ts),
            so there's no manual editor here: hand-typed values would just
            get overwritten by the next refresh. This view is always a
            read-only live snapshot; "Refresh live data" is the only way
            to change it. */}
        <DashboardCanvas value={draft.dashboardData ?? newDashboard()} versions={versions} updatedAt={selected?.updatedAt ?? new Date().toISOString()} />
        {selected && viewers.length > 0 && <p className="dashboard-viewers">Also viewing now: {viewers.map((viewer) => viewer.name).join(", ")}</p>}
        {selected && <div className="dashboard-actions-row">
          <button type="button" className="secondary-button dashboard-refresh-button" disabled={saving} onClick={() => void refreshDashboard()}>{saving ? "Refreshing…" : "Refresh live data"}</button>
          {shareControls}
        </div>}
      </> : draft.type === "release_notes" ? <>
        <label>Version / tag<input value={draft.releaseVersion ?? ""} onChange={(e) => setDraft({ ...draft, releaseVersion: e.target.value || null })} placeholder="v1.2.0 or Sprint 14" /></label>
        {selected && <div className="dashboard-actions-row">
          <button type="button" className="secondary-button" disabled={saving} onClick={() => void generateFromGithub()}>{saving ? "Generating…" : "Generate from GitHub"}</button>
          <button type="button" className="secondary-button" disabled={saving} onClick={() => void shareToSlack()}>Share to Slack</button>
          {shareControls}
        </div>}
      </> : draft.type === "report" ? <>
        {selected && <div className="dashboard-actions-row">
          <button type="button" className="secondary-button" disabled={saving} onClick={() => void generateFromAuditTrail()}>{saving ? "Generating…" : "Generate from activity"}</button>
          <button type="button" className="secondary-button" disabled={saving} onClick={() => void shareToSlack()}>Share to Slack</button>
          {shareControls}
        </div>}
      </> : (draft.type === "plan" || draft.type === "task_list") ? <>
        {(() => { const progress = checklistProgress(draft.content); return progress && progress.total > 0 ? (
          <div className="artifact-checklist-progress">
            <div className="readiness-track"><i style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div>
            <small className="muted">{progress.done}/{progress.total} complete</small>
          </div>
        ) : null; })()}
        {selected && <div className="dashboard-actions-row">{shareControls}</div>}
      </> : null}
      <label>Notes and context<textarea rows={draft.type === "dashboard" ? 4 : 11} value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} placeholder="Write the shared artifact. Use headings and checklist items where helpful." /></label>{error && <p className="error-text">{error}</p>}{notice && <p className="success-text">{notice}</p>}<div className="agent-builder-actions"><button className="primary-button" disabled={saving || !draft.title.trim() || !draft.content.trim()} onClick={() => void save()}>{saving ? "Saving…" : selected ? "Save changes" : "Save artifact"}</button>{selected && draft.type === "dashboard" && draft.status !== "published" && <button className="secondary-button" disabled={saving} onClick={() => void publishDashboard()}>Publish dashboard</button>}{selected && <button className="agent-delete-button" disabled={saving} onClick={() => void remove()}>Delete artifact</button>}</div>{selected && <><section className="artifact-history"><h3>Version history</h3>{versions.slice(0, 5).map((version) => <div key={version.id}><span>Version {version.version} · {version.savedByName ?? "Former member"}</span><button className="secondary-button" onClick={() => void restore(version)}>Restore</button></div>)}</section><section className="artifact-comments"><h3>Comments</h3>{comments.map((entry) => <article key={entry.id}><strong>{entry.authorName ?? "Former member"}</strong><small>{new Date(entry.createdAt).toLocaleString()}</small><p>{entry.content}</p></article>)}<div><textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Leave feedback for the team" /><button className="secondary-button" disabled={!comment.trim()} onClick={() => void addComment()}>Add comment</button></div></section></>}</section>
  </div></main>;
}
