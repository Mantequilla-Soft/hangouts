import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mongo fake: one `embed-users` collection the module talks to ────────────
const mongo = vi.hoisted(() => ({
  connectFails: false,
  connects: 0,
  findOne: vi.fn(),
  updateOne: vi.fn(),
  find: vi.fn(),
  config: { MONGODB_URI: 'mongodb://test' } as { MONGODB_URI: string },
}));

vi.mock('mongodb', () => ({
  MongoClient: class {
    async connect() {
      mongo.connects++;
      if (mongo.connectFails) throw new Error('connect refused');
      return this;
    }
    db() {
      return {
        collection: () => ({ findOne: mongo.findOne, updateOne: mongo.updateOne, find: mongo.find }),
      };
    }
  },
}));

vi.mock('../../src/config.js', () => ({ config: mongo.config }));

type UsersModule = typeof import('../../src/lib/users.js');

/** Fresh module per test: the connection and the cache are module state. */
async function load(): Promise<UsersModule> {
  vi.resetModules();
  return import('../../src/lib/users.js');
}

/** A find() chain that resolves to `docs` and records its arguments. */
function findChain(docs: unknown[] | Error) {
  const chain = {
    sort: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    toArray: vi.fn(async () => {
      if (docs instanceof Error) throw docs;
      return docs;
    }),
  };
  return chain;
}

beforeEach(() => {
  mongo.connectFails = false;
  mongo.connects = 0;
  mongo.config.MONGODB_URI = 'mongodb://test';
  mongo.findOne.mockReset();
  mongo.updateOne.mockReset();
  mongo.find.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ban and premium lookups', () => {
  it('reports a banned user as banned and a premium user as premium', async () => {
    const users = await load();
    mongo.findOne.mockImplementation(async ({ username }: { username: string }) => (
      username === 'troll' ? { username, banned: true, premium: false }
        : username === 'pro' ? { username, banned: false, premium: true }
          : null
    ));
    expect(await users.isUserBanned('troll')).toBe(true);
    expect(await users.isUserPremium('troll')).toBe(false);
    expect(await users.isUserBanned('pro')).toBe(false);
    expect(await users.isUserPremium('pro')).toBe(true);
    expect(await users.getUserStatus('pro')).toEqual({ banned: false, premium: true });
  });

  it('treats an unknown user as neither banned nor premium', async () => {
    const users = await load();
    mongo.findOne.mockResolvedValue(null);
    expect(await users.getUserStatus('nobody')).toEqual({ banned: false, premium: false });
  });

  it('only a literal true counts: truthy non-boolean flags do not ban or grant premium', async () => {
    const users = await load();
    mongo.findOne.mockResolvedValue({ username: 'odd', banned: 'yes', premium: 1 });
    expect(await users.getUserStatus('odd')).toEqual({ banned: false, premium: false });
  });

  it('fails open (not banned, not premium) when no MONGODB_URI is configured', async () => {
    mongo.config.MONGODB_URI = '';
    const users = await load();
    expect(await users.getUserStatus('alice')).toEqual({ banned: false, premium: false });
    expect(mongo.connects).toBe(0);
    expect(mongo.findOne).not.toHaveBeenCalled();
  });

  it('fails open when Mongo cannot be reached, and retries the connection on the next call', async () => {
    mongo.connectFails = true;
    const users = await load();
    expect(await users.isUserBanned('alice')).toBe(false);
    expect(mongo.connects).toBe(1);

    mongo.connectFails = false;
    mongo.findOne.mockResolvedValue({ username: 'alice', banned: true, premium: false });
    expect(await users.isUserBanned('alice')).toBe(true);
    expect(mongo.connects).toBe(2);
  });

  it('connects once and reuses the collection for later lookups', async () => {
    const users = await load();
    mongo.findOne.mockResolvedValue(null);
    await users.isUserBanned('a');
    await users.isUserBanned('b');
    await users.isUserBanned('c');
    expect(mongo.connects).toBe(1);
  });

  it('a failed query fails open and drops the connection so the next lookup reconnects', async () => {
    const users = await load();
    mongo.findOne.mockRejectedValueOnce(new Error('socket closed'));
    expect(await users.isUserBanned('alice')).toBe(false);
    expect(mongo.connects).toBe(1);

    mongo.findOne.mockResolvedValueOnce({ username: 'alice', banned: true, premium: false });
    expect(await users.isUserBanned('alice')).toBe(true);
    expect(mongo.connects).toBe(2);
  });
});

