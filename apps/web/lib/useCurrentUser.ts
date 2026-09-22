"use client";

import { useEffect, useState } from "react";
import type { User } from "@mai-chat/shared-types";
import { getCurrentUser } from "./api";

export type AuthStatus = "loading" | "authenticated" | "anonymous";

export interface CurrentUserState {
  status: AuthStatus;
  user: User | null;
  // Re-runs the GET /auth/me check -- used right after a sign-out (or
  // after landing back from the GitHub OAuth callback) instead of a full
  // page reload.
  refresh: () => void;
}

// Single source of truth for "who's signed in, if anyone" -- both the
// home page and the room page use this instead of each independently
// calling GET /auth/me. "anonymous" covers both an honest 401 (never
// signed in, or a session that expired/was revoked) and any other
// failure reaching the chat server -- either way, the caller's job is the
// same: show the sign-in screen rather than render as if the rest of the
// page will work.
export function useCurrentUser(): CurrentUserState {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<User | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    getCurrentUser()
      .then((u) => {
        if (!cancelled) {
          setUser(u);
          setStatus("authenticated");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setUser(null);
          setStatus("anonymous");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [generation]);

  return { status, user, refresh: () => setGeneration((g) => g + 1) };
}
