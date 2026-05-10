interface HeadphonesIconProps {
  className?: string;
  size?: number;
  title?: string;
}

export function HeadphonesIcon({ className, size = 16, title }: HeadphonesIconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      xmlns="http://www.w3.org/2000/svg"
    >
      {title && <title>{title}</title>}
      <path d="M12 3a9 9 0 0 0-9 9v5a4 4 0 0 0 4 4h2v-9H5v0a7 7 0 0 1 14 0v0h-4v9h2a4 4 0 0 0 4-4v-5a9 9 0 0 0-9-9z" />
    </svg>
  );
}
