import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import { makeToken } from '../setup.js';

vi.mock('../../src/lib/livekit.js', () => ({
  roomService: { listRooms: vi.fn(), updateRoomMetadata: vi.fn() },
}));
vi.mock('../../src/lib/users.js', () => ({ isUserBanned: vi.fn(), isUserPremium: vi.fn() }));

const ROOM = 'badadib-cap1234';
let app: FastifyInstance;
let auth: Record<string, string>;
let lk: typeof import('../../src/lib/livekit.js')['roomService'];
let users: typeof import('../../src/lib/users.js');
let captions: typeof import('../../src/routes/captions.js');
/** The room's live metadata, as LiveKit would hold it. */
let meta: Record<string, unknown> | null;

async function setup(env: Record<string, string> = {}) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  lk = (await import('../../src/lib/livekit.js')).roomService;
  users = await import('../../src/lib/users.js');
  captions = await import('../../src/routes/captions.js');
  app = Fastify();
  await app.register(sensible);
  await app.register(rateLimit, { global: false });
  await app.register(captions.captionRoutes);
  auth = { authorization: `Bearer ${await makeToken('badadib')}` };
  vi.mocked(lk.listRooms).mockImplementation(async () => (meta ? [{ name: ROOM, metadata: JSON.stringify(meta) }] : []) as never);
  vi.mocked(lk.updateRoomMetadata).mockImplementation(async (_n: string, m: string) => { meta = JSON.parse(m); return {} as never; });
  vi.mocked(users.isUserBanned).mockResolvedValue(false);
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  meta = { host: 'badadib', mode: 'standalone' };
  await setup();
});

