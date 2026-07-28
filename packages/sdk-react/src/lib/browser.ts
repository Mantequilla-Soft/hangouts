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


/**
 * Is this an in-app browser (a WebView embedded in another app) rather than a
 * real browser?
 *
 * Hive Keychain's mobile app, and every social app's link opener, render pages
 * in a WebView. Broadcasting from one is a bad idea even where the APIs nominally
 * exist: camera permission prompts are unreliable, the host app can suspend or
 * kill the view at will, and there is no address bar to reopen the page in a
 * real browser.
 *
 * Detected structurally rather than by naming apps, so this catches Keychain,
 * Twitter, Instagram, Facebook, Telegram and the rest without a list to
 * maintain:
 *   - Android WebView stamps a literal `; wv)` into the user agent. That token
 *     exists for exactly this purpose and is the most dependable signal there
 *     is.
 *   - iOS WKWebView reports a Safari-shaped UA but omits the `Safari/` token
 *     that real Safari always sends. Chrome/Firefox on iOS send CriOS/FxiOS,
 *     so exclude those before concluding it's a WebView.
 *   - Several apps additionally announce themselves (FBAN/FBAV, Instagram,
 *     Line, WhatsApp…). Cheap to check and catches the odd WebView that hides
 *     the markers above.
 */
export function isInAppBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;   // SSR: assume a real browser
  const ua = navigator.userAgent || '';

  // Android WebView — definitive.
  if (/;\s*wv\)/i.test(ua)) return true;

  // Named in-app browsers that don't set the WebView markers.
  if (/FBAN|FBAV|FB_IAB|Instagram|Line\/|MicroMessenger|Twitter|WhatsApp|Snapchat|LinkedInApp/i.test(ua)) {
    return true;
  }

  // iOS: a WKWebView looks like Safari but never sends the Safari token.
  const iOS = /iPhone|iPad|iPod/i.test(ua);
  if (iOS && !/CriOS|FxiOS|EdgiOS/i.test(ua) && !/Safari\//i.test(ua)) return true;

  return false;
}

/**
 * Can this browser actually run the studio?
 *
 * A capability check rather than a name check — the studio composites onto a
 * canvas, captures it as a stream, and publishes over WebRTC, so a browser
 * missing any one of these cannot broadcast no matter what it calls itself.
 * Used as a hard backstop behind isInAppBrowser(): between them, a host is only
 * allowed to go live somewhere it will actually work.
 */
export function canBroadcast(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return true;
  const hasCapture = typeof HTMLCanvasElement !== 'undefined'
    && typeof HTMLCanvasElement.prototype.captureStream === 'function';
  const hasMedia = !!navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function';
  const hasRtc = typeof window.RTCPeerConnection === 'function';
  return hasCapture && hasMedia && hasRtc;
}
