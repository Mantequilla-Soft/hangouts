import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import { makeToken } from '../setup.js';

vi.mock('../../src/lib/livekit.js', () => ({
  roomService: { listRooms: vi.fn(), updateRoomMetadata: vi.fn() },
}));
vi.mock('../../src/lib/users.js', () => ({
  isUserBanned: vi.fn().mockResolvedValue(false),
}));
const store = vi.hoisted(() => {
  class OverlayStoreUnavailableError extends Error {}
  const docs = new Map<string, unknown[]>();
  return {
    docs,
    OverlayStoreUnavailableError,
    down: false,
    getOverlayTemplates: vi.fn(async (owner: string) => {
      if (store.down) throw new OverlayStoreUnavailableError();
      return docs.get(owner) ?? [];
    }),
    saveOverlayTemplates: vi.fn(async (owner: string, t: unknown[]) => {
      if (store.down) throw new OverlayStoreUnavailableError();
      docs.set(owner, t);
    }),
  };
});
vi.mock('../../src/lib/studioOverlayStore.js', () => store);

let app: FastifyInstance;
let alice: string;
let bob: string;
let lk: typeof import('../../src/lib/livekit.js')['roomService'];
let meta: Record<string, unknown>;

beforeAll(async () => {
  const { studioToolRoutes } = await import('../../src/routes/studioTools.js');
  app = Fastify();
  await app.register(sensible);
  await app.register(rateLimit, { global: false });
  await app.register(studioToolRoutes);
  alice = `Bearer ${await makeToken('alice')}`;
  bob = `Bearer ${await makeToken('bob')}`;
  lk = (await import('../../src/lib/livekit.js')).roomService;
});

beforeEach(() => {
  store.docs.clear();
  store.down = false;
  meta = { host: 'alice', portrait: false };
  vi.mocked(lk.listRooms).mockReset().mockImplementation(async () => [{ name: 'alice-room', metadata: JSON.stringify(meta) }] as never);
  vi.mocked(lk.updateRoomMetadata).mockReset().mockImplementation(async (_n: string, m: string) => { meta = JSON.parse(m); return {} as never; });
});

const patchVertical = (auth: string | null, payload: Record<string, unknown>) => app.inject({
  method: 'PATCH', url: '/rooms/alice-room/vertical', payload,
  headers: auth ? { authorization: auth } : {},
});

describe('PATCH /rooms/:name/vertical', () => {
  it('stores the cleaned crop in the room metadata, keeping other fields', async () => {
    const res = await patchVertical(alice, { on: true, x: 0.9, w: 0.316, follow: 'camera', track: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().vertical).toEqual({ on: true, x: 0.842, w: 0.316, follow: 'camera', track: true });
    expect(meta).toMatchObject({ host: 'alice', portrait: false, vertical: { on: true, x: 0.842 } });
  });

  it('does not write the metadata again when nothing changed', async () => {
    await patchVertical(alice, { on: true, x: 0.5 });
    await patchVertical(alice, { on: true, x: 0.5 });
    expect(lk.updateRoomMetadata).toHaveBeenCalledTimes(1);
  });

  it('is host only, needs auth, and 404s for a missing room', async () => {
    expect((await patchVertical(null, { on: true })).statusCode).toBe(401);
    expect((await patchVertical(bob, { on: true })).statusCode).toBe(403);
    vi.mocked(lk.listRooms).mockResolvedValue([] as never);
    expect((await patchVertical(alice, { on: true })).statusCode).toBe(404);
    expect(lk.updateRoomMetadata).not.toHaveBeenCalled();
  });
});

describe('/studio/overlays', () => {
  it('starts empty, saves cleaned templates and reads them back per host', async () => {
    const empty = await app.inject({ method: 'GET', url: '/studio/overlays', headers: { authorization: alice } });
    expect(empty.json()).toEqual({ templates: [] });
    const put = await app.inject({
      method: 'PUT', url: '/studio/overlays', headers: { authorization: alice },
      payload: { templates: [{ id: 'show', name: 'Show', config: { lowerThird: { name: 'badadib' }, brb: { music: 'calm' } } }] },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().templates[0]).toMatchObject({ id: 'show', config: { lowerThird: { name: 'badadib' }, brb: { music: 'calm' } } });
    const got = await app.inject({ method: 'GET', url: '/studio/overlays', headers: { authorization: alice } });
    expect(got.json().templates).toHaveLength(1);
    const other = await app.inject({ method: 'GET', url: '/studio/overlays', headers: { authorization: bob } });
    expect(other.json().templates).toEqual([]);
  });

  it('refuses invalid input and unauthenticated calls', async () => {
    const bad = await app.inject({ method: 'PUT', url: '/studio/overlays', headers: { authorization: alice }, payload: { templates: [{ id: 'x' }] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('invalid_input');
    expect((await app.inject({ method: 'GET', url: '/studio/overlays' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PUT', url: '/studio/overlays', payload: { templates: [] } })).statusCode).toBe(401);
  });

  it('answers 503 when the storage is down', async () => {
    store.down = true;
    expect((await app.inject({ method: 'GET', url: '/studio/overlays', headers: { authorization: alice } })).statusCode).toBe(503);
    const put = await app.inject({ method: 'PUT', url: '/studio/overlays', headers: { authorization: alice }, payload: { templates: [] } });
    expect(put.statusCode).toBe(503);
  });
});
