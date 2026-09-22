import { describe, it, expect } from "vitest";
import { toLlmHistory } from "../src/history.js";
import type { ChatMessage as PersistedMessage } from "@mai-chat/shared-types";

function persisted(overrides: Partial<PersistedMessage> = {}): PersistedMessage {
  return {
    id: "m1",
    workspaceId: "w1",
    role: "user",
    authorName: "Alice",
    content: "hello",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  } as PersistedMessage;
}

describe("toLlmHistory", () => {
  it("folds the author's display name into a user message's content", () => {
    const out = toLlmHistory([persisted({ role: "user", authorName: "Alice", content: "what's open?" })]);
    expect(out).toEqual([{ role: "user", content: "Alice: what's open?" }]);
  });

  it("maps an agent message to an assistant message with no author prefix", () => {
    const out = toLlmHistory([persisted({ role: "agent", authorName: "Agent", content: "Nothing's open." })]);
    expect(out).toEqual([{ role: "assistant", content: "Nothing's open." }]);
  });

  it("drops system-role rows entirely rather than forwarding them to the LLM", () => {
    // These are operational notices for the humans in the chat (an LLM
    // request failure, a "so-and-so confirmed" notice) -- not part of the
    // conversation, and often the very kind of large/irrelevant text that
    // makes future requests more likely to blow the token budget (see
    // agent.ts / token-budget.ts).
    const out = toLlmHistory([
      persisted({ role: "user", authorName: "Alice", content: "commit the fix" }),
      persisted({ role: "system", authorName: "System", content: "The agent couldn't reply: 429 ... (long error JSON)" }),
      persisted({ role: "agent", authorName: "Agent", content: "Done." }),
    ]);
    expect(out).toEqual([
      { role: "user", content: "Alice: commit the fix" },
      { role: "assistant", content: "Done." },
    ]);
  });

  it("preserves chronological order", () => {
    const out = toLlmHistory([
      persisted({ role: "user", content: "first" }),
      persisted({ role: "agent", content: "second" }),
      persisted({ role: "user", content: "third" }),
    ]);
    expect(out.map((m) => m.content)).toEqual(["Alice: first", "second", "Alice: third"]);
  });
});
