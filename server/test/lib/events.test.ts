import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectId } from 'mongodb';

// A fake Mongo: one shared collection object whose methods each test programs.
// The module under test caches the collection, so every test re-imports it
// (vi.resetModules) to start from a cold, unconnected state.
const h = vi.hoisted(() => ({
  config: { MONGODB_URI: 'mongodb://test' },
  connectError: null as Error | null,
  clients: [] as string[],
  collectionNames: [] as string[],
  col: {
    createIndex: vi.fn(),
    find: vi.fn(),
    findOne: vi.fn(),
    insertOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
  },
}));

vi.mock('mongodb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('mongodb')>();
  return {
    ...actual,
    MongoClient: class {
      constructor(uri: string) { h.clients.push(uri); }
      async connect() {
        if (h.connectError) throw h.connectError;
        return this;
      }
      db() {
        return {
          collection: (name: string) => {
            h.collectionNames.push(name);
            return h.col;
          },
        };
      }
    },
  };
});

vi.mock('../../src/config.js', () => ({ config: h.config }));

type EventsModule = typeof import('../../src/lib/events.js');
let events: EventsModule;

const ID = '507f1f77bcf86cd799439011';
const SCHEDULED_AT = new Date('2030-01-02T03:04:05.000Z');
const CREATED_AT = new Date('2026-01-01T00:00:00.000Z');

function makeDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: new ObjectId(ID),
    title: 'Morning hangout',
    description: 'coffee',
    hostUsername: 'alice',
    scheduledAt: SCHEDULED_AT,
    coverImage: 'https://img.test/c.png',
    tags: ['music'],
    attendees: ['bob', 'carol'],
    status: 'scheduled',
    roomName: undefined,
    visibility: 'public',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