describe('lookup cache', () => {
  it('serves a repeat lookup from the cache for one minute, then asks Mongo again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-13T12:00:00Z'));
    const users = await load();
    mongo.findOne.mockResolvedValue({ username: 'alice', banned: false, premium: true });

    await users.isUserPremium('alice');
    await users.isUserBanned('alice');
    await users.getUserStatus('alice');
    expect(mongo.findOne).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-11-13T12:00:59Z'));
    await users.isUserPremium('alice');
    expect(mongo.findOne).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-11-13T12:01:01Z'));
    mongo.findOne.mockResolvedValue({ username: 'alice', banned: true, premium: false });
    expect(await users.isUserBanned('alice')).toBe(true);
    expect(mongo.findOne).toHaveBeenCalledTimes(2);
  });

  it('caches a missing user too, so unknown accounts do not hit Mongo every request', async () => {
    const users = await load();
    mongo.findOne.mockResolvedValue(null);
    await users.isUserBanned('ghost');
    await users.isUserBanned('ghost');
    expect(mongo.findOne).toHaveBeenCalledTimes(1);
  });

  it('keeps a separate cache entry per username', async () => {
    const users = await load();
    mongo.findOne.mockResolvedValue(null);
    await users.isUserBanned('a');
    await users.isUserBanned('b');
    expect(mongo.findOne).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed query', async () => {
    const users = await load();
    mongo.findOne.mockRejectedValueOnce(new Error('timeout'));
    await users.isUserBanned('alice');
    mongo.findOne.mockResolvedValueOnce({ username: 'alice', banned: true, premium: false });
    expect(await users.isUserBanned('alice')).toBe(true);
    expect(mongo.findOne).toHaveBeenCalledTimes(2);
  });
});

describe('getPremiumStatus', () => {
  it('normalises the name and returns the full premium shape with ISO dates', async () => {
    const users = await load();
    const expires = new Date('2026-12-01T00:00:00Z');
    const started = new Date('2026-11-01T00:00:00Z');
    mongo.findOne.mockResolvedValue({
      username: 'alice', banned: false, premium: true,
      premium_source: 'subs', premium_expires_at: expires, testing_started: started,
    });
    expect(await users.getPremiumStatus('  Alice ')).toEqual({
      username: 'alice',
      premium: true,
      premium_source: 'subs',
      premium_expires_at: '2026-12-01T00:00:00.000Z',
      testing_started: '2026-11-01T00:00:00.000Z',
    });
    expect(mongo.findOne).toHaveBeenCalledWith({ username: 'alice' });
  });

  it('passes string dates through and turns other date values into null', async () => {
    const users = await load();
    mongo.findOne.mockResolvedValue({
      username: 'bob', banned: false, premium: false,
      premium_expires_at: '2026-12-01T00:00:00Z', testing_started: 12345,
    });
    expect(await users.getPremiumStatus('bob')).toMatchObject({
      premium: false,
      premium_source: null,
      premium_expires_at: '2026-12-01T00:00:00Z',
      testing_started: null,
    });
  });

  it('returns a non-premium status with all nulls for an unknown user', async () => {
    const users = await load();
    mongo.findOne.mockResolvedValue(null);
    expect(await users.getPremiumStatus('nobody')).toEqual({
      username: 'nobody', premium: false, premium_source: null, premium_expires_at: null, testing_started: null,
    });
  });
});

describe('listPremiumUsers', () => {
  it('queries premium rows sorted by name, limited, and maps them to the ticker shape', async () => {
    const users = await load();
    const chain = findChain([
      { username: 'a', premium_source: 'subs', premium_expires_at: new Date('2026-12-01T00:00:00Z') },
      { username: 'b' },
    ]);
    mongo.find.mockReturnValue(chain);
    expect(await users.listPremiumUsers(5)).toEqual([
      { username: 'a', premium_source: 'subs', premium_expires_at: '2026-12-01T00:00:00.000Z' },
      { username: 'b', premium_source: null, premium_expires_at: null },
    ]);
    expect(mongo.find).toHaveBeenCalledWith({ premium: true }, expect.objectContaining({ projection: expect.any(Object) }));
    expect(chain.sort).toHaveBeenCalledWith({ username: 1 });
    expect(chain.limit).toHaveBeenCalledWith(5);
  });

  it('returns an empty list when Mongo is not configured', async () => {
    mongo.config.MONGODB_URI = '';
    const users = await load();
    expect(await users.listPremiumUsers(10)).toEqual([]);
  });

  it('returns an empty list on a query error and reconnects next time', async () => {
    const users = await load();
    mongo.find.mockReturnValueOnce(findChain(new Error('cursor killed')));
    expect(await users.listPremiumUsers(10)).toEqual([]);
    mongo.find.mockReturnValueOnce(findChain([]));
    await users.listPremiumUsers(10);
    expect(mongo.connects).toBe(2);
  });
});

