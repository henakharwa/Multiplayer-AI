import type { WebSocket } from "ws";
import type { Participant } from "@mai-chat/shared-types";

interface Connection {
  ws: WebSocket;
  participant: Participant;
}

// One room per workspace: the set of currently-connected WebSocket clients.
// Deliberately in-memory, not persisted -- presence is ephemeral, same
// distinction this project's prior build drew between Yjs Awareness
// (ephemeral) and Y.Doc content (persisted). Chat messages themselves are
// real rows in packages/db; who's online right now is not.
export class RoomRegistry {
  private rooms = new Map<string, Set<Connection>>();
  // Workspaces where an agent turn (server.ts's runAgentReply) is
  // currently in flight -- the chat is multiplayer, but only one agent
  // turn should ever run at a time per workspace: it reads the full
  // message history and can propose mutating GitHub tool calls, so two
  // overlapping turns could read stale/interleaved history or double-fire
  // the same write. Tracked here, alongside the other ephemeral
  // (non-persisted) per-workspace room state.
  private busyWorkspaces = new Set<string>();

  isBusy(workspaceId: string): boolean {
    return this.busyWorkspaces.has(workspaceId);
  }

  setBusy(workspaceId: string, busy: boolean): void {
    if (busy) {
      this.busyWorkspaces.add(workspaceId);
    } else {
      this.busyWorkspaces.delete(workspaceId);
    }
  }

  // A second connection joining with the SAME displayName replaces the
  // earlier one instead of sitting alongside it in the presence list --
  // found live 2026-09-21: a duplicate "name (you)" row could briefly (or
  // not-so-briefly, before the heartbeat in server.ts got a chance to
  // prune it) show up from React StrictMode's dev-mode double-effect
  // invoke opening a second WebSocket before the first one's close
  // handshake finished, or a stale tab/connection left over from earlier
  // testing. The presence list is meant to answer "who's here", one row
  // per person, not one row per WebSocket that's ever connected. The
  // evicted connection is actually closed here (not just dropped from
  // tracking), so it can't linger as a zombie for the heartbeat to have
  // to clean up later, and its own "close" handler in server.ts still
  // runs normally (a harmless no-op re-broadcast, since it's already
  // gone from the room by then).
  join(workspaceId: string, ws: WebSocket, participant: Participant): void {
    let room = this.rooms.get(workspaceId);
    if (!room) {
      room = new Set();
      this.rooms.set(workspaceId, room);
    }
    for (const conn of room) {
      if ((conn.participant.userId ?? conn.participant.displayName) === (participant.userId ?? participant.displayName) && conn.ws !== ws) {
        room.delete(conn);
        if (conn.ws.readyState === conn.ws.OPEN || conn.ws.readyState === conn.ws.CONNECTING) {
          conn.ws.close(4008, "replaced by a new connection with the same name");
        }
      }
    }
    room.add({ ws, participant });
  }

  leave(workspaceId: string, ws: WebSocket): void {
    const room = this.rooms.get(workspaceId);
    if (!room) return;
    for (const conn of room) {
      if (conn.ws === ws) {
        room.delete(conn);
        break;
      }
    }
    if (room.size === 0) this.rooms.delete(workspaceId);
  }

  participants(workspaceId: string): Participant[] {
    const room = this.rooms.get(workspaceId);
    if (!room) return [];
    return Array.from(room).map((c) => c.participant);
  }

  broadcast(workspaceId: string, payload: unknown, exclude?: WebSocket): void {
    const room = this.rooms.get(workspaceId);
    if (!room) return;
    const data = JSON.stringify(payload);
    for (const conn of room) {
      if (conn.ws === exclude) continue;
      if (conn.ws.readyState === conn.ws.OPEN) {
        conn.ws.send(data);
      }
    }
  }
}
