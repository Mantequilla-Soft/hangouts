import { useEffect, useState } from 'react';

/** Phone-sized layout breakpoint. Matches the studio's existing CSS breakpoint
 *  so the JS and the stylesheet can never disagree about what "mobile" means. */
export const MOBILE_QUERY = '(max-width: 820px)';

/** The phone studio's breakpoint: phone width, or a phone turned sideways
 *  (wider than 820px but short, on a touch screen). The studio can stream in
 *  landscape, and a turned phone must keep the phone studio rather than flip
 *  to the desktop one. Kept apart from MOBILE_QUERY, which viewer pages use. */
export const PHONE_STUDIO_QUERY = '(max-width: 820px), (orientation: landscape) and (max-height: 500px) and (pointer: coarse)';

/**
 * True while the viewport is phone-sized.
 *
 * Deliberately a media query rather than a user-agent sniff: a narrow desktop
 * window should get the same layout, and UA sniffing gets tablets and desktop
 * mode on phones wrong. Re-evaluates on rotate/resize.
 */
export function useIsMobile(query: string = MOBILE_QUERY): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia?.(query).matches === true,
  );

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    setIsMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);

  return isMobile;
}
