"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import type { AuditEvent, AuditEventType } from "@mai-chat/shared-types";
import { listAuditEvents, ApiError } from "../../../../lib/api";

// Matches the AuditEventType union in packages/shared-types -- add a new
// kind there and in services/chat-server/src/actions.ts / server.ts
// together with a label here.
const EVENT_TYPE_LABELS: Record<AuditEventType, string> = {
  "workspace.created": "Workspace created",
  "member.joined": "Member joined",
  "member.invited": "Member invited",
  "integration.connected": "Integration connected",
  "action.proposed": "Action proposed",
  "action.confirmed": "Action confirmed",
  "action.cancelled": "Action cancelled",
  "action.failed": "Action failed",
  "handoff.directed": "Handed off to a teammate",
};

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

export default function AuditPage() {
  const params = useParams<{ id: string }>();
  const workspaceId = params.id;

  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [type, setType] = useState<AuditEventType | "">("");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounced so every keystroke in the search box doesn't fire its own
  // request -- 250ms is short enough to still feel live.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const timeout = setTimeout(() => {
      listAuditEvents(workspaceId, { q: search.trim() || undefined, type: type || undefined })
        .then(({ events: list, nextBefore: next }) => {
          if (cancelled) return;
          setEvents(list);
          setNextBefore(next);
        })
        .catch((err) => {
          if (cancelled) return;
          setError(err instanceof ApiError ? err.message : "Could not reach the chat server.");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [workspaceId, search, type]);

  async function loadMore() {
    if (!nextBefore) return;
    setLoadingMore(true);
    try {
      const { events: more, nextBefore: next } = await listAuditEvents(workspaceId, {
        q: search.trim() || undefined,
        type: type || undefined,
        before: nextBefore,
      });
      setEvents((prev) => [...prev, ...more]);
      // Fewer rows than asked for is this page's "no more history" signal
      // -- stop offering "Load older" once a page comes back short.
      setNextBefore(more.length > 0 ? next : null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the chat server.");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="audit-page">
      <Link className="back-link" href={`/w/${workspaceId}`}>
        ← Back to chat
      </Link>
      <h1 className="title">Activity</h1>
      <p style={{ color: "var(--text-dim)", fontSize: 13, marginTop: -10, marginBottom: 24, lineHeight: 1.5 }}>
        Who asked for what, what the agent did, and when -- every workspace creation, membership, integration, and agent action in
        this workspace.
      </p>

      <div className="audit-toolbar">
        <input
          className="audit-search"
          type="text"
          placeholder="Search by person or action…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          data-testid="audit-search"
          aria-label="Search activity"
        />
        <select
          className="audit-type-select"
          value={type}
          onChange={(e) => setType(e.target.value as AuditEventType | "")}
          data-testid="audit-type-filter"
          aria-label="Filter by event type"
        >
          <option value="">All event types</option>
          {(Object.keys(EVENT_TYPE_LABELS) as AuditEventType[]).map((t) => (
            <option key={t} value={t}>
              {EVENT_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="error-text" style={{ marginBottom: 16 }}>{error}</p>}

      <div className="audit-table" data-testid="audit-table">
        {loading && events.length === 0 && <div className="audit-empty">Loading…</div>}
        {!loading && events.length === 0 && !error && (
          <div className="audit-empty" data-testid="audit-empty">
            {search || type ? "No activity matches these filters." : "No activity yet."}
          </div>
        )}
        {events.map((event) => (
          <div className="audit-row" key={event.id} data-testid="audit-row">
            <span className={`audit-actor-badge ${event.actorType}`}>{event.actorType}</span>
            <span className="audit-summary">{event.summary}</span>
            <span className="audit-time">{formatTimestamp(event.createdAt)}</span>
          </div>
        ))}
      </div>

      {nextBefore && events.length > 0 && (
        <button className="btn secondary audit-load-more" type="button" onClick={loadMore} disabled={loadingMore} data-testid="audit-load-more">
          {loadingMore ? "Loading…" : "Load older activity"}
        </button>
      )}
    </div>
  );
}
