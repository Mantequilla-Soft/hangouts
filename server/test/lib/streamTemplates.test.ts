import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectId } from 'mongodb';

// Fake Mongo with two collections (templates + secrets). The module caches the
// collections and its single-flight connect promise, so each test re-imports it.
const h = vi.hoisted(() => {
  const makeCol = () => ({
    createIndex: vi.fn(),
    find: vi.fn(),
    findOne: vi.fn(),
    countDocuments: vi.fn(),
    insertOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    deleteOne: vi.fn(),
    updateOne: vi.fn(),
  });
  return {
    config: {
      MONGODB_URI: 'mongodb://test',
      STREAM_KEY_SECRET: 'test-stream-key-secret',
      SESSION_SECRET: 'test-session-secret-at-least-32chars!!',
    },
    connectError: null as Error | null,
    clients: 0,
    templates: makeCol(),
    secrets: makeCol(),
  };
});

vi.mock('mongodb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('mongodb')>();
  return {
    ...actual,
    MongoClient: class {
      constructor() { h.clients += 1; }
      async connect() {
        // yield so concurrent callers really overlap
        await new Promise((r) => setTimeout(r, 1));
        if (h.connectError) throw h.connectError;
        return this;
      }
      db() {
        return {
          collection: (name: string) => (name === 'stream-templates' ? h.templates : name === 'stream-secrets' ? h.secrets : null),
        };
      }
    },
  };
});

vi.mock('../../src/config.js', () => ({ config: h.config }));

type Mod = typeof import('../../src/lib/streamTemplates.js');
type Secrets = typeof import('../../src/lib/streamSecrets.js');
let store: Mod;
let secretsLib: Secrets;

const ID = '507f1f77bcf86cd799439011';

const FIELDS = {
  name: 'Friday show',
  title: 'Friday show',
  description: '',
  thumbnail: '',
  tags: [],
  language: 'en',
  visibility: 'public' as const,
  boost: { enabled: true, minBoostUsd: 0, creatorPayoutAccount: 'alice' },
  recording: { publishVod: false, allowClips: false },
  announce: {
    enabled: false, community: '', communityTitle: '', declineRewards: false, rewardPowerup: false, beneficiaries: [],
  },
};

const dupKey = () => Object.assign(new Error('E11000 duplicate key'), { code: 11000 });

