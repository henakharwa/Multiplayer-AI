"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import type { WorkspaceArtifact, WorkspaceArtifactComment, WorkspaceArtifactDashboard, WorkspaceArtifactVersion, WorkspaceMember } from "@mai-chat/shared-types";
import { ApiError, createWorkspaceArtifact, createWorkspaceArtifactComment, deleteWorkspaceArtifact, generateAssistedArtifactDraft, generateReleaseNotes, generateReport, listWorkspaceArtifactComments, listWorkspaceArtifactVersions, listWorkspaceArtifacts, listWorkspaceMembers, notifyDashboardHealthChange, pingDashboardPresence, refreshWorkspaceDashboard, restoreWorkspaceArtifactVersion, updateWorkspaceArtifact, type WorkspaceArtifactInput } from "../../../../lib/api";
import { DashboardCanvas } from "../../../_components/DashboardCanvas";
import { PlanVisual } from "../../../_components/PlanVisual";
import { ReportVisual } from "../../../_components/ReportVisual";
import { ReleaseNotesVisual } from "../../../_components/ReleaseNotesVisual";
import { TaskListVisual } from "../../../_components/TaskListVisual";

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
  const [selected, setSelected] = useState<WorkspaceArtifact | null>(null); const [draft, setDraft] = useState<WorkspaceArtifactInput>(empty); const [builderStep, setBuilderStep] = useState<"setup" | "compose" | "review">("setup");
  const [comments, setComments] = useState<WorkspaceArtifactComment[]>([]); const [versions, setVersions] = useState<WorkspaceArtifactVersion[]>([]); const [comment, setComment] = useState(""); const [filter, setFilter] = useState<"all" | WorkspaceArtifactInput["type"]>("all"); const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [saving, setSaving] = useState(false);
  const [viewers, setViewers] = useState<{ userId: string; name: string }[]>([]);
  const [assistantPrompt, setAssistantPrompt] = useState(""); const [taskListEditing, setTaskListEditing] = useState(false); const [releaseEditing, setReleaseEditing] = useState(false); const [reportEditing, setReportEditing] = useState(false); const [planEditing, setPlanEditing] = useState(false);
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

  async function select(item: WorkspaceArtifact) { setPlanEditing(false); setReportEditing(false); setReleaseEditing(false); setTaskListEditing(false); setBuilderStep("setup"); setSelected(item); setDraft({ type: item.type, status: item.status, title: item.title, summary: item.summary, content: item.content, dashboardData: item.dashboardData, ownerUserId: item.ownerUserId, releaseVersion: item.releaseVersion }); const [artifactComments, artifactVersions] = await Promise.all([listWorkspaceArtifactComments(workspaceId, item.id), listWorkspaceArtifactVersions(workspaceId, item.id)]); setComments(artifactComments); setVersions(artifactVersions); setError(""); setNotice(""); }
  async function save() { setSaving(true); setError(""); try { const saved = selected ? await updateWorkspaceArtifact(workspaceId, selected.id, draft) : await createWorkspaceArtifact(workspaceId, draft); await refresh(); await select(saved); setPlanEditing(false); setReportEditing(false); setReleaseEditing(false); setTaskListEditing(false); setNotice(selected ? "Artifact updated." : "Artifact saved for the workspace."); } catch (err) { setError(err instanceof ApiError ? err.message : "Could not save artifact."); } finally { setSaving(false); } }
  async function remove() { if (!selected || !window.confirm(`Delete ${selected.title}?`)) return; setSaving(true); try { await deleteWorkspaceArtifact(workspaceId, selected.id); setSelected(null); setDraft(empty); setComments([]); await refresh(); } catch (err) { setError(err instanceof Error ? err.message : "Could not delete artifact."); } finally { setSaving(false); } }
  const visibleArtifacts = artifacts.filter((item) => filter === "all" || item.type === filter);
  function useTemplate(template: typeof templates[number]) { setSelected(null); setComments([]); setDraft({ ...empty, type: template.type, title: "", summary: "", content: template.type === "dashboard" ? template.content : "", dashboardData: template.type === "dashboard" ? newDashboard() : null, releaseVersion: null }); setError(""); setNotice(""); }
  async function restore(version: WorkspaceArtifactVersion) { if (!selected || !window.confirm(`Restore version ${version.version}?`)) return; try { const restored = await restoreWorkspaceArtifactVersion(workspaceId, selected.id, version.id); await refresh(); await select(restored); setNotice(`Restored version ${version.version}.`); } catch (err) { setError(err instanceof Error ? err.message : "Could not restore version."); } }
  async function publishTaskList() { if (!selected) return; setSaving(true); try { const published = await updateWorkspaceArtifact(workspaceId, selected.id, { ...draft, status: "published" }); await refresh(); await select(published); setTaskListEditing(false); setNotice("Task list published as a delivery calendar."); } catch (err) { setError(err instanceof Error ? err.message : "Could not publish task list."); } finally { setSaving(false); } }
  async function publishReleaseNotes() { if (!selected) return; setSaving(true); try { const published = await updateWorkspaceArtifact(workspaceId, selected.id, { ...draft, status: "published" }); await refresh(); await select(published); setReleaseEditing(false); setNotice("Release notes published as a change log."); } catch (err) { setError(err instanceof Error ? err.message : "Could not publish release notes."); } finally { setSaving(false); } }
  async function publishReport() { if (!selected) return; setSaving(true); try { const published = await updateWorkspaceArtifact(workspaceId, selected.id, { ...draft, status: "published" }); await refresh(); await select(published); setReportEditing(false); setNotice("Report published as a decision timeline."); } catch (err) { setError(err instanceof Error ? err.message : "Could not publish report."); } finally { setSaving(false); } }
  async function publishPlan() { if (!selected) return; setSaving(true); try { const published = await updateWorkspaceArtifact(workspaceId, selected.id, { ...draft, status: "published" }); await refresh(); await select(published); setPlanEditing(false); setNotice("Plan published in the selected visual layout."); } catch (err) { setError(err instanceof Error ? err.message : "Could not publish plan."); } finally { setSaving(false); } }
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
  async function generateAssistedDraft() {
    if (!draft.title.trim()) { setError("Add a title before creating an AI-assisted draft."); return; }
    setSaving(true); setError("");
    try {
      // AI generation needs a persisted artifact ID. For a new artifact, save
      // the smallest possible draft first, then immediately replace its
      // content with the model's grounded draft in the same user action.
      const target = selected ?? await createWorkspaceArtifact(workspaceId, draft);
      const generated = await generateAssistedArtifactDraft(workspaceId, target.id, assistantPrompt);
      await refresh(); await select(generated); setAssistantPrompt("");
      setNotice("Created an AI-assisted draft grounded in workspace context. Review and edit it before publishing.");
    } catch (err) { setError(err instanceof Error ? err.message : "Could not create an assisted draft."); } finally { setSaving(false); }
  }
  async function generateFromGithub() {
    if (!selected) return;
    setSaving(true);
    try { const generated = await generateReleaseNotes(workspaceId, selected.id); await refresh(); await select(generated); setNotice("Drafted from GitHub activity -- review before publishing."); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not generate release notes."); } finally { setSaving(false); }
  }
  async function generateAiReportVisual() {
    if (!selected) { setError("Save the report before generating an AI visual source."); return; }
    setSaving(true); setError("");
    try {
      const generated = await generateAssistedArtifactDraft(workspaceId, selected.id, "Create a comprehensive, visual-ready report source. Use every relevant detail from the report title, summary, notes, workspace memory, connected tools, and recent workspace activity. Preserve factual detail. Organize it with clear headings for highlights, progress, risks, decisions, metrics, and next steps so every report view can use the complete information.");
      await refresh(); await select(generated); setNotice("AI generated a complete visual-ready report source from your report inputs and workspace context.");
    } catch (err) { setError(err instanceof Error ? err.message : "Could not generate the AI report visual source."); } finally { setSaving(false); }
  }  async function generateFromAuditTrail() {
    if (!selected) return;
    setSaving(true);
    try { const generated = await generateReport(workspaceId, selected.id); await refresh(); await select(generated); setNotice("Drafted from this workspace's activity -- review before publishing."); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not generate report."); } finally { setSaving(false); }
  }
  async function addComment() { if (!selected || !comment.trim()) return; try { const created = await createWorkspaceArtifactComment(workspaceId, selected.id, comment); setComments((items) => [...items, created]); setComment(""); } catch (err) { setError(err instanceof Error ? err.message : "Could not add comment."); } }  function addSuggestedBlock(content: string) {
    setDraft((current) => ({ ...current, content: current.content.trim() ? `${current.content.trim()}\n\n${content}` : content }));
    setNotice("Added a structured block. Fill in its details below.");
  }
  // Plan and Task list use the same "- [ ] / - [x]" checklist convention
  // as the templates above -- parse it client-side for a quick progress
  // readout; no backend change needed since it's just counting markdown.
  function preparePlanTasks() {
    setDraft((current) => {
      if (/## Delivery tasks/i.test(current.content)) return current;
      const clean = (line: string) => line.replace(/<!--plan-stage:[^>]+-->/g, "").replace(/(\*\*|__|`|~~|\*)/g, "").replace(/[□☐]/g, "").replace(/\bTBD\b/gi, "").replace(/^\s*(?:[-*+]\s+|\d+\s*[.)]\s*)/, "").replace(/^\||\|$/g, "").split("|").map((part) => part.trim()).filter(Boolean).join(" · ").replace(/\s*[·|]\s*(?=[·|]|$)/g, "").replace(/\s+/g, " ").trim();
      const existing = new Set([...current.content.matchAll(/^\s*[-*+]\s+\[[ xX]\]\s*(.+?)(?:\s*<!--|$)/gm)].map((match) => clean(match[1]).toLowerCase()));
      const candidates = current.content.split(/\r?\n/).filter((line) => /^\s*(?:[-*+]\s+|\d+\s*[.)]\s*|\|)/.test(line) && !/^\s*[-*+]\s+\[[ xX]\]/.test(line)).map(clean).filter((line) => line.length > 3 && !/^(item|milestone|owner|due date|status)(\s*·|$)/i.test(line)).filter((line) => !existing.has(line.toLowerCase()));
      const unique = [...new Set(candidates.map((line) => line.toLowerCase()))].map((normalized) => candidates.find((line) => line.toLowerCase() === normalized)!);
      return unique.length ? { ...current, content: `${current.content.trim()}\n\n## Delivery tasks\n${unique.map((line) => `- [ ] ${line} <!--plan-stage:todo-->`).join("\n")}` } : current;
    });
    setPlanEditing(true);
    setNotice("Workstream items are now delivery tasks. Move them through the board, then save changes.");
  }
  function advancePlanTask(taskIndex: number, direction: "next" | "previous") {
    let currentIndex = -1; const stages = ["todo", "progress", "review", "done"] as const;
    setDraft((current) => ({ ...current, content: current.content.replace(/^(\s*[-*+]\s+\[)([ xX])(\]\s+.+)$/gm, (line, prefix, checked, suffix) => {
      currentIndex += 1; if (currentIndex !== taskIndex) return line;
      const currentStage = /<!--plan-stage:(todo|progress|review|done)-->/.exec(suffix)?.[1] ?? (/[xX]/.test(checked) ? "done" : "todo");
      const position = stages.indexOf(currentStage as typeof stages[number]); const nextStage = stages[Math.max(0, Math.min(stages.length - 1, position + (direction === "previous" ? -1 : 1)))];
      const text = suffix.replace(/\s*<!--plan-stage:(todo|progress|review|done)-->/, "").trimEnd();
      return `${prefix}${nextStage === "done" ? "x" : " "}${text} <!--plan-stage:${nextStage}-->`;
    }) }));
    setNotice(direction === "previous" ? "Moved the task back to Review." : "Moved the task to its next delivery stage. Save changes to share it with the workspace.");
  }  function toggleTaskListItem(taskIndex: number) { let currentIndex = -1; setDraft((current) => ({ ...current, content: current.content.replace(/^(\s*[-*+]\s+\[)([ xX])(\]\s+.+)$/gm, (line, prefix, checked, suffix) => { currentIndex += 1; return currentIndex === taskIndex ? `${prefix}${/[xX]/.test(checked) ? " " : "x"}${suffix}` : line; }) })); setNotice("Schedule updated. Save changes to share it with the workspace."); }
    function checklistProgress(content: string): { done: number; total: number } | null {
    const items = content.match(/^- \[[ xX]\]/gm);
    if (!items || !items.length) return null;
    return { done: items.filter((item) => /\[[xX]\]/.test(item)).length, total: items.length };
  }
  return <main className="workspace-settings-page artifacts-page"><header><p className="eyebrow">COLLABORATION ARTIFACTS</p><h1>Turn team work into shared artifacts</h1><p>Create plans, reports, release notes, dashboards, and task lists that teammates can own, review, and discuss.</p></header><section className="artifact-overview"><div><strong>{artifacts.length}</strong><span>Shared artifacts</span></div><div><strong>{artifacts.filter((item) => item.status === "published").length}</strong><span>Published</span></div><div><strong>{artifacts.reduce((total, item) => total + (item.status === "draft" ? 1 : 0), 0)}</strong><span>In draft</span></div></section><section className="artifact-templates"><div><p className="eyebrow">START FROM A TEMPLATE</p><h2>Build a useful team artifact faster</h2></div><div className="template-grid">{templates.map((template) => <button key={template.type} className={`template-card ${template.type}`} onClick={() => useTemplate(template)}><span>{labels[template.type]}</span><strong>{template.title}</strong><small>{template.summary}</small></button>)}</div></section><div className="artifacts-layout">
    <section className="artifacts-list"><div className="section-heading"><h2>Artifacts</h2><button onClick={() => { setSelected(null); setDraft(empty); setComments([]); setError(""); setNotice(""); }}>New artifact</button></div><div className="artifact-filter"><button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>All</button>{Object.entries(labels).map(([type, label]) => <button key={type} className={filter === type ? "active" : ""} onClick={() => setFilter(type as WorkspaceArtifactInput["type"])}>{label}</button>)}</div>{visibleArtifacts.length ? visibleArtifacts.map((item) => <button key={item.id} className={`artifact-card ${item.type} ${selected?.id === item.id ? "selected" : ""}`} onClick={() => void select(item)}><span className={`artifact-status ${item.status}`}>{item.status}</span><strong>{item.title}</strong><small>{labels[item.type]}{item.releaseVersion ? ` · ${item.releaseVersion}` : ""} · {item.ownerName ?? "Unassigned"}</small></button>) : <p className="muted">No artifacts yet. Save the next useful team output here.</p>}</section>
    <section className={`artifact-form artifact-builder artifact-step-${builderStep}`}><div className="section-heading"><h2>{selected ? selected.title : "New artifact"}</h2><span className="artifact-type-label">{labels[draft.type]}</span></div>{!selected && <section className="artifact-builder-steps"><section className="artifact-review-summary"><p>REVIEW</p><strong>{draft.title || "Untitled artifact"}</strong><span>{labels[draft.type]} · {draft.ownerUserId ? members.find((member) => member.id === draft.ownerUserId)?.displayName ?? "Assigned" : "Unassigned"}</span><small>{draft.summary || "No summary added"}</small><em>{draft.content ? `${draft.content.length.toLocaleString()} characters of content ready` : "No artifact content added"}</em></section>{([['setup','Setup'],['compose','Compose'],['review','Review']] as const).map(([step,label],index)=><button type="button" key={step} className={builderStep===step?"active":""} onClick={()=>setBuilderStep(step)}><span>{index+1}</span>{label}</button>)}</section>}{!selected && <p className="artifact-builder-guidance">{builderStep==="setup"?"Choose the artifact type, owner, and outcome.":builderStep==="compose"?"Use guided blocks or AI assistance to prepare the content.":"Review the artifact, then save it as a draft."}</p>}{!((draft.type === "plan" && draft.status === "published" && !planEditing) || (draft.type === "report" && draft.status === "published" && !reportEditing) || (draft.type === "release_notes" && draft.status === "published" && !releaseEditing) || (draft.type === "task_list" && draft.status === "published" && !taskListEditing)) && <><section className="artifact-setup-fields"><div className="artifact-two-columns"><label>Type<select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as WorkspaceArtifactInput["type"] })}>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Status<select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as WorkspaceArtifactInput["status"] })}><option value="draft">Draft</option><option value="published" disabled={draft.type === "dashboard" || draft.type === "plan" || draft.type === "report" || draft.type === "release_notes" || draft.type === "task_list"}>Published</option></select></label></div><label>Title<input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Release readiness plan" /></label><label>Summary<input value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} placeholder="A concise description for the workspace" /></label><label>Owner<select value={draft.ownerUserId ?? ""} onChange={(e) => setDraft({ ...draft, ownerUserId: e.target.value || null })}><option value="">Unassigned</option>{members.map((member) => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select></label></section>
      {draft.type !== "dashboard" && blockSuggestions[draft.type] && <section className="artifact-guided-builder"><div><p className="eyebrow">GUIDED BUILDER</p><h3>{labels[draft.type]} building blocks</h3><p>Add a structured section, then fill in its details in the artifact below.</p></div><div>{blockSuggestions[draft.type]!.map((block) => <button type="button" key={block.label} onClick={() => addSuggestedBlock(block.content)}>{block.label}</button>)}</div><div className="artifact-assistant"><label>Assistant focus<input value={assistantPrompt} onChange={(event) => setAssistantPrompt(event.target.value)} placeholder="Optional: e.g. focus on launch blockers" /></label><button type="button" className="secondary-button" disabled={saving || !draft.title.trim()} onClick={() => void generateAssistedDraft()}>{saving ? "Creating…" : draft.type === "release_notes" ? "Generate AI change log" : "Create AI-assisted draft"}</button></div></section>}      {draft.type === "dashboard" ? <>
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

        </div>}
      </> : draft.type === "release_notes" ? <>
        <label>Version / tag<input value={draft.releaseVersion ?? ""} onChange={(e) => setDraft({ ...draft, releaseVersion: e.target.value || null })} placeholder="v1.2.0 or Sprint 14" /></label>
        {selected && <div className="dashboard-actions-row">
          <button type="button" className="secondary-button" disabled={saving} onClick={() => void generateFromGithub()}>{saving ? "Generating…" : "Generate from GitHub"}</button>

        </div>}
      </> : draft.type === "report" ? <>
        {selected && <div className="dashboard-actions-row">
          <button type="button" className="secondary-button" disabled={saving} onClick={() => void generateAiReportVisual()}>{saving ? "Generating…" : "Generate AI visual source"}</button>
          <button type="button" className="secondary-button" disabled={saving} onClick={() => void generateFromAuditTrail()}>{saving ? "Generating…" : "Generate from activity"}</button>

        </div>}
      </> : (draft.type === "plan" || draft.type === "task_list") ? <>
        {(() => { const progress = checklistProgress(draft.content); return progress && progress.total > 0 ? (
          <div className="artifact-checklist-progress">
            <div className="readiness-track"><i style={{ width: `${(progress.done / progress.total) * 100}%` }} /></div>
            <small className="muted">{progress.done}/{progress.total} complete</small>
          </div>
        ) : null; })()}

      </> : null}{draft.type === "task_list" && taskListEditing && <TaskListVisual title={draft.title} summary={draft.summary} content={draft.content} onToggle={toggleTaskListItem} />}<label>Notes and context<textarea rows={draft.type === "dashboard" ? 4 : 11} value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} placeholder="Write the shared artifact. Use headings and checklist items where helpful." /></label></>}{draft.type === "plan" && draft.status === "published" && !planEditing && <section className="published-plan-only"><PlanVisual title={draft.title} summary={draft.summary} content={draft.content} layout="execution" /><button type="button" className="secondary-button" onClick={preparePlanTasks}>Edit plan details</button><small>Open the editor to update task stages.</small></section>}{draft.type === "task_list" && draft.status === "published" && !taskListEditing && <section className="published-plan-only"><TaskListVisual title={draft.title} summary={draft.summary} content={draft.content} /><button type="button" className="secondary-button" onClick={() => setTaskListEditing(true)}>Edit task list</button></section>}{draft.type === "release_notes" && draft.status === "published" && !releaseEditing && <section className="published-plan-only"><ReleaseNotesVisual title={draft.title} summary={draft.summary} content={draft.content} /><button type="button" className="secondary-button" onClick={() => setReleaseEditing(true)}>Edit release notes</button></section>}{draft.type === "report" && draft.status === "published" && !reportEditing && <section className="published-plan-only"><ReportVisual title={draft.title} summary={draft.summary} content={draft.content} /><button type="button" className="secondary-button" onClick={() => setReportEditing(true)}>Edit report details</button></section>}{error && <p className="error-text">{error}</p>}{notice && <p className="success-text">{notice}</p>}<div className="agent-builder-actions"><button className="primary-button" disabled={saving || !draft.title.trim() || !draft.content.trim()} onClick={() => void save()}>{saving ? "Saving…" : selected ? "Save changes" : "Save artifact"}</button>{selected && draft.type === "task_list" && draft.status !== "published" && <button className="secondary-button" disabled={saving} onClick={() => void publishTaskList()}>Publish task list</button>}{selected && draft.type === "release_notes" && draft.status !== "published" && <button className="secondary-button" disabled={saving} onClick={() => void publishReleaseNotes()}>Publish release notes</button>}{selected && draft.type === "report" && draft.status !== "published" && <button className="secondary-button" disabled={saving} onClick={() => void publishReport()}>Publish report</button>}{selected && draft.type === "plan" && draft.status !== "published" && <button className="secondary-button" disabled={saving} onClick={() => void publishPlan()}>Publish plan</button>}{selected && draft.type === "dashboard" && draft.status !== "published" && <button className="secondary-button" disabled={saving} onClick={() => void publishDashboard()}>Publish dashboard</button>}{selected && <button className="agent-delete-button" disabled={saving} onClick={() => void remove()}>Delete artifact</button>}</div>{selected && <><section className="artifact-history"><h3>Version history</h3>{versions.slice(0, 5).map((version) => <div key={version.id}><span>Version {version.version} · {version.savedByName ?? "Former member"}</span><button className="secondary-button" onClick={() => void restore(version)}>Restore</button></div>)}</section><section className="artifact-comments"><h3>Comments</h3>{comments.map((entry) => <article key={entry.id}><strong>{entry.authorName ?? "Former member"}</strong><small>{new Date(entry.createdAt).toLocaleString()}</small><p>{entry.content}</p></article>)}<div><textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Leave feedback for the team" /><button className="secondary-button" disabled={!comment.trim()} onClick={() => void addComment()}>Add comment</button></div></section></>}</section>
  </div></main>;
}
