import type { ChatMessage } from "@mai-chat/shared-types";
import { colorForName, initialsForName } from "../../../../lib/avatar";
import { renderMessageContent } from "../../../../lib/messageMarkdown";
import { MessageProvenanceLine } from "../../../_components/TeamAwareness";
import { AGENTS, identityForAgentMessage } from "./agents";
import { formatTime, roleLabel } from "./format";
import { AgentIcon, CustomAgentLogo } from "./glyphs";

// The conversation's messages: system notes, people and agents.
export default function MessageList({
  messages,
  currentUserId,
  displayName,
  participantNames,
}: {
  messages: ChatMessage[];
  currentUserId: string;
  displayName: string;
  participantNames: string[];
}) {
  return (
    <>
      {messages.map((m) => {
        if (m.role === "system") {
          return (
            <div className="msg system" key={m.id} data-testid="chat-message">
              <div className="bubble">{m.content}</div>
            </div>
          );
        }
        const isAgent = m.role === "agent";
        const agentIdentity = isAgent ? identityForAgentMessage(m.authorName) : null;
        // A user message that @-mentioned only a teammate never started an
        // agent turn (see server.ts's WebSocket handler), so it is marked as
        // handed off rather than looking like a request the agent ignored.
        // mentionsAgent may be missing on very old messages: treat those as
        // ordinary messages.
        const isHandoff = m.role === "user" && m.mentionsAgent === false;
        const mentionsCurrentUser = (m.mentionedUserIds ?? []).includes(currentUserId);
        // Prefer the immutable user id. The name fallback keeps older messages aligned for their author.
        const isCurrentUserMessage =
          m.role === "user" && (m.authorUserId ? m.authorUserId === currentUserId : m.authorName === displayName);
        return (
          <div
            className={`msg${isCurrentUserMessage ? " own" : ""}${mentionsCurrentUser ? " mentions-you" : ""}`}
            key={m.id}
            data-testid="chat-message"
          >
            <span
              className={`avatar ${isAgent ? "agent" : ""}`}
              style={isAgent ? undefined : { background: colorForName(m.authorName) }}
            >
              {isAgent && agentIdentity ? (
                AGENTS.some((agent) => agent.name === agentIdentity.name) ? (
                  <AgentIcon agent={agentIdentity.kind} />
                ) : (
                  <CustomAgentLogo name={agentIdentity.name} />
                )
              ) : (
                initialsForName(m.authorName)
              )}
            </span>
            <div className="msg-body">
              <div className="meta">
                <span className={`author ${isAgent ? "agent" : ""}`}>
                  {agentIdentity?.name ?? (m.authorName || roleLabel(m.role))}
                </span>
                <span>· {formatTime(m.createdAt)}</span>
                {isHandoff && (
                  <span
                    className="handoff-badge"
                    data-testid="handoff-badge"
                    title="Directed at a teammate -- the agent didn't see this as a request"
                  >
                    handed off
                  </span>
                )}
              </div>
              <div className="bubble">{renderMessageContent(m.content, participantNames)}</div>
              {isAgent && m.provenance && <MessageProvenanceLine provenance={m.provenance} />}
            </div>
          </div>
        );
      })}
    </>
  );
}
