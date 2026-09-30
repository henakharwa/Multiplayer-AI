"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// A persistent nav bar for every page under /w/[id]/* other than the chat
// page itself (which already has its own full sidebar, including this
// same set of links, in page.tsx -- see workspace-nav there). Before this
// existed, Agents/Artifacts/Audit/Integrations/Memory/Workflows were each
// a dead end: the only way to reach a sibling feature was to follow a
// single "back to workspace" link, land on chat, then click again.
// Rendered once from w/layout.tsx so every one of those pages gets the
// same lateral navigation instead of each re-implementing its own.
//
// The six items are grouped the same way the workspace's own data is
// organized -- "happening now", "things you build", "things you keep",
// and admin -- rather than left as one flat row.
const glyphs = {
  chat: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H8l-4 3V5Z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /></svg>,
  activity: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h4l2-6 4 12 2-6h4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>,
  agent: <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="7" width="16" height="12" rx="3" fill="none" stroke="currentColor" strokeWidth="2" /><circle cx="9" cy="13" r="1.4" fill="currentColor" /><circle cx="15" cy="13" r="1.4" fill="currentColor" /><path d="M12 3v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>,
  grid: <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="6" height="6" rx="1" fill="none" stroke="currentColor" strokeWidth="2" /><rect x="14" y="4" width="6" height="6" rx="1" fill="none" stroke="currentColor" strokeWidth="2" /><rect x="4" y="14" width="6" height="6" rx="1" fill="none" stroke="currentColor" strokeWidth="2" /><rect x="14" y="14" width="6" height="6" rx="1" fill="none" stroke="currentColor" strokeWidth="2" /></svg>,
  plug: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3v6m8-6v6M6 9h12v2a6 6 0 0 1-12 0V9Zm6 8v4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>,
};

function groupsFor(workspaceId: string) {
  return [
    { label: "Workspace", items: [
      { href: `/w/${workspaceId}/overview`, label: "Overview", glyph: glyphs.grid, exact: false },
      { href: `/w/${workspaceId}`, label: "Chat", glyph: glyphs.chat, exact: true },
      { href: `/w/${workspaceId}/audit`, label: "Activity", glyph: glyphs.activity, exact: false },
    ] },
    { label: "Build", items: [
      { href: `/w/${workspaceId}/agents`, label: "Agents", glyph: glyphs.agent, exact: false },
      { href: `/w/${workspaceId}/workflows`, label: "Workflows", glyph: glyphs.activity, exact: false },
    ] },
    { label: "Keep", items: [
      { href: `/w/${workspaceId}/memory`, label: "Memory", glyph: glyphs.grid, exact: false },
      { href: `/w/${workspaceId}/artifacts`, label: "Artifacts", glyph: glyphs.grid, exact: false },
    ] },
    { label: "Admin", items: [
      { href: `/w/${workspaceId}/integrations`, label: "Integrations", glyph: glyphs.plug, exact: false },
    ] },
  ];
}

export default function WorkspaceSecondaryNav({ workspaceId }: { workspaceId: string }) {
  const pathname = usePathname();
  const groups = groupsFor(workspaceId);
  return (
    <nav className="workspace-secondary-nav" aria-label="Workspace sections">
      {groups.map((group, index) => (
        <div className="workspace-secondary-nav-group" key={group.label}>
          {index > 0 && <span className="workspace-secondary-nav-divider" aria-hidden="true" />}
          <span className="workspace-secondary-nav-label">{group.label}</span>
          {group.items.map((item) => {
            const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
            return (
              <Link key={item.href} href={item.href} className={active ? "active" : ""} aria-current={active ? "page" : undefined}>
                {item.glyph} {item.label}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
