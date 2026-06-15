import { gameRegistry } from '../lib/game-registry.js';
import { wordGuessPlugin } from './word-guess.js';
import { chessPlugin } from './chess.js';

gameRegistry.register(wordGuessPlugin);
gameRegistry.register(chessPlugin);