afterEach(async () => {
  await app.close();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const start = (body: unknown = { lang: 'en-us' }, headers = auth, room = ROOM) =>
  app.inject({ method: 'POST', url: `/rooms/${room}/captions/start`, headers, payload: body as object });
const stop = (headers = auth, room = ROOM) => app.inject({ method: 'POST', url: `/rooms/${room}/captions/stop`, headers, payload: {} });
const status = async () => (await app.inject({ method: 'GET', url: '/captions/status' })).json();

describe('caption slots', () => {
  it('status is public and shows the cap', async () => {
    expect(await status()).toEqual({ enabled: true, max: 3, active: 0, available: true });
  });

  it('needs a session (401) and the room\'s host (403), and a room (404)', async () => {
    expect((await start(undefined, {})).statusCode).toBe(401);
    expect((await start(undefined, { authorization: `Bearer ${await makeToken('fan')}` })).statusCode).toBe(403);
    meta = null;
    expect((await start()).statusCode).toBe(404);
  });

  it('refuses a banned host', async () => {
    vi.mocked(users.isUserBanned).mockResolvedValue(true);
    expect((await start()).statusCode).toBe(403);
  });

  it('rejects a language that is not a model code', async () => {
    expect((await start({ lang: 'English!' })).statusCode).toBe(400);
  });

  it('takes a slot, flags the room for viewers, renews without a LiveKit lookup', async () => {
    const res = await start({ lang: 'en-us' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, lang: 'en-us', renewInSec: 30, expiresInSec: 90, active: 1, max: 3 });
    expect(meta).toMatchObject({ host: 'badadib', captions: { lang: 'en-us' } });
    vi.mocked(lk.listRooms).mockClear();
    vi.mocked(lk.updateRoomMetadata).mockClear();
    const again = await start({ lang: 'en-us' });
    expect(again.statusCode).toBe(200);
    expect(lk.listRooms).not.toHaveBeenCalled();
    expect(lk.updateRoomMetadata).not.toHaveBeenCalled();
  });

  it('defaults the language to en-us when none is sent', async () => {
    const res = await start({});
    expect(res.json().lang).toBe('en-us');
  });

  it('stop frees the slot and clears the flag; stop by someone else changes nothing', async () => {
    await start();
    await stop({ authorization: `Bearer ${await makeToken('fan')}` });
    expect(meta).toHaveProperty('captions');
    expect((await stop()).json()).toEqual({ ok: true });
    expect(meta).not.toHaveProperty('captions');
    expect(meta).toMatchObject({ host: 'badadib', mode: 'standalone' });
    expect((await status()).active).toBe(0);
  });

  it('stop with nothing held is a quiet no-op', async () => {
    expect((await stop()).statusCode).toBe(200);
    expect(lk.updateRoomMetadata).not.toHaveBeenCalled();
  });

  it('the cap holds: the next stream gets 429 with the counts', async () => {
    await app.close();
    await setup({ CAPTIONS_MAX_STREAMS: '1' });
    expect((await start()).statusCode).toBe(200);
    const rooms: Record<string, Record<string, unknown>> = { other: { host: 'fan' } };
    vi.mocked(lk.listRooms).mockImplementation(async (names?: string[]) => {
      const n = names?.[0] ?? '';
      if (n === ROOM) return [{ name: ROOM, metadata: JSON.stringify(meta) }] as never;
      return (rooms[n] ? [{ name: n, metadata: JSON.stringify(rooms[n]) }] : []) as never;
    });
    const res = await start({ lang: 'en-us' }, { authorization: `Bearer ${await makeToken('fan')}` }, 'other');
    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({ reason: 'full', max: 1, active: 1 });
    expect(await status()).toMatchObject({ available: false });
  });

  it('returns 503 when switched off by config, or when the cap is zero', async () => {
    await app.close();
    await setup({ CAPTIONS_ENABLED: 'false' });
    expect((await start()).statusCode).toBe(503);
    expect(await status()).toMatchObject({ enabled: false, available: false });
    await app.close();
    await setup({ CAPTIONS_MAX_STREAMS: '0' });
    expect((await start()).json()).toMatchObject({ reason: 'disabled' });
  });

  it('a lapsed slot (studio gone) is swept and the room flag cleared', async () => {
    await start();
    expect(meta).toHaveProperty('captions');
    vi.setSystemTime(Date.now() + 91_000);
    expect(await captions.sweepCaptionSlots()).toEqual([ROOM]);
    expect(meta).not.toHaveProperty('captions');
    expect((await status()).active).toBe(0);
  });

  it('the sweep survives a room that is already gone', async () => {
    await start();
    meta = null;
    vi.setSystemTime(Date.now() + 91_000);
    await expect(captions.sweepCaptionSlots()).resolves.toEqual([ROOM]);
  });

  it('a held slot for the same room by another account is 409', async () => {
    await start();
    // Host handover: the room now says fan is host, but badadib's slot is still live.
    meta = { host: 'fan' };
    const res = await start({ lang: 'en-us' }, { authorization: `Bearer ${await makeToken('fan')}` });
    expect(res.statusCode).toBe(409);
    expect(res.json().reason).toBe('taken');
  });

  it('a room with unreadable metadata has no host', async () => {
    vi.mocked(lk.listRooms).mockResolvedValue([{ name: ROOM, metadata: '{nope' }] as never);
    expect((await start()).statusCode).toBe(403);
    vi.mocked(lk.listRooms).mockResolvedValue([{ name: ROOM, metadata: '' }] as never);
    expect((await start()).statusCode).toBe(403);
  });

  it('writeCaptionMeta leaves an unchanged flag alone', async () => {
    meta = { host: 'badadib', captions: { lang: 'en-us' } };
    await captions.writeCaptionMeta(ROOM, 'en-us');
    expect(lk.updateRoomMetadata).not.toHaveBeenCalled();
    await captions.writeCaptionMeta(ROOM, 'de');
    expect(meta).toMatchObject({ captions: { lang: 'de' } });
    meta = { host: 'badadib' };
    vi.mocked(lk.updateRoomMetadata).mockClear();
    await captions.writeCaptionMeta(ROOM, null);
    expect(lk.updateRoomMetadata).not.toHaveBeenCalled();
  });
});
