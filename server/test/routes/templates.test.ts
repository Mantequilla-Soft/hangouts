import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.js';
import { makeToken } from '../setup.js';

vi.mock('../../src/lib/livekit.js', () => ({
  roomService: {
    listRooms: vi.fn(), listParticipants: vi.fn(), createRoom: vi.fn(),
    removeParticipant: vi.fn(), updateParticipant: vi.fn(), updateRoomMetadata: vi.fn(), deleteRoom: vi.fn(),
  },
  generateRoomName: vi.fn().mockReturnValue('alice-abc1234'),
  createLivekitToken: vi.fn().mockResolvedValue('mock-token'),
}));

vi.mock('../../src/lib/users.js', () => ({
  isUserBanned: vi.fn().mockResolvedValue(false),
  isUserPremium: vi.fn().mockResolvedValue(false),
  getUserStatus: vi.fn().mockResolvedValue({ banned: false, premium: false }),
}));

vi.mock('../../src/lib/streamTemplates.js', async () => {
  const { createFakeStore } = await import('../helpers/fakeTemplateStore.js');
  return createFakeStore();
});

vi.mock('../../src/lib/headlessStreams.js', () => ({
  isTemplateBusy: vi.fn().mockReturnValue(false),
  getHeadlessStatus: vi.fn().mockReturnValue(null),
  getLastHeadlessEnd: vi.fn().mockReturnValue(null),
  streamCapMs: (p: boolean) => (p ? 4 : 1) * 3600_000,
  capCooldownRemaining: vi.fn().mockReturnValue(0),
  startHeadlessStream: vi.fn(),
  forwardWhipPatch: vi.fn(),
  endWhipSession: vi.fn(),
  getSessionByToken: vi.fn(),
  endHeadlessStreamForRoom: vi.fn(),
  headlessViewerIdentity: (h: string) => `${h}~watch`,
}));

let app: FastifyInstance;
// Each test gets its own client IP so the per-IP create rate limit (which the
// 20-template cap test alone nearly exhausts) doesn't leak between tests.
let ipN = 0;
let ip = '10.0.0.1';
let alice: string;
let bob: string;

beforeAll(async () => {
  app = await buildApp();
  alice = `Bearer ${await makeToken('alice')}`;
  bob = `Bearer ${await makeToken('bob')}`;
});

beforeEach(async () => {
  ip = `10.0.${Math.floor(++ipN / 250)}.${ipN % 250 + 1}`;
  const store = await import('../../src/lib/streamTemplates.js') as unknown as { _templates: Map<string, unknown>; _secrets: Map<string, unknown> };
  store._templates.clear();
  store._secrets.clear();
  const hs = await import('../../src/lib/headlessStreams.js');
  vi.mocked(hs.isTemplateBusy).mockReturnValue(false);
  vi.mocked(hs.getHeadlessStatus).mockReturnValue(null);
});

async function create(auth: string, body: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/templates', headers: { authorization: auth }, payload: body, remoteAddress: ip });
}

