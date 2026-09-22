"use client";

import { createContext, useContext, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import type { User } from "@mai-chat/shared-types";
import { useCurrentUser } from "../../lib/useCurrentUser";
import SignInScreen from "./SignInScreen";

const WorkspaceUser = createContext<User | null>(null);
export const useWorkspaceUser = () => useContext(WorkspaceUser)!;

export default function WorkspaceAuth({ children }: { children: ReactNode }) {
  const auth = useCurrentUser();
  const pathname = usePathname();
  if (auth.status === "loading") return <div className="page">Checking your session…</div>;
  if (!auth.user) {
    // Includes the query string (e.g. ?invite=<token>) so an invite link
    // survives the sign-in round trip -- usePathname() alone drops it,
    // and losing it here would mean "sign in to accept an invite" simply
    // not working. window.location.search matches the same
    // read-it-directly convention the room page already uses for its
    // own post-OAuth-redirect query params.
    const returnTo = typeof window !== "undefined" ? `${pathname}${window.location.search}` : pathname;
    return <SignInScreen returnTo={returnTo} />;
  }
  return <WorkspaceUser.Provider value={auth.user}>{children}</WorkspaceUser.Provider>;
}
