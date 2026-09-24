interface BrandMarkProps {
  compact?: boolean;
  className?: string;
}

export function BrandMark({ compact = false, className = "" }: BrandMarkProps) {
  return (
    <span
      className={`brand-mark ${compact ? "brand-mark--compact" : ""} ${className}`.trim()}
      aria-label="back2csgo"
    >
      <svg className="brand-mark__wordmark" viewBox="0 0 130 45" role="img" aria-hidden="true">
        <path d="M5 7h29c8 0 11 4 10 10-.5 4-3 6-7 7 4 1 6 4 5 8-1 5-5 7-12 7H0L5 7Zm10 7-1 7h17c3 0 4-1 4-4 0-2-1-3-4-3H15Zm-2 13-1 6h17c3 0 4-1 4-3s-1-3-4-3H13Z" fill="currentColor" fillRule="evenodd" />
        <path d="M48 15c1-6 5-8 12-8h22c8 0 12 4 11 10-.5 4-3 7-8 10L67 33h21l-1 6H45l1-7 31-11c3-1 5-3 5-5 0-2-2-3-5-3H61c-3 0-5 1-5 4H47l1-2Z" fill="currentColor" />
        <path d="M105 7h25l-1 7h-20c-4 0-6 2-7 6l-2 7c-1 4 1 6 5 6h12l1-5h-11l1-6h21l-3 17h-26c-8 0-11-4-9-12l3-11c1-6 5-9 11-9Z" fill="var(--accent-secondary)" />
      </svg>
      {!compact && <span className="brand-mark__descriptor">back2csgo</span>}
    </span>
  );
}
