"use client";

import { useEffect, useRef, useState } from "react";
import type { Conversation } from "@mai-chat/shared-types";
import {
  getWorkspacePreference,
  listNotifications,
  markNotificationsRead,
  setWorkspacePreference,
} from "../../../../lib/api";
import type { WorkspaceChatState } from "../../../../lib/useWorkspaceChat";
import type { StoredNotification } from "./format";

// Notifications for the room: the server's list (polled every 15s), plus
// live in-session entries for new agent replies, system messages and
// approval requests in the open conversation. "Clear" is saved per member on
// the server, so it holds across refreshes and devices.
export function useRoomNotifications(
  workspaceId: string,
  chat: WorkspaceChatState,
  conversations: Conversation[],
  selectedConversationId: string | null,
) {
  const [notifications, setNotifications] = useState<StoredNotification[]>([]);
  const [clearedAt, setClearedAt] = useState<string | null>(null);
  const knownMessageIds = useRef(new Set<string>());
  const knownActionIds = useRef(new Set<string>());
  const initializedConversation = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getWorkspacePreference<string>(workspaceId, "notifications-cleared-at")
      .then((value) => {
        if (!cancelled) setClearedAt(typeof value === "string" ? value : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  useEffect(() => {
    let cancelled = false;
    const refresh = () =>
      listNotifications(workspaceId)
        .then((serverNotifications) => {
          if (cancelled) return;
          const fromServer = serverNotifications.map((notification) => ({
            id: notification.id,
            text: notification.text,
            createdAt: notification.createdAt,
            read: Boolean(notification.readAt),
          }));
          // Keep live, in-session entries for a minute so they don't vanish
          // before the server's copy (if any) arrives.
          setNotifications((current) => {
            const recentLocal = current.filter(
              (item) =>
                item.id.startsWith("local:") &&
                Date.now() - new Date(item.createdAt).getTime() < 60_000 &&
                !fromServer.some((server) => server.text === item.text),
            );
            return [...recentLocal, ...fromServer].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30);
          });
        })
        .catch(() => {});
    refresh();
    const interval = window.setInterval(refresh, 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [workspaceId]);

  function add(text: string): void {
    setNotifications((current) =>
      [
        { id: `local:${crypto.randomUUID()}`, text, createdAt: new Date().toISOString(), read: false },
        ...current,
      ].slice(0, 30),
    );
  }

  useEffect(() => {
    if (!chat.historyLoaded) return;
    // A newly opened conversation's history is already known; only later
    // messages create notifications.
    if (initializedConversation.current !== selectedConversationId) {
      initializedConversation.current = selectedConversationId;
      chat.messages.forEach((message) => knownMessageIds.current.add(message.id));
      chat.pendingActions.forEach((action) => knownActionIds.current.add(action.id));
      return;
    }
    for (const message of chat.messages) {
      if (knownMessageIds.current.has(message.id)) continue;
      knownMessageIds.current.add(message.id);
      if (message.role === "agent")
        add(
          `Agent replied in ${conversations.find((item) => item.id === selectedConversationId)?.title ?? "this conversation"}`,
        );
      if (message.role === "system") add(message.content);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.historyLoaded, chat.messages]);

  useEffect(() => {
    if (!chat.historyLoaded) return;
    for (const action of chat.pendingActions) {
      if (knownActionIds.current.has(action.id)) continue;
      knownActionIds.current.add(action.id);
      if (action.status === "pending") add(`Approval needed: ${action.description}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.historyLoaded, chat.pendingActions]);

  const visible = notifications.filter((notification) => !clearedAt || notification.createdAt > clearedAt);
  return {
    visible,
    unreadCount: visible.filter((notification) => !notification.read).length,
    markAllRead(): void {
      setNotifications((current) => current.map((item) => ({ ...item, read: true })));
      void markNotificationsRead(workspaceId).catch(() => {});
    },
    clear(): void {
      const now = new Date().toISOString();
      setClearedAt(now);
      setNotifications([]);
      void setWorkspacePreference(workspaceId, "notifications-cleared-at", now).catch(() => {});
      void markNotificationsRead(workspaceId).catch(() => {});
    },
  };
}
