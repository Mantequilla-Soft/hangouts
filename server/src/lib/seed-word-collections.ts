import { getWordCollectionCol } from './word-collection.js';

const BUILT_IN = [
  {
    id: 'animals',
    name: 'Animals',
    words: [
      'elephant', 'rhinoceros', 'crocodile', 'giraffe', 'hippopotamus',
      'cheetah', 'penguin', 'flamingo', 'octopus', 'platypus',
      'kangaroo', 'orangutan', 'chameleon', 'wolverine', 'armadillo',
      'capybara', 'narwhal', 'axolotl', 'pangolin', 'tapir',
    ],
  },
  {
    id: 'food',
    name: 'Food',
    words: [
      'pizza', 'sushi', 'taco', 'croissant', 'ramen',
      'avocado', 'pineapple', 'lasagna', 'hummus', 'paella',
      'dumpling', 'kimchi', 'tiramisu', 'guacamole', 'bruschetta',
      'shakshuka', 'poutine', 'bibimbap', 'baklava', 'ceviche',
    ],
  },
  {
    id: 'movies',
    name: 'Movies',
    words: [
      'inception', 'titanic', 'avatar', 'gladiator', 'interstellar',
      'parasite', 'joker', 'oppenheimer', 'dune', 'matrix',
      'jaws', 'shrek', 'casablanca', 'godfather', 'beetlejuice',
      'psycho', 'vertigo', 'chinatown', 'scarface', 'goodfellas',
    ],
  },
  {
    id: 'famous-people',
    name: 'Famous People',
    words: [
      'einstein', 'shakespeare', 'mozart', 'newton', 'darwin',
      'napoleon', 'cleopatra', 'gandhi', 'picasso', 'beethoven',
      'lincoln', 'tesla', 'michelangelo', 'rembrandt', 'mandela',
      'churchill', 'columbus', 'galileo', 'tutankhamun', 'confucius',
      'voltaire', 'jefferson', 'washington', 'freud', 'curie',
    ],
  },
  {
    id: 'historical-figures',
    name: 'Historical Figures',
    words: [
      'cleopatra', 'napoleon', 'caesar', 'alexander', 'hannibal',
      'columbus', 'lincoln', 'washington', 'charlemagne', 'saladin',
      'spartacus', 'ramesses', 'confucius', 'machiavelli', 'attila',
      'nero', 'caligula', 'hammurabi', 'xerxes', 'leonidas',
      'boudicca', 'bismarck', 'robespierre', 'genghis', 'tamerlane',
    ],
  },
  {
    id: 'philosophers',
    name: 'Philosophers',
    words: [
      'socrates', 'plato', 'aristotle', 'kant', 'nietzsche',
      'descartes', 'hegel', 'locke', 'hume', 'rousseau',
      'voltaire', 'spinoza', 'epicurus', 'seneca', 'schopenhauer',
      'wittgenstein', 'sartre', 'camus', 'confucius', 'kierkegaard',
      'leibniz', 'aquinas', 'zeno', 'plutarch', 'marcus',
    ],
  },
  {
    id: 'evil-characters',
    name: 'Evil Characters',
    words: [
      'voldemort', 'sauron', 'thanos', 'joker', 'hannibal',
      'magneto', 'maleficent', 'ursula', 'jafar', 'cruella',
      'moriarty', 'chucky', 'pennywise', 'freddy', 'dracula',
      'palpatine', 'iago', 'cersei', 'megatron', 'shredder',
      'carnage', 'ultron', 'apocalypse', 'loki', 'lex',
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
    // Code 11000 = duplicate key — some or all collections already exist, that's fine
    if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: number }).code === 11000) {
      return;
    }
    console.error('[WordCollections] Seed error:', err);
  }
}
