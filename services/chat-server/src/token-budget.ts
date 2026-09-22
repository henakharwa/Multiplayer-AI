import { encode } from "gpt-tokenizer";
import type { ChatMessage } from "./llm-client.js";

// A rough, conservative approximation -- gpt-tokenizer's default encoding
// (cl100k_base) isn't the exact tokenizer this project's default model
// (Groq's openai/gpt-oss-20b) uses internally, but it's in the same
// family and close enough to budget against. Every caller here also adds
// its own safety margin on top for that gap (see agent.ts's
// TOKEN_BUDGET_SAFETY_MARGIN). The alternative -- no estimate at all, or
// a blind chars/4 guess -- is what let requests silently grow past
// Groq's free-tier 8000 TPM limit unnoticed until they failed outright
// (found live 2026-09-20).
export function estimateTokens(text: string): number {
  return encode(text).length;
}

// Rough per-message wire overhead (role, name, and message-boundary
// tokens the chat-completions format adds beyond the raw content) --
// small per message, but adds up over a long history, so it's counted
// rather than ignored.
const PER_MESSAGE_OVERHEAD_TOKENS = 4;

// Keeps the most recent messages that fit within `budgetTokens`, dropping
// older ones first, and returns them back in chronological order. Always
// keeps at least the single most recent message even if it alone exceeds
// the budget -- replying with zero context is worse than sending one
// request that's still too large (which fails loudly with a clear 413
// rather than silently answering blind).
export function trimHistoryToBudget(history: ChatMessage[], budgetTokens: number): ChatMessage[] {
  const kept: ChatMessage[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    const cost = estimateTokens(message.content ?? "") + PER_MESSAGE_OVERHEAD_TOKENS;
    if (kept.length > 0 && used + cost > Math.max(budgetTokens, 0)) break;
    kept.unshift(message);
    used += cost;
  }
  return kept;
}
