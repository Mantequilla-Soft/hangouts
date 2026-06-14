import { MongoClient, type Db, type Collection, ObjectId } from 'mongodb';
import { config } from '../config.js';

export type EventStatus = 'scheduled' | 'live' | 'ended' | 'cancelled';
export type EventVisibility = 'public' | 'unlisted';

interface EventDoc {
  _id?: ObjectId;
  title: string;
  description?: string;
  hostUsername: string;
  scheduledAt: Date;
  coverImage?: string;
  tags?: string[];
  attendees: string[];
  status: EventStatus;
  roomName?: string;
  visibility: EventVisibility;
  createdAt: Date;
  updatedAt: Date;
}

export interface EventView {
  id: string;
  title: string;
  description?: string;
  hostUsername: string;
  scheduledAt: string;
  coverImage?: string;
  tags?: string[];
  attendees: string[];
  attendeeCount: number;
  status: EventStatus;
  roomName?: string;
  visibility: EventVisibility;
  createdAt: string;
  updatedAt: string;
}

let db: Db | null = null;
let col: Collection<EventDoc> | null = null;

async function getCollection(): Promise<Collection<EventDoc> | null> {
  if (col) return col;
  if (!config.MONGODB_URI) return null;

  try {
    const client = new MongoClient(config.MONGODB_URI);
    await client.connect();
    db = client.db();
    col = db.collection<EventDoc>('hangouts-events');
    await col.createIndex({ scheduledAt: 1, status: 1 });
    console.log('[Events] Connected to MongoDB');
    return col;
  } catch (err) {
    console.error('[Events] Failed to connect to MongoDB:', err);
    return null;
  }
}

function toView(doc: EventDoc & { _id: ObjectId }): EventView {
  return {
    id: doc._id.toHexString(),
    title: doc.title,
    description: doc.description,
    hostUsername: doc.hostUsername,
    scheduledAt: doc.scheduledAt.toISOString(),
    coverImage: doc.coverImage,
    tags: doc.tags,
    attendees: doc.attendees,
    attendeeCount: doc.attendees.length,
    status: doc.status,
    roomName: doc.roomName,
    visibility: doc.visibility,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

function resetConnection(err: unknown, label: string) {
  console.error(`[Events] ${label} failed, resetting connection:`, err);
  col = null;
  db = null;
}

export async function listEvents(opts: {
  status?: EventStatus | EventStatus[];
  host?: string;
  limit?: number;
}): Promise<EventView[]> {
  const collection = await getCollection();
  if (!collection) return [];

  const query: Record<string, unknown> = {};
  if (opts.status) {
    query.status = Array.isArray(opts.status) ? { $in: opts.status } : opts.status;
  } else {
    query.status = { $in: ['scheduled', 'live'] };
  }
  if (opts.host) query.hostUsername = opts.host;

  try {
    const docs = await collection
      .find(query)
      .sort({ scheduledAt: 1 })
      .limit(Math.min(opts.limit ?? 20, 100))
      .toArray();
    return docs.map((d) => toView(d as EventDoc & { _id: ObjectId }));
  } catch (err) {
    resetConnection(err, 'listEvents');
    return [];
  }
}

export async function getEventById(id: string): Promise<EventView | null> {
  const collection = await getCollection();
  if (!collection) return null;

  let oid: ObjectId;
  try { oid = new ObjectId(id); } catch { return null; }

  try {
    const doc = await collection.findOne({ _id: oid });
    if (!doc) return null;
    return toView(doc as EventDoc & { _id: ObjectId });
  } catch (err) {
    resetConnection(err, 'getEventById');
    return null;
  }
}

export interface CreateEventInput {
  title: string;
  description?: string;
  hostUsername: string;
  scheduledAt: Date;
  coverImage?: string;
  tags?: string[];
  visibility?: EventVisibility;
}

export async function createEvent(input: CreateEventInput): Promise<EventView | null> {
  const collection = await getCollection();
  if (!collection) return null;

  const now = new Date();
  const doc: EventDoc = {
    title: input.title,
    description: input.description,
    hostUsername: input.hostUsername,
    scheduledAt: input.scheduledAt,
    coverImage: input.coverImage,
    tags: input.tags,
    attendees: [],
    status: 'scheduled',
    visibility: input.visibility ?? 'public',
    createdAt: now,
    updatedAt: now,
  };

  try {
    const result = await collection.insertOne(doc as EventDoc & { _id: ObjectId });
    return toView({ ...doc, _id: result.insertedId } as EventDoc & { _id: ObjectId });
  } catch (err) {
    resetConnection(err, 'createEvent');
    return null;
  }
}

export interface UpdateEventInput {
  title?: string;
  description?: string;
  scheduledAt?: Date;
  coverImage?: string;
  tags?: string[];
  visibility?: EventVisibility;
}

export async function updateEvent(id: string, input: UpdateEventInput): Promise<EventView | null> {
  const collection = await getCollection();
  if (!collection) return null;

  let oid: ObjectId;
  try { oid = new ObjectId(id); } catch { return null; }

  const $set: Record<string, unknown> = { updatedAt: new Date() };
  if (input.title !== undefined) $set.title = input.title;
  if (input.description !== undefined) $set.description = input.description;
  if (input.scheduledAt !== undefined) $set.scheduledAt = input.scheduledAt;
  if (input.coverImage !== undefined) $set.coverImage = input.coverImage;
  if (input.tags !== undefined) $set.tags = input.tags;
  if (input.visibility !== undefined) $set.visibility = input.visibility;

  try {
    const result = await collection.findOneAndUpdate(
      { _id: oid },
      { $set },
      { returnDocument: 'after' },
    );
    if (!result) return null;
    return toView(result as EventDoc & { _id: ObjectId });
  } catch (err) {
    resetConnection(err, 'updateEvent');
    return null;
  }
}

export async function setEventStatus(
  id: string,
  status: EventStatus,
  roomName?: string,
): Promise<EventView | null> {
  const collection = await getCollection();
  if (!collection) return null;

  let oid: ObjectId;
  try { oid = new ObjectId(id); } catch { return null; }

  const $set: Record<string, unknown> = { status, updatedAt: new Date() };
  if (roomName !== undefined) $set.roomName = roomName;

  try {
    const result = await collection.findOneAndUpdate(
      { _id: oid },
      { $set },
      { returnDocument: 'after' },
    );
    if (!result) return null;
    return toView(result as EventDoc & { _id: ObjectId });
  } catch (err) {
    resetConnection(err, 'setEventStatus');
    return null;
  }
}

export async function toggleAttendance(
  id: string,
  username: string,
  attending: boolean,
): Promise<EventView | null> {
  const collection = await getCollection();
  if (!collection) return null;

  let oid: ObjectId;
  try { oid = new ObjectId(id); } catch { return null; }

  const update = attending
    ? { $addToSet: { attendees: username }, $set: { updatedAt: new Date() } }
    : { $pull: { attendees: username }, $set: { updatedAt: new Date() } };

  try {
    const result = await collection.findOneAndUpdate(
      { _id: oid },
      update,
      { returnDocument: 'after' },
    );
    if (!result) return null;
    return toView(result as EventDoc & { _id: ObjectId });
  } catch (err) {
    resetConnection(err, 'toggleAttendance');
    return null;
  }
}
