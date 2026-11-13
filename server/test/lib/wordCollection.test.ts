import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mongo fake: one `word-collections` collection. The connection is module
// state, so every test re-imports the module.
const mongo = vi.hoisted(() => ({
  connects: 0,
  connectFails: false,
  collectionNames: [] as string[],
  createIndex: vi.fn(),
  findOne: vi.fn(),
  find: vi.fn(),
  config: { MONGODB_URI: 'mongodb://test' },
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
        collection: (name: string) => {
          mongo.collectionNames.push(name);
          return { createIndex: mongo.createIndex, findOne: mongo.findOne, find: mongo.find };
        },
      };
    }
  },
}));
vi.mock('../../src/config.js', () => ({ config: mongo.config }));

type WcModule = typeof import('../../src/lib/word-collection.js');
async function load(): Promise<WcModule> {
  vi.resetModules();
  return import('../../src/lib/word-collection.js');
}

beforeEach(() => {
  mongo.connects = 0;
  mongo.connectFails = false;
  mongo.collectionNames.length = 0;
  mongo.config.MONGODB_URI = 'mongodb://test';
  mongo.createIndex.mockReset().mockResolvedValue('id_1');
  mongo.findOne.mockReset();
  mongo.find.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('getWordCollectionCol', () => {
  it('connects once, ensures a unique id index and reuses the collection', async () => {
    const wc = await load();
    const first = await wc.getWordCollectionCol();
    const second = await wc.getWordCollectionCol();

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(mongo.connects).toBe(1);
    expect(mongo.collectionNames).toEqual(['word-collections']);
    expect(mongo.createIndex).toHaveBeenCalledTimes(1);
    expect(mongo.createIndex).toHaveBeenCalledWith({ id: 1 }, { unique: true });
  });

  it('returns null without a Mongo URI and never connects', async () => {
    mongo.config.MONGODB_URI = '';
    const wc = await load();

    expect(await wc.getWordCollectionCol()).toBeNull();
    expect(mongo.connects).toBe(0);
  });

  it('returns null and logs when Mongo refuses the connection, then retries on the next call', async () => {
    mongo.connectFails = true;
    const wc = await load();

    expect(await wc.getWordCollectionCol()).toBeNull();
    expect(console.error).toHaveBeenCalledWith('[WordCollections] Failed to connect to MongoDB:', expect.any(Error));

    mongo.connectFails = false;
    expect(await wc.getWordCollectionCol()).not.toBeNull();
    expect(mongo.connects).toBe(2);
  });

  it('returns null when the index cannot be created', async () => {
    mongo.createIndex.mockRejectedValueOnce(new Error('index build failed'));
    const wc = await load();

    expect(await wc.getWordCollectionCol()).toBeNull();
  });

  // Was a bug, fixed (src/lib/word-collection.ts:21-22): `col` is assigned before
  // createIndex() runs, so when createIndex fails the first call returns null
  // but the half-initialised collection stays cached. Every later call returns
  // it straight away and the unique `id` index is never retried for the life of
  // the process (duplicate collection ids can then be inserted by the seeder).
  it('retries the unique index after a failed index build', async () => {
    mongo.createIndex.mockRejectedValueOnce(new Error('index build failed'));
    const wc = await load();
    await wc.getWordCollectionCol();
    await wc.getWordCollectionCol();

    expect(mongo.createIndex).toHaveBeenCalledTimes(2);
  });
});

describe('findCollection', () => {
  it('looks a collection up by id without the Mongo _id', async () => {
    const doc = { id: 'animals', name: 'Animals', words: ['cat', 'dog'] };
    mongo.findOne.mockResolvedValue(doc);
    const wc = await load();

    expect(await wc.findCollection('animals')).toEqual(doc);
    expect(mongo.findOne).toHaveBeenCalledWith({ id: 'animals' }, { projection: { _id: 0 } });
  });

  it('returns null for an unknown id', async () => {
    mongo.findOne.mockResolvedValue(null);
    const wc = await load();

    expect(await wc.findCollection('nope')).toBeNull();
  });

  it('returns null when Mongo is not configured', async () => {
    mongo.config.MONGODB_URI = '';
    const wc = await load();

    expect(await wc.findCollection('animals')).toBeNull();
    expect(mongo.findOne).not.toHaveBeenCalled();
  });
});

describe('listCollections', () => {
  it('lists every collection with its word count instead of its words', async () => {
    const toArray = vi.fn().mockResolvedValue([
      { id: 'animals', name: 'Animals', words: ['cat', 'dog', 'owl'] },
      { id: 'empty', name: 'Empty', words: [] },
    ]);
    mongo.find.mockReturnValue({ toArray });
    const wc = await load();

    expect(await wc.listCollections()).toEqual([
      { id: 'animals', name: 'Animals', wordCount: 3 },
      { id: 'empty', name: 'Empty', wordCount: 0 },
    ]);
    expect(mongo.find).toHaveBeenCalledWith({}, { projection: { _id: 0, id: 1, name: 1, words: 1 } });
  });

  it('returns an empty list when Mongo is not configured', async () => {
    mongo.config.MONGODB_URI = '';
    const wc = await load();

    expect(await wc.listCollections()).toEqual([]);
  });
});
