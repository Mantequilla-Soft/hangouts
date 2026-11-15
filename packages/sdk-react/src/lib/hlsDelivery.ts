/**
 * Client side of WebRTC-or-HLS delivery for stream viewers (backlog idea H1).
 * The server decides per viewer; these helpers build the request and read
 * the answer. See server/src/lib/hlsLive.ts.
 */
export type Delivery = 'webrtc' | 'hls';

/** Options for join() and listen(). */
export interface JoinOptions {
  /** Ask for HLS (a viewer whose WebRTC connection stays poor). The server
   *  decides; it honours this only when it runs HLS. */
  delivery?: Delivery;
  /** This page can play HLS (it renders <StreamVideo> inside
   *  <StandaloneWatch>), so the server may move it there. Never set it for a
   *  page that only renders LiveKit tracks: it would get no picture. */
  hlsCapable?: boolean;
}

/** The JSON body for join/listen, or null when plain apiClient calls do. */
export function deliveryBody(opts?: JoinOptions): Record<string, unknown> | null {
  if (!opts?.delivery && !opts?.hlsCapable) return null;
  return { ...(opts.delivery ? { delivery: opts.delivery } : {}), ...(opts.hlsCapable ? { hlsCapable: true } : {}) };
}

/** The delivery fields a /join or /listen answer may carry (servers before
 *  HLS send none of them, which means WebRTC). */
export interface DeliveryAnswer {
  delivery?: Delivery;
  hlsUrl?: string;
  hlsFallback?: boolean;
}

export const EMPTY_DELIVERY = { delivery: 'webrtc' as Delivery, hlsUrl: null, hlsFallback: false };

/** A relative playlist URL ("/rooms/x/hls/live.m3u8") is served by the API. */
export function resolveHlsUrl(apiBaseUrl: string, url?: string): string | null {
  if (!url) return null;
  if (/^https?:\/\//.test(url)) return url;
  return apiBaseUrl.replace(/\/+$/, '') + (url.startsWith('/') ? url : `/${url}`);
}

export function deliveryState(apiBaseUrl: string, r: DeliveryAnswer) {
  const delivery: Delivery = r.delivery === 'hls' ? 'hls' : 'webrtc';
  const hlsUrl = delivery === 'hls' ? resolveHlsUrl(apiBaseUrl, r.hlsUrl) : null;
  // An HLS answer always carries a URL; without one, fall back to the WebRTC
  // view rather than an HLS player with nothing to load.
  return { delivery: hlsUrl ? delivery : 'webrtc' as Delivery, hlsUrl, hlsFallback: r.hlsFallback === true };
}
