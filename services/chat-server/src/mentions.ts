// @-mention / handoff mechanics (docs/spec.md Phase 2: "members can
// direct a message at the agent or hand a task to a teammate within the
// thread"). Parsing lives here, alone, so both the WebSocket handler
// (server.ts, deciding whether to run an agent turn) and any future
// caller can share one definition of what counts as a mention.

export interface MentionTarget {
  userId: string;
  displayName: string;
}

export interface ParsedMentions {
  // True unless the message @-mentions one or more teammates and does
  // NOT also @-mention the agent -- see schema.sql's comment on
  // messages.mentions_agent for the full reasoning. A message with no
  // @-mention at all is the common case and defaults to true, matching
  // this app's behavior before mentions existed at all.
  mentionsAgent: boolean;
  // Deduplicated, in the order each teammate was first mentioned.
  mentionedUserIds: string[];
}

// Recognized ways to address the agent itself -- kept separate from
// teammate names since the agent isn't a row in `users`/workspace
// membership. Case-insensitive, matched the same way a teammate's name
// is (see matchMentionAt below).
const AGENT_ALIASES = ["agent", "ai", "assistant", "bot"];

// Tries to match the longest known target (a teammate's display name or
// an agent alias) starting at `content[at + 1]` (right after the '@').
// Longest-first so "@Jane Doe" resolves to the teammate named "Jane Doe"
// rather than stopping early at just "Jane" if both existed. Requires a
// word boundary right after the match (not followed by another letter/
// digit) so "@Janet" doesn't false-positive match a mention of "@Jane".
function matchMentionAt(
  content: string,
  at: number,
  candidates: { key: string; isAgent: boolean; userId?: string }[]
): { length: number; isAgent: boolean; userId?: string } | null {
  const rest = content.slice(at + 1);
  let best: { length: number; isAgent: boolean; userId?: string } | null = null;
  for (const candidate of candidates) {
    if (!candidate.key) continue;
    if (rest.slice(0, candidate.key.length).toLowerCase() !== candidate.key.toLowerCase()) continue;
    const nextChar = rest[candidate.key.length];
    if (nextChar && /[A-Za-z0-9_]/.test(nextChar)) continue; // not a real word boundary -- e.g. "@Janet" vs "@Jane"
    if (!best || candidate.key.length > best.length) {
      best = { length: candidate.key.length, isAgent: candidate.isAgent, userId: candidate.userId };
    }
  }
  return best;
}

export function parseMentions(content: string, members: MentionTarget[]): ParsedMentions {
  const candidates: { key: string; isAgent: boolean; userId?: string }[] = [
    ...AGENT_ALIASES.map((alias) => ({ key: alias, isAgent: true })),
    ...members.map((m) => ({ key: m.displayName, isAgent: false, userId: m.userId })),
  ];

  let mentionedAgent = false;
  const mentionedUserIds: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < content.length; i++) {
    if (content[i] !== "@") continue;
    // A real mention starts at the beginning of the message or after
    // whitespace/punctuation, not mid-word (an email-like "name@site"
    // shouldn't trigger one).
    if (i > 0 && /[A-Za-z0-9_]/.test(content[i - 1])) continue;
    const match = matchMentionAt(content, i, candidates);
    if (!match) continue;
    if (match.isAgent) {
      mentionedAgent = true;
    } else if (match.userId && !seen.has(match.userId)) {
      seen.add(match.userId);
      mentionedUserIds.push(match.userId);
    }
    i += match.length; // skip past this mention so it isn't re-matched inside itself
  }

  const hasAnyMention = mentionedAgent || mentionedUserIds.length > 0;
  return {
    // No mention at all -> agent's default audience, same as before this
    // feature existed. A mention that includes the agent -> agent runs.
    // A mention that's ONLY teammates -> handed off, agent does not run.
    mentionsAgent: !hasAnyMention || mentionedAgent,
    mentionedUserIds,
  };
}
