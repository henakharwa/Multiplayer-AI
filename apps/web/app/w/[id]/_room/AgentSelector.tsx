"use client";

import { useRef, useState } from "react";
import type { WorkspaceAgent } from "@mai-chat/shared-types";
import { AGENTS, type AgentKind } from "./agents";
import { AgentIcon, CustomAgentLogo, SearchGlyph } from "./glyphs";

// The agent chip in the composer and its searchable picker.
export default function AgentSelector({
  selected,
  selectedName,
  customName,
  customAgents,
  selectedCustomId,
  open,
  onToggle,
  onSelect,
  onSelectCustom,
  compact = false,
}: {
  selected: AgentKind;
  selectedName: string;
  customName?: string;
  customAgents: WorkspaceAgent[];
  selectedCustomId?: string;
  open: boolean;
  onToggle: () => void;
  onSelect: (agent: AgentKind) => void;
  onSelectCustom: (agent: WorkspaceAgent) => void;
  compact?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [pickerPlacement, setPickerPlacement] = useState<"above" | "below">("above");
  const [pickerMaxHeight, setPickerMaxHeight] = useState(330);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const matchingAgents = AGENTS.filter((agent) =>
    `${agent.name} ${agent.description}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const matchingCustomAgents = customAgents.filter((agent) =>
    agent.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  function togglePicker() {
    if (!open && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const above = rect.top - 12;
      const below = window.innerHeight - rect.bottom - 12;
      const placement = above >= below ? "above" : "below";
      setPickerPlacement(placement);
      setPickerMaxHeight(Math.max(96, Math.min(330, placement === "above" ? above : below)));
    }
    onToggle();
  }
  return (
    <div className={`agent-selector${compact ? " compact" : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className="workspace-agent-chip"
        onClick={togglePicker}
        title={`Select agent: ${selectedName}`}
        aria-label={`Select agent: ${selectedName}`}
      >
        {customName ? <CustomAgentLogo name={customName} /> : <AgentIcon agent={selected} />}
      </button>
      {open && (
        <div className={`agent-picker ${pickerPlacement}`} style={{ maxHeight: pickerMaxHeight }} role="menu">
          <div className="agent-picker-toolbar">
            <label>
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search agents"
                aria-label="Search agents"
              />
              <SearchGlyph />
            </label>
          </div>
          <div className="agent-picker-columns">
            <section>
              <p className="agent-picker-section">Built-in agents</p>
              <div className="agent-picker-list">
                {matchingAgents.map((agent) => (
                  <button
                    type="button"
                    key={agent.id}
                    className={!selectedCustomId && agent.id === selected ? "selected" : ""}
                    onClick={() => onSelect(agent.id)}
                  >
                    <span>
                      <AgentIcon agent={agent.id} />
                    </span>
                    <strong>{agent.name}</strong>
                    <small>{agent.description}</small>
                    {!selectedCustomId && agent.id === selected && <b>✓</b>}
                  </button>
                ))}
                {matchingAgents.length === 0 && <p>No built-in agents match.</p>}
              </div>
            </section>
            <section>
              <p className="agent-picker-section">Your agents</p>
              <div className="agent-picker-list">
                {matchingCustomAgents.map((agent) => (
                  <button
                    type="button"
                    key={agent.id}
                    className={agent.id === selectedCustomId ? "selected" : ""}
                    onClick={() => onSelectCustom(agent)}
                  >
                    <span>
                      <CustomAgentLogo name={agent.name} />
                    </span>
                    <strong>{agent.name}</strong>
                    <small>
                      {agent.baseAgent} · version {agent.publishedVersion}
                    </small>
                    {agent.id === selectedCustomId && <b>✓</b>}
                  </button>
                ))}
                {matchingCustomAgents.length === 0 && <p>No published agents yet.</p>}
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
}
