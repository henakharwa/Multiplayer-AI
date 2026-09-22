/**
 * Talks to any OpenAI-compatible `/chat/completions` endpoint (Groq's free
 * tier by default -- fast, no-cost access to tool-calling-capable
 * open-weight models; OpenRouter or a local Ollama instance work too, just
 * an env var change). Deliberately a single hand-written fetch call rather
 * than an SDK -- same reasoning as this project's prior build: a
 * well-documented, stable wire format is easier to verify by reading the
 * response than trusting an SDK's internals.
 */
import { Agent } from "undici";

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  // Groq's default max output tokens for a tool-calling response is small
  // enough that a tool call carrying a whole file's contents as an
  // argument (e.g. commit_github_file) can get cut off mid-generation --
  // which produces exactly the kind of truncated, unparseable JSON that
  // shows up as a 400 "Failed to parse tool call arguments as JSON"
  // (found live 2026-09-20 asking the agent to commit a new Python file).
  // Raising this gives the model room to finish -- but it's not free:
  // Groq counts max_tokens against the SAME per-minute budget as the
  // prompt itself when deciding whether to even accept a request (a 413
  // "Request too large" happens before any generation starts), so a
  // bigger number here directly shrinks how much of that budget is left
  // for the tool schema and conversation history. See agent.ts's
  // history-budget comment for the numbers that motivated 2048 as the
  // default instead of the 4096 this was briefly raised to.
  maxTokens: number;
  // The provider's tokens-per-minute ceiling for a single request
  // (Groq's free tier: 8000). agent.ts sizes how much conversation
  // history it includes each turn against this, the tool schema's real
  // size, and maxTokens above -- so raising this (e.g. after upgrading to
  // a paid tier with a much bigger TPM) lets more history through instead
  // of it being trimmed unnecessarily.
  tpmLimit: number;
}

/** Injectable for tests -- exercises the real tool-execution loop without a real network call. */
export type LlmChatFn = (config: LlmConfig, messages: ChatMessage[], tools: ToolDefinition[]) => Promise<ChatMessage>;

// This retry logic was written against Groq's cloud API and its specific
// error shapes ("Please try again in 22.125s", error.code
// "tool_use_failed") -- it's dormant but harmless against a local Ollama
// server (see resolveLlmConfig's default below), which doesn't impose a
// per-minute/per-day quota to retry around in the first place. Kept here
// rather than removed since switching back to Groq (or another
// rate-limited provider) is meant to be a one-line .env change, not a
// code change.
//
// A large connected tool schema (GitHub's MCP-provided tools, plus
// Slack's) makes every request noticeably bigger than a tool-free one --
// easy to trip Groq's free-tier 8000 TPM limit with just a couple of
// messages back to back. A 429 there is a transient
// per-minute quota, not a real failure, and Groq's own error body tells us
// exactly how long to wait ("Please try again in 22.125s") -- so retry
// instead of surfacing it as a broken chat. A 5xx is treated the same way
// (also usually transient).
//
// A 400 with error.code "tool_use_failed" is different in cause (the model
// generated malformed/truncated JSON for a tool call's arguments, not a
// request problem) but the same in spirit -- it's the model's sampling
// misfiring on that one attempt, and a fresh attempt often succeeds since
// generation isn't deterministic. So it's retried too. Anything else
// (401, a genuinely invalid request, etc) is thrown immediately.
const MAX_RETRIES = 3;

// A near-exhausted *daily* quota (Groq's TPD, not TPM) can report a wait
// far longer than any per-minute rate limit ever would -- "try again in
// 21m7.056s" is a real message we've seen, not a hypothetical. Retrying
// sleeps inside the agent turn, which holds the whole workspace's chat
// busy (see server.ts's busy flag / agent_status broadcast) for exactly
// as long as we wait -- so past this threshold we don't retry at all.
// Failing fast with a clear message beats silently locking everyone's
// composer for 21 minutes.
//
// A per-minute (TPM) wait, by definition, is never more than about a
// minute -- found live 2026-09-21: agent.ts's own per-turn budgeting
// (see its historyBudget comment) only keeps a SINGLE request under the
// configured tpmLimit, it does nothing to stop two normal-sized requests
// sent moments apart from adding up past Groq's rolling 60s window ("Used
// 7325" from the previous turn plus "Requested 4934" from this one, on an
// 8000 limit). That produced a "try again in 31.9s" wait, which the
// original 20s threshold treated as "too long to wait on" and surfaced
// as a hard chat error the user had to notice and manually retry --
// exactly the kind of routine, self-resolving throttle a real chat
// client should ride out quietly. Raised to comfortably cover any true
// per-minute wait (Groq's own messages top out a little over 60s for a
// TPM limit) while still failing fast on the daily-quota case the
// comment above describes, which is an order of magnitude longer.
const MAX_AUTO_RETRY_DELAY_MS = 65_000;

