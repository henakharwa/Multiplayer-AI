import { describe, it, expect } from "vitest";
import { estimateTokens, trimHistoryToBudget } from "../src/token-budget.js";
import type { ChatMessage } from "../src/llm-client.js";

describe("estimateTokens", () => {
  it("returns 0 for an empty string and a positive count for real text", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("hello world")).toBeGreaterThan(0);
  });

  it("scales roughly with text length", () => {
    const short = estimateTokens("hello");
    const long = estimateTokens("hello ".repeat(50));
    expect(long).toBeGreaterThan(short * 10);
  });
});

describe("trimHistoryToBudget", () => {
  function msg(content: string): ChatMessage {
    return { role: "user", content };
  }

  it("keeps everything when it all fits comfortably within budget", () => {
    const history = [msg("hi"), msg("how are you"), msg("good thanks")];
    const trimmed = trimHistoryToBudget(history, 1000);
    expect(trimmed).toEqual(history);
  });

  it("drops the oldest messages first when the budget is tight, keeping chronological order", () => {
    const history = [msg("very old message one"), msg("old message two"), msg("recent message three")];
    // Budget only large enough for roughly the last message.
    const tightBudget = estimateTokens("recent message three") + 4 + 2;
    const trimmed = trimHistoryToBudget(history, tightBudget);
    expect(trimmed.length).toBeLessThan(history.length);
    expect(trimmed[trimmed.length - 1]).toEqual(msg("recent message three"));
    // Whatever survived is still in original chronological order.
    const survivedContents = trimmed.map((m) => m.content);
    const originalIndexes = survivedContents.map((c) => history.findIndex((h) => h.content === c));
    expect(originalIndexes).toEqual([...originalIndexes].sort((a, b) => a - b));
  });

  it("always keeps at least the single most recent message, even over budget", () => {
    const history = [msg("a very very very very very very long earlier message"), msg("short")];
    const trimmed = trimHistoryToBudget(history, 0);
    expect(trimmed).toEqual([msg("short")]);
  });

  it("returns an empty array for an empty history regardless of budget", () => {
    expect(trimHistoryToBudget([], 1000)).toEqual([]);
    expect(trimHistoryToBudget([], 0)).toEqual([]);
  });
});
