import { afterEach, describe, expect, it, vi } from "vitest";
import { chatCompletion, isCreditExhaustion, LlmHttpError, type LlmConfig } from "../src/llm-client.js";

const primary: LlmConfig = {
  baseUrl: "https://api.openai.example/v1",
  apiKey: "paid-key",
  model: "gpt-6-luna",
  maxTokens: 128,
  tpmLimit: 8192,
  fallback: {
    baseUrl: "https://free.example/v1",
    apiKey: "free-key",
    model: "free-model",
    maxTokens: 128,
    tpmLimit: 8192,
  },
};

afterEach(() => vi.unstubAllGlobals());

describe("paid LLM fallback", () => {
  it("uses the configured free provider when the paid account reports exhausted credit", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "insufficient_quota", message: "You exceeded your current quota." } }), { status: 429, statusText: "Too Many Requests" }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Fallback reply" } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const reply = await chatCompletion(primary, [{ role: "user", content: "hello" }], []);

    expect(reply.content).toBe("Fallback reply");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain("api.openai.example");
    expect(String(fetchMock.mock.calls[1][0])).toContain("free.example");
  });

  it("does not treat a normal rate limit as exhausted credit", () => {
    expect(isCreditExhaustion(new LlmHttpError(429, "Too Many Requests", "Please try again in 5s.", "https://provider.example"))).toBe(false);
  });
});
