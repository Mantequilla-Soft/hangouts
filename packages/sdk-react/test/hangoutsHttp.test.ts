import { describe, expect, it, vi } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  hangoutsJson, HangoutsHttpError, podcastApi, waitForEpisode, clock, chapterTitle, type PodcastEpisode,
} from '../src/lib/hangoutsHttp.js';
import { HangoutsContext, type HangoutsContextValue } from '../src/context/HangoutsContext.js';
import { PodcastRecordControls } from '../src/components/room/PodcastRecordControls.js';

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('hangoutsJson and podcastApi', () => {
  it('sends the bearer and a JSON body, and returns the JSON', async () => {
    const f = vi.fn().mockResolvedValue(ok({ ok: true, at: 12 }));
    expect(await podcastApi.marker('https://x/', 'room', 'tok', 'Q&A', f)).toEqual({ ok: true, at: 12 });
    expect(f).toHaveBeenCalledWith('https://x/rooms/room/podcast/marker', {
      method: 'POST', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: '{"title":"Q&A"}',
    });
    f.mockImplementation(async () => ok({ recording: false }));
    await podcastApi.status('https://x', 'room', null, f);
    expect(f).toHaveBeenLastCalledWith('https://x/rooms/room/podcast/status', { method: 'GET', headers: {} });
    await podcastApi.start('https://x', 'room', 't', f);
    await podcastApi.stop('https://x', 'room', 't', f);
    expect(f.mock.calls.map((c) => c[0])).toContain('https://x/rooms/room/podcast/stop');
  });

  it('throws the server message with the status, or a generic one', async () => {
    const f = vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'Pro only' }), { status: 402 }));
    await expect(hangoutsJson('https://x', '/p', null, {}, f)).rejects.toMatchObject({ status: 402, message: 'Pro only' });
    f.mockResolvedValue(new Response('nope', { status: 500 }));
    const err = await hangoutsJson('https://x', '/p', null, {}, f).catch((e) => e);
    expect(err).toBeInstanceOf(HangoutsHttpError);
    expect(err.message).toBe('Request failed (500)');
  });
});

describe('waitForEpisode', () => {
  const ep = (status: PodcastEpisode['status']): PodcastEpisode => ({
    token: 'T', room: 'r', title: null, status, durationSec: 60, createdAt: '', mixUrl: null, tracks: [], chapters: [],
  });

  it('polls until the mix is no longer mixing', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(ok({ recordings: [ep('mixing')] }))
      .mockResolvedValueOnce(ok({ recordings: [ep('ready')] }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    expect((await waitForEpisode('https://x', 't', 'T', { fetchFn: f, sleep }))?.status).toBe('ready');
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('is null when the episode is gone, and gives up at the deadline', async () => {
    const f = vi.fn().mockResolvedValue(ok({ recordings: [] }));
    expect(await waitForEpisode('https://x', 't', 'T', { fetchFn: f })).toBeNull();
    const g = vi.fn().mockImplementation(async () => ok({ recordings: [ep('mixing')] }));
    expect((await waitForEpisode('https://x', 't', 'T', { fetchFn: g, timeoutMs: 0 }))?.status).toBe('mixing');
  });
});

describe('clock and chapterTitle', () => {
  it('formats times and gives English chapter titles', () => {
    expect(clock(247)).toBe('4:07');
    expect(clock(3909)).toBe('1:05:09');
    expect(clock(-3)).toBe('0:00');
    expect(chapterTitle({ start: 0, kind: 'start' }, 'Weekly show')).toBe('Weekly show');
    expect(chapterTitle({ start: 0, kind: 'start' })).toBe('Intro');
    expect(chapterTitle({ start: 5, kind: 'join', identity: 'fan' })).toBe('@fan joins the stage');
    expect(chapterTitle({ start: 5, kind: 'marker', title: 'Q&A' })).toBe('Q&A');
    expect(chapterTitle({ start: 5, kind: 'marker' })).toBe('Chapter');
  });
});

describe('PodcastRecordControls', () => {
  const ctx = (token: string | null) => ({
    apiBaseUrl: 'https://live.example',
    apiClient: { getSessionToken: () => token },
  }) as unknown as HangoutsContextValue;

  it('offers Record as podcast to a signed-in host, disabled without a session', () => {
    const html = renderToStaticMarkup(h(HangoutsContext.Provider, { value: ctx('tok') }, h(PodcastRecordControls, { roomName: 'r' })));
    expect(html).toContain('hh-podcast');
    expect(html).toContain('Record as podcast');
    expect(html).not.toContain('disabled');
    const off = renderToStaticMarkup(h(HangoutsContext.Provider, { value: ctx(null) }, h(PodcastRecordControls, { roomName: 'r' })));
    expect(off).toContain('disabled');
  });
});
