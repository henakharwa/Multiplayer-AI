"use client";

import type { WorkspaceArtifactInput } from "../../lib/api";
import type { WorkspaceMember } from "@mai-chat/shared-types";
import { artifactLabels } from "./ArtifactCatalog";

export type ArtifactBuilderStep = "setup" | "compose" | "review";

export function ArtifactBuilderChrome({ title, draft, members, step, onStepChange }: { title: string; draft: WorkspaceArtifactInput; members: WorkspaceMember[]; step: ArtifactBuilderStep; onStepChange: (step: ArtifactBuilderStep) => void }) {
  const owner = draft.ownerUserId ? members.find((member) => member.id === draft.ownerUserId)?.displayName ?? "Assigned" : "Unassigned";
  const guidance = step === "setup" ? "Choose the artifact type, owner, and outcome." : step === "compose" ? "Use guided blocks or AI assistance to prepare the content." : "Review the artifact, then save or publish it for the workspace.";
  return <><div className="section-heading"><h2>{title}</h2><span className="artifact-type-label">{artifactLabels[draft.type]}</span></div><section className="artifact-builder-steps" aria-label="Artifact editor steps">{(["setup", "compose", "review"] as const).map((entry, index) => <button type="button" key={entry} className={step === entry ? "active" : ""} aria-current={step === entry ? "step" : undefined} onClick={() => onStepChange(entry)}><span>{index + 1}</span>{entry[0].toUpperCase() + entry.slice(1)}</button>)}</section><section className="artifact-review-summary"><p>REVIEW</p><strong>{draft.title || "Untitled artifact"}</strong><span>{artifactLabels[draft.type]} · {owner}</span><small>{draft.summary || "No summary added"}</small><em>{draft.content ? `${draft.content.length.toLocaleString()} characters of content ready` : "No artifact content added"}</em></section><p className="artifact-builder-guidance">{guidance}</p></>;
}
