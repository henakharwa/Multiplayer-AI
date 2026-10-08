"use client";
import { useEffect, useState } from "react";
import { useDialog } from "../../../_components/DialogProvider";
import Link from "next/link";
import { useParams } from "next/navigation";
import type { WorkspaceAgent, WorkspaceAgentVersion } from "@mai-chat/shared-types";
import { AccessNotice } from "../../../_components/AccessNotice";
import { useWorkspaceAccess } from "../../../../lib/useWorkspaceAccess";
import {
  describeError,
  getWorkspacePreference,
  setWorkspacePreference,
  createWorkspaceAgent,
  deleteWorkspaceAgent,
  listWorkspaceAgentVersions,
  listWorkspaceAgents,
  listAgentModels,
  publishWorkspaceAgent,
  updateWorkspaceAgent,
} from "../../../../lib/api";
const providers = ["github", "slack", "linear", "notion", "figma"] as const;
const bases = ["project", ...providers] as const;
type Base = (typeof bases)[number];
const blank = {
  name: "",
  baseAgent: "project" as Base,
  instructions: "",
  knowledge: "",
  approvedProviders: [] as string[],
  model: "workspace-default",
};
export default function AgentsPage() {
  const { id } = useParams<{ id: string }>();
  const [agents, setAgents] = useState<WorkspaceAgent[]>([]);
  const [models, setModels] = useState<string[]>(["workspace-default"]);
  const [draft, setDraft] = useState(blank);
  const [selected, setSelected] = useState<WorkspaceAgent | null>(null);
  const [versions, setVersions] = useState<WorkspaceAgentVersion[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState("");
  const [publishedOnly, setPublishedOnly] = useState(false);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [directoryFilter, setDirectoryFilter] = useState<"all" | "published" | "draft" | "favorites">("all");
  const [builderStep, setBuilderStep] = useState<"identity" | "behavior" | "knowledge" | "tools" | "review">(
    "identity",
  );
  const dialog = useDialog();
  const access = useWorkspaceAccess(id);
  const canChange = access.can("createAgents");
  const canPublish = access.can("publishAgents");
  const [loading, setLoading] = useState(true);
  const refresh = () =>
    listWorkspaceAgents(id)
      .then(setAgents)
      .catch((e: unknown) => setError(describeError(e, "Could not load agents.")))
      .finally(() => setLoading(false));
  useEffect(() => {
    refresh();
    listAgentModels(id)
      .then(setModels)
      .catch(() => {});
  }, [id]);
  // Favorites are saved per member on the server so they follow you across devices. Older browser-only favorites are moved over once.
  useEffect(() => {
    let cancelled = false;
    const legacyKey = `nexus-agent-favorites-${id}`;
    getWorkspacePreference<string[]>(id, "agent-favorites")
      .then((saved) => {
        if (cancelled) return;
        if (Array.isArray(saved)) {
          setFavorites(saved);
          return;
        }
        let legacy: string[] = [];
        try {
          legacy = JSON.parse(window.localStorage.getItem(legacyKey) ?? "[]");
        } catch {
          legacy = [];
        }
        setFavorites(Array.isArray(legacy) ? legacy : []);
        if (Array.isArray(legacy) && legacy.length)
          void setWorkspacePreference(id, "agent-favorites", legacy)
            .then(() => {
              try {
                window.localStorage.removeItem(legacyKey);
              } catch {}
            })
            .catch(() => {});
      })
      .catch(() => setFavorites([]));
    return () => {
      cancelled = true;
    };
  }, [id]);
  const toggleFavorite = (agentId: string) =>
    setFavorites((current) => {
      const next = current.includes(agentId) ? current.filter((item) => item !== agentId) : [...current, agentId];
      void setWorkspacePreference(id, "agent-favorites", next).catch(() => setError("Could not save favorites."));
      return next;
    });
  const visibleAgents = agents
    .filter((agent) => {
      const matches =
        !query.trim() ||
        `${agent.name} ${agent.baseAgent} ${agent.instructions} ${agent.knowledge}`
          .toLowerCase()
          .includes(query.trim().toLowerCase());
      const matchesDirectory =
        directoryFilter === "all" ||
        (directoryFilter === "published" && agent.status === "published") ||
        (directoryFilter === "draft" && agent.status === "draft") ||
        (directoryFilter === "favorites" && favorites.includes(agent.id));
      return matches && (!publishedOnly || agent.status === "published") && matchesDirectory;
    })
    .sort(
      (a, b) => Number(favorites.includes(b.id)) - Number(favorites.includes(a.id)) || a.name.localeCompare(b.name),
    );
  function edit(agent: WorkspaceAgent) {
    setSelected(agent);
    setBuilderStep("identity");
    setDraft({
      name: agent.name,
      baseAgent: agent.baseAgent,
      instructions: agent.instructions,
      knowledge: agent.knowledge,
      approvedProviders: agent.approvedProviders,
      model: agent.model,
    });
    listWorkspaceAgentVersions(id, agent.id)
      .then(setVersions)
      .catch(() => setVersions([]));
  }
  async function save() {
    setSaving(true);
    setError("");
    try {
      const payload = { ...draft, approvedProviders: draft.approvedProviders };
      const agent = selected
        ? await updateWorkspaceAgent(id, selected.id, payload)
        : await createWorkspaceAgent(id, payload);
      setSelected(agent);
      await refresh();
      await listWorkspaceAgentVersions(id, agent.id).then(setVersions);
    } catch (e) {
      setError(describeError(e, "Could not save agent."));
    } finally {
      setSaving(false);
    }
  }
  async function publish() {
    if (!selected) return;
    setSaving(true);
    try {
      const agent = await publishWorkspaceAgent(id, selected.id);
      setSelected(agent);
      await refresh();
      setVersions(await listWorkspaceAgentVersions(id, agent.id));
    } catch (e) {
      setError(describeError(e, "Could not publish agent."));
    } finally {
      setSaving(false);
    }
  }
  async function remove() {
    if (
      !selected ||
      !(await dialog.confirm({
        title: `Delete ${selected.name}?`,
        message: "This agent and its version history will be removed. This cannot be undone.",
        confirmLabel: "Delete agent",
        danger: true,
      }))
    )
      return;
    setSaving(true);
    setError("");
    try {
      await deleteWorkspaceAgent(id, selected.id);
      setSelected(null);
      setDraft(blank);
      setVersions([]);
      await refresh();
    } catch (e) {
      setError(describeError(e, "Could not delete agent."));
    } finally {
      setSaving(false);
    }
  }
  const providerCount = new Set(agents.flatMap((agent) => agent.approvedProviders)).size;
  const selectedContext = [
    draft.baseAgent === "project" ? "Workspace context" : `${draft.baseAgent} specialist`,
    draft.knowledge.trim() ? "Saved knowledge" : "No knowledge added",
    draft.approvedProviders.length
      ? `${draft.approvedProviders.length} approved tool${draft.approvedProviders.length === 1 ? "" : "s"}`
      : "No external tools",
  ];
  return (
    <main className="workspace-settings-page agents-operations-page">
      <header>
        <p className="eyebrow">AGENT OPERATIONS</p>
        <h1>Build capable workspace agents</h1>
        <p>
          Configure context, tools, and specialist behavior. Publish a reviewed version when the agent is ready for your
          team.
        </p>
      </header>
      <section className="agent-command-center">
        <div>
          <span>PUBLISHED</span>
          <strong>{agents.filter((agent) => agent.status === "published").length}</strong>
          <small>team-ready agents</small>
        </div>
        <div>
          <span>DRAFTS</span>
          <strong>{agents.filter((agent) => agent.status === "draft").length}</strong>
          <small>awaiting review</small>
        </div>
        <div>
          <span>CONNECTED TOOLS</span>
          <strong>{providerCount}</strong>
          <small>approved providers</small>
        </div>
        <div>
          <span>FAVORITES</span>
          <strong>{favorites.length}</strong>
          <small>pinned agents</small>
        </div>
      </section>
      <section className="agent-starter-gallery">
        <div>
          <p className="eyebrow">AGENT BLUEPRINTS</p>
          <h2>Start with a role, then make it yours</h2>
        </div>
        <div>
          {[
            { name: "Release lead", base: "github" as Base, description: "Track release health and owners." },
            {
              name: "Project coordinator",
              base: "project" as Base,
              description: "Turn decisions into clear next steps.",
            },
            { name: "Research partner", base: "notion" as Base, description: "Ground answers in team knowledge." },
          ].map((blueprint, index) => (
            <button
              type="button"
              key={blueprint.name}
              disabled={!canChange}
              onClick={() => {
                setSelected(null);
                setVersions([]);
                setDraft({
                  ...blank,
                  name: blueprint.name,
                  baseAgent: blueprint.base,
                  instructions: blueprint.description,
                  knowledge: "",
                });
              }}
            >
              <span>{index === 0 ? "◒" : index === 1 ? "✦" : "⌘"}</span>
              <strong>{blueprint.name}</strong>
              <small>{blueprint.description}</small>
              <em>Use blueprint →</em>
            </button>
          ))}
        </div>
      </section>
      <div className="agent-builder-layout">
        <section className="agent-builder-list">
          <div className="section-heading">
            <h2>Agent directory</h2>
            <button
              disabled={!canChange}
              onClick={() => {
                setSelected(null);
                setDraft(blank);
                setVersions([]);
              }}
            >
              New agent
            </button>
          </div>
          <div className="agent-directory-controls">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search agents, skills, or tools"
              aria-label="Search agents"
            />
            <div>
              {(["all", "published", "draft", "favorites"] as const).map((filter) => (
                <button
                  type="button"
                  key={filter}
                  onClick={() => setDirectoryFilter(filter)}
                  className={directoryFilter === filter ? "active" : ""}
                >
                  {filter}
                </button>
              ))}
            </div>
            <label>
              <input type="checkbox" checked={publishedOnly} onChange={(e) => setPublishedOnly(e.target.checked)} />{" "}
              Published only
            </label>
          </div>
          {visibleAgents.length ? (
            visibleAgents.map((agent) => (
              <div className={`agent-directory-item ${selected?.id === agent.id ? "selected" : ""}`} key={agent.id}>
                <button className="agent-builder-card" onClick={() => edit(agent)}>
                  <AgentAvatar name={agent.name} />
                  <strong>{agent.name}</strong>
                  <span>
                    {agent.baseAgent} · {agent.status}
                    {agent.publishedVersion ? ` · v${agent.publishedVersion}` : ""}
                  </span>
                  <small>
                    {agent.approvedProviders.length ? agent.approvedProviders.join(", ") : "Workspace context"}
                  </small>
                </button>
                <button
                  type="button"
                  className={`agent-favorite ${favorites.includes(agent.id) ? "active" : ""}`}
                  onClick={() => toggleFavorite(agent.id)}
                  aria-label={`${favorites.includes(agent.id) ? "Remove" : "Add"} ${agent.name} ${favorites.includes(agent.id) ? "from" : "to"} favorites`}
                >
                  ★
                </button>
              </div>
            ))
          ) : loading ? (
            <div className="list-loading" role="status" aria-label="Loading agents">
              <span />
              <span />
              <span />
            </div>
          ) : (
            <p className="muted">{agents.length ? "No agents match these filters." : "No workspace agents yet."}</p>
          )}
        </section>
        <section className="agent-builder-form">
          <div className="section-heading">
            <div>
              <p className="eyebrow">{selected ? "AGENT DETAILS" : "NEW AGENT"}</p>
              <h2>{selected ? selected.name : "New agent"}</h2>
            </div>
            {selected && <span className={`status-pill ${selected.status}`}>{selected.status}</span>}
          </div>
          <section className="agent-capability-preview">
            <div>
              <p>CONTEXT AND TOOLS</p>
              <strong>What this agent can use</strong>
              <span>
                {selectedContext.map((item) => (
                  <em key={item}>{item}</em>
                ))}
              </span>
            </div>
            <div>
              <p>TEAM AVAILABILITY</p>
              <strong>{selected?.status === "published" ? "Published for the workspace" : "Draft only"}</strong>
              <small>
                {selected?.status === "published"
                  ? "Available in chat and workflows."
                  : "Publish after you review its behavior and access."}
              </small>
            </div>
          </section>
          <section className="agent-builder-steps" aria-label="Agent setup steps">
            {(
              [
                ["identity", "Identity"],
                ["behavior", "Behavior"],
                ["knowledge", "Knowledge"],
                ["tools", "Tools"],
                ["review", "Review"],
              ] as const
            ).map(([step, label], index) => (
              <button
                type="button"
                key={step}
                className={builderStep === step ? "active" : ""}
                onClick={() => setBuilderStep(step)}
              >
                <span>{index + 1}</span>
                {label}
              </button>
            ))}
          </section>
          <section className="agent-builder-stage">
            <fieldset className="access-readonly" disabled={!canChange}>
              {builderStep === "identity" && (
                <>
                  <p className="agent-stage-kicker">STEP 1 · IDENTITY</p>
                  <h3>Give this agent a clear role</h3>
                  <small>A role and specialist help teammates understand when to use it.</small>
                  <label>
                    Name (required)
                    <input
                      value={draft.name}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      placeholder="Release coordinator"
                      autoFocus
                      required
                    />
                  </label>
                  <label>
                    Base specialist (required)
                    <select
                      value={draft.baseAgent}
                      onChange={(e) => setDraft({ ...draft, baseAgent: e.target.value as Base })}
                      required
                    >
                      {bases.map((base) => (
                        <option key={base}>{base}</option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              {builderStep === "behavior" && (
                <>
                  <p className="agent-stage-kicker">STEP 2 · BEHAVIOR</p>
                  <h3>Define how it should work</h3>
                  <small>Write the instructions that guide every conversation.</small>
                  <label>
                    Instructions (required to publish)
                    <textarea
                      value={draft.instructions}
                      onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
                      placeholder="How this agent should work with the team."
                      rows={7}
                    />
                  </label>
                  <label>
                    Model (optional)
                    <select value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })}>
                      {models.map((model) => (
                        <option key={model} value={model}>
                          {model === "workspace-default" ? "Workspace default" : model}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              {builderStep === "knowledge" && (
                <>
                  <p className="agent-stage-kicker">STEP 3 · KNOWLEDGE</p>
                  <h3>Give the agent team context</h3>
                  <small>
                    Add standards, terminology, policies, or reference material that should shape its responses.
                  </small>
                  <label>
                    Knowledge (optional)
                    <textarea
                      value={draft.knowledge}
                      onChange={(e) => setDraft({ ...draft, knowledge: e.target.value })}
                      placeholder="Team context, standards, and references."
                      rows={8}
                    />
                  </label>
                </>
              )}
              {builderStep === "tools" && (
                <>
                  <p className="agent-stage-kicker">STEP 4 · TOOL ACCESS</p>
                  <h3>Choose approved connections</h3>
                  <small>
                    Enable only the sources this agent needs. The agent will still ask for approval before external
                    changes.
                  </small>
                  <fieldset>
                    <legend>Approved tools (optional)</legend>
                    {providers.map((provider) => (
                      <label className="check-row" key={provider}>
                        <span>{provider}</span>
                        <span className="toggle-switch">
                          <input
                            type="checkbox"
                            checked={draft.approvedProviders.includes(provider)}
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                approvedProviders: e.target.checked
                                  ? [...draft.approvedProviders, provider]
                                  : draft.approvedProviders.filter((p) => p !== provider),
                              })
                            }
                          />
                          <span className="toggle-track" aria-hidden="true" />
                        </span>
                      </label>
                    ))}
                  </fieldset>
                </>
              )}
              {builderStep === "review" && (
                <>
                  <p className="agent-stage-kicker">STEP 5 · REVIEW</p>
                  <h3>Ready to save this agent?</h3>
                  <small>Check the configuration below. You can return to any step before saving or publishing.</small>
                  <dl className="agent-review-summary">
                    <div>
                      <dt>Role</dt>
                      <dd>{draft.name || "Untitled agent"}</dd>
                    </div>
                    <div>
                      <dt>Specialist</dt>
                      <dd>{draft.baseAgent}</dd>
                    </div>
                    <div>
                      <dt>Instructions</dt>
                      <dd>{draft.instructions || "No instructions added"}</dd>
                    </div>
                    <div>
                      <dt>Knowledge</dt>
                      <dd>{draft.knowledge ? "Included" : "Not added"}</dd>
                    </div>
                    <div>
                      <dt>Approved tools</dt>
                      <dd>{draft.approvedProviders.length ? draft.approvedProviders.join(", ") : "None"}</dd>
                    </div>
                  </dl>
                </>
              )}
            </fieldset>
          </section>
          <div className="agent-builder-footer">
            <button
              type="button"
              className="secondary-button"
              disabled={builderStep === "identity"}
              onClick={() =>
                setBuilderStep(
                  (
                    {
                      identity: "identity",
                      behavior: "identity",
                      knowledge: "behavior",
                      tools: "knowledge",
                      review: "tools",
                    } as const
                  )[builderStep],
                )
              }
            >
              Back
            </button>
            {builderStep !== "review" ? (
              <button
                type="button"
                className="primary-button"
                onClick={() =>
                  setBuilderStep(
                    (
                      {
                        identity: "behavior",
                        behavior: "knowledge",
                        knowledge: "tools",
                        tools: "review",
                        review: "review",
                      } as const
                    )[builderStep],
                  )
                }
              >
                Continue
              </button>
            ) : (
              <button className="primary-button" onClick={save} disabled={saving || !canChange || !draft.name.trim()}>
                {saving ? "Saving…" : "Save draft"}
              </button>
            )}
            {selected && (
              <button
                className="secondary-button"
                onClick={publish}
                disabled={saving || !canPublish || !draft.instructions.trim()}
                title={!draft.instructions.trim() ? "Add instructions before publishing this agent." : undefined}
              >
                Publish version
              </button>
            )}
            {selected?.status === "published" && (
              <Link className="secondary-button" href={`/w/${id}?agentId=${selected.id}`}>
                Test in chat
              </Link>
            )}
            {selected && (
              <button className="agent-delete-button" onClick={remove} disabled={saving || !canChange}>
                Delete
              </button>
            )}
          </div>
          <AccessNotice
            workspaceId={id}
            access={access}
            permission="createAgents"
            message="Creating, editing, or deleting agents requires the “Create agents and workflows” permission. You can still view agents, versions, and configuration."
          />
          {selected && (
            <AccessNotice
              workspaceId={id}
              access={access}
              permission="publishAgents"
              message="Publishing an agent version requires the “Publish agents” permission."
            />
          )}
          {error && <p className="error-text">{error}</p>}
          {selected && (
            <div className="agent-versions">
              <h3>Version history</h3>
              {versions.length ? (
                versions.map((version) => (
                  <p key={version.id}>
                    Version {version.version} · {new Date(version.createdAt).toLocaleString()}
                  </p>
                ))
              ) : (
                <p className="muted">Publish this draft to create the first version.</p>
              )}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
function AgentAvatar({ name }: { name: string }) {
  const initials =
    name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "AI";
  const hue = [...name].reduce((total, char) => total + char.charCodeAt(0), 0) % 360;
  return (
    <span
      className="agent-avatar"
      style={{ background: `linear-gradient(135deg,hsl(${hue} 70% 48%),hsl(${(hue + 44) % 360} 76% 63%))` }}
    >
      {initials}
    </span>
  );
}
