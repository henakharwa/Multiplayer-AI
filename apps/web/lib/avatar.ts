// Small, dependency-free helpers for the colored initials avatars used in
// the room sidebar and message list (apps/web/app/w/[id]/page.tsx). Purely
// presentational -- the color is derived from the name so the same person
// always gets the same color in a given session, nothing is persisted.

const PALETTE = ["#2F5FED", "#7C5CFF", "#0F9D63", "#D9730D", "#D63384", "#0EA5A5"];

export function colorForName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

export function initialsForName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
