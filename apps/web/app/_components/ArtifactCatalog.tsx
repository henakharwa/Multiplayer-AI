"use client";

import type { WorkspaceArtifact, WorkspaceArtifactType } from "@mai-chat/shared-types";

export type ArtifactTemplate = { type: WorkspaceArtifactType; title: string; summary: string; content: string };
export const artifactLabels: Record<WorkspaceArtifactType, string> = { plan: "Plan", report: "Report", release_notes: "Release notes", dashboard: "Dashboard", task_list: "Task list" };

type Props = {
  artifacts: WorkspaceArtifact[];
  templates: ArtifactTemplate[];
  onTemplate: (template: ArtifactTemplate) => void;
};

export function ArtifactCatalog({ artifacts, templates, onTemplate }: Props) {
  return <><section className="artifact-overview"><div><strong>{artifacts.length}</strong><span>Shared artifacts</span></div><div><strong>{artifacts.filter((artifact) => artifact.status === "published").length}</strong><span>Published</span></div><div><strong>{artifacts.filter((artifact) => artifact.status === "draft").length}</strong><span>In draft</span></div></section><section className="artifact-templates"><div><p className="eyebrow">START FROM A TEMPLATE</p><h2>Build a useful team artifact faster</h2></div><div className="template-grid">{templates.map((template) => <button key={template.type} className={`template-card ${template.type}`} onClick={() => onTemplate(template)}><span>{artifactLabels[template.type]}</span><strong>{template.title}</strong><small>{template.summary}</small></button>)}</div></section></>;
}

type ListProps = {
  artifacts: WorkspaceArtifact[];
  selectedId: string | undefined;
  filter: "all" | WorkspaceArtifactType;
  onFilterChange: (filter: "all" | WorkspaceArtifactType) => void;
  onSelect: (artifact: WorkspaceArtifact) => void;
  onNew: () => void;
};

export function ArtifactList({ artifacts, selectedId, filter, onFilterChange, onSelect, onNew }: ListProps) {
  const visible = artifacts.filter((artifact) => filter === "all" || artifact.type === filter);
  return <section className="artifacts-list"><div className="section-heading"><h2>Artifacts</h2><button onClick={onNew}>New artifact</button></div><div className="artifact-filter"><button className={filter === "all" ? "active" : ""} onClick={() => onFilterChange("all")}>All</button>{Object.entries(artifactLabels).map(([type, label]) => <button key={type} className={filter === type ? "active" : ""} onClick={() => onFilterChange(type as WorkspaceArtifactType)}>{label}</button>)}</div>{visible.length ? visible.map((artifact) => <button key={artifact.id} className={`artifact-card ${artifact.type} ${selectedId === artifact.id ? "selected" : ""}`} onClick={() => onSelect(artifact)}><span className={`artifact-status ${artifact.status}`}>{artifact.status}</span><strong>{artifact.title}</strong><small>{artifactLabels[artifact.type]}{artifact.releaseVersion ? ` · ${artifact.releaseVersion}` : ""} · {artifact.ownerName ?? "Unassigned"}</small></button>) : <p className="muted">No artifacts yet. Save the next useful team output here.</p>}</section>;
}
