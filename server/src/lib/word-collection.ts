import { MongoClient, type Db, type Collection } from 'mongodb';
import { config } from '../config.js';

export interface WordCollectionDoc {
  id: string;
  name: string;
  words: string[];
}

let db: Db | null = null;
let col: Collection<WordCollectionDoc> | null = null;

export async function getWordCollectionCol(): Promise<Collection<WordCollectionDoc> | null> {
  if (col) return col;
  if (!config.MONGODB_URI) return null;

  try {
    const client = new MongoClient(config.MONGODB_URI);
    await client.connect();
    db = client.db();
    col = db.collection<WordCollectionDoc>('word-collections');
    await col.createIndex({ id: 1 }, { unique: true });
    return col;
  } catch (err) {
    console.error('[WordCollections] Failed to connect to MongoDB:', err);
    return null;
  }
}

export async function findCollection(id: string): Promise<WordCollectionDoc | null> {
  const c = await getWordCollectionCol();
  if (!c) return null;
  return c.findOne({ id }, { projection: { _id: 0 } });
}

export async function listCollections(): Promise<Array<{ id: string; name: string; wordCount: number }>> {
  const c = await getWordCollectionCol();
  if (!c) return [];
  const docs = await c.find({}, { projection: { _id: 0, id: 1, name: 1, words: 1 } }).toArray();
  return docs.map((d) => ({ id: d.id, name: d.name, wordCount: d.words.length }));
}
