import { gameRegistry } from '../lib/game-registry.js';
import { wordGuessPlugin } from './word-guess.js';

gameRegistry.register(wordGuessPlugin);
