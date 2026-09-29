// Minimal, single-purpose Slack client -- used ONLY by the Release Notes
// artifact's "Share to Slack" action (services/chat-server/src/server.ts's
// POST .../share-to-slack). Not part of the agent's tool surface (that's
// still the Slack MCP server, see slack-mcp-pool.ts); this is a plain
// `chat.postMessage` call so a release note can be posted without going
// through the agent's tool-calling loop at all, same reasoning as
// github.ts's verification-only GithubClient.
export interface SlackClientOptions {
  token: string;
  // Injectable so tests can intercept the real network call without
  // mocking this client's own request-shaping logic.
  fetch?: typeof fetch;
}

export interface SlackClient {
  postMessage(channel: string, text: string): Promise<void>;
}

export function createSlackClient(opts: SlackClientOptions): SlackClient {
  const fetchImpl = opts.fetch ?? fetch;
  return {
    async postMessage(channel: string, text: string) {
      const res = await fetchImpl("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${opts.token}` },
        body: JSON.stringify({ channel, text }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      // Slack's API returns HTTP 200 even for most application-level
      // errors (invalid channel, missing scope, etc.) -- `ok` is the real
      // success signal, not the status code.
      if (!res.ok || !body.ok) throw new Error(body.error ?? `Slack API request failed (${res.status})`);
    },
  };
}
