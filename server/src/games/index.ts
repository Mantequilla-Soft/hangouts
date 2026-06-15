import { gameRegistry } from '../lib/game-registry.js';
import { wordGuessPlugin } from './word-guess.js';
import { chessPlugin } from './chess.js';
import { fastDrawPlugin } from './fast-draw.js';

gameRegistry.register(wordGuessPlugin);
gameRegistry.register(chessPlugin);
gameRegistry.register(fastDrawPlugin);
