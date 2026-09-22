import { describe, it, expect } from "vitest";
import { runAgentTurn, stripConfirmationBoilerplate } from "../src/agent.js";
import type { ChatMessage, LlmChatFn } from "../src/llm-client.js";
import type { ToolExecutor } from "../src/tools.js";

// Same "mock only the non-deterministic/external call" line this project
// has drawn since its first LLM integration: only the chat() call itself
// is scripted here, everything else (tool dispatch, argument parsing,
// message threading) is the real agent.ts code.

function fakeTool(name: string, execute: (args: Record<string, unknown>) => Promise<unknown>): ToolExecutor {
  return {
    definition: { type: "function", function: { name, description: name, parameters: { type: "object", properties: {} } } },
    execute,
  };
}

describe("runAgentTurn", () => {
  it("returns the plain reply when the model doesn't call any tool", async () => {
    const chat: LlmChatFn = async () => ({ role: "assistant", content: "Hello there!" });
    const result = await runAgentTurn({ history: [{ role: "user", content: "hi" }], tools: [], chat });
    expect(result.reply).toBe("Hello there!");
    expect(result.toolCallsMade).toBe(0);
  });

  it("executes a real tool call, feeds the result back, and returns the model's follow-up reply", async () => {
    let call = 0;
    const chat: LlmChatFn = async (_config, messages) => {
      call++;
      if (call === 1) {
        return {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"SF"}' } }],
        };
      }
      // Second call: the tool result should now be in the message history as a "tool" role message.
      const toolMessage = messages.find((m) => m.role === "tool");
      expect(toolMessage?.content).toContain("sunny");
      return { role: "assistant", content: "It's sunny in SF!" };
    };
    const tools = [fakeTool("get_weather", async (args) => ({ city: args.city, weather: "sunny" }))];
    const result = await runAgentTurn({ history: [{ role: "user", content: "weather in SF?" }], tools, chat });
    expect(result.reply).toBe("It's sunny in SF!");
    expect(result.toolCallsMade).toBe(1);
  });

  it("handles multiple tool calls in one turn", async () => {
    let call = 0;
    const executed: string[] = [];
    const chat: LlmChatFn = async () => {
      call++;
      if (call === 1) {
        return {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "a", type: "function", function: { name: "tool_a", arguments: "{}" } },
            { id: "b", type: "function", function: { name: "tool_b", arguments: "{}" } },
          ],
        };
      }
      return { role: "assistant", content: "done with both" };
    };
    const tools = [
      fakeTool("tool_a", async () => {
        executed.push("a");
        return "result a";
      }),
      fakeTool("tool_b", async () => {
        executed.push("b");
        return "result b";
      }),
    ];
    const result = await runAgentTurn({ history: [{ role: "user", content: "do both" }], tools, chat });
    expect(result.reply).toBe("done with both");
    expect(result.toolCallsMade).toBe(2);
    expect(executed.sort()).toEqual(["a", "b"]);
  });

  it("feeds a tool execution error back to the model instead of throwing", async () => {
    let call = 0;
    const chat: LlmChatFn = async (_config, messages) => {
      call++;
      if (call === 1) {
        return {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "x", type: "function", function: { name: "flaky_tool", arguments: "{}" } }],
        };
      }
      const toolMessage = messages.find((m) => m.role === "tool");
      expect(toolMessage?.content).toContain("error:");
      expect(toolMessage?.content).toContain("boom");
      return { role: "assistant", content: "That tool failed, sorry." };
    };
    const tools = [
      fakeTool("flaky_tool", async () => {
        throw new Error("boom");
      }),
    ];
    const result = await runAgentTurn({ history: [{ role: "user", content: "try it" }], tools, chat });
    expect(result.reply).toBe("That tool failed, sorry.");
  });

  it("reports an unknown tool name back to the model rather than crashing", async () => {
    let call = 0;
    const chat: LlmChatFn = async (_config, messages) => {
      call++;
      if (call === 1) {
        return {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "y", type: "function", function: { name: "nonexistent_tool", arguments: "{}" } }],
        };
      }
      const toolMessage = messages.find((m) => m.role === "tool");
      expect(toolMessage?.content).toContain("unknown tool");
      return { role: "assistant", content: "I don't have that capability." };
    };
    const result = await runAgentTurn({ history: [{ role: "user", content: "?" }], tools: [], chat });
    expect(result.reply).toBe("I don't have that capability.");
  });

  it("stops after maxTurns and returns a clear message instead of looping forever", async () => {
    const chat: LlmChatFn = async () => ({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "loop", type: "function", function: { name: "loopy", arguments: "{}" } }],
    });
    const tools = [fakeTool("loopy", async () => "again")];
    const result = await runAgentTurn({ history: [{ role: "user", content: "loop" }], tools, chat, maxTurns: 2 });
    expect(result.reply).toContain("turn budget");
    expect(result.toolCallsMade).toBe(2);
  });

  it("puts the system prompt first and preserves the given history order", async () => {
    let seenMessages: ChatMessage[] = [];
    const chat: LlmChatFn = async (_config, messages) => {
      // Snapshot the array now: agent.ts intentionally mutates `messages` in
      // place (push) after this callback returns, to build up the transcript
      // across turns -- holding onto the live reference here would see that
      // later push too, once the request has already resolved.
      seenMessages = messages.slice();
      return { role: "assistant", content: "ok" };
    };
    const history: ChatMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "second" },
    ];
    await runAgentTurn({ history, tools: [], chat });
    expect(seenMessages[0].role).toBe("system");
    expect(seenMessages.slice(1)).toEqual(history);
  });

  it("tells the model which repo is connected when githubContext is given, and says none is connected otherwise", async () => {
    let seenSystemPrompt = "";
    const chat: LlmChatFn = async (_config, messages) => {
      seenSystemPrompt = String(messages[0].content);
      return { role: "assistant", content: "ok" };
    };
    await runAgentTurn({ history: [], tools: [], chat, githubContext: { owner: "octocat", repo: "hello-world" } });
    expect(seenSystemPrompt).toContain("octocat/hello-world");

    await runAgentTurn({ history: [], tools: [], chat });
    expect(seenSystemPrompt).toContain("No GitHub repository is connected");
  });

  it("trims older history to fit the configured token budget, keeping the most recent messages and their order", async () => {
    let seenMessages: ChatMessage[] = [];
    const chat: LlmChatFn = async (_config, messages) => {
      seenMessages = messages.slice();
      return { role: "assistant", content: "ok" };
    };
    const history: ChatMessage[] = [
      { role: "user", content: "a very very very very very very very long old message that should get dropped" },
      { role: "assistant", content: "an equally long old reply that should also get dropped from history" },
      { role: "user", content: "short recent message" },
    ];
    // A tiny tpmLimit forces the history budget down to almost nothing --
    // this project's real config would never be this small, but it's the
    // simplest way to exercise the trimming path deterministically (see
    // token-budget.test.ts for trimHistoryToBudget's own unit tests).
    await runAgentTurn({
      history,
      tools: [],
      chat,
      llmConfig: { baseUrl: "http://example.invalid", apiKey: "k", model: "m", maxTokens: 10, tpmLimit: 60 },
    });
    expect(seenMessages[0].role).toBe("system");
    const forwardedHistory = seenMessages.slice(1);
    expect(forwardedHistory.length).toBeLessThan(history.length);
    expect(forwardedHistory[forwardedHistory.length - 1]).toEqual(history[history.length - 1]);
  });

  // Found live 2026-09-21: after proposing a write action, the model kept
  // telling the user to "click Confirm on the card" -- redundant (the
  // card already has its own buttons) and sometimes flatly stale, since
  // this reply is a SECOND LLM call that can finish after a fast human
  // already clicked Confirm. The system prompt asks the model not to say
  // this, but this project's default local model doesn't reliably follow
  // that, so runAgentTurn strips it deterministically whenever a tool
  // call this turn came back "awaiting_user_confirmation" -- see
  // stripConfirmationBoilerplate.
  it("strips redundant confirm/cancel chatter from the reply after proposing a write action", async () => {
    let call = 0;
    const chat: LlmChatFn = async () => {
      call++;
      if (call === 1) {
        return {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "open_issue", arguments: "{}" } }],
        };
      }
      return {
        role: "assistant",
        content:
          'I\'m preparing to create a new issue titled **"team meeting."**\n\nThis action is pending -- please confirm it in the card that just appeared.',
      };
    };
    const tools = [fakeTool("open_issue", async () => ({ status: "awaiting_user_confirmation", actionId: "a1", description: "open an issue" }))];
    const result = await runAgentTurn({ history: [{ role: "user", content: "open an issue" }], tools, chat });
    expect(result.reply).toContain("team meeting");
    expect(result.reply.toLowerCase()).not.toContain("confirm");
    expect(result.reply.toLowerCase()).not.toContain("card");
  });

  it("leaves the reply alone when no tool call proposed a write action this turn", async () => {
    const chat: LlmChatFn = async () => ({
      role: "assistant",
      content: "Sure -- I opened an issue titled \"confirm meeting time\" for the team to track.",
    });
    const result = await runAgentTurn({ history: [{ role: "user", content: "hi" }], tools: [], chat });
    expect(result.reply).toBe('Sure -- I opened an issue titled "confirm meeting time" for the team to track.');
  });
});