describe('template CRUD', () => {
  it('requires auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/templates' });
    expect(res.statusCode).toBe(401);
  });

  it('creates, lists, updates and deletes', async () => {
    const c = await create(alice, { name: 'Morning Show', title: 'Coffee & code', tags: ['dev'] });
    expect(c.statusCode).toBe(201);
    const { template } = c.json();
    expect(template).toMatchObject({
      owner: 'alice', name: 'Morning Show', slug: 'morning-show',
      whipUrl: 'https://hangouts.okinoko.io/whip/alice/morning-show',
      title: 'Coffee & code', tags: ['dev'], visibility: 'public', lastLiveAt: null,
    });
    expect(template).not.toHaveProperty('keyHint');
    expect(c.body).not.toMatch(/ss_/);

    const l = await app.inject({ method: 'GET', url: '/templates', headers: { authorization: alice } });
    expect(l.json()).toMatchObject({ whipBase: 'https://hangouts.okinoko.io/whip' });
    expect(l.json().templates).toHaveLength(1);

    const p = await app.inject({
      method: 'PATCH', url: `/templates/${template.id}`, headers: { authorization: alice },
      payload: { title: 'New title', announce: { enabled: true, beneficiaries: [{ account: 'bob', weight: 1000 }] } },
    });
    expect(p.statusCode).toBe(200);
    expect(p.json().template).toMatchObject({ title: 'New title', slug: 'morning-show', announce: { enabled: true } });

    const d = await app.inject({ method: 'DELETE', url: `/templates/${template.id}`, headers: { authorization: alice } });
    expect(d.json()).toEqual({ ok: true });
    const l2 = await app.inject({ method: 'GET', url: '/templates', headers: { authorization: alice } });
    expect(l2.json().templates).toHaveLength(0);
  });

  it('400s invalid input with a code', async () => {
    const res = await create(alice, { name: 'x', title: '' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_input');
  });

  it('enforces unique slugs per owner (409 name_taken) but not across owners', async () => {
    expect((await create(alice, { name: 'Morning Show', title: 't' })).statusCode).toBe(201);
    const dup = await create(alice, { name: 'morning  SHOW!', title: 't' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe('name_taken');
    expect((await create(bob, { name: 'Morning Show', title: 't' })).statusCode).toBe(201);
  });

  it('409s a rename onto another template\'s slug', async () => {
    await create(alice, { name: 'One', title: 't' });
    const two = (await create(alice, { name: 'Two', title: 't' })).json().template;
    const res = await app.inject({ method: 'PATCH', url: `/templates/${two.id}`, headers: { authorization: alice }, payload: { name: 'ONE' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('name_taken');
  });

  it('caps templates per user at 20', async () => {
    for (let i = 0; i < 20; i++) expect((await create(alice, { name: `T ${i}`, title: 't' })).statusCode).toBe(201);
    const res = await create(alice, { name: 'T 21', title: 't' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('limit_reached');
  });

  it('is owner-scoped: another user gets 404', async () => {
    const t = (await create(alice, { name: 'Mine', title: 't' })).json().template;
    for (const [method, url] of [['PATCH', `/templates/${t.id}`], ['DELETE', `/templates/${t.id}`], ['GET', `/templates/${t.id}/status`]] as const) {
      const res = await app.inject({ method, url, headers: { authorization: bob }, payload: method === 'PATCH' ? { title: 'x' } : undefined });
      expect(res.statusCode).toBe(404);
    }
    expect((await app.inject({ method: 'GET', url: '/templates/not-an-id/status', headers: { authorization: alice } })).statusCode).toBe(404);
  });

  it('refuses rename and delete while live, but allows other edits', async () => {
    const hs = await import('../../src/lib/headlessStreams.js');
    const t = (await create(alice, { name: 'Live One', title: 't' })).json().template;
    vi.mocked(hs.isTemplateBusy).mockReturnValue(true);

    const rename = await app.inject({ method: 'PATCH', url: `/templates/${t.id}`, headers: { authorization: alice }, payload: { name: 'Other' } });
    expect(rename.statusCode).toBe(409);
    expect(rename.json().error).toBe('live');

    // Same slug (case / punctuation only) is not a rename of the address.
    const cosmetic = await app.inject({ method: 'PATCH', url: `/templates/${t.id}`, headers: { authorization: alice }, payload: { name: 'LIVE one!' } });
    expect(cosmetic.statusCode).toBe(200);

    const edit = await app.inject({ method: 'PATCH', url: `/templates/${t.id}`, headers: { authorization: alice }, payload: { title: 'still fine' } });
    expect(edit.statusCode).toBe(200);

    const del = await app.inject({ method: 'DELETE', url: `/templates/${t.id}`, headers: { authorization: alice } });
    expect(del.statusCode).toBe(409);
  });

  it('reports idle status with the tier cap, and live status from the session', async () => {
    const hs = await import('../../src/lib/headlessStreams.js');
    const t = (await create(alice, { name: 'S', title: 't' })).json().template;
    const idle = await app.inject({ method: 'GET', url: `/templates/${t.id}/status`, headers: { authorization: alice } });
    expect(idle.json()).toEqual({ state: 'idle', room: null, startedAt: null, capSeconds: 3600, ingress: null, announced: null, lastEnd: null });

    vi.mocked(hs.getLastHeadlessEnd).mockReturnValueOnce({ reason: 'never_published', at: 456 });
    const stuck = await app.inject({ method: 'GET', url: `/templates/${t.id}/status`, headers: { authorization: alice } });
    expect(stuck.json().lastEnd).toEqual({ reason: 'never_published', at: 456 });

    vi.mocked(hs.getHeadlessStatus).mockReturnValue({
      state: 'live', room: 'alice-abc1234', startedAt: 123,
      ingress: { status: 'publishing', width: 1280, height: 720, bitrate: 2500000, fps: 30 },
      announced: { ok: false, reason: 'no_posting_authority' },
    });
    const live = await app.inject({ method: 'GET', url: `/templates/${t.id}/status`, headers: { authorization: alice } });
    expect(live.json()).toMatchObject({ state: 'live', room: 'alice-abc1234', capSeconds: 3600, announced: { ok: false } });
  });
});

describe('stream secret', () => {
  it('creates once, reveals the same value, and reset rotates it', async () => {
    const a = await app.inject({ method: 'GET', url: '/stream-secret', headers: { authorization: alice } });
    expect(a.statusCode).toBe(200);
    expect(a.headers['cache-control']).toBe('no-store');
    const s1 = a.json().secret;
    expect(s1).toMatch(/^ss_/);
    const b = await app.inject({ method: 'GET', url: '/stream-secret', headers: { authorization: alice } });
    expect(b.json().secret).toBe(s1);

    const r = await app.inject({ method: 'POST', url: '/stream-secret/reset', headers: { authorization: alice } });
    const s2 = r.json().secret;
    expect(s2).toMatch(/^ss_/);
    expect(s2).not.toBe(s1);
    const c = await app.inject({ method: 'GET', url: '/stream-secret', headers: { authorization: alice } });
    expect(c.json().secret).toBe(s2);

    // Per user.
    const other = await app.inject({ method: 'GET', url: '/stream-secret', headers: { authorization: bob } });
    expect(other.json().secret).not.toBe(s2);
  });
});