// Node's global fetch (built on undici) gives up waiting for a
// response's headers well before a slow-but-healthy local model can
// finish -- found live 2026-09-21: a request with this project's real
// GitHub tool schema needed several minutes of CPU-only prompt
// processing (measured directly: 2728 prompt tokens took 205s, ~13
// tok/sec, on hardware with no dedicated GPU) and was killed with
// UND_ERR_HEADERS_TIMEOUT before Ollama ever got to respond, turning a
// slow-but-correct request into a hard failure. This raises that ceiling
// for LLM requests specifically (not touched globally, so it can't mask
// an unrelated fetch hanging elsewhere in the app) -- it does NOT make
// anything faster, it only stops a genuinely slow local model from being
// treated as broken. 20 minutes is generous even for the biggest prompt
// this project sends today; a truly hung server still fails eventually
// rather than blocking forever.
const LLM_FETCH_TIMEOUT_MS = 20 * 60 * 1000;
const longRunningLlmDispatcher = new Agent({
  headersTimeout: LLM_FETCH_TIMEOUT_MS,
  bodyTimeout: LLM_FETCH_TIMEOUT_MS,
});

// Groq's own wait-time text comes in a few shapes: "try again in 7.056s"
// for a per-minute limit, or "try again in 21m7.056s" for a much longer
// daily-quota wait. The original version of this only matched the
// seconds-only form -- against "21m7.056s" it silently failed to parse
// (no "s" immediately follows the leading digits, since "m" is in the
// way), so a 21-minute wait fell through to the exponential-backoff
// default (~1-4s) and burned through MAX_RETRIES in a few seconds for
// nothing. This matches both shapes and returns the true total.
function parseRetryDelayMs(body: string): number | null {
  const match = body.match(/try again in (?:([\d.]+)m)?([\d.]+)s/i);
  if (!match) return null;
  const minutes = match[1] ? Number(match[1]) : 0;
  const seconds = Number(match[2]);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
  return Math.ceil((minutes * 60 + seconds) * 1000) + 250;
}