describe('startPremiumTesting', () => {
  it('grants a trial with the right expiry, as one guarded upsert, and drops the cached row', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-13T12:00:00Z'));
    const users = await load();
    mongo.findOne.mockResolvedValue({ username: 'alice', banned: false, premium: false });
    mongo.updateOne.mockResolvedValue({ matchedCount: 1, upsertedCount: 0 });

    // Warm the cache with the pre-trial row.
    expect(await users.isUserPremium('alice')).toBe(false);
    expect(mongo.findOne).toHaveBeenCalledTimes(1);

    const res = await users.startPremiumTesting(' Alice ', 24);
    expect(res).toEqual({ ok: true, expiresAt: '2026-11-14T12:00:00.000Z' });

    const [filter, update, opts] = mongo.updateOne.mock.calls[0];
    expect(filter).toEqual({ username: 'alice', testing_started: { $exists: false } });
    expect(update.$set).toMatchObject({ premium: true, premium_source: 'testing' });
    expect((update.$set.premium_expires_at as Date).toISOString()).toBe('2026-11-14T12:00:00.000Z');
    expect(update.$setOnInsert).toEqual({ username: 'alice', banned: false });
    expect(opts).toEqual({ upsert: true });

    // The cache entry was dropped, so the next read sees the new premium row.
    mongo.findOne.mockResolvedValue({ username: 'alice', banned: false, premium: true });
    expect(await users.isUserPremium('alice')).toBe(true);
    expect(mongo.findOne).toHaveBeenCalledTimes(2);
  });

  it('counts an upsert of a brand new row as a granted trial', async () => {
    const users = await load();
    mongo.findOne.mockResolvedValue(null);
    mongo.updateOne.mockResolvedValue({ matchedCount: 0, upsertedCount: 1 });
    expect(await users.startPremiumTesting('newbie', 1)).toMatchObject({ ok: true });
  });

  it('refuses an already premium user without writing, so a paid subscription is never relabelled', async () => {
    const users = await load();
    mongo.findOne.mockResolvedValue({ username: 'pro', banned: false, premium: true, premium_source: 'subs' });
    expect(await users.startPremiumTesting('pro', 24)).toEqual({ ok: false, reason: 'already_premium' });
    expect(mongo.updateOne).not.toHaveBeenCalled();
  });

  it('reports already_used when the guarded update matches nothing', async () => {
    const users = await load();
    mongo.findOne.mockResolvedValue({ username: 'alice', banned: false, premium: false });
    mongo.updateOne.mockResolvedValue({ matchedCount: 0, upsertedCount: 0 });
    expect(await users.startPremiumTesting('alice', 24)).toEqual({ ok: false, reason: 'already_used' });
  });

  it('reports already_used on a duplicate key race and keeps the connection', async () => {
    const users = await load();
    mongo.findOne.mockResolvedValue({ username: 'alice', banned: false, premium: false });
    mongo.updateOne.mockRejectedValueOnce(Object.assign(new Error('E11000'), { code: 11000 }));
    expect(await users.startPremiumTesting('alice', 24)).toEqual({ ok: false, reason: 'already_used' });
    mongo.updateOne.mockResolvedValueOnce({ matchedCount: 0, upsertedCount: 0 });
    await users.startPremiumTesting('alice', 24);
    expect(mongo.connects).toBe(1);
  });

  it('reports unavailable on any other write error and reconnects next time', async () => {
    const users = await load();
    mongo.findOne.mockResolvedValue({ username: 'alice', banned: false, premium: false });
    mongo.updateOne.mockRejectedValueOnce(new Error('not primary'));
    expect(await users.startPremiumTesting('alice', 24)).toEqual({ ok: false, reason: 'unavailable' });
    mongo.updateOne.mockResolvedValueOnce({ matchedCount: 1, upsertedCount: 0 });
    expect(await users.startPremiumTesting('alice', 24)).toMatchObject({ ok: true });
    expect(mongo.connects).toBe(2);
  });

  it('reports unavailable when Mongo is not configured', async () => {
    mongo.config.MONGODB_URI = '';
    const users = await load();
    expect(await users.startPremiumTesting('alice', 24)).toEqual({ ok: false, reason: 'unavailable' });
  });
});
