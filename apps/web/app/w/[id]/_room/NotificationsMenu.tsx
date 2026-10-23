"use client";

import { useState } from "react";
import { formatTime, type StoredNotification } from "./format";
import { BellGlyph } from "./glyphs";

// The bell in the sidebar and its dropdown of recent notifications.
export default function NotificationsMenu({
  notifications,
  unreadCount,
  onOpened,
  onClear,
}: {
  notifications: StoredNotification[];
  unreadCount: number;
  // Called each time the bell is clicked, so the caller can mark everything read.
  onOpened: () => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const today = notifications.filter(
    (notification) => new Date(notification.createdAt).toDateString() === new Date().toDateString(),
  );
  const earlier = notifications.filter((notification) => !today.includes(notification));
  return (
    <div className="workspace-notification-wrap">
      <button
        type="button"
        title="Notifications"
        onClick={() => {
          setOpen((current) => !current);
          onOpened();
        }}
        aria-label={`Notifications${unreadCount ? ` (${unreadCount} unread)` : ""}`}
      >
        <BellGlyph />
        {unreadCount > 0 && (
          <span className="workspace-notification-badge">{unreadCount > 9 ? "9+" : unreadCount}</span>
        )}
      </button>
      {open && (
        <section className="workspace-notification-panel" aria-label="Notifications">
          <div>
            <strong>Notifications</strong>
            <button type="button" onClick={onClear}>
              Clear
            </button>
          </div>
          {notifications.length ? (
            <>
              {today.length > 0 && <NotificationGroup label="Today" notifications={today} />}
              {earlier.length > 0 && <NotificationGroup label="Earlier" notifications={earlier} />}
            </>
          ) : (
            <div className="workspace-notification-empty">
              <strong>You&apos;re all caught up</strong>
              <span>Updates from teammates and approved actions will appear here.</span>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function NotificationGroup({ label, notifications }: { label: string; notifications: StoredNotification[] }) {
  return (
    <section className="workspace-notification-group">
      <p>{label}</p>
      {notifications.map((notification) => (
        <article key={notification.id}>
          <p>{notification.text}</p>
          <time>{formatTime(notification.createdAt)}</time>
        </article>
      ))}
    </section>
  );
}
