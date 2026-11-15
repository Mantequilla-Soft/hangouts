/**
 * Small fetch helpers for the highlight, clip, rewind and podcast endpoints
 * (H13, H14, H23). Kept out of the core api client so the client stays as it
 * is; they take the same base URL and session token the provider holds.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const trim = (base: string) => base.replace(/\/+$/, '');
const room = (name: string) => encodeURIComponent(name);

/** One chat line happened in `roomName`: a fire-and-forget count for the
 *  stream's highlight moments. Never throws, never blocks the chat. */
export function sendChatTick(apiBaseUrl: string | undefined, roomName: string | undefined, token: string | null | undefined, fetchFn: FetchLike | undefined = globalThis.fetch?.bind(globalThis)): void {
  if (!apiBaseUrl || !roomName || !fetchFn) return;
  try {
    void fetchFn(`${trim(apiBaseUrl)}/rooms/${room(roomName)}/highlights/chat`, {
      method: 'POST',
      keepalive: true,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }).catch(() => { /* counting is best effort */ });
  } catch { /* never let counting break chat */ }
}

export class HangoutsHttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function hangoutsJson<T>(
  apiBaseUrl: string, path: string, token: string | null,
  init: { method?: string; body?: unknown } = {}, fetchFn: FetchLike = fetch,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetchFn(`${trim(apiBaseUrl)}${path}`, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try { const j = await res.json() as { message?: string }; if (j?.message) message = j.message; } catch { /* not json */ }
    throw new HangoutsHttpError(res.status, message);
  }
  return res.json() as Promise<T>;
}

// --- record as podcast (H23) -------------------------------------------------

export type PodcastChapterKind = 'start' | 'join' | 'marker';
export interface PodcastChapter { start: number; kind: PodcastChapterKind; identity?: string; title?: string }
export interface PodcastEpisode {
  token: string;
  room: string;
  title: string | null;
  status: 'mixing' | 'ready' | 'failed';
  durationSec: number;
  createdAt: string;
  mixUrl: string | null;
  tracks: Array<{ identity: string; offsetSec: number; url: string }>;
  chapters: PodcastChapter[];
}
export interface PodcastStatus { recording: boolean; startedAt?: string; speakers?: string[]; chapters?: number }

export const podcastApi = {
  start: (base: string, name: string, token: string | null, f?: FetchLike) =>
    hangoutsJson<{ recording: boolean; startedAt: string }>(base, `/rooms/${room(name)}/podcast/start`, token, { method: 'POST' }, f),
  stop: (base: string, name: string, token: string | null, f?: FetchLike) =>
    hangoutsJson<PodcastEpisode>(base, `/rooms/${room(name)}/podcast/stop`, token, { method: 'POST' }, f),
  marker: (base: string, name: string, token: string | null, title: string, f?: FetchLike) =>
    hangoutsJson<{ ok: boolean; at: number }>(base, `/rooms/${room(name)}/podcast/marker`, token, { method: 'POST', body: { title } }, f),
  status: (base: string, name: string, token: string | null, f?: FetchLike) =>
    hangoutsJson<PodcastStatus>(base, `/rooms/${room(name)}/podcast/status`, token, {}, f),
  recordings: (base: string, token: string | null, f?: FetchLike) =>
    hangoutsJson<{ recordings: PodcastEpisode[] }>(base, '/podcast/recordings', token, {}, f),
};

/** Poll until the episode's mix is ready (or failed). */
export async function waitForEpisode(
  base: string, token: string | null, episodeToken: string,
  { fetchFn, intervalMs = 2000, timeoutMs = 10 * 60_000, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)) }:
  { fetchFn?: FetchLike; intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<unknown> } = {},
): Promise<PodcastEpisode | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { recordings } = await podcastApi.recordings(base, token, fetchFn);
    const ep = recordings.find((r) => r.token === episodeToken) ?? null;
    if (!ep || ep.status !== 'mixing') return ep;
    if (Date.now() >= deadline) return ep;
    await sleep(intervalMs);
  }
}

/** "1:05:09" / "4:07" */
export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** English chapter titles for an integrator without its own (the 3Speak
 *  frontend translates the structured chapters itself). */
export function chapterTitle(c: PodcastChapter, showTitle?: string | null): string {
  if (c.kind === 'marker') return c.title || 'Chapter';
  if (c.kind === 'join') return `@${c.identity} joins the stage`;
  return showTitle || 'Intro';
}
