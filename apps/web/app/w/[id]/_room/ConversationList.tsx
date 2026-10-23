"use client";

import { useState } from "react";
import type { Conversation } from "@mai-chat/shared-types";
import { ChevronGlyph, MoreGlyph } from "./glyphs";

// The collapsible list of conversations in the sidebar, with each one's
// rename / pin / archive / delete menu.
export default function ConversationList({
  conversations,
  selectedConversationId,
  unreadConversationIds,
  canEdit,
  isAdmin,
  onSelect,
  onRename,
  onUpdate,
  onDelete,
}: {
  conversations: Conversation[];
  selectedConversationId: string | null;
  unreadConversationIds: string[];
  canEdit: boolean;
  isAdmin: boolean;
  onSelect: (conversationId: string) => void;
  onRename: (conversation: Conversation) => void;
  onUpdate: (conversation: Conversation, input: { pinned?: boolean; archived?: boolean }) => void;
  onDelete: (conversation: Conversation) => void;
}) {
  const [open, setOpen] = useState(true);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  // Picking any menu option closes the menu.
  const act = (action: () => void) => () => {
    setMenuFor(null);
    action();
  };
  return (
    <div className="workspace-conversations" aria-label="Conversations">
      <button
        type="button"
        className="workspace-conversation-toggle"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>Conversations</span>
        <ChevronGlyph direction={open ? "up" : "down"} />
      </button>
      {open &&
        conversations.map((conversation) => (
          <div
            className={`workspace-conversation-row${conversation.id === selectedConversationId ? " active" : ""}${conversation.archivedAt ? " archived" : ""}`}
            key={conversation.id}
          >
            <button
              type="button"
              className="workspace-conversation-item"
              onClick={() => onSelect(conversation.id)}
              title={conversation.title}
            >
              <span>
                {conversation.pinnedAt && (
                  <b className="workspace-pin" aria-label="Pinned">
                    ⌖
                  </b>
                )}
                {conversation.title}
              </span>
              {conversation.archivedAt && <small className="workspace-archived-label">Archived</small>}
              {unreadConversationIds.includes(conversation.id) && (
                <i className="workspace-unread-dot" aria-label="Unread messages" />
              )}
            </button>
            {canEdit && (
              <div className="workspace-conversation-menu">
                <button
                  type="button"
                  className="workspace-conversation-more"
                  aria-label={`More options for ${conversation.title}`}
                  aria-expanded={menuFor === conversation.id}
                  onClick={() => setMenuFor((current) => (current === conversation.id ? null : conversation.id))}
                >
                  <MoreGlyph />
                </button>
                {menuFor === conversation.id && (
                  <div className="workspace-conversation-popover">
                    <button type="button" onClick={act(() => onRename(conversation))}>
                      Rename
                    </button>
                    <button
                      type="button"
                      onClick={act(() => onUpdate(conversation, { pinned: !conversation.pinnedAt }))}
                    >
                      {conversation.pinnedAt ? "Unpin chat" : "Pin chat"}
                    </button>
                    {isAdmin && (
                      <>
                        <button
                          type="button"
                          onClick={act(() => onUpdate(conversation, { archived: !conversation.archivedAt }))}
                        >
                          {conversation.archivedAt ? "Restore chat" : "Archive chat"}
                        </button>
                        <button type="button" className="danger" onClick={act(() => onDelete(conversation))}>
                          Delete chat
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
    </div>
  );
}
