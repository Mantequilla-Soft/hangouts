/**
 * Chromium detection, used to set expectations in the studio.
 *
 * It matters because the capture features the studio leans on are
 * Chromium-only in practice:
 *   - picking a single browser TAB (`displaySurface: 'browser'`)
 *   - capturing tab / system audio (`audio` + `systemAudio` in getDisplayMedia)
 * Firefox and Safari offer window/screen video with NO audio, so a share there
 * is silent — worth telling the host up front rather than mid-stream.
 */
export function isChromium(): boolean {
  if (typeof navigator === 'undefined') return true; // SSR: don't nag

  // Chromium exposes brands via userAgentData; Firefox/Safari don't.
  const brands = (navigator as Navigator & {
    userAgentData?: { brands?: Array<{ brand: string }> };
  }).userAgentData?.brands;
  if (Array.isArray(brands) && brands.length) {
    return brands.some((b) => /Chromium|Google Chrome|Microsoft Edge|Opera/i.test(b.brand || ''));
  }

  const ua = navigator.userAgent || '';
  if (/Firefox\/|FxiOS/i.test(ua)) return false;
  // Safari sends no Chrome/Chromium token; Chrome/Edge/Opera/Brave all do.
  return /Chrome\/|Chromium\/|Edg\//i.test(ua);
}
