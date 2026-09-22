// Small original brand mark -- two overlapping rounded squares, meant to
// read as "two participants (or a person + the agent) sharing one space"
// without copying any competitor's actual logo. Used on the landing page
// and, small, has room to reuse in the room header later if wanted.
export default function BrandMark({ size = 26, withWordmark = true }: { size?: number; withWordmark?: boolean }) {
  return (
    <span className="brand-mark">
      <svg width={size} height={size} viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <rect x="2" y="2" width="17" height="17" rx="6" fill="#2F5FED" />
        <rect x="9" y="9" width="17" height="17" rx="6" fill="#7C5CFF" fillOpacity="0.88" />
      </svg>
      {withWordmark && <span className="brand-mark-word">Multiplayer AI</span>}
    </span>
  );
}
