// Standalone diagnostic -- deliberately has NO dependency on this
// project's own code (no chat-server, no Docker/MCP, no DB). Run it
// directly on the machine running Ollama:
//
//   node scripts/diagnostics/test-ollama-tool-schema.mjs
//
// It sends two requests straight to Ollama's OpenAI-compatible endpoint:
// one with no tools, one with a synthetic tools array sized/shaped like
// this project's real GitHub MCP tool schema (~4500 tokens, verbose
// "mega-tool" style descriptions) -- but with made-up names/content, so
// this isolates whether TOOL-SCHEMA SIZE itself is what's slow/hanging,
// independent of the real GitHub MCP server, Docker, or any of this
// project's own code.

const BASE_URL = process.env.AGENT_LLM_BASE_URL ?? "http://localhost:11434/v1";
const MODEL = process.env.AGENT_LLM_MODEL ?? "mai-agent";

function makeFakeTools(count) {
  const tools = [];
  for (let i = 0; i < count; i++) {
    tools.push({
      type: "function",
      function: {
        name: `fake_tool_${i}`,
        description:
          `This is a fake diagnostic tool number ${i}, with a moderately long description meant to roughly ` +
          `resemble the verbosity of one of github-mcp-server's real consolidated "mega-tools" that dispatch ` +
          `through a method argument covering several related operations at once (get/list/create/update), so ` +
          `the overall schema size in this test is comparable to what this project actually sends in production.`,
        parameters: {
          type: "object",
          properties: {
            method: { type: "string", description: "which operation to perform, e.g. get, list, create, or update" },
            owner: { type: "string", description: "the repository owner" },
            repo: { type: "string", description: "the repository name" },
            id: { type: "number", description: "a numeric id argument, meaning depends on method" },
            filter: { type: "object", description: "an optional filter object, meaning depends on method" },
          },
          required: ["method", "owner", "repo"],
        },
      },
    });
  }
  return tools;
}

async function run(label, tools) {
  const body = {
    model: MODEL,
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Say hello in one sentence." },
    ],
    max_tokens: 100,
    ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
  };
  const bodyStr = JSON.stringify(body);
  console.log(`\n=== ${label} (request body ${bodyStr.length} chars, ~${Math.round(bodyStr.length / 4)} tokens est.) ===`);
  const start = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: bodyStr,
    });
    const elapsed = Date.now() - start;
    const data = await res.json();
    console.log(`${label}: HTTP ${res.status} in ${elapsed}ms`);
    console.log(JSON.stringify(data).slice(0, 400));
  } catch (err) {
    const elapsed = Date.now() - start;
    console.log(`${label}: FAILED after ${elapsed}ms -- ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.cause) console.log(`  cause: ${err.cause}`);
  }
}

console.log(`Testing ${BASE_URL} with model "${MODEL}"...`);
await run("no tools", []);
await run("14 fake tools (~size of real GitHub schema)", makeFakeTools(14));
