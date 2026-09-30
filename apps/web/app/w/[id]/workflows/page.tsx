"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import type { Conversation, WorkspaceAgent, WorkspaceWorkflow, WorkflowRun, WorkflowTrigger } from "@mai-chat/shared-types";
import { ApiError, createWorkspaceWorkflow, deleteWorkspaceWorkflow, listConversations, listWorkflowRuns, listWorkspaceAgents, listWorkspaceWorkflows, runWorkspaceWorkflow, updateWorkspaceWorkflow, type WorkflowInput } from "../../../../lib/api";

const triggers: Array<{ value: WorkflowTrigger; label: string; help: string }> = [
  { value: "manual", label: "Manual", help: "Run when a teammate starts it." },
  { value: "schedule", label: "Schedule", help: "Run on a repeating interval." },
  { value: "github_issue", label: "New GitHub issue", help: "Run when a new issue event arrives." },
  { value: "github_status", label: "GitHub status change", help: "Run when a status event arrives." },
  { value: "slack_mention", label: "Slack mention", help: "Run when the workspace is mentioned in Slack." },
];
const agentKinds = ["project", "github", "slack", "linear", "notion", "figma"] as const;
const empty: WorkflowInput = { name: "", description: "", instructions: "", agentKind: "project", workspaceAgentId: null, conversationId: null, trigger: "manual", scheduleMinutes: 60, enabled: true };
const testEventDefaults: Record<Exclude<WorkflowTrigger, "manual" | "schedule">, string> = {
  github_issue: "A new issue was opened: \"Release build fails on the verification step.\" Summarize the issue and identify the next owner.",
  github_status: "The latest CI workflow completed with a failure in the test-and-build job. Explain whether the team is blocked and list the next action.",
  slack_mention: "@Nexus Can you summarize the release risk from today's discussion and tell us the next step?",
};
const workflowTemplates: Array<{ label: string; detail: string; value: WorkflowInput }> = [
  { label: "Release readiness", detail: "Daily GitHub release review", value: { ...empty, name: "Release readiness update", description: "Summarize release risk and the next owner.", instructions: "Review the connected repository, recent workspace context, open release risks, and approvals. Post a concise release-readiness update with blockers, owners, and the next action.", agentKind: "github", trigger: "schedule", scheduleMinutes: 1440 } },
  { label: "Mention responder", detail: "Answer Slack mentions with context", value: { ...empty, name: "Slack mention response", description: "Respond to workspace mentions with a concise next step.", instructions: "Use relevant workspace memory and connected Slack context. Summarize the request, identify risk or decisions, and provide one concrete next step.", agentKind: "slack", trigger: "slack_mention" } },
  { label: "Issue triage", detail: "Assess new GitHub issues", value: { ...empty, name: "GitHub issue triage", description: "Classify a new issue and assign the next investigation.", instructions: "Read the incoming issue and relevant workspace context. Summarize impact, identify the likely owner, list missing information, and propose the next investigation step.", agentKind: "github", trigger: "github_issue" } },
];

function formatDate(value: string | null) { return value ? new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "Not run yet"; }
function labelForTrigger(trigger: WorkflowTrigger) { return triggers.find((item) => item.value === trigger)?.label ?? trigger; }

