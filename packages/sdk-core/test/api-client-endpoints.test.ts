import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HangoutsApiClient, HangoutsApiError } from '../src/index.js';

const BASE_URL = 'https://api.test';

interface FakeResponseInit {
  status?: number;
  statusText?: string;
  body?: unknown;
  jsonThrows?: boolean;
  blob?: Blob;
  headers?: Record<string, string>;
}

function fakeResponse({ status = 200, statusText = 'OK', body, jsonThrows, blob, headers = {} }: FakeResponseInit = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: () => (jsonThrows ? Promise.reject(new SyntaxError('Unexpected token')) : Promise.resolve(body)),
    blob: () => Promise.resolve(blob ?? new Blob([])),
    headers: { get: (name: string) => headers[name] ?? null },
  };
}

let fetchSpy: ReturnType<typeof vi.fn>;

function respondWith(init: FakeResponseInit = {}) {
  fetchSpy.mockResolvedValue(fakeResponse(init));
}

function lastCall(): { url: string; init: { method: string; headers: Record<string, string>; body?: string } } {
  const [url, init] = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
  return { url, init };
}

beforeEach(() => {
  fetchSpy = vi.fn();
  vi.stubGlobal('fetch', fetchSpy);
  respondWith({ body: { ok: true } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HangoutsApiClient construction and session token', () => {
  it('strips one trailing slash from the base url', async () => {
    const client = new HangoutsApiClient({ baseUrl: `${BASE_URL}/` });
    await client.listRooms();
    expect(lastCall().url).toBe(`${BASE_URL}/rooms`);
  });

  it('stores, returns and clears the session token', () => {
    const client = new HangoutsApiClient({ baseUrl: BASE_URL });
    expect(client.getSessionToken()).toBeNull();
    client.setSessionToken('tok');
    expect(client.getSessionToken()).toBe('tok');
    client.clearSessionToken();
    expect(client.getSessionToken()).toBeNull();
  });

  it('sends a bearer token only while one is set', async () => {
    const client = new HangoutsApiClient({ baseUrl: BASE_URL });
    await client.listRooms();
    expect(lastCall().init.headers).toEqual({});

    client.setSessionToken('tok');
    await client.listRooms();
    expect(lastCall().init.headers).toEqual({ Authorization: 'Bearer tok' });

    client.clearSessionToken();
    await client.listRooms();
    expect(lastCall().init.headers.Authorization).toBeUndefined();
  });

  it('sets a JSON content type and body only when there is a body', async () => {
    const client = new HangoutsApiClient({ baseUrl: BASE_URL });
    await client.joinRoom('r');
    expect(lastCall().init.headers['Content-Type']).toBeUndefined();
    expect(lastCall().init.body).toBeUndefined();

    await client.transferHost('r', 'bob');
    expect(lastCall().init.headers['Content-Type']).toBe('application/json');
    expect(lastCall().init.body).toBe(JSON.stringify({ newHost: 'bob' }));
  });
});

describe('HangoutsApiClient responses and errors', () => {
  const client = () => new HangoutsApiClient({ baseUrl: BASE_URL });

  it('returns the parsed JSON body on success', async () => {
    respondWith({ body: [{ name: 'r1' }] });
    expect(await client().listRooms()).toEqual([{ name: 'r1' }]);
  });

  it('returns undefined for 204 No Content without reading the body', async () => {
    const res = fakeResponse({ status: 204 });
    const json = vi.spyOn(res, 'json');
    fetchSpy.mockResolvedValue(res);
    expect(await client().deleteRoom('r')).toBeUndefined();
    expect(json).not.toHaveBeenCalled();
  });

  it('throws HangoutsApiError with the server message, status and body', async () => {
    respondWith({ status: 409, statusText: 'Conflict', body: { message: 'Trial already used', code: 'used' } });
    const err = await client().startProTrial().catch((e) => e);
    expect(err).toBeInstanceOf(HangoutsApiError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('HangoutsApiError');
    expect(err.status).toBe(409);
    expect(err.message).toBe('Trial already used');
    expect(err.body).toEqual({ message: 'Trial already used', code: 'used' });
  });

  it('falls back to the status text when the error body is not JSON', async () => {
    respondWith({ status: 502, statusText: 'Bad Gateway', jsonThrows: true });
    const err = await client().listRooms().catch((e) => e);
    expect(err.status).toBe(502);
    expect(err.message).toBe('Bad Gateway');
    expect(err.body).toBeUndefined();
  });

  it('falls back to the status text when the error body has no message', async () => {
    respondWith({ status: 500, statusText: 'Internal Server Error', body: { error: 'x' } });
    await expect(client().listRooms()).rejects.toThrow('Internal Server Error');
  });

  it('lets a network failure from fetch propagate as is', async () => {
    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(client().listRooms()).rejects.toThrow(TypeError);
  });
});

describe('lookups that answer null on 404', () => {
  const client = () => new HangoutsApiClient({ baseUrl: BASE_URL });
  const cases: Array<[string, (c: HangoutsApiClient) => Promise<unknown>, string]> = [
    ['getRoom', (c) => c.getRoom('my room'), '/rooms/my%20room'],
    ['getEvent', (c) => c.getEvent('ev/1'), '/events/ev%2F1'],
    ['getActiveGame', (c) => c.getActiveGame('r1'), '/rooms/r1/game'],
  ];

  for (const [name, call, path] of cases) {
    it(`${name} returns the body when found`, async () => {
      respondWith({ body: { found: true } });
      expect(await call(client())).toEqual({ found: true });
      expect(lastCall().url).toBe(`${BASE_URL}${path}`);
      expect(lastCall().init.method).toBe('GET');
    });

    it(`${name} returns null on 404`, async () => {
      respondWith({ status: 404, statusText: 'Not Found', body: { message: 'nope' } });
      expect(await call(client())).toBeNull();
    });

    it(`${name} rethrows any other error`, async () => {
      respondWith({ status: 500, statusText: 'Internal Server Error', body: { message: 'db down' } });
      await expect(call(client())).rejects.toMatchObject({ status: 500, message: 'db down' });
    });

    it(`${name} rethrows a network error`, async () => {
      fetchSpy.mockRejectedValue(new TypeError('offline'));
      await expect(call(client())).rejects.toThrow('offline');
    });
  }
});

describe('endpoint request shapes', () => {
  // [label, call, method, path, body (undefined = no body)]
  const cases: Array<[string, (c: HangoutsApiClient) => Promise<unknown>, string, string, unknown]> = [
    ['requestChallenge', (c) => c.requestChallenge('alice'), 'POST', '/auth/challenge', { username: 'alice' }],
    ['verifySignature', (c) => c.verifySignature('alice', 'ch', 'sig'), 'POST', '/auth/verify', { username: 'alice', challenge: 'ch', signature: 'sig' }],
    ['listRooms', (c) => c.listRooms(), 'GET', '/rooms', undefined],
    ['createRoom', (c) => c.createRoom('T', 'D', 'bg.png', 'unlisted', 'en', { enabled: true } as never, 'standalone'), 'POST', '/rooms',
      { title: 'T', description: 'D', backgroundImage: 'bg.png', visibility: 'unlisted', language: 'en', boost: { enabled: true }, mode: 'standalone' }],
    ['joinRoom', (c) => c.joinRoom('a b'), 'POST', '/rooms/a%20b/join', undefined],
    ['joinAsObserver', (c) => c.joinAsObserver('r'), 'POST', '/rooms/r/listen', { silent: true }],
    ['deleteRoom', (c) => c.deleteRoom('r'), 'DELETE', '/rooms/r', undefined],
    ['transferHost', (c) => c.transferHost('r', 'bob'), 'POST', '/rooms/r/host', { newHost: 'bob' }],
    ['setRoomLayout', (c) => c.setRoomLayout('r', 'grid'), 'PATCH', '/rooms/r/layout', { layout: 'grid' }],
    ['setRoomViewState', (c) => c.setRoomViewState('r', { focusedIdentity: 'bob', chatOpen: true }), 'PATCH', '/rooms/r/layout', { focusedIdentity: 'bob', chatOpen: true }],
    ['setPermissions', (c) => c.setPermissions('r', 'bob/x', true), 'PATCH', '/rooms/r/participants/bob%2Fx/permissions', { canPublish: true }],
    ['kickParticipant', (c) => c.kickParticipant('r', 'bob'), 'DELETE', '/rooms/r/participants/bob', undefined],
    ['setModerator', (c) => c.setModerator('r', 'bob', false), 'PATCH', '/rooms/r/mods/bob', { isMod: false }],
    ['startDvr', (c) => c.startDvr('r'), 'POST', '/rooms/r/dvr/start', undefined],
    ['stopDvr', (c) => c.stopDvr('r'), 'POST', '/rooms/r/dvr/stop', undefined],
    ['clipDvr', (c) => c.clipDvr('r'), 'POST', '/rooms/r/dvr/clip', undefined],
    ['dvrStatus', (c) => c.dvrStatus('r'), 'GET', '/rooms/r/dvr/status', undefined],
    ['startRecording with options', (c) => c.startRecording('r', { mode: 'video', layout: 'grid' }), 'POST', '/rooms/r/record/start', { mode: 'video', layout: 'grid' }],
    ['startRecording without options sends an empty object', (c) => c.startRecording('r'), 'POST', '/rooms/r/record/start', {}],
    ['stopRecording', (c) => c.stopRecording('r'), 'POST', '/rooms/r/record/stop', undefined],
    ['getRecordingStatus', (c) => c.getRecordingStatus('r'), 'GET', '/rooms/r/record/status', undefined],
    ['setRecordingLayout', (c) => c.setRecordingLayout('r', 'single'), 'PATCH', '/rooms/r/record/layout', { layout: 'single' }],
    ['uploadRecording', (c) => c.uploadRecording('r', '/tmp/f.mp4', 12, 'Title', ['a']), 'POST', '/rooms/r/record/upload', { filePath: '/tmp/f.mp4', duration: 12, title: 'Title', tags: ['a'] }],
    ['startStream', (c) => c.startStream('r', 'youtube', 'key', 'bg.png', true), 'POST', '/rooms/r/stream/start', { platform: 'youtube', streamKey: 'key', backgroundImageUrl: 'bg.png', videoEnabled: true }],
    ['stopStream', (c) => c.stopStream('r'), 'POST', '/rooms/r/stream/stop', undefined],
    ['getStreamStatus', (c) => c.getStreamStatus('r'), 'GET', '/rooms/r/stream/status', undefined],
    ['getBoostConfig', (c) => c.getBoostConfig(), 'GET', '/boosts/config', undefined],
    ['updateBoostConfig', (c) => c.updateBoostConfig('r', { minBoostUsd: 2 }), 'PATCH', '/rooms/r/boost', { minBoostUsd: 2 }],
    ['updateStreamPost', (c) => c.updateStreamPost('r', { title: 'New' }), 'PATCH', '/rooms/r/post', { title: 'New' }],
    ['setBroadcasting', (c) => c.setBroadcasting('r', false), 'PATCH', '/rooms/r/broadcast', { broadcasting: false }],
    ['startWhipIngress transcodes by default', (c) => c.startWhipIngress('r'), 'POST', '/rooms/r/ingress', { transcode: true }],
    ['startWhipIngress can skip transcoding', (c) => c.startWhipIngress('r', { transcode: false }), 'POST', '/rooms/r/ingress', { transcode: false }],
    ['stopWhipIngress', (c) => c.stopWhipIngress('r'), 'DELETE', '/rooms/r/ingress', undefined],
    ['listEvents without filters', (c) => c.listEvents(), 'GET', '/events', undefined],
    ['listEvents with filters', (c) => c.listEvents({ status: 'live', host: 'alice', limit: 5 }), 'GET', '/events?status=live&host=alice&limit=5', undefined],
    ['createEvent', (c) => c.createEvent({ title: 'E', scheduledAt: '2030-01-01T00:00:00Z' } as never), 'POST', '/events', { title: 'E', scheduledAt: '2030-01-01T00:00:00Z' }],
    ['updateEvent', (c) => c.updateEvent('e1', { title: 'E2' }), 'PATCH', '/events/e1', { title: 'E2' }],
    ['cancelEvent', (c) => c.cancelEvent('e1'), 'DELETE', '/events/e1', undefined],
    ['attendEvent', (c) => c.attendEvent('e1'), 'POST', '/events/e1/attend', undefined],
    ['unattendEvent', (c) => c.unattendEvent('e1'), 'DELETE', '/events/e1/attend', undefined],
    ['startEvent', (c) => c.startEvent('e1'), 'POST', '/events/e1/start', undefined],
    ['getUserPresence', (c) => c.getUserPresence('ali.ce'), 'GET', '/presence/ali.ce', undefined],
    ['getBulkPresence', (c) => c.getBulkPresence(['a', 'b']), 'POST', '/presence/bulk', { usernames: ['a', 'b'] }],
    ['listGames', (c) => c.listGames(), 'GET', '/games', undefined],
    ['startGame', (c) => c.startGame('r', 'chess', { time: 5 }), 'POST', '/rooms/r/game/start', { gameId: 'chess', config: { time: 5 } }],
    ['sendGameAction', (c) => c.sendGameAction('r', { move: 'e4' }), 'POST', '/rooms/r/game/action', { action: { move: 'e4' } }],
    ['endGame', (c) => c.endGame('r'), 'DELETE', '/rooms/r/game', undefined],
    ['listWordCollections', (c) => c.listWordCollections(), 'GET', '/game-collections', undefined],
  ];

  for (const [label, call, method, path, body] of cases) {
    it(`${label}: ${method} ${path}`, async () => {
      const client = new HangoutsApiClient({ baseUrl: BASE_URL });
      await call(client);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const { url, init } = lastCall();
      expect(url).toBe(`${BASE_URL}${path}`);
      expect(init.method).toBe(method);
      if (body === undefined) {
        expect(init.body).toBeUndefined();
      } else {
        expect(JSON.parse(init.body!)).toEqual(body);
      }
    });
  }

  it('createRoom leaves out the optional fields it was not given', async () => {
    const client = new HangoutsApiClient({ baseUrl: BASE_URL });
    await client.createRoom('Only a title');
    expect(JSON.parse(lastCall().init.body!)).toEqual({ title: 'Only a title' });
  });

  it('listEvents leaves out a zero limit', async () => {
    const client = new HangoutsApiClient({ baseUrl: BASE_URL });
    await client.listEvents({ limit: 0 });
    expect(lastCall().url).toBe(`${BASE_URL}/events`);
  });

  it('stopWhipIngress resolves to undefined whatever the server answers', async () => {
    respondWith({ body: { ok: true } });
    const client = new HangoutsApiClient({ baseUrl: BASE_URL });
    expect(await client.stopWhipIngress('r')).toBeUndefined();
  });
});

describe('premium endpoints', () => {
  it('use the base url when no premium host is configured', async () => {
    const client = new HangoutsApiClient({ baseUrl: BASE_URL });
    await client.getPremiumStatus('alice');
    expect(lastCall().url).toBe(`${BASE_URL}/premium/alice`);
  });

  it('go to the separate premium host when one is configured, rooms stay on the base url', async () => {
    const client = new HangoutsApiClient({ baseUrl: BASE_URL, premiumBaseUrl: 'https://pro.test/' });
    await client.getPremiumStatus('ali ce');
    expect(lastCall().url).toBe('https://pro.test/premium/ali%20ce');
    await client.startProTrial();
    expect(lastCall().url).toBe('https://pro.test/premium/start-testing');
    await client.listRooms();
    expect(lastCall().url).toBe(`${BASE_URL}/rooms`);
  });

  it('startProTrial posts with no body and no JSON content type', async () => {
    const client = new HangoutsApiClient({ baseUrl: BASE_URL });
    client.setSessionToken('tok');
    await client.startProTrial();
    const { init } = lastCall();
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({ Authorization: 'Bearer tok' });
  });

  it('listPremiumUsers unwraps the subscribers with a default limit of 1000', async () => {
    respondWith({ body: { count: 1, subscribers: [{ username: 'alice' }] } });
    const client = new HangoutsApiClient({ baseUrl: BASE_URL });
    expect(await client.listPremiumUsers()).toEqual([{ username: 'alice' }]);
    expect(lastCall().url).toBe(`${BASE_URL}/premium?limit=1000`);
    expect(lastCall().init.method).toBe('GET');
  });

  it('listPremiumUsers passes a custom limit and answers an empty list when subscribers are missing', async () => {
    respondWith({ body: { count: 0 } });
    const client = new HangoutsApiClient({ baseUrl: BASE_URL });
    expect(await client.listPremiumUsers(25)).toEqual([]);
    expect(lastCall().url).toBe(`${BASE_URL}/premium?limit=25`);
  });
});

describe('fetchRecordingFile', () => {
  it('downloads the file with the bearer token and reads name and duration from the headers', async () => {
    const blob = new Blob(['abcdef']);
    respondWith({ blob, headers: { 'X-Recording-Filename': 'show.mp4', 'X-Recording-Duration': '42.5' } });
    const client = new HangoutsApiClient({ baseUrl: BASE_URL });
    client.setSessionToken('tok');

    const result = await client.fetchRecordingFile('my room', 'tok/en');

    const { url, init } = lastCall();
    expect(url).toBe(`${BASE_URL}/rooms/my%20room/record/file/tok%2Fen`);
    expect(init).toEqual({ method: 'GET', headers: { Authorization: 'Bearer tok' } });
    expect(result).toEqual({ blob, filename: 'show.mp4', duration: 42.5, size: 6 });
  });

  it('defaults the file name to the room and the duration to 0, and sends no auth without a token', async () => {
    respondWith({ blob: new Blob([]) });
    const client = new HangoutsApiClient({ baseUrl: BASE_URL });
    const result = await client.fetchRecordingFile('r1', 't');
    expect(lastCall().init.headers).toEqual({});
    expect(result).toMatchObject({ filename: 'r1.mp4', duration: 0, size: 0 });
  });

  it('throws HangoutsApiError with the server message on failure', async () => {
    respondWith({ status: 410, statusText: 'Gone', body: { message: 'Download link expired' } });
    const client = new HangoutsApiClient({ baseUrl: BASE_URL });
    await expect(client.fetchRecordingFile('r1', 't')).rejects.toMatchObject({
      name: 'HangoutsApiError', status: 410, message: 'Download link expired',
    });
  });

  it('falls back to the status text when the failure body is not JSON', async () => {
    respondWith({ status: 403, statusText: 'Forbidden', jsonThrows: true });
    const client = new HangoutsApiClient({ baseUrl: BASE_URL });
    await expect(client.fetchRecordingFile('r1', 't')).rejects.toMatchObject({ status: 403, message: 'Forbidden' });
  });
});
