import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  config: { MONGODB_URI: 'mongodb://test', SESSION_SECRET: 'test-session-secret-at-least-32chars!!' },
  connectError: null as Error | null,
  col: {
    createIndex: vi.fn(),
    findOne: vi.fn(),
    updateOne: vi.fn(),
  },
}));

vi.mock('../../src/config.js', () => ({ config: h.config }));
vi.mock('mongodb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('mongodb')>();
  return {
    ...actual,
    MongoClient: class {
      async connect() { if (h.connectError) throw h.connectError; return this; }
      db() { return { collection: () => h.col }; }
    },
  };
});

async function load() {
  vi.resetModules();
  return import('../../src/lib/studioOverlayStore.js');
}

beforeEach(() => {
  h.connectError = null;
  h.config.MONGODB_URI = 'mongodb://test';
  h.col.createIndex.mockReset();
  h.col.findOne.mockReset();
  h.col.updateOne.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('studioOverlayStore', () => {
  it('creates a unique owner index and a TTL on updatedAt', async () => {
    const s = await load();
    h.col.findOne.mockResolvedValue(null);
    expect(await s.getOverlayTemplates('alice')).toEqual([]);
    expect(h.col.createIndex).toHaveBeenCalledWith({ owner: 1 }, { unique: true });
    expect(h.col.createIndex).toHaveBeenCalledWith({ updatedAt: 1 }, { expireAfterSeconds: s.OVERLAY_TTL_SECONDS });
  });

  it('reads and upserts the one document per owner', async () => {
    const s = await load();
    const templates = [{ id: 'a', name: 'A', config: {} }];
    h.col.findOne.mockResolvedValue({ templates });
    expect(await s.getOverlayTemplates('alice')).toEqual(templates);
    expect(h.col.findOne.mock.calls[0][0]).toEqual({ owner: 'alice' });
    await s.saveOverlayTemplates('alice', templates as never);
    const [filter, update, opts] = h.col.updateOne.mock.calls[0];
    expect(filter).toEqual({ owner: 'alice' });
    expect(update.$set).toMatchObject({ owner: 'alice', templates });
    expect(update.$set.updatedAt).toBeInstanceOf(Date);
    expect(opts).toEqual({ upsert: true });
  });

  it('is unavailable without a URI or when the connection fails, and resets after a failed query', async () => {
    h.config.MONGODB_URI = '';
    let s = await load();
    await expect(s.getOverlayTemplates('alice')).rejects.toBeInstanceOf(s.OverlayStoreUnavailableError);
    h.config.MONGODB_URI = 'mongodb://test';
    h.connectError = new Error('down');
    s = await load();
    await expect(s.saveOverlayTemplates('alice', [])).rejects.toBeInstanceOf(s.OverlayStoreUnavailableError);
    h.connectError = null;
    s = await load();
    h.col.findOne.mockRejectedValueOnce(new Error('boom'));
    await expect(s.getOverlayTemplates('alice')).rejects.toBeInstanceOf(s.OverlayStoreUnavailableError);
    h.col.updateOne.mockRejectedValueOnce(new Error('boom'));
    await expect(s.saveOverlayTemplates('alice', [])).rejects.toBeInstanceOf(s.OverlayStoreUnavailableError);
  });
});
