/**
 * Load word collections into MongoDB from a JSON file.
 *
 * Usage:
 *   npx tsx scripts/load-collections.ts path/to/collections.json
 *
 * JSON format — a single collection or an array of collections:
 *   { "id": "space", "name": "Space & Astronomy", "words": ["nebula", "quasar", ...] }
 *   [ { "id": "space", ... }, { "id": "sports", ... } ]
 *
 * Existing collections are REPLACED (upsert by id).
 * MONGODB_URI is read from the .env file or environment.
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MongoClient } from 'mongodb';
import { config } from '../src/config.js';

interface CollectionInput {
  id: string;
  name: string;
  words: string[];
}

function validate(raw: unknown): CollectionInput[] {
  const items: unknown[] = Array.isArray(raw) ? raw : [raw];

  return items.map((item, i) => {
    const label = `item[${i}]`;
    if (typeof item !== 'object' || item === null) {
      throw new Error(`${label}: must be an object`);
    }
    const obj = item as Record<string, unknown>;

    if (typeof obj['id'] !== 'string' || !obj['id'].trim()) {
      throw new Error(`${label}: "id" must be a non-empty string`);
    }
    if (typeof obj['name'] !== 'string' || !obj['name'].trim()) {
      throw new Error(`${label}: "name" must be a non-empty string`);
    }
    if (!Array.isArray(obj['words']) || obj['words'].length < 2) {
      throw new Error(`${label}: "words" must be an array with at least 2 entries`);
    }
    for (const [wi, w] of obj['words'].entries()) {
      if (typeof w !== 'string' || !w.trim()) {
        throw new Error(`${label}.words[${wi}]: must be a non-empty string`);
      }
    }

    return {
      id: (obj['id'] as string).trim(),
      name: (obj['name'] as string).trim(),
      words: (obj['words'] as string[]).map((w) => w.trim()),
    };
  });
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: npx tsx scripts/load-collections.ts <path-to-json>');
    process.exit(1);
  }

  if (!config.MONGODB_URI) {
    console.error('Error: MONGODB_URI is not set in .env');
    process.exit(1);
  }

  // Parse and validate the JSON file
  let collections: CollectionInput[];
  try {
    const raw = JSON.parse(readFileSync(resolve(filePath), 'utf8')) as unknown;
    collections = validate(raw);
  } catch (err) {
    console.error(`Failed to load "${filePath}":`, (err as Error).message);
    process.exit(1);
  }

  console.log(`Loaded ${collections.length} collection(s) from file.`);

  // Connect and upsert
  const client = new MongoClient(config.MONGODB_URI);
  try {
    await client.connect();
    const col = client.db().collection('word-collections');

    let inserted = 0;
    let updated = 0;

    for (const c of collections) {
      const existing = await col.findOne({ id: c.id });
      await col.updateOne(
        { id: c.id },
        { $set: { id: c.id, name: c.name, words: c.words } },
        { upsert: true },
      );
      if (existing) {
        updated++;
        console.log(`  ↻  Updated  "${c.name}" (${c.id}) — ${c.words.length} words`);
      } else {
        inserted++;
        console.log(`  +  Inserted "${c.name}" (${c.id}) — ${c.words.length} words`);
      }
    }

    console.log(`\nDone: ${inserted} inserted, ${updated} updated.`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
