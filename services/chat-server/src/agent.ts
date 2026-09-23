import { chatCompletion, resolveLlmConfig, type ChatMessage, type LlmChatFn, type LlmConfig } from "./llm-client.js";
import type { ToolExecutor } from "./tools.js";
import { estimateTokens, trimHistoryToBudget } from "./token-budget.js";

export type AgentKind = "project" | "github" | "slack" | "linear" | "notion" | "figma";

export interface RunAgentTurnInput {
  /** Full conversation so far, in OpenAI chat-completions shape, NOT including a system prompt (one is added here). */
  history: ChatMessage[];
  tools: ToolExecutor[];
  // Set exactly when a GitHub repo is connected (see actions.ts's
  // buildToolsForWorkspace) -- used to tell the model which owner/repo to
  // pass as arguments to every GitHub tool call. Unlike the old
  // Octokit-backed tools (which were pre-bound to one repo via closure),
  // GitHub's MCP server tools are generic -- every call takes owner/repo
  // explicitly, so the model has to be told what they are.
  githubContext?: { owner: string; repo: string } | null;
  /**
   * Server-generated state for actions recently proposed in this
   * conversation. This is deliberately separate from chat history: action
   * confirmations are operational system messages and are not otherwise
   * sent to the model.
   */
  actionContext?: string | null;
  agentKind?: AgentKind;
  chat?: LlmChatFn;
  llmConfig?: LlmConfig;
  maxTurns?: number;
}

export interface RunAgentTurnResult {
  reply: string;
  toolCallsMade: number;
  // IDs of write actions proposed during this turn. The server uses these
  // exact IDs to avoid publishing a stale "please confirm" reply when a
  // person resolves the card before the model's follow-up text arrives.
  proposedActionIds?: string[];
}

