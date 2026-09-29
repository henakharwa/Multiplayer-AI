"use client";

import { useParams, usePathname } from "next/navigation";
import WorkspaceAuth from "../_components/WorkspaceAuth";
import WorkspaceSecondaryNav from "../_components/WorkspaceSecondaryNav";

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const pathname = usePathname();
  // The chat page (exactly /w/[id]) already renders its own full sidebar,
  // which includes this same set of links -- see workspace-nav in
  // page.tsx. Every other page under /w/[id]/* used to be a dead end
  // (Agents, Artifacts, Memory, Workflows had a single "back to
  // workspace" link; Audit and Integrations had no way back at all
  // besides the browser's own back button), so they get this persistent
  // nav instead.
  const isChatPage = pathname === `/w/${id}`;
  return (
    <WorkspaceAuth>
      {!isChatPage && <WorkspaceSecondaryNav workspaceId={id} />}
      {children}
    </WorkspaceAuth>
  );
}