describe("stripConfirmationBoilerplate", () => {
  it("drops a paragraph that just tells the human to confirm/cancel via the card", () => {
    const reply = stripConfirmationBoilerplate(
      'I\'m proposing to open an issue titled "Team meeting".\n\nThis action is pending -- please confirm it in the card that just appeared.'
    );
    expect(reply).toBe('I\'m proposing to open an issue titled "Team meeting".');
  });

  it("handles the confirm/cancel sentence sharing a line with real content, including trailing markdown", () => {
    const reply = stripConfirmationBoilerplate(
      'I\'m preparing to create a new issue titled **"hena."** This action is pending – please confirm it in the card that just appeared.'
    );
    expect(reply).toBe('I\'m preparing to create a new issue titled **"hena."**');
  });

  it("leaves a sentence alone when it only has a confirm/cancel word, with no UI-mechanics word alongside it", () => {
    const reply = stripConfirmationBoilerplate('Sure, I opened an issue titled "confirm meeting time" for the team to track.');
    expect(reply).toBe('Sure, I opened an issue titled "confirm meeting time" for the team to track.');
  });

  it("falls back to a short static line if stripping would empty the reply out entirely", () => {
    const reply = stripConfirmationBoilerplate("Please confirm it in the card that just appeared.");
    expect(reply).toBe("Here's what I'm proposing -- see the card above.");
  });

  it("leaves an unrelated reply untouched", () => {
    const reply = stripConfirmationBoilerplate("The weather in SF is sunny today.");
    expect(reply).toBe("The weather in SF is sunny today.");
  });
});