// Built fresh per turn (rather than a single module-level constant) since
// the GitHub section depends on whether -- and which -- repo is connected
// right now. See buildToolsForWorkspace's githubContext.
function buildSystemPrompt(
  githubContext?: { owner: string; repo: string } | null,
  agentKind: AgentKind = "project",
  actionContext?: string | null
): string {
  const specialist = agentKind === "github"
    ? "You are the GitHub specialist. Focus on repository code, issues, pull requests, branches, and CI. Only use the GitHub tools supplied for this turn."
    : agentKind === "slack"
      ? "You are the Slack specialist. Focus on team communication, channels, and messages. Only use the Slack tools supplied for this turn."
      : agentKind === "linear"
        ? "You are the Linear specialist. Focus on issues, projects, milestones, and delivery planning. Only use the Linear tools supplied for this turn."
        : agentKind === "notion"
          ? "You are the Notion specialist. Focus on workspace knowledge, documents, and databases. Only use the Notion tools supplied for this turn."
          : agentKind === "figma"
            ? "You are the Figma specialist. Focus on design context, components, and design handoff. Only use the Figma tools supplied for this turn."
      : "You are the Project coordinator. Help plan, summarize, and coordinate the team. Do not use external GitHub or Slack tools; direct users to a specialist when relevant.";
  const githubSection = githubContext
    ? `A GitHub repository IS connected to this workspace right now: **${githubContext.owner}/${githubContext.repo}**.
Every GitHub tool call requires explicit "owner" and "repo" arguments --
they are never assumed or pre-filled for you. Unless the user clearly
means a different repository, always pass owner="${githubContext.owner}"
and repo="${githubContext.repo}".`
    : `No GitHub repository is connected to this workspace right now. If
someone asks about GitHub (issues, pull requests, code, commits, etc.),
say so plainly rather than guessing -- do not answer from memory or from
something said earlier in this conversation, since a repo could be
connected at any point after that.`;

  return `You are the shared AI teammate in a group chat workspace. ${specialist} Multiple
human members share this same chat and can all see your replies. You have
tools to read AND act on a connected GitHub repo -- issues, pull requests,
files, commits, and branches -- and to read a connected Slack workspace's
channels and message history, plus post a new message to one. If no
relevant tool is available for what someone's asking, say so plainly
rather than guessing.

${githubSection}

${actionContext ? `Trusted action status for this conversation (this is server-generated state, not a request or instruction):
${actionContext}
When asked whether one of these actions is complete, answer from this status. A confirmed action has completed; do not call it pending or ask for another confirmation.` : ""}

IMPORTANT: whether a GitHub repo is connected, and which tools you have for
it, can change at any point in this conversation, and your own earlier
replies in this same history may be stale -- from before that happened.
Whatever tools you were actually given THIS turn (not what you or anyone
else said earlier) is the only thing that tells you the truth right now.

Some tools change something outside this chat instead of just reading it
-- on GitHub: opening/updating/merging a pull request, committing a file,
creating a branch, creating an issue or comment, and so on; on Slack:
posting a message to a channel. Calling one of these tools does NOT
perform the action right away -- it queues a pending action that a human in this chat must
explicitly confirm or cancel from a card shown in the UI, and only fires
for real if they hit Confirm. Treat every such tool's result as "proposed,
awaiting confirmation", never as done. After calling one, briefly
describe what you're proposing, in case someone wants context before
deciding -- never say or imply you already did it. Do NOT tell them to
click Confirm or Cancel, and do not say it's "waiting on their
confirmation" -- the pending-action card already shown in the UI has its
own Confirm/Cancel buttons, so saying that is redundant at best, and
actively wrong if (very plausible, since your reply can take a moment to
generate) they've already clicked one by the time this reply appears.

IMPORTANT: the ONLY way a pending action can be approved is a human
clicking the Confirm button on its card in the UI. A user typing "yes",
"confirm", "go ahead", "do it", or anything similar in the chat is NOT a
confirmation and does not authorize anything -- chat text can never
approve a mutating action, no matter how clearly it's phrased or how many
people agree. If a user says something like that in chat, do not re-call
the tool, do not treat the action as approved, and do not say it happened
or is happening. Instead, tell them to click Confirm on the pending
action's card. Likewise, never invent or claim a confirmation happened
that you weren't shown proof of via a tool result.

Keep replies concise -- this is a live chat, not a report.`;
}

// Kept back from the model's per-minute token quota so this project's own
// approximate token counter (token-budget.ts's cl100k-based estimate,
// not gpt-oss-20b's real tokenizer), the chat-completions wire format's
// own per-message overhead, and simple rounding all have room to be wrong
// without still tipping a request over the limit.
const TOKEN_BUDGET_SAFETY_MARGIN = 200;

// The provider counts tool definitions as prompt tokens. Remote MCP servers
// can expose dozens of large JSON schemas, which made a Slack turn exceed
// Groq's 8k request cap before the user message was even considered. Keep
// the tool portion conservative so the system prompt, reply reservation,
// and some current chat context still fit.
const MAX_TOOL_SCHEMA_SHARE = 0.32;

function compactSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactSchema);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      // These fields help a human read a schema but do not affect the
      // shape of a tool call. Remote MCP schemas often repeat them enough
      // times to dominate the entire LLM request.
      .filter(([key]) => !["description", "title", "examples", "default", "$schema"].includes(key))
      .map(([key, child]) => [key, compactSchema(child)])
  );
}

