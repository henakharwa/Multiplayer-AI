import { STARTER_TEMPLATES, type AgentKind } from "./agents";

// Suggested first prompts for the selected agent, or a nudge to connect it.
export default function StarterPrompts({
  agent,
  agentName,
  connected,
  canEdit,
  canConnect,
  chatOpen,
  onChoose,
  onConnect,
  compact = false,
}: {
  agent: AgentKind;
  agentName: string;
  connected: boolean;
  canEdit: boolean;
  // Connecting tools requires connectTools (Admins by default).
  canConnect: boolean;
  chatOpen: boolean;
  onChoose: (prompt: string) => void;
  onConnect: () => void;
  compact?: boolean;
}) {
  return (
    <section
      className={`workspace-starter-prompts${compact ? " compact" : ""}`}
      aria-label={`${agentName} starter prompts`}
    >
      <p>Try {agentName}</p>
      <div>
        {connected ? (
          STARTER_TEMPLATES[agent].map((template) => (
            <button
              key={template.prompt}
              type="button"
              onClick={() => onChoose(template.prompt)}
              disabled={!canEdit || !chatOpen}
            >
              <span>{template.prompt}</span>
              {template.requiresApproval && <small>Requires approval</small>}
            </button>
          ))
        ) : (
          <button
            type="button"
            onClick={onConnect}
            disabled={!canEdit || !canConnect}
            title={canConnect ? undefined : "Connecting tools requires the “Connect and manage tools” permission."}
          >
            <span>
              {canConnect
                ? `Connect ${agentName} to get started`
                : `${agentName} isn't connected — ask an Admin or request tool access`}
            </span>
          </button>
        )}
      </div>
    </section>
  );
}
