// Client-side counterpart to services/chat-server/src/mentions.ts's
// parsing -- that file decides whether a message reaches the agent (the
// thing that actually matters); this one is purely cosmetic, turning a
// plain "@Name" substring into a styled pill so a mention reads clearly
// in the transcript. Deliberately simpler than the server's matcher (no
// longest-match tie-breaking beyond regex alternation order) since a
// wrong render here is a cosmetic miss, not a routing bug.

const AGENT_ALIASES = ["agent", "ai", "assistant", "bot"];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Renders `content` as plain text with every "@<known name or agent
// alias>" substring wrapped in a highlighted <span>. `names` should be
// the display names of everyone currently known in this workspace (e.g.
// chat.participants) -- an offline teammate's mention still routes
// correctly server-side (see listWorkspaceMembers), it just won't be
// highlighted here since the client has no cheap way to know their name.
export function renderWithMentions(content: string, names: string[]): React.ReactNode {
  const candidates = [...new Set([...AGENT_ALIASES, ...names])].filter(Boolean).sort((a, b) => b.length - a.length);
  if (candidates.length === 0) return content;
  const pattern = new RegExp(`@(${candidates.map(escapeRegExp).join("|")})\\b`, "gi");

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(content))) {
    // Skip an email-like "name@site" -- only highlight when the '@' is at
    // the start of the message or follows whitespace/punctuation.
    const charBefore = content[match.index - 1];
    if (charBefore && /[A-Za-z0-9_]/.test(charBefore)) continue;
    if (match.index > lastIndex) parts.push(content.slice(lastIndex, match.index));
    parts.push(
      <span className="mention-pill" key={key++}>
        {match[0]}
      </span>
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) parts.push(content.slice(lastIndex));
  return parts.length > 0 ? parts : content;
}

// Cheap client-side approximation of services/chat-server/src/
// mentions.ts's parseMentions, used ONLY to decide whether the composer
// should stay enabled while the agent is busy (a handoff-only draft
// doesn't need to wait -- see server.ts's WebSocket handler for the
// real, authoritative decision, which this mirrors but doesn't replace).
// Conservative by design: if this can't tell, it says "not a handoff" --
// worst case the composer stays disabled a little longer than strictly
// necessary, never the reverse.
export function draftLooksLikeHandoff(content: string, names: string[]): boolean {
  const trimmed = content.trim();
  if (!trimmed.startsWith("@")) return false;
  const candidates = [...new Set([...AGENT_ALIASES, ...names])].filter(Boolean).sort((a, b) => b.length - a.length);
  const mentionsAgent = new RegExp(`@(${AGENT_ALIASES.map(escapeRegExp).join("|")})\\b`, "i").test(trimmed);
  if (mentionsAgent) return false;
  const mentionsSomeone = new RegExp(`@(${candidates.map(escapeRegExp).join("|")})\\b`, "i").test(trimmed);
  return mentionsSomeone;
}
