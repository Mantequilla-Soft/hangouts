/**
 * Studio rail icons.
 *
 * Inline SVG rather than an icon package: the SDK ships no icon dependency and
 * shouldn't gain one just for a handful of glyphs. Stroke-based and drawn with
 * `currentColor` so the rail controls their colour, and sized by the parent's
 * font-size via `1em` — a subtle, uniform set instead of emoji, which render
 * differently on every platform and read as clip-art over video.
 */
import type { SVGProps } from 'react';

function Svg({ children, ...rest }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Switch between front and back camera. */
export const IconFlipCamera = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M3 12a9 9 0 0 1 15.5-6.2M21 12a9 9 0 0 1-15.5 6.2" />
    <path d="M18 3v3h-3M6 21v-3h3" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
);

/** Mirror the camera image horizontally (selfie view). */
export const IconMirror = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M12 3v18" strokeDasharray="2 3" />
    <path d="M9 7 4 12l5 5z" />
    <path d="M15 7l5 5-5 5z" />
  </Svg>
);

/** Clip — scissors, for grabbing the last few seconds. */
export const IconClip = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <circle cx="6" cy="6" r="3" />
    <circle cx="6" cy="18" r="3" />
    <path d="M20 4 8.5 15.5" />
    <path d="M14.5 14.5 20 20" />
    <path d="M8.5 8.5 12 12" />
  </Svg>
);

/** Broadcast / restream — a signal source radiating outward. */
export const IconBroadcast = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="2" />
    <path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 16.2a6 6 0 0 0 0-8.4" />
    <path d="M5 5a9.5 9.5 0 0 0 0 14M19 19a9.5 9.5 0 0 0 0-14" />
  </Svg>
);


/** Portrait / landscape aspect toggle. */
export const IconAspect = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <rect x="3" y="6" width="18" height="12" rx="2" />
    <path d="M9 6v12" />
  </Svg>
);

export const IconZoomIn = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5M11 8.5v5M8.5 11h5" />
  </Svg>
);

export const IconZoomOut = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5M8.5 11h5" />
  </Svg>
);

/** Audio input picker. */
export const IconAudio = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M5 4v16M12 4v16M19 4v16" />
    <circle cx="5" cy="9" r="2" />
    <circle cx="12" cy="14" r="2" />
    <circle cx="19" cy="8" r="2" />
  </Svg>
);

export const IconChat = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M20 15a2 2 0 0 1-2 2H8l-4 3V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z" />
  </Svg>
);

/** The stream post / announcement editor. */
export const IconPost = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" />
    <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z" />
  </Svg>
);

export const IconShare = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <circle cx="18" cy="5" r="3" />
    <circle cx="6" cy="12" r="3" />
    <circle cx="18" cy="19" r="3" />
    <path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4" />
  </Svg>
);

/** Boost history. */
export const IconBoost = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M13 2L4.5 13H11l-1 9 8.5-11H12z" />
  </Svg>
);

export const IconCheck = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M20 6L9 17l-5-5" />
  </Svg>
);

/** Lens / camera picker. */
export const IconLens = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="3" />
    <path d="M12 4v2M12 18v2M4 12h2M18 12h2" />
  </Svg>
);

/** Go live. Filled triangle so it reads as "play/start" at a glance. */
export const IconPlay = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p} fill="currentColor" strokeWidth={0}>
    <path d="M8 5.5v13l11-6.5z" />
  </Svg>
);

/** Pause — two distinct bars. */
export const IconPause = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p} fill="currentColor" strokeWidth={0}>
    <rect x="6.5" y="5" width="3.6" height="14" rx="1" />
    <rect x="13.9" y="5" width="3.6" height="14" rx="1" />
  </Svg>
);

/** Stop — a filled square. */
export const IconStop = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p} fill="currentColor" strokeWidth={0}>
    <rect x="6" y="6" width="12" height="12" rx="1.5" />
  </Svg>
);

/** Collab guest / requests to join. */
export const IconGuest = (p: SVGProps<SVGSVGElement>) => (
  <Svg {...p}>
    <path d="M15 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20" />
    <circle cx="8.5" cy="7" r="3.5" />
    <path d="M19 8v6M22 11h-6" />
  </Svg>
);