function stubFind(result: unknown[] | Error) {
  const cursor = {
    sort: vi.fn(() => cursor),
    limit: vi.fn(() => cursor),
    toArray: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
  h.templates.find.mockReturnValue(cursor);
  return cursor;
}

beforeEach(async () => {
  h.config.MONGODB_URI = 'mongodb://test';
  h.connectError = null;
  h.clients = 0;
  for (const col of [h.templates, h.secrets]) {
    for (const fn of Object.values(col)) fn.mockReset();
    col.createIndex.mockResolvedValue('idx');
  }
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.resetModules();
  store = await import('../../src/lib/streamTemplates.js');
  secretsLib = await import('../../src/lib/streamSecrets.js');
});

describe('template storage connection', () => {
  it('throws StoreUnavailableError when Mongo is not configured', async () => {
    h.config.MONGODB_URI = '';
    await expect(store.listTemplates('alice')).rejects.toBeInstanceOf(store.StoreUnavailableError);
    await expect(store.listTemplates('alice')).rejects.toThrow('Template storage unavailable');
    expect(h.clients).toBe(0);
  });

  it('opens a single client for a burst of first requests and creates both unique indexes', async () => {
    h.templates.countDocuments.mockResolvedValue(0);
    await Promise.all([store.countTemplates('a'), store.countTemplates('b'), store.countTemplates('c')]);
    expect(h.clients).toBe(1);
    expect(h.templates.createIndex).toHaveBeenCalledWith({ owner: 1, slug: 1 }, { unique: true });
    expect(h.secrets.createIndex).toHaveBeenCalledWith({ owner: 1 }, { unique: true });
    await store.countTemplates('d');
    expect(h.clients).toBe(1);
  });

  it('throws StoreUnavailableError when the connection fails, and retries on the next call', async () => {
    h.connectError = new Error('ECONNREFUSED');
    await expect(store.countTemplates('alice')).rejects.toBeInstanceOf(store.StoreUnavailableError);
    expect(console.error).toHaveBeenCalledWith('[StreamTemplates] Failed to connect to MongoDB:', h.connectError);

    h.connectError = null;
    h.templates.countDocuments.mockResolvedValue(3);
    expect(await store.countTemplates('alice')).toBe(3);
    expect(h.clients).toBe(2);
  });

  it('a failing createIndex leaves the store unavailable', async () => {
    h.secrets.createIndex.mockRejectedValue(new Error('index build failed'));
    await expect(store.countTemplates('alice')).rejects.toBeInstanceOf(store.StoreUnavailableError);
  });

  it('a query error resets the connection and surfaces as StoreUnavailableError', async () => {
    h.templates.countDocuments.mockRejectedValueOnce(new Error('socket closed'));
    await expect(store.countTemplates('alice')).rejects.toBeInstanceOf(store.StoreUnavailableError);
    expect(console.error).toHaveBeenCalledWith(
      '[StreamTemplates] countTemplates failed, resetting connection:',
      expect.any(Error),
    );
    h.templates.countDocuments.mockResolvedValue(1);
    await store.countTemplates('alice');
    expect(h.clients).toBe(2);
  });
});

describe('listTemplates', () => {
  it('lists the owner templates oldest first, at most 100', async () => {
    const cursor = stubFind([{ slug: 'a' }]);
    expect(await store.listTemplates('alice')).toEqual([{ slug: 'a' }]);
    expect(h.templates.find).toHaveBeenCalledWith({ owner: 'alice' });
    expect(cursor.sort).toHaveBeenCalledWith({ createdAt: 1 });
    expect(cursor.limit).toHaveBeenCalledWith(100);
  });

  it('turns a query failure into StoreUnavailableError', async () => {
    stubFind(new Error('boom'));
    await expect(store.listTemplates('alice')).rejects.toBeInstanceOf(store.StoreUnavailableError);
  });
});

describe('countTemplates', () => {
  it('counts the owner templates', async () => {
    h.templates.countDocuments.mockResolvedValue(7);
    expect(await store.countTemplates('alice')).toBe(7);
    expect(h.templates.countDocuments).toHaveBeenCalledWith({ owner: 'alice' });
  });
});

describe('getTemplate and getTemplateById', () => {
  it('return null for ids that are not 24 hex characters, without connecting', async () => {
    h.config.MONGODB_URI = '';
    // a 12 character string is a valid ObjectId to the driver; the regex must refuse it
    for (const bad of ['', 'abc', 'abcdefghijkl', 'zz7f1f77bcf86cd799439011', `${ID}0`]) {
      expect(await store.getTemplate('alice', bad)).toBeNull();
      expect(await store.getTemplateById(bad)).toBeNull();
    }
    expect(h.clients).toBe(0);
  });

  it('getTemplate looks the id up scoped to the owner', async () => {
    h.templates.findOne.mockResolvedValue({ slug: 'friday' });
    expect(await store.getTemplate('alice', ID)).toEqual({ slug: 'friday' });
    const filter = h.templates.findOne.mock.calls[0][0];
    expect(filter.owner).toBe('alice');
    expect(filter._id.toHexString()).toBe(ID);
  });

  it('getTemplateById looks the id up without an owner', async () => {
    h.templates.findOne.mockResolvedValue(null);
    expect(await store.getTemplateById(ID.toUpperCase())).toBeNull();
    const filter = h.templates.findOne.mock.calls[0][0];
    expect(Object.keys(filter)).toEqual(['_id']);
    expect(filter._id.toHexString()).toBe(ID);
  });

  it('both turn a query failure into StoreUnavailableError', async () => {
    h.templates.findOne.mockRejectedValue(new Error('boom'));
    await expect(store.getTemplate('alice', ID)).rejects.toBeInstanceOf(store.StoreUnavailableError);
    await expect(store.getTemplateById(ID)).rejects.toBeInstanceOf(store.StoreUnavailableError);
  });
});

describe('findTemplateBySlug', () => {
  it('finds by owner and slug', async () => {
    h.templates.findOne.mockResolvedValue({ slug: 'friday-show' });
    expect(await store.findTemplateBySlug('alice', 'friday-show')).toEqual({ slug: 'friday-show' });
    expect(h.templates.findOne).toHaveBeenCalledWith({ owner: 'alice', slug: 'friday-show' });
  });

  it('turns a query failure into StoreUnavailableError', async () => {
    h.templates.findOne.mockRejectedValue(new Error('boom'));
    await expect(store.findTemplateBySlug('alice', 'x')).rejects.toBeInstanceOf(store.StoreUnavailableError);
  });
});

describe('insertTemplate', () => {
  it('stores the fields with owner, slug, timestamps and no lastLiveAt, and returns the doc', async () => {
    h.templates.insertOne.mockResolvedValue({ acknowledged: true });
    const doc = await store.insertTemplate('alice', FIELDS, 'friday-show');
    expect(doc).not.toBe('name_taken');
    const saved = h.templates.insertOne.mock.calls[0][0];
    expect(saved).toBe(doc);
    expect(saved).toMatchObject({ ...FIELDS, owner: 'alice', slug: 'friday-show', lastLiveAt: null });
    expect(saved._id).toBeInstanceOf(ObjectId);
    expect(saved.createdAt).toBeInstanceOf(Date);
    expect(saved.updatedAt).toBe(saved.createdAt);
  });

  it('answers name_taken when the unique owner+slug index rejects the insert', async () => {
    h.templates.insertOne.mockRejectedValue(dupKey());
    expect(await store.insertTemplate('alice', FIELDS, 'friday-show')).toBe('name_taken');
    expect(console.error).not.toHaveBeenCalled();
  });

  it('turns any other insert failure into StoreUnavailableError', async () => {
    h.templates.insertOne.mockRejectedValue(new Error('write concern'));
    await expect(store.insertTemplate('alice', FIELDS, 'x')).rejects.toBeInstanceOf(store.StoreUnavailableError);
  });
});

describe('updateTemplate', () => {
  it('returns null for a malformed id without connecting', async () => {
    expect(await store.updateTemplate('alice', 'nope', FIELDS, 's')).toBeNull();
    expect(h.clients).toBe(0);
  });

  it('sets the fields, slug and updatedAt for the owner template and returns the new doc', async () => {
    h.templates.findOneAndUpdate.mockResolvedValue({ slug: 'new-slug' });
    expect(await store.updateTemplate('alice', ID, FIELDS, 'new-slug')).toEqual({ slug: 'new-slug' });
    const [filter, update, options] = h.templates.findOneAndUpdate.mock.calls[0];
    expect(filter.owner).toBe('alice');
    expect(filter._id.toHexString()).toBe(ID);
    expect(update.$set).toMatchObject({ ...FIELDS, slug: 'new-slug' });
    expect(update.$set.updatedAt).toBeInstanceOf(Date);
    expect(options).toEqual({ returnDocument: 'after' });
  });

  it('returns null when the owner has no such template', async () => {
    h.templates.findOneAndUpdate.mockResolvedValue(null);
    expect(await store.updateTemplate('mallory', ID, FIELDS, 's')).toBeNull();
  });

  it('answers name_taken when the new slug collides with another template', async () => {
    h.templates.findOneAndUpdate.mockRejectedValue(dupKey());
    expect(await store.updateTemplate('alice', ID, FIELDS, 'taken')).toBe('name_taken');
  });

  it('turns any other failure into StoreUnavailableError', async () => {
    h.templates.findOneAndUpdate.mockRejectedValue(new Error('boom'));
    await expect(store.updateTemplate('alice', ID, FIELDS, 's')).rejects.toBeInstanceOf(store.StoreUnavailableError);
  });
});

describe('deleteTemplate', () => {
  it('returns false for a malformed id without connecting', async () => {
    expect(await store.deleteTemplate('alice', 'nope')).toBe(false);
    expect(h.clients).toBe(0);
  });

  it('returns true only when exactly one owner template was deleted', async () => {
    h.templates.deleteOne.mockResolvedValueOnce({ deletedCount: 1 });
    expect(await store.deleteTemplate('alice', ID)).toBe(true);
    h.templates.deleteOne.mockResolvedValueOnce({ deletedCount: 0 });
    expect(await store.deleteTemplate('mallory', ID)).toBe(false);
    expect(h.templates.deleteOne.mock.calls[1][0].owner).toBe('mallory');
  });

  it('turns a failure into StoreUnavailableError', async () => {
    h.templates.deleteOne.mockRejectedValue(new Error('boom'));
    await expect(store.deleteTemplate('alice', ID)).rejects.toBeInstanceOf(store.StoreUnavailableError);
  });
});

describe('setTemplateLastLiveAt', () => {
  it('stamps lastLiveAt on the template', async () => {
    const at = new Date('2026-11-13T10:00:00Z');
    h.templates.updateOne.mockResolvedValue({ modifiedCount: 1 });
    await store.setTemplateLastLiveAt(ID, at);
    const [filter, update] = h.templates.updateOne.mock.calls[0];
    expect(filter._id.toHexString()).toBe(ID);
    expect(update).toEqual({ $set: { lastLiveAt: at } });
  });

  it('does nothing for a malformed id', async () => {
    await store.setTemplateLastLiveAt('nope', new Date());
    expect(h.clients).toBe(0);
    expect(h.templates.updateOne).not.toHaveBeenCalled();
  });

  it('is best effort: a failed write or an unavailable store is only logged', async () => {
    h.templates.updateOne.mockRejectedValue(new Error('boom'));
    await expect(store.setTemplateLastLiveAt(ID, new Date())).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith('[StreamTemplates] setTemplateLastLiveAt failed:', expect.any(Error));

    vi.resetModules();
    h.config.MONGODB_URI = '';
    const fresh = await import('../../src/lib/streamTemplates.js');
    await expect(fresh.setTemplateLastLiveAt(ID, new Date())).resolves.toBeUndefined();
  });
});

describe('getOrCreateStreamSecret', () => {
  it('returns the decrypted secret when the owner already has one', async () => {
    const enc = secretsLib.encryptStreamSecret('ss_existing');
    h.secrets.findOne.mockResolvedValue({ owner: 'alice', hash: 'h', enc });
    expect(await store.getOrCreateStreamSecret('alice')).toBe('ss_existing');
    expect(h.secrets.updateOne).not.toHaveBeenCalled();
  });

  it('creates one with $setOnInsert on first use and reads back whatever won', async () => {
    h.secrets.findOne.mockResolvedValueOnce(null);
    let stored: { hash: string; enc: string } | null = null;
    h.secrets.updateOne.mockImplementation(async (_f: unknown, update: { $setOnInsert: { hash: string; enc: string } }) => {
      stored = update.$setOnInsert;
      return { upsertedCount: 1 };
    });
    h.secrets.findOne.mockImplementationOnce(async () => ({ owner: 'alice', ...stored! }));

    const secret = await store.getOrCreateStreamSecret('alice');

    expect(secret).toMatch(/^ss_[A-Za-z0-9_-]{43}$/);
    const [filter, update, options] = h.secrets.updateOne.mock.calls[0];
    expect(filter).toEqual({ owner: 'alice' });
    expect(options).toEqual({ upsert: true });
    expect(update.$set).toBeUndefined();
    expect(update.$setOnInsert.owner).toBe('alice');
    expect(update.$setOnInsert.hash).toBe(secretsLib.hashStreamSecret(secret));
    expect(update.$setOnInsert.createdAt).toBe(update.$setOnInsert.rotatedAt);
  });

  it('when a racing first request wins the upsert, returns the winner secret instead of failing', async () => {
    const winnerEnc = secretsLib.encryptStreamSecret('ss_winner');
    h.secrets.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ owner: 'alice', hash: 'h', enc: winnerEnc });
    h.secrets.updateOne.mockRejectedValue(dupKey());
    expect(await store.getOrCreateStreamSecret('alice')).toBe('ss_winner');
  });

  it('turns a non duplicate upsert failure into StoreUnavailableError', async () => {
    h.secrets.findOne.mockResolvedValue(null);
    h.secrets.updateOne.mockRejectedValue(new Error('boom'));
    await expect(store.getOrCreateStreamSecret('alice')).rejects.toBeInstanceOf(store.StoreUnavailableError);
    expect(console.error).toHaveBeenCalledWith(
      '[StreamTemplates] getOrCreateStreamSecret failed, resetting connection:',
      expect.any(Error),
    );
  });

  it('throws StoreUnavailableError when the secret is still missing after the upsert', async () => {
    h.secrets.findOne.mockResolvedValue(null);
    h.secrets.updateOne.mockResolvedValue({ upsertedCount: 0 });
    await expect(store.getOrCreateStreamSecret('alice')).rejects.toBeInstanceOf(store.StoreUnavailableError);
  });

  it('a secret that no longer decrypts throws a plain error and keeps the connection', async () => {
    h.secrets.findOne.mockResolvedValue({ owner: 'alice', hash: 'h', enc: 'v0.garbage' });
    const err = await store.getOrCreateStreamSecret('alice').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(store.StoreUnavailableError);
    expect(err.message).toBe('Unsupported stream secret format');
    h.secrets.findOne.mockResolvedValue({ owner: 'alice', hash: 'h', enc: secretsLib.encryptStreamSecret('ss_ok') });
    await store.getOrCreateStreamSecret('alice');
    expect(h.clients).toBe(1);
  });
});