/** Chainable find().sort().limit().toArray() that records its arguments. */
function stubFind(result: unknown[] | Error) {
  const cursor = {
    sort: vi.fn(() => cursor),
    limit: vi.fn(() => cursor),
    toArray: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
  h.col.find.mockReturnValue(cursor);
  return cursor;
}

beforeEach(async () => {
  h.config.MONGODB_URI = 'mongodb://test';
  h.connectError = null;
  h.clients.length = 0;
  h.collectionNames.length = 0;
  h.col.createIndex.mockReset().mockResolvedValue('idx');
  h.col.find.mockReset();
  h.col.findOne.mockReset();
  h.col.insertOne.mockReset();
  h.col.findOneAndUpdate.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.resetModules();
  events = await import('../../src/lib/events.js');
});

describe('events storage without Mongo configured', () => {
  it('answers empty or null from every call and never opens a client', async () => {
    h.config.MONGODB_URI = '';
    expect(await events.listEvents({})).toEqual([]);
    expect(await events.getEventById(ID)).toBeNull();
    expect(await events.createEvent({ title: 't', hostUsername: 'alice', scheduledAt: SCHEDULED_AT })).toBeNull();
    expect(await events.updateEvent(ID, { title: 'x' })).toBeNull();
    expect(await events.setEventStatus(ID, 'live')).toBeNull();
    expect(await events.toggleAttendance(ID, 'bob', true)).toBeNull();
    expect(h.clients).toHaveLength(0);
  });
});

describe('events storage connection', () => {
  it('connects once, uses the hangouts-events collection and indexes scheduledAt + status', async () => {
    stubFind([]);
    await events.listEvents({});
    await events.listEvents({});
    expect(h.clients).toEqual(['mongodb://test']);
    expect(h.collectionNames).toEqual(['hangouts-events']);
    expect(h.col.createIndex).toHaveBeenCalledWith({ scheduledAt: 1, status: 1 });
  });

  it('returns an empty list when the connection fails, and tries again on the next call', async () => {
    h.connectError = new Error('ECONNREFUSED');
    expect(await events.listEvents({})).toEqual([]);
    expect(console.error).toHaveBeenCalledWith('[Events] Failed to connect to MongoDB:', h.connectError);

    h.connectError = null;
    stubFind([makeDoc()]);
    expect(await events.listEvents({})).toHaveLength(1);
    expect(h.clients).toHaveLength(2);
  });

  it('treats a failing createIndex as a failed connection', async () => {
    h.col.createIndex.mockRejectedValue(new Error('not primary'));
    expect(await events.getEventById(ID)).toBeNull();
    expect(h.col.findOne).not.toHaveBeenCalled();
  });
});

describe('listEvents', () => {
  it('by default asks for future scheduled events or live ones', async () => {
    const cursor = stubFind([]);
    const before = Date.now();
    await events.listEvents({});
    const query = h.col.find.mock.calls[0][0];
    expect(query.status).toBeUndefined();
    expect(query.$or).toHaveLength(2);
    expect(query.$or[0].status).toBe('scheduled');
    expect(query.$or[0].scheduledAt.$gte.getTime()).toBeGreaterThanOrEqual(before);
    expect(query.$or[1]).toEqual({ status: 'live' });
    expect(cursor.sort).toHaveBeenCalledWith({ scheduledAt: 1 });
    expect(cursor.limit).toHaveBeenCalledWith(20);
  });

  it('asking for scheduled only filters to future scheduled events without an $or', async () => {
    stubFind([]);
    await events.listEvents({ status: 'scheduled' });
    const query = h.col.find.mock.calls[0][0];
    expect(query.status).toBe('scheduled');
    expect(query.scheduledAt.$gte).toBeInstanceOf(Date);
    expect(query.$or).toBeUndefined();
  });

  it('scheduled plus two other statuses puts the others in an $in branch', async () => {
    stubFind([]);
    await events.listEvents({ status: ['scheduled', 'live', 'ended'] });
    const query = h.col.find.mock.calls[0][0];
    expect(query.$or[1]).toEqual({ status: { $in: ['live', 'ended'] } });
  });

  it('a single non-scheduled status is matched exactly with no date restriction', async () => {
    stubFind([]);
    await events.listEvents({ status: 'ended' });
    expect(h.col.find.mock.calls[0][0]).toEqual({ status: 'ended' });
  });

  it('several non-scheduled statuses are matched with $in', async () => {
    stubFind([]);
    await events.listEvents({ status: ['ended', 'cancelled'] });
    expect(h.col.find.mock.calls[0][0]).toEqual({ status: { $in: ['ended', 'cancelled'] } });
  });

  it('filters by host when one is given', async () => {
    stubFind([]);
    await events.listEvents({ status: 'live', host: 'alice' });
    expect(h.col.find.mock.calls[0][0]).toEqual({ status: 'live', hostUsername: 'alice' });
  });

  it('honours a small limit and caps a large one at 100', async () => {
    const cursor = stubFind([]);
    await events.listEvents({ limit: 5 });
    await events.listEvents({ limit: 5000 });
    expect(cursor.limit.mock.calls).toEqual([[5], [100]]);
  });

  it('turns stored documents into views with string ids, ISO dates and an attendee count', async () => {
    stubFind([makeDoc({ status: 'live', roomName: 'alice-room-abc123' })]);
    const [view] = await events.listEvents({});
    expect(view).toEqual({
      id: ID,
      title: 'Morning hangout',
      description: 'coffee',
      hostUsername: 'alice',
      scheduledAt: '2030-01-02T03:04:05.000Z',
      coverImage: 'https://img.test/c.png',
      tags: ['music'],
      attendees: ['bob', 'carol'],
      attendeeCount: 2,
      status: 'live',
      roomName: 'alice-room-abc123',
      visibility: 'public',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('returns an empty list when the query fails and reconnects on the next call', async () => {
    stubFind(new Error('socket closed'));
    expect(await events.listEvents({})).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(
      '[Events] listEvents failed, resetting connection:',
      expect.any(Error),
    );
    stubFind([]);
    await events.listEvents({});
    expect(h.clients).toHaveLength(2);
  });
});

describe('getEventById', () => {
  it('returns null for an id that is not an ObjectId, without querying', async () => {
    expect(await events.getEventById('not-an-object-id')).toBeNull();
    expect(h.col.findOne).not.toHaveBeenCalled();
  });

  it('returns null when no event has that id', async () => {
    h.col.findOne.mockResolvedValue(null);
    expect(await events.getEventById(ID)).toBeNull();
    expect(h.col.findOne.mock.calls[0][0]._id.toHexString()).toBe(ID);
  });

  it('returns the event view when found', async () => {
    h.col.findOne.mockResolvedValue(makeDoc());
    const view = await events.getEventById(ID);
    expect(view?.id).toBe(ID);
    expect(view?.attendeeCount).toBe(2);
  });

  it('returns null and resets the connection when findOne throws', async () => {
    h.col.findOne.mockRejectedValue(new Error('boom'));
    expect(await events.getEventById(ID)).toBeNull();
    h.col.findOne.mockResolvedValue(null);
    await events.getEventById(ID);
    expect(h.clients).toHaveLength(2);
  });
});

describe('createEvent', () => {
  it('stores a scheduled public event with no attendees and returns it with the new id', async () => {
    const newId = new ObjectId();
    h.col.insertOne.mockResolvedValue({ insertedId: newId });
    const view = await events.createEvent({
      title: 'Launch party',
      hostUsername: 'alice',
      scheduledAt: SCHEDULED_AT,
      tags: ['party'],
    });
    const doc = h.col.insertOne.mock.calls[0][0];
    expect(doc).toMatchObject({
      title: 'Launch party',
      hostUsername: 'alice',
      scheduledAt: SCHEDULED_AT,
      tags: ['party'],
      attendees: [],
      status: 'scheduled',
      visibility: 'public',
    });
    expect(doc.createdAt).toBe(doc.updatedAt);
    expect(view).toMatchObject({ id: newId.toHexString(), attendeeCount: 0, status: 'scheduled', visibility: 'public' });
  });

  it('keeps an explicit unlisted visibility', async () => {
    h.col.insertOne.mockResolvedValue({ insertedId: new ObjectId() });
    const view = await events.createEvent({
      title: 'Secret', hostUsername: 'alice', scheduledAt: SCHEDULED_AT, visibility: 'unlisted',
    });
    expect(view?.visibility).toBe('unlisted');
  });

  it('returns null when the insert fails', async () => {
    h.col.insertOne.mockRejectedValue(new Error('write concern'));
    expect(await events.createEvent({ title: 't', hostUsername: 'alice', scheduledAt: SCHEDULED_AT })).toBeNull();
    expect(console.error).toHaveBeenCalledWith('[Events] createEvent failed, resetting connection:', expect.any(Error));
  });
});

describe('updateEvent', () => {
  it('sets only the fields that were given, plus updatedAt, and returns the updated view', async () => {
    h.col.findOneAndUpdate.mockResolvedValue(makeDoc({ title: 'New title' }));
    const view = await events.updateEvent(ID, { title: 'New title', tags: [] });
    const [filter, update, options] = h.col.findOneAndUpdate.mock.calls[0];
    expect(filter._id.toHexString()).toBe(ID);
    expect(Object.keys(update.$set).sort()).toEqual(['tags', 'title', 'updatedAt']);
    expect(update.$set.tags).toEqual([]);
    expect(options).toEqual({ returnDocument: 'after' });
    expect(view?.title).toBe('New title');
  });

  it('can set every editable field at once', async () => {
    h.col.findOneAndUpdate.mockResolvedValue(makeDoc());
    const when = new Date('2031-01-01T00:00:00Z');
    await events.updateEvent(ID, {
      title: 'a', description: 'b', scheduledAt: when, coverImage: 'c', tags: ['d'], visibility: 'unlisted',
    });
    expect(h.col.findOneAndUpdate.mock.calls[0][1].$set).toMatchObject({
      title: 'a', description: 'b', scheduledAt: when, coverImage: 'c', tags: ['d'], visibility: 'unlisted',
    });
  });

  it('returns null for a malformed id without querying', async () => {
    expect(await events.updateEvent('xyz', { title: 'a' })).toBeNull();
    expect(h.col.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('returns null when the event does not exist', async () => {
    h.col.findOneAndUpdate.mockResolvedValue(null);
    expect(await events.updateEvent(ID, { title: 'a' })).toBeNull();
  });

  it('returns null when the update throws', async () => {
    h.col.findOneAndUpdate.mockRejectedValue(new Error('boom'));
    expect(await events.updateEvent(ID, { title: 'a' })).toBeNull();
    expect(console.error).toHaveBeenCalledWith('[Events] updateEvent failed, resetting connection:', expect.any(Error));
  });
});

describe('setEventStatus', () => {
  it('stores the status and the room name when one is given', async () => {
    h.col.findOneAndUpdate.mockResolvedValue(makeDoc({ status: 'live', roomName: 'alice-room-abc123' }));
    const view = await events.setEventStatus(ID, 'live', 'alice-room-abc123');
    expect(h.col.findOneAndUpdate.mock.calls[0][1].$set).toMatchObject({ status: 'live', roomName: 'alice-room-abc123' });
    expect(view?.roomName).toBe('alice-room-abc123');
  });

  it('leaves the room name alone when none is given', async () => {
    h.col.findOneAndUpdate.mockResolvedValue(makeDoc({ status: 'ended' }));
    await events.setEventStatus(ID, 'ended');
    expect(h.col.findOneAndUpdate.mock.calls[0][1].$set).not.toHaveProperty('roomName');
  });

  it('returns null for a malformed id, a missing event, or a failing update', async () => {
    expect(await events.setEventStatus('nope', 'ended')).toBeNull();
    h.col.findOneAndUpdate.mockResolvedValueOnce(null);
    expect(await events.setEventStatus(ID, 'ended')).toBeNull();
    h.col.findOneAndUpdate.mockRejectedValueOnce(new Error('boom'));
    expect(await events.setEventStatus(ID, 'ended')).toBeNull();
    expect(console.error).toHaveBeenCalledWith('[Events] setEventStatus failed, resetting connection:', expect.any(Error));
  });
});

describe('toggleAttendance', () => {
  it('adds the user to the attendees with $addToSet when attending', async () => {
    h.col.findOneAndUpdate.mockResolvedValue(makeDoc({ attendees: ['bob'] }));
    const view = await events.toggleAttendance(ID, 'bob', true);
    const update = h.col.findOneAndUpdate.mock.calls[0][1];
    expect(update.$addToSet).toEqual({ attendees: 'bob' });
    expect(update.$pull).toBeUndefined();
    expect(update.$set.updatedAt).toBeInstanceOf(Date);
    expect(view?.attendeeCount).toBe(1);
  });

  it('removes the user with $pull when no longer attending', async () => {
    h.col.findOneAndUpdate.mockResolvedValue(makeDoc({ attendees: [] }));
    const view = await events.toggleAttendance(ID, 'bob', false);
    const update = h.col.findOneAndUpdate.mock.calls[0][1];
    expect(update.$pull).toEqual({ attendees: 'bob' });
    expect(update.$addToSet).toBeUndefined();
    expect(view?.attendeeCount).toBe(0);
  });

  it('returns null for a malformed id, a missing event, or a failing update', async () => {
    expect(await events.toggleAttendance('nope', 'bob', true)).toBeNull();
    h.col.findOneAndUpdate.mockResolvedValueOnce(null);
    expect(await events.toggleAttendance(ID, 'bob', true)).toBeNull();
    h.col.findOneAndUpdate.mockRejectedValueOnce(new Error('boom'));
    expect(await events.toggleAttendance(ID, 'bob', true)).toBeNull();
    expect(console.error).toHaveBeenCalledWith('[Events] toggleAttendance failed, resetting connection:', expect.any(Error));
  });
});