export default function WorkflowsPage() {
  const { id: workspaceId } = useParams<{ id: string }>();
  const [workflows, setWorkflows] = useState<WorkspaceWorkflow[]>([]);
  const [agents, setAgents] = useState<WorkspaceAgent[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<WorkspaceWorkflow | null>(null);
  const [draft, setDraft] = useState<WorkflowInput>(empty);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [testEventText, setTestEventText] = useState("");

  const refresh = async () => setWorkflows(await listWorkspaceWorkflows(workspaceId));
  useEffect(() => { void Promise.all([refresh(), listWorkspaceAgents(workspaceId).then(setAgents), listConversations(workspaceId).then(setConversations)]).catch((err: Error) => setError(err.message)); }, [workspaceId]);
  async function select(workflow: WorkspaceWorkflow) {
    setSelected(workflow); setError(""); setNotice("");
    setDraft({ name: workflow.name, description: workflow.description, instructions: workflow.instructions, agentKind: workflow.agentKind, workspaceAgentId: workflow.workspaceAgentId, conversationId: workflow.conversationId, trigger: workflow.trigger, scheduleMinutes: workflow.scheduleMinutes ?? 60, enabled: workflow.enabled });
    try { setRuns(await listWorkflowRuns(workspaceId, workflow.id)); } catch { setRuns([]); }
  }
  async function save() {
    setSaving(true); setError(""); setNotice("");
    try {
      const workflow = selected ? await updateWorkspaceWorkflow(workspaceId, selected.id, draft) : await createWorkspaceWorkflow(workspaceId, draft);
      await refresh(); await select(workflow); setNotice(selected ? "Workflow updated." : "Workflow created.");
    } catch (err) { setError(err instanceof ApiError ? err.message : "Could not save workflow."); } finally { setSaving(false); }
  }
  async function run(trigger: "manual" | "github_issue" | "github_status" | "slack_mention" = "manual") {
    if (!selected) return; setSaving(true); setError("");
    try { await runWorkspaceWorkflow(workspaceId, selected.id, trigger, trigger === "manual" ? undefined : (testEventText.trim() || testEventDefaults[trigger])); setNotice("Workflow started. Its response will appear in the selected conversation."); setTimeout(() => { void listWorkflowRuns(workspaceId, selected.id).then(setRuns); void refresh(); }, 800); }
    catch (err) { setError(err instanceof Error ? err.message : "Could not run workflow."); } finally { setSaving(false); }
  }
  async function remove() {
    if (!selected || !window.confirm(`Delete ${selected.name}? This cannot be undone.`)) return;
    setSaving(true); try { await deleteWorkspaceWorkflow(workspaceId, selected.id); setSelected(null); setDraft(empty); setRuns([]); await refresh(); } catch (err) { setError(err instanceof Error ? err.message : "Could not delete workflow."); } finally { setSaving(false); }
  }
  const publishedAgents = agents.filter((agent) => agent.status === "published");
  const triggerHelp = triggers.find((item) => item.value === draft.trigger)?.help;
  return <main className="workspace-settings-page workflow-page">
    
    <header><p className="eyebrow">WORKFLOW AUTOMATION</p><h1>Build reusable workflows</h1><p>Turn recurring work into governed agent runs. Schedules and event triggers use the same connections, permissions, and approval steps as chat.</p></header>
    <div className="workflow-layout">
      <section className="workflow-list"><div className="section-heading"><h2>Workflows</h2><button onClick={() => { setSelected(null); setDraft(empty); setRuns([]); setError(""); setNotice(""); }}>New workflow</button></div>
        {!selected && <div className="workflow-templates"><p>Start from a template</p>{workflowTemplates.map((template) => <button type="button" key={template.label} onClick={() => { setSelected(null); setDraft(template.value); setRuns([]); setNotice(`Loaded the ${template.label} template.`); }}><strong>{template.label}</strong><small>{template.detail}</small></button>)}</div>}
        {workflows.length ? workflows.map((workflow) => <button key={workflow.id} className={`workflow-card ${selected?.id === workflow.id ? "selected" : ""}`} onClick={() => void select(workflow)}><span className={`workflow-status ${workflow.enabled ? "enabled" : "paused"}`}>{workflow.enabled ? "Active" : "Paused"}</span><strong>{workflow.name}</strong><small>{labelForTrigger(workflow.trigger)} · {formatDate(workflow.lastRunAt)}</small></button>) : <p className="muted">No workflows yet. Create one for a recurring team task.</p>}
      </section>
      <section className="workflow-form"><div className="section-heading"><h2>{selected ? selected.name : "New workflow"}</h2>{selected && <button className="secondary-button workflow-run-button" disabled={saving} onClick={() => void run()}>Run now</button>}</div>
        <label>Name<input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Weekly release readiness" /></label>
        <label>Description<input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="A short description for your team" /></label>
        <label>Instructions<textarea rows={5} value={draft.instructions} onChange={(e) => setDraft({ ...draft, instructions: e.target.value })} placeholder="Review open pull requests, checks, and release blockers. Share a concise update." /></label>
        <div className="workflow-two-columns"><fieldset className="workflow-agent-picker"><legend>Agent</legend><div role="radiogroup" aria-label="Workflow agent"><button type="button" className={!draft.workspaceAgentId ? "selected" : ""} aria-pressed={!draft.workspaceAgentId} aria-label="Built-in specialist" title="Built-in specialist" onClick={() => setDraft({ ...draft, workspaceAgentId: null })}><SpecialistIcon kind={draft.agentKind} /></button>{publishedAgents.map((agent) => <button type="button" key={agent.id} className={draft.workspaceAgentId === agent.id ? "selected custom" : "custom"} aria-pressed={draft.workspaceAgentId === agent.id} aria-label={`${agent.name}, custom agent`} title={`${agent.name} · version ${agent.publishedVersion}`} onClick={() => setDraft({ ...draft, workspaceAgentId: agent.id, agentKind: agent.baseAgent })}><CustomAgentIcon name={agent.name} /></button>)}</div>{publishedAgents.length === 0 && <small>Create and publish an agent to use it here.</small>}</fieldset><fieldset className="workflow-specialist-picker"><legend>Specialist</legend><div role="radiogroup" aria-label="Built-in specialist">{agentKinds.map((agent) => <button type="button" key={agent} className={draft.agentKind === agent ? "selected" : ""} disabled={Boolean(draft.workspaceAgentId)} aria-pressed={draft.agentKind === agent} aria-label={`${agent[0].toUpperCase() + agent.slice(1)} specialist`} title={agent[0].toUpperCase() + agent.slice(1)} onClick={() => setDraft({ ...draft, agentKind: agent })}><SpecialistIcon kind={agent} /></button>)}</div></fieldset></div>
        <label>Post responses in<select value={draft.conversationId ?? ""} onChange={(e) => setDraft({ ...draft, conversationId: e.target.value || null })}><option value="">A dedicated workflow conversation</option>{conversations.map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.title}</option>)}</select></label>
        <fieldset className="workflow-trigger-options"><legend>Start this workflow</legend>{triggers.map((item) => <label key={item.value} className={draft.trigger === item.value ? "chosen" : ""}><input type="radio" name="trigger" checked={draft.trigger === item.value} onChange={() => setDraft({ ...draft, trigger: item.value })} /><span><strong>{item.label}</strong><small>{item.help}</small></span></label>)}</fieldset>
        {draft.trigger === "schedule" && <label>Repeat every <select value={draft.scheduleMinutes ?? 60} onChange={(e) => setDraft({ ...draft, scheduleMinutes: Number(e.target.value) })}>{[[15,"15 minutes"],[30,"30 minutes"],[60,"hour"],[240,"4 hours"],[1440,"day"],[10080,"week"]].map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
        {draft.trigger !== "manual" && draft.trigger !== "schedule" && selected && <><label>Test event details<textarea rows={3} value={testEventText} onChange={(e) => setTestEventText(e.target.value)} placeholder={testEventDefaults[draft.trigger]} /></label><p className="workflow-help">This sample event is used only for the test run. It is not sent to GitHub or Slack.</p><button type="button" className="secondary-button workflow-test-button" disabled={saving} onClick={() => void run(draft.trigger as "github_issue" | "github_status" | "slack_mention")}>Test {labelForTrigger(draft.trigger)} trigger</button></>}
        <label className="workflow-enabled"><span><strong>Workflow active</strong><small>{draft.enabled ? "It can run when this trigger occurs." : "Saved but paused."}</small></span><span className="toggle-switch"><input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}/><span className="toggle-track" /></span></label>
        {triggerHelp && <p className="workflow-help">{triggerHelp}</p>}{error && <p className="error-text">{error}</p>}{notice && <p className="success-text">{notice}</p>}
        <div className="agent-builder-actions"><button className="primary-button" disabled={saving || !draft.name.trim() || !draft.instructions.trim()} onClick={() => void save()}>{saving ? "Saving…" : selected ? "Save changes" : "Create workflow"}</button>{selected && <button className="agent-delete-button" disabled={saving} onClick={() => void remove()}>Delete workflow</button>}</div>
        {selected && <div className="workflow-runs"><h3>Recent runs</h3>{runs.length ? runs.map((run) => <div key={run.id}><span className={`run-status ${run.status}`}>{run.status}</span><strong>{labelForTrigger(run.trigger)}</strong><small>{formatDate(run.startedAt)}{run.detail ? ` · ${run.detail}` : ""}</small></div>) : <p className="muted">No runs yet.</p>}</div>}
      </section>
    </div>
  </main>;
}

