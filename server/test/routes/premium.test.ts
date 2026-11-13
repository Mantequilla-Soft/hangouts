import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { makeToken } from '../setup.js';

vi.mock('../../src/lib/users.js', () => ({
  getPremiumStatus: vi.fn(),
  listPremiumUsers: vi.fn(),
  startPremiumTesting: vi.fn(),
  isUserBanned: vi.fn(),
}));

let app: FastifyInstance;
let users: typeof import('../../src/lib/users.js');
let auth: Record<string, string>;

/** Fresh app per test, so PRO_TESTING_* env changes are picked up by config. */
async function setup(env: Record<string, string> = {}) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  users = await import('../../src/lib/users.js');
  const { premiumRoutes } = await import('../../src/routes/premium.js');
  app = Fastify();
  await app.register(sensible);
  await app.register(premiumRoutes);
  vi.mocked(users.isUserBanned).mockResolvedValue(false);
}

const STATUS = {
  username: 'alice',
  premium: false,
  premium_source: null,
  premium_expires_at: null,
  testing_started: null,
};

beforeEach(async () => {
  vi.stubEnv('PRO_TESTING_ENABLED', 'true');
  vi.stubEnv('PRO_TESTING_HOURS', '24');
  auth = { authorization: `Bearer ${await makeToken('alice')}` };
  await setup();
});

afterEach(async () => {
  await app.close();
  vi.unstubAllEnvs();
});

describe('GET /premium/:username', () => {
  it('returns the premium status with the trial capability and a 60 s cache', async () => {
    vi.mocked(users.getPremiumStatus).mockResolvedValue(STATUS);
    const res = await app.inject({ method: 'GET', url: '/premium/alice' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    expect(res.json()).toEqual({ ...STATUS, testing_available: true, testing_hours: 24 });
    expect(users.getPremiumStatus).toHaveBeenCalledWith('alice');
  });

  it('tells the client when trials are switched off on this deployment', async () => {
    await setup({ PRO_TESTING_ENABLED: 'false', PRO_TESTING_HOURS: '48' });
    vi.mocked(users.getPremiumStatus).mockResolvedValue(STATUS);
    const res = await app.inject({ method: 'GET', url: '/premium/alice' });

    expect(res.json()).toMatchObject({ testing_available: false, testing_hours: 48 });
  });

  it('rejects a username longer than 64 characters', async () => {
    const res = await app.inject({ method: 'GET', url: `/premium/${'a'.repeat(65)}` });

    expect(res.statusCode).toBe(400);
    expect(users.getPremiumStatus).not.toHaveBeenCalled();
  });

  it('answers 500 when the status lookup fails', async () => {
    vi.mocked(users.getPremiumStatus).mockRejectedValue(new Error('mongo down'));
    const res = await app.inject({ method: 'GET', url: '/premium/alice' });

    expect(res.statusCode).toBe(500);
  });
});

describe('GET /premium', () => {
  const SUBS = [
    { username: 'alice', premium_source: 'subs', premium_expires_at: null },
    { username: 'bob', premium_source: 'testing', premium_expires_at: '2026-11-14T00:00:00.000Z' },
  ];

  it('lists current subscribers with their count and a 60 s cache', async () => {
    vi.mocked(users.listPremiumUsers).mockResolvedValue(SUBS);
    const res = await app.inject({ method: 'GET', url: '/premium?limit=10' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    expect(res.json()).toEqual({ count: 2, subscribers: SUBS });
    expect(users.listPremiumUsers).toHaveBeenCalledWith(10);
  });

  it.each([
    ['no limit', '', 1000],
    ['a non-numeric limit', '?limit=abc', 1000],
    ['a zero limit', '?limit=0', 1000],
    ['a negative limit', '?limit=-5', 1000],
    ['a limit above the cap', '?limit=99999', 5000],
  ])('uses a sane limit for %s', async (_label, query, expected) => {
    vi.mocked(users.listPremiumUsers).mockResolvedValue([]);
    await app.inject({ method: 'GET', url: `/premium${query}` });

    expect(users.listPremiumUsers).toHaveBeenCalledWith(expected);
  });
});

describe('POST /premium/start-testing', () => {
  const claim = (headers: Record<string, string> = auth) =>
    app.inject({ method: 'POST', url: '/premium/start-testing', headers });

  it('starts the trial for the signed-in user and returns its expiry', async () => {
    vi.mocked(users.startPremiumTesting).mockResolvedValue({ ok: true, expiresAt: '2026-11-14T12:00:00.000Z' } as never);
    const res = await claim();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, expiresAt: '2026-11-14T12:00:00.000Z', hours: 24 });
    expect(users.startPremiumTesting).toHaveBeenCalledWith('alice', 24);
  });

  it('requires a session', async () => {
    const res = await claim({});

    expect(res.statusCode).toBe(401);
    expect(users.startPremiumTesting).not.toHaveBeenCalled();
  });

  it('refuses a banned user', async () => {
    vi.mocked(users.isUserBanned).mockResolvedValue(true);
    const res = await claim();

    expect(res.statusCode).toBe(403);
    expect(users.startPremiumTesting).not.toHaveBeenCalled();
  });

  it('answers 403 when trials are switched off', async () => {
    await setup({ PRO_TESTING_ENABLED: 'false' });
    const res = await claim();

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ ok: false, message: 'The Pro trial is not available right now.' });
    expect(users.startPremiumTesting).not.toHaveBeenCalled();
  });

  it('answers 409 when the user already used their one trial', async () => {
    vi.mocked(users.startPremiumTesting).mockResolvedValue({ ok: false, reason: 'already_used' });
    const res = await claim();

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ ok: false, message: 'You have already used your one-time Pro trial.' });
  });

  it('answers 409 when the user already has Pro', async () => {
    vi.mocked(users.startPremiumTesting).mockResolvedValue({ ok: false, reason: 'already_premium' });
    const res = await claim();

    expect(res.statusCode).toBe(409);
    expect(res.json().message).toMatch(/already has Pro/);
  });

  it('answers 503 when the user store is unavailable', async () => {
    vi.mocked(users.startPremiumTesting).mockResolvedValue({ ok: false, reason: 'unavailable' });
    const res = await claim();

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, message: 'The Pro trial is temporarily unavailable.' });
  });
});