describe('resetStreamSecret', () => {
  it('stores a fresh secret as hash plus encrypted copy and returns the plaintext', async () => {
    h.secrets.updateOne.mockResolvedValue({ modifiedCount: 1 });
    const secret = await store.resetStreamSecret('alice');
    expect(secret).toMatch(/^ss_/);
    const [filter, update, options] = h.secrets.updateOne.mock.calls[0];
    expect(filter).toEqual({ owner: 'alice' });
    expect(options).toEqual({ upsert: true });
    expect(update.$set.hash).toBe(secretsLib.hashStreamSecret(secret));
    expect(secretsLib.decryptStreamSecret(update.$set.enc)).toBe(secret);
    expect(update.$set.rotatedAt).toBeInstanceOf(Date);
    expect(update.$setOnInsert).toMatchObject({ owner: 'alice' });
    expect(JSON.stringify(update)).not.toContain(secret);
  });

  it('gives a different secret every time', async () => {
    h.secrets.updateOne.mockResolvedValue({});
    expect(await store.resetStreamSecret('alice')).not.toBe(await store.resetStreamSecret('alice'));
  });

  it('turns a failure into StoreUnavailableError', async () => {
    h.secrets.updateOne.mockRejectedValue(new Error('boom'));
    await expect(store.resetStreamSecret('alice')).rejects.toBeInstanceOf(store.StoreUnavailableError);
  });
});

describe('checkStreamSecret', () => {
  it('accepts the right secret and refuses a wrong one', async () => {
    h.secrets.findOne.mockResolvedValue({ owner: 'alice', hash: secretsLib.hashStreamSecret('ss_right'), enc: 'x' });
    expect(await store.checkStreamSecret('alice', 'ss_right')).toBe(true);
    expect(await store.checkStreamSecret('alice', 'ss_wrong')).toBe(false);
    expect(h.secrets.findOne).toHaveBeenCalledWith({ owner: 'alice' });
  });

  it('refuses everything when the owner has no secret, even a secret hashing to the placeholder', async () => {
    h.secrets.findOne.mockResolvedValue(null);
    expect(await store.checkStreamSecret('alice', 'anything')).toBe(false);
    expect(await store.checkStreamSecret('alice', '')).toBe(false);
  });

  it('turns a lookup failure into StoreUnavailableError', async () => {
    h.secrets.findOne.mockRejectedValue(new Error('boom'));
    await expect(store.checkStreamSecret('alice', 'x')).rejects.toBeInstanceOf(store.StoreUnavailableError);
  });
});
