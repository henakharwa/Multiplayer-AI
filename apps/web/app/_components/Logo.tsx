// The Shared Orbit mark represents teammates, tools, and agents moving
// around a common workspace. It stays clear at navigation-bar scale.
export default function BrandMark({ size = 30, withWordmark = true }: { size?: number; withWordmark?: boolean }) {
  return (
    <span className="brand-mark">
      <svg
        width={size}
        height={size}
        viewBox="0 0 28 28"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <ellipse cx="14" cy="14" rx="11.6" ry="5.1" stroke="#2F5FED" strokeWidth="1.9" transform="rotate(-30 14 14)" />
        <ellipse cx="14" cy="14" rx="11.6" ry="5.1" stroke="#8D70FF" strokeWidth="1.9" transform="rotate(30 14 14)" />
        <circle cx="14" cy="14" r="3.9" fill="#17244A" />
        <circle cx="22.5" cy="6.8" r="2.1" fill="#2F5FED" />
        <circle cx="5.5" cy="21.2" r="2.1" fill="#8D70FF" />
      </svg>
      {withWordmark && <span className="brand-mark-word">Nexus</span>}
    </span>
  );
}
