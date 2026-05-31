import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HangoutsApiClient, HangoutsApiError } from '../src/index.js';

const BASE_URL = 'https://api.test';

function makeClient() {
  return new HangoutsApiClient({ baseUrl: BASE_URL });
}

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('listenAsGuest', () => {
  it('sends POST with no body when displayName is omitted', async () => {
    const fetchSpy = mockFetch(200, { token: 'tok', roomName: 'r', identity: 'guest-1', isGuest: true, isHost: false, isPremium: false });
    vi.stubGlobal('fetch', fetchSpy);

    const client = makeClient();
    await client.listenAsGuest('room-1');

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/rooms/room-1/listen`);
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });

  it('sends POST with displayName in the body when provided', async () => {
    const fetchSpy = mockFetch(200, { token: 'tok', roomName: 'r', identity: 'guest-1', isGuest: true, isHost: false, isPremium: false });
    vi.stubGlobal('fetch', fetchSpy);

    const client = makeClient();
    await client.listenAsGuest('room-1', 'Alice');

    const [, init] = fetchSpy.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ displayName: 'Alice' });
  });

  it('URL-encodes special characters in the room name', async () => {
    const fetchSpy = mockFetch(200, { token: 'tok', roomName: 'r', identity: 'guest-1', isGuest: true, isHost: false, isPremium: false });
    vi.stubGlobal('fetch', fetchSpy);

    const client = makeClient();
    await client.listenAsGuest('room name/special');

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/rooms/room%20name%2Fspecial/listen`);
  });
});

describe('banGuest', () => {
  it('sends POST to the ban endpoint', async () => {
    const fetchSpy = mockFetch(204, undefined);
    vi.stubGlobal('fetch', fetchSpy);

    const client = makeClient();
    client.setSessionToken('my-session-token');
    await client.banGuest('room-1', 'guest-abc');

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/rooms/room-1/participants/guest-abc/ban`);
    expect(init.method).toBe('POST');
    expect(init.headers['Authorization']).toBe('Bearer my-session-token');
  });

  it('URL-encodes the guest identity', async () => {
    const fetchSpy = mockFetch(204, undefined);
    vi.stubGlobal('fetch', fetchSpy);

    const client = makeClient();
    await client.banGuest('room-1', 'guest-abc/xyz');

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toContain('guest-abc%2Fxyz');
  });

  it('throws HangoutsApiError when the server returns 4xx', async () => {
    const fetchSpy = mockFetch(403, { message: 'Only the host can ban participants' });
    vi.stubGlobal('fetch', fetchSpy);

    const client = makeClient();
    await expect(client.banGuest('room-1', 'guest-abc')).rejects.toBeInstanceOf(HangoutsApiError);
  });

  it('HangoutsApiError carries the status code', async () => {
    const fetchSpy = mockFetch(403, { message: 'Forbidden' });
    vi.stubGlobal('fetch', fetchSpy);

    const client = makeClient();
    try {
      await client.banGuest('room-1', 'guest-abc');
    } catch (err) {
      expect(err).toBeInstanceOf(HangoutsApiError);
      expect((err as HangoutsApiError).status).toBe(403);
    }
  });
});
