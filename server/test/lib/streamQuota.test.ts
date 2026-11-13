import { describe, it, expect, vi } from 'vitest';

// One stream already went live in the last 24 hours, for whoever asks.
const today = [{ owner: 'x', roomName: 'earlier', at: new Date(Date.now() - 60 * 60 * 1000) }];
const collection = {
  createIndex: vi.fn(async () => 'ok'),
  find: vi.fn(() => ({ sort: () => ({ toArray: async () => today }) })),
};

vi.mock('mongodb', () => ({
  MongoClient: class {
    async connect() { return this; }
    db() { return { collection: () => collection }; }
  },
}));

vi.mock('../../src/config.js', () => ({
  config: {
    MONGODB_URI: 'mongodb://test',
    STREAM_LIMIT_EXEMPT: new Set(['badadib']),
  },
}));

const { nextFreeStreamAt } = await import('../../src/lib/streamQuota.js');

describe('nextFreeStreamAt', () => {
  it('holds a free host to one stream a day', async () => {
    const next = await nextFreeStreamAt('someone');
    expect(next).toBeInstanceOf(Date);
    expect(next!.getTime()).toBeGreaterThan(Date.now());
  });

  it('lets an exempt host start another stream without asking the store', async () => {
    collection.find.mockClear();
    expect(await nextFreeStreamAt('badadib')).toBeNull();
    expect(await nextFreeStreamAt('BadAdib')).toBeNull();
    expect(collection.find).not.toHaveBeenCalled();
  });
});
