"use client";

import { useState } from "react";
import type { MessageProvenance, TeamActivity } from "@mai-chat/shared-types";

const PROVIDER_LABELS: Record<MessageProvenance["provider"], string> = {
  github: "GitHub",
  slack: "Slack",
  linear: "Linear",
  notion: "Notion",
  figma: "Figma",
};

/** One line under an agent reply: whose account it used and, for GitHub, which repositories. */
export function provenanceText(provenance: MessageProvenance): string {
  const repos = provenance.repos?.length ? ` · ${provenance.repos.join(", ")}` : "";
  // Replies from before the workspace GitHub App was removed.
  if (provenance.via === "app") {
    return `Used the workspace GitHub App${provenance.account ? ` (@${provenance.account})` : ""}${repos}`;
  }
  if (provenance.provider === "github") {
    return `Used ${provenance.account ? `@${provenance.account}` : "a GitHub account"} (${provenance.actedAsName}'s GitHub)${repos}`;
  }
  return `Used ${provenance.actedAsName}'s ${PROVIDER_LABELS[provenance.provider]}${provenance.account ? ` (${provenance.account})` : ""}`;
}

export function MessageProvenanceLine({ provenance }: { provenance: MessageProvenance }) {
  const text = provenanceText(provenance);
  return (
    <div className="msg-provenance" data-testid="message-provenance" title={text}>
      {text}
    </div>
  );
}

function ago(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/**
 * What teammates' agents and GitHub did recently, so people see what is
 * already handled before asking for it again. Shows the latest item; the
 * rest of the last day opens on demand.
 */
export function TeamActivityStrip({ activity }: { activity: TeamActivity[] }) {
  const [open, setOpen] = useState(false);
  const [hiddenBefore, setHiddenBefore] = useState<string | null>(null);
  const visible = activity.filter((item) => !hiddenBefore || Date.parse(item.createdAt) > Date.parse(hiddenBefore));
  if (!visible.length) return null;
  const [latest, ...rest] = visible;
  const item = (entry: TeamActivity) => (
    <>
      <span className={`team-activity-source ${entry.source}`}>{entry.source === "github" ? "GitHub" : "Team"}</span>
      <span className="team-activity-text">
        {entry.url ? (
          <a href={entry.url} target="_blank" rel="noreferrer">
            {entry.summary}
          </a>
        ) : (
          entry.summary
        )}
      </span>
      <span className="team-activity-time">{ago(entry.createdAt)}</span>
    </>
  );
  return (
    <section className="team-activity" aria-label="Recent team activity" data-testid="team-activity">
      <div className="team-activity-row">
        {item(latest)}
        <span className="team-activity-actions">
          {rest.length > 0 && (
            <button
              type="button"
              className="text-button"
              onClick={() => setOpen((value) => !value)}
              aria-expanded={open}
            >
              {open ? "Less" : `${rest.length} more`}
            </button>
          )}
          <button
            type="button"
            className="text-button"
            aria-label="Hide recent team activity"
            onClick={() => {
              setOpen(false);
              setHiddenBefore(latest.createdAt);
            }}
          >
            ×
          </button>
        </span>
      </div>
      {open && (
        <ul className="team-activity-list">
          {rest.map((entry) => (
            <li key={entry.id} className="team-activity-row">
              {item(entry)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
