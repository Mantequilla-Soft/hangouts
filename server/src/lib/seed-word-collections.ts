import { getWordCollectionCol } from './word-collection.js';

const BUILT_IN = [
  {
    id: 'animals',
    name: 'Animals',
    words: [
      'elephant', 'rhinoceros', 'crocodile', 'giraffe', 'hippopotamus',
      'cheetah', 'penguin', 'flamingo', 'octopus', 'platypus',
      'kangaroo', 'orangutan', 'chameleon', 'wolverine', 'armadillo',
    ],
  },
  {
    id: 'food',
    name: 'Food',
    words: [
      'pizza', 'sushi', 'taco', 'croissant', 'ramen',
      'avocado', 'pineapple', 'lasagna', 'hummus', 'paella',
      'dumpling', 'kimchi', 'tiramisu', 'guacamole', 'bruschetta',
    ],
  },
  {
    id: 'movies',
    name: 'Movies',
    words: [
      'inception', 'titanic', 'avatar', 'gladiator', 'interstellar',
      'parasite', 'joker', 'oppenheimer', 'dune', 'matrix',
      'jaws', 'shrek', 'casablanca', 'godfather', 'beetlejuice',
    ],
  },
];

export async function seedWordCollections(): Promise<void> {
  const col = await getWordCollectionCol();
  if (!col) {
    console.warn('[WordCollections] MongoDB not configured — skipping seed');
    return;
  }

  try {
    await col.insertMany(BUILT_IN, { ordered: false });
    console.log('[WordCollections] Seeded built-in collections');
  } catch (err: unknown) {
    // Code 11000 = duplicate key — collections already exist, that's fine
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: number }).code === 11000) {
      return;
    }
    console.error('[WordCollections] Seed error:', err);
  }
}