function friendlyWaitSuffix(delayMs: number | null): string {
  if (delayMs === null) return "";
  const totalSeconds = Math.ceil(delayMs / 1000);
  if (totalSeconds < 60) return ` Try again in about ${totalSeconds}s.`;
  const minutes = Math.round(totalSeconds / 60);
  return ` Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

function isRetryableFailure(status: number, body: string): boolean {
  if (status === 429 || status >= 500) return true;
  if (status === 400) {
    try {
      const parsed = JSON.parse(body) as { error?: { code?: string } };
      return parsed.error?.code === "tool_use_failed";
    } catch {
      return false;
    }
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const chatCompletion: LlmChatFn = async (config, messages, tools) => {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  for (let attempt = 0; ; attempt++) {
    // A slow local model can legitimately take minutes here (see
    // LLM_FETCH_TIMEOUT_MS's comment above) -- without any output in
    // between, that's indistinguishable in the terminal from the process
    // having hung. This heartbeat is purely cosmetic (cleared as soon as
    // the request settles either way) but keeps a long-but-healthy wait
    // visibly different from a stuck one.
    const heartbeatStart = Date.now();
    const heartbeat = setInterval(() => {
      console.log(`[llm-client] still waiting on ${url} (${Math.round((Date.now() - heartbeatStart) / 1000)}s elapsed)...`);
    }, 30_000);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          max_tokens: config.maxTokens,
          ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
        }),
        // See LLM_FETCH_TIMEOUT_MS's comment -- without this, Node's
        // default dispatcher aborts a slow-but-working local-model
        // request well before it can finish.
        dispatcher: longRunningLlmDispatcher,
      } as unknown as RequestInit & { dispatcher: Agent });
      // (Node's built-in fetch types come from a separate, lighter-weight
      // "undici-types" package bundled with @types/node, which doesn't
      // structurally match the real undici package's own Agent/Dispatcher
      // types closely enough for a direct cast -- going through `unknown`
      // is the standard, safe way to bridge the two here; the actual
      // runtime object shape is exactly what fetch expects.)
    } finally {
      clearInterval(heartbeat);
    }

    if (res.ok) {
      const data = (await res.json()) as { choices?: { message?: ChatMessage }[] };
      const message = data.choices?.[0]?.message;
      if (!message) {
        throw new Error(`LLM response from ${url} had no choices[0].message: ${JSON.stringify(data).slice(0, 500)}`);
      }
      return message;
    }

    const body = await res.text().catch(() => "");
    const retryable = isRetryableFailure(res.status, body);
    const parsedDelayMs = retryable ? parseRetryDelayMs(body) : null;
    const tooLongToWaitOn = parsedDelayMs !== null && parsedDelayMs > MAX_AUTO_RETRY_DELAY_MS;
    if (!retryable || attempt >= MAX_RETRIES || tooLongToWaitOn) {
      throw new Error(
        `LLM request to ${url} failed: ${res.status} ${res.statusText} -- ${body.slice(0, 500)}${friendlyWaitSuffix(parsedDelayMs)}`
      );
    }
    const delayMs = parsedDelayMs ?? 1000 * 2 ** attempt;
    // Visible in the chat-server terminal -- without this, a retry looks
    // identical to a hang: the chat UI shows nothing at all (no message
    // has been inserted yet) for however long the retries take.
    console.warn(
      `[llm-client] ${res.status} from ${url}, retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`
    );
    await sleep(delayMs);
  }
};

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  // `??` alone doesn't help when a value is a present-but-empty string --
  // this project has one real incident from that exact gap (a `.env` line
  // left as `KEY=` loaded as `""`, silently breaking a default). See
  // services/chat-server/README.md.
  return values.find((v) => v !== undefined && v !== "");
}

// Defaults to a local Ollama server rather than Groq's cloud API -- free,
// open-source end to end (Ollama is MIT-licensed; the model this expects
// by default, an Ollama tag built from an open-weight model, has no
// usage cost either), and with no rate limit or daily quota at all, since
// nothing but your own machine is involved. Set AGENT_LLM_* env vars to
// point at Groq (or any other OpenAI-compatible provider) instead -- see
// .env.example's commented-out Groq block. See README.md's "Running the
// agent for free, without a cloud API key" section for the one-time
// Ollama setup this default assumes (installing Ollama, pulling a model,
// and building the "mai-agent" tag from scripts/ollama/Modelfile.mai-agent
// so it gets a context window bigger than Ollama's silent 2048-token
// default).
export function resolveLlmConfig(overrides?: Partial<LlmConfig>): LlmConfig {
  const baseUrl = firstNonEmpty(overrides?.baseUrl, process.env.AGENT_LLM_BASE_URL, "http://localhost:11434/v1")!;
  const apiKey = firstNonEmpty(overrides?.apiKey, process.env.AGENT_LLM_API_KEY, process.env.GROQ_API_KEY, "ollama")!;
  const model = firstNonEmpty(overrides?.model, process.env.AGENT_LLM_MODEL, "mai-agent")!;
  const maxTokensRaw = firstNonEmpty(
    overrides?.maxTokens !== undefined ? String(overrides.maxTokens) : undefined,
    process.env.AGENT_LLM_MAX_TOKENS
  );
  // 1024 by default -- there's no per-minute quota to share with history
  // when running fully locally, but CPU-only generation (the common case
  // for a dev machine with no dedicated GPU) is slow enough that a
  // shorter completion cap keeps replies from taking uncomfortably long.
  // (When this pointed at Groq, this was 2048 -- see git history around
  // 2026-09-20/21 for why even that was already a deliberate reduction
  // from a briefly-tried 4096: Groq counts max_tokens against the SAME
  // per-minute quota as the request itself, so a bigger number there
  // directly starved the tool schema and history of budget. That
  // constraint doesn't apply locally, but slow CPU generation is its own
  // reason to keep completions modest.)
  const maxTokens = maxTokensRaw !== undefined && Number.isFinite(Number(maxTokensRaw)) ? Number(maxTokensRaw) : 1024;
  const tpmLimitRaw = firstNonEmpty(
    overrides?.tpmLimit !== undefined ? String(overrides.tpmLimit) : undefined,
    process.env.AGENT_LLM_TPM_LIMIT
  );
  // 8192 to match scripts/ollama/Modelfile.mai-agent's num_ctx -- this
  // field's name is a holdover from when it always meant a provider's
  // tokens-PER-MINUTE ceiling (Groq's free tier: 8000), but agent.ts
  // really just treats it as "the token ceiling for a single request,
  // whatever imposes it" -- a rate limit for a hosted provider, or a
  // configured context window for a local model. Keep this in sync with
  // whatever num_ctx you actually set.
  const tpmLimit = tpmLimitRaw !== undefined && Number.isFinite(Number(tpmLimitRaw)) ? Number(tpmLimitRaw) : 8192;
  return { baseUrl, apiKey, model, maxTokens, tpmLimit };
}
