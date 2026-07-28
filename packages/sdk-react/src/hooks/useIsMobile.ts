import { useEffect, useState } from 'react';

/** Phone-sized layout breakpoint. Matches the studio's existing CSS breakpoint
 *  so the JS and the stylesheet can never disagree about what "mobile" means. */
export const MOBILE_QUERY = '(max-width: 820px)';

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
