// The built-in agents a message can be addressed to, and their starter prompts.

export type AgentKind = "project" | "github" | "slack" | "linear" | "notion" | "figma";
export const AGENTS: Array<{ id: AgentKind; name: string; description: string }> = [
  { id: "project", name: "Project", description: "Planning and coordination" },
  { id: "github", name: "GitHub", description: "Code, issues, and pull requests" },
  { id: "slack", name: "Slack", description: "Team communication" },
  { id: "linear", name: "Linear", description: "Issues and project planning" },
  { id: "notion", name: "Notion", description: "Knowledge and documents" },
  { id: "figma", name: "Figma", description: "Design context and handoff" },
];

export type StarterTemplate = { prompt: string; requiresApproval?: boolean };

export const STARTER_TEMPLATES: Record<AgentKind, StarterTemplate[]> = {
  project: [
    { prompt: "Summarize this conversation and list the next steps." },
    { prompt: "Create a simple plan for this project." },
    { prompt: "What should our team decide next?" },
  ],
  github: [
    { prompt: "List the open issues in the connected repository." },
    { prompt: "Summarize the latest pull requests." },
    { prompt: "Create an issue for: [describe the task]", requiresApproval: true },
  ],
  slack: [
    { prompt: "List the channels I can access." },
    { prompt: "Find recent messages about: [topic]" },
    { prompt: "Post an update in #[channel]: [message]", requiresApproval: true },
  ],
  linear: [
    { prompt: "List my active issues." },
    { prompt: "Find issues related to: [topic]" },
    { prompt: "What work is currently blocked?" },
  ],
  notion: [
    { prompt: "Search Notion for: [topic]" },
    { prompt: "Find documents about: [project]" },
    { prompt: "Create a page for [topic] under [parent page].", requiresApproval: true },
  ],
  figma: [
    { prompt: "List the Figma files I can access." },
    { prompt: "Summarize the design in [file name]." },
    { prompt: "Find comments or open design questions in [file name]." },
  ],
};

export function identityForAgentMessage(authorName: string): { kind: AgentKind; name: string } {
  const knownAgents: Record<string, { kind: AgentKind; name: string }> = {
    "Project Agent": { kind: "project", name: "Project" },
    "GitHub Agent": { kind: "github", name: "GitHub" },
    "Slack Agent": { kind: "slack", name: "Slack" },
    "Linear Agent": { kind: "linear", name: "Linear" },
    "Notion Agent": { kind: "notion", name: "Notion" },
    "Figma Agent": { kind: "figma", name: "Figma" },
  };
  return knownAgents[authorName] ?? { kind: "project", name: authorName.replace(/\s+Agent$/, "").trim() || "Project" };
}
