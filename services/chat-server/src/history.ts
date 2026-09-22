import type { ChatMessage as PersistedMessage } from "@mai-chat/shared-types";
import type { ChatMessage as LlmMessage } from "./llm-client.js";

// Converts the workspace's persisted chat history into the OpenAI
// chat-completions shape the agent loop expects. Author names are folded
// into each user message's content (e.g. "Alice: what's open right now?")
// since this is a GROUP chat -- the model needs to know who's asking, and
// the wire format has no separate "display name" field for a "user" role.
//
// "system"-role rows are dropped entirely here rather than converted --
// they're operational notices for the HUMANS in the chat (an LLM request
// failure, a "so-and-so confirmed/cancelled" notice), not part of the
// conversation, and replaying them back to the model on every future turn
// only burns tokens for nothing. Worse, an LLM-failure notice can itself
// carry a few hundred tokens of raw error JSON, which then counts toward
// -- and can help trigger -- the very token-limit failures it's
// reporting. The model doesn't need them: it has its own ground-truth
// mechanism for "did an action actually happen" (call a read tool), per
// the IMPORTANT note in agent.ts's SYSTEM_PROMPT.
//
// This intentionally does NOT trim to a fixed number of recent messages --
// agent.ts's runAgentTurn does that, sized to the actual token budget left
// over this turn (after the tool schema, system prompt, and reserved
// completion tokens), since a fixed count here would either waste budget
// when tools are few, or still overflow it when the current tool set is
// large. See token-budget.ts.
export function toLlmHistory(messages: PersistedMessage[]): LlmMessage[] {
  return messages
    .filter((m) => m.role !== "system")
    .map((m): LlmMessage => {
      if (m.role === "agent") {
        return { role: "assistant", content: m.content };
      }
      return { role: "user", content: `${m.authorName}: ${m.content}` };
    });
}
