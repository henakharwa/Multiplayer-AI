#!/usr/bin/env node
// A tiny OpenAI-compatible /chat/completions server for the browser tests.
// It answers every request with a predictable reply that quotes the latest
// user message, so tests can assert on the agent's answer without a real
// model, an API key or network access.
import { createServer } from "node:http";

const port = Number(process.env.MOCK_LLM_PORT ?? 4911);

function lastUserMessage(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "user" && typeof message.content === "string") return message.content;
  }
  return "";
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
    return;
  }
  if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found" }));
    return;
  }
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    let messages = [];
    try {
      messages = JSON.parse(body).messages ?? [];
    } catch {
      // Reply anyway; the agent loop only needs a well-formed answer.
    }
    // The chat history arrives as "Name: text"; quote just the text.
    const asked = lastUserMessage(messages).replace(/^[^:\n]{1,80}:\s*/, "").trim().slice(0, 120);
    const reply = {
      id: `mock-${Date.now()}`,
      object: "chat.completion",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: `Mock agent reply to: ${asked}` } }],
      usage: { prompt_tokens: 10, completion_tokens: 10 },
    };
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
  });
});

server.listen(port, () => console.log(`mock LLM listening on :${port}`));