function SpecialistIcon({ kind }: { kind: typeof agentKinds[number] }) {
  if (kind === "project") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" fill="currentColor"/></svg>;
  if (kind === "github") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.4a8.6 8.6 0 0 0-2.7 16.8c.4.1.5-.2.5-.4v-1.5c-2.1.5-2.5-.9-2.5-.9-.3-.9-.8-1.1-.8-1.1-.7-.5.1-.5.1-.5.7 0 1 .7 1 .7.6 1.1 1.7.8 2.1.6.1-.5.3-.8.5-1-1.7-.2-3.4-.8-3.4-3.7 0-.8.3-1.5.8-2-.1-.2-.4-1 .1-2 .6-.2 2 .8 2 .8a7 7 0 0 1 3.7 0s1.4-1 2-.8c.5 1 .2 1.8.1 2 .5.5.8 1.2.8 2 0 2.9-1.8 3.5-3.4 3.7.3.2.5.7.5 1.3v2c0 .2.1.5.5.4A8.6 8.6 0 0 0 12 3.4Z" fill="currentColor"/></svg>;
  if (kind === "slack") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.7 13.7a1.7 1.7 0 1 1-1.7-1.7h1.7v1.7Zm.9 0a1.7 1.7 0 1 1 3.4 0v4.2a1.7 1.7 0 1 1-3.4 0v-4.2ZM10.9 6.7A1.7 1.7 0 1 1 12.6 5v1.7h-1.7Zm0 .9a1.7 1.7 0 1 1 0 3.4H6.7a1.7 1.7 0 1 1 0-3.4h4.2ZM17.3 10.9A1.7 1.7 0 1 1 19 12.6h-1.7v-1.7Zm-.9 0a1.7 1.7 0 1 1-3.4 0V6.7a1.7 1.7 0 1 1 3.4 0v4.2ZM13.1 17.3a1.7 1.7 0 1 1-1.7 1.7v-1.7h1.7Zm0-.9a1.7 1.7 0 1 1 0-3.4h4.2a1.7 1.7 0 1 1 0 3.4h-4.2Z" fill="currentColor"/></svg>;
  if (kind === "linear") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 5 15 14M4 10l9 9M9 4l10 10M15 4l5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>;
  if (kind === "notion") return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="1" fill="none" stroke="currentColor" strokeWidth="1.8"/><path d="M8 17V7l8 10V7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="7" r="3" fill="currentColor"/><circle cx="15" cy="7" r="3" fill="currentColor"/><circle cx="9" cy="15" r="3" fill="currentColor"/><circle cx="15" cy="15" r="3" fill="currentColor"/></svg>;
}
function CustomAgentIcon({ name }: { name: string }) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "AI";
  const hue = [...name].reduce((total, char) => total + char.charCodeAt(0), 0) % 360;
  return <span className="workflow-custom-agent-icon" style={{ background: `linear-gradient(135deg, hsl(${hue} 72% 48%), hsl(${(hue + 42) % 360} 75% 61%))` }}>{initials}</span>;
}