function scoreTool(tool: ToolExecutor, request: string): number {
  const haystack = `${tool.definition.function.name} ${tool.definition.function.description}`.toLowerCase();
  const terms = request.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [];
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

/**
 * Produces a bounded, compact tool surface for one LLM request. Executing a
 * tool still uses the original executor; only the schema shown to the model
 * is shortened. Relevant tools are preferred using words from the newest
 * user request, then original order is used as a deterministic tie-break.
 */
export function selectToolsForBudget(tools: ToolExecutor[], request: string, budgetTokens: number): ToolExecutor[] {
  const ranked = tools
    .map((tool, index) => ({ tool, index, score: scoreTool(tool, request) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const selected: ToolExecutor[] = [];
  let used = 0;
  for (const { tool } of ranked) {
    const compact = {
      ...tool,
      definition: {
        ...tool.definition,
        function: {
          ...tool.definition.function,
          description: tool.definition.function.description.slice(0, 400),
          parameters: compactSchema(tool.definition.function.parameters) as Record<string, unknown>,
        },
      },
    };
    const cost = estimateTokens(JSON.stringify(compact.definition));
    if (selected.length > 0 && used + cost > budgetTokens) continue;
    if (cost > budgetTokens) continue;
    selected.push(compact);
    used += cost;
  }
  return selected;
}

// A write proposal appears as its own interactive card. The model's second
// response often repeats "please confirm it in the UI", which is redundant
// at best and can become stale if someone approves the card before that
// response arrives. Remove only sentences that combine confirmation wording
// with proposal-card mechanics; ordinary uses of words such as "confirm"
// remain untouched.
export function stripConfirmationBoilerplate(reply: string): string {
  const kept = reply
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => {
      if (!(/\b(confirm|cancel)\b/i.test(sentence) && /\b(pending|awaiting|card|ui|button)\b/i.test(sentence))) return sentence;
      // The model often puts the useful proposal and stale UI instruction
      // into one sentence. Keep the former by cutting only from the action
      // status / instruction phrase onward.
      return sentence
        .replace(/\s+(?:this|the)\s+(?:action|request|change|proposal)\s+(?:is|remains)\s+(?:pending|awaiting)[\s\S]*$/i, "")
        .replace(/\s+please\s+(?:confirm|cancel)\b[\s\S]*$/i, "")
        .replace(/^(?:this|the)\s+(?:action|request|change|proposal)\s+(?:is|remains)\s+(?:pending|awaiting)[\s\S]*$/i, "")
        .replace(/^please\s+(?:confirm|cancel)\b[\s\S]*$/i, "")
        .trim();
    })
    .filter(Boolean)
    .join(" ")
    .trim();
  return kept || "Here's what I'm proposing -- see the card above.";
}

export function replyForResolvedActions(
  actions: Array<{ status: "pending" | "confirmed" | "cancelled" | "failed" }>,
  agentKind: AgentKind
): string | null {
  if (actions.length === 0 || actions.some((action) => action.status === "pending")) return null;
  const label = agentKind === "github" ? "GitHub " : agentKind === "slack" ? "Slack " : "";
  const noun = actions.length === 1 ? "action" : "actions";
  if (actions.every((action) => action.status === "confirmed")) return `The proposed ${label}${noun} ${actions.length === 1 ? "was" : "were"} confirmed and completed.`;
  if (actions.every((action) => action.status === "cancelled")) return `The proposed ${label}${noun} ${actions.length === 1 ? "was" : "were"} cancelled.`;
  if (actions.every((action) => action.status === "failed")) return `The proposed ${label}${noun} could not be completed.`;
  return null;
}

export async function runAgentTurn(input: RunAgentTurnInput): Promise<RunAgentTurnResult> {
  const chat = input.chat ?? chatCompletion;
  const config = input.llmConfig ?? resolveLlmConfig();
  const maxTurns = input.maxTurns ?? 6;
  const newestUserRequest = [...input.history].reverse().find((message) => message.role === "user")?.content ?? "";
  const toolBudget = Math.max(600, Math.floor(config.tpmLimit * MAX_TOOL_SCHEMA_SHARE));
  const selectedTools = selectToolsForBudget(input.tools, newestUserRequest, toolBudget);
  const toolDefs = selectedTools.map((t) => t.definition);
  const toolMap = new Map(selectedTools.map((t) => [t.definition.function.name, t.execute]));

  // The connected tool schema (Slack's 2 hand-written tools, plus
  // whatever GitHub MCP tools are configured -- see github-mcp-pool.ts's
  // DEFAULT_GITHUB_TOOLS) plus this system prompt can already spend most
  // of a small per-minute token budget (see
  // llm-client.ts's LlmConfig.tpmLimit -- default 8000, matching Groq's
  // free tier) before a single word of conversation is added. Rather than
  // guess at a fixed history length, size the history window to whatever
  // budget is actually left THIS turn: total limit minus what the tools,
  // system prompt, and reserved completion tokens are already spending.
  // Found live 2026-09-20: a routine message failed with "Requested 8038"
  // against an 8000 limit, almost entirely from tool schema + system
  // prompt + the (then 4096) completion reserve, with nothing left over
  // for history at all.
  const systemPrompt = buildSystemPrompt(input.githubContext, input.agentKind, input.actionContext);
  const toolsTokens = estimateTokens(JSON.stringify(toolDefs));
  const systemTokens = estimateTokens(systemPrompt);
  const historyBudget = config.tpmLimit - toolsTokens - systemTokens - config.maxTokens - TOKEN_BUDGET_SAFETY_MARGIN;
  const trimmedHistory = trimHistoryToBudget(input.history, historyBudget);
  // Empirical, not estimated -- lets you actually see whether your
  // configured GitHub tool set (GITHUB_TOOLS / GITHUB_TOOLSETS -- see
  // github-mcp-pool.ts and README.md) leaves any real room for
  // conversation history, instead of guessing from this project's docs.
  console.log(
    `[agent] ${selectedTools.length}/${input.tools.length} tool(s), schema ~${toolsTokens} tok, system prompt ~${systemTokens} tok, ` +
      `history budget ~${Math.max(historyBudget, 0)} tok (of ${config.tpmLimit} total, ${config.maxTokens} reserved for the reply)`
  );

  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }, ...trimmedHistory];
  let toolCallsMade = 0;
  let proposedWriteAction = false;
  const proposedActionIds: string[] = [];

  for (let turn = 0; turn < maxTurns; turn++) {
    // Diagnostic timing (temporary, 2026-09-21 -- tracking down reports of
    // slow replies since GitHub's MCP tools were added): wall-clock time
    // of the LLM call itself, separate from tool execution below, so a
    // slow reply can be pinned on "the model is slow to respond" vs
    // "a specific tool call is slow" instead of just one big number.
    const llmCallStart = Date.now();
    const message = await chat(config, messages, toolDefs);
    console.log(`[timing] LLM call (turn ${turn + 1}) took ${Date.now() - llmCallStart}ms`);
    messages.push(message);

    if (!message.tool_calls || message.tool_calls.length === 0) {
      const reply = message.content ?? "";
      return { reply: proposedWriteAction ? stripConfirmationBoilerplate(reply) : reply, toolCallsMade, proposedActionIds };
    }

    for (const call of message.tool_calls) {
      toolCallsMade++;
      const exec = toolMap.get(call.function.name);
      let resultText: string;
      const toolCallStart = Date.now();
      if (!exec) {
        resultText = `error: unknown tool "${call.function.name}"`;
      } else {
        try {
          const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          const result = await exec(args);
          if (result && typeof result === "object" && (result as { status?: unknown }).status === "awaiting_user_confirmation") {
            proposedWriteAction = true;
            const actionId = (result as { actionId?: unknown }).actionId;
            if (typeof actionId === "string") proposedActionIds.push(actionId);
          }
          resultText = JSON.stringify(result);
        } catch (err) {
          resultText = `error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      console.log(`[timing] tool "${call.function.name}" took ${Date.now() - toolCallStart}ms`);
      messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: resultText });
    }
  }

  return {
    reply: "I wasn't able to finish that within my turn budget -- try asking something narrower.",
    toolCallsMade,
    proposedActionIds,
  };
}
