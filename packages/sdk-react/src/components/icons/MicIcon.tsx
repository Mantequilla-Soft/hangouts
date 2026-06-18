interface MicIconProps {
  className?: string;
  size?: number;
  title?: string;
  /** Draws a diagonal slash through the mic — the universal "muted" mark.
   *  Deliberately NOT a speaker/volume icon: muting your mic is an input
   *  (you → others) concept, not an output (others → you) one, and mixing
   *  the two icon families is exactly what was confusing users. */
  muted?: boolean;
}

export function MicIcon({ className, size = 16, title, muted = false }: MicIconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      xmlns="http://www.w3.org/2000/svg"
    >
      {title && <title>{title}</title>}
      <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" fill="currentColor" stroke="none" />
      <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
      <line x1="12" y1="18" x2="12" y2="22" />
      <line x1="8" y1="22" x2="16" y2="22" />
      {muted && <line x1="3" y1="3" x2="21" y2="21" strokeWidth={2.5} />}
    </svg>
  );
}
