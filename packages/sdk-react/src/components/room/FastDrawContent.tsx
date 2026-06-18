import { useState, useEffect } from 'react';
import { useFastDraw } from '../../hooks/useFastDraw.js';
import { DrawingCanvas } from './DrawingCanvas.js';

interface FastDrawContentProps {
  roomName: string;
  isHost: boolean;
}

function formatTime(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function WordHint({ word, wordLength, phase, revealedWord }: { word: string | null; wordLength: number; phase: string; revealedWord: string | null }) {
  if (word) return <span className="hh-fastdraw__word">{word}</span>;
  if (phase !== 'drawing' && revealedWord) return <span className="hh-fastdraw__word hh-fastdraw__word--revealed">{revealedWord}</span>;
  // Fixed-width blocks with explicit gap, not letter-spaced underscores — guarantees
  // distinct blanks at any zoom/font instead of relying on glyph spacing to not merge.
  const dashes = Array.from({ length: wordLength }, (_, i) => <span key={i} className="hh-fastdraw__dash" />);
  return <span className="hh-fastdraw__word hh-fastdraw__word--dashes">{dashes}</span>;
}

export function FastDrawContent({ roomName, isHost }: FastDrawContentProps) {
  const game = useFastDraw({ roomName });
  const [guess, setGuess] = useState('');
  const [timeLeft, setTimeLeft] = useState(0);

  useEffect(() => {
    if (!game.active || game.phase === 'game_over') return;
    const target = game.phase === 'drawing'
      ? game.roundStartedAt + game.roundDuration * 1000
      : game.phase === 'guessing'
      ? (game.guessPhaseStartedAt ?? 0) + game.guessDuration * 1000
      : (game.revealEndsAt ?? 0);

    // Compare against the server's clock, not the browser's, to avoid skewed countdowns.
    const tick = () => setTimeLeft(Math.max(0, target - (Date.now() + game.serverTimeOffset)));
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [game.active, game.phase, game.roundStartedAt, game.roundDuration, game.guessPhaseStartedAt, game.guessDuration, game.revealEndsAt, game.serverTimeOffset]);

  const handleGuess = (e: React.FormEvent) => {
    e.preventDefault();
    if (!guess.trim()) return;
    void game.submitGuess(guess.trim());
    setGuess('');
  };

  if (!game.active) return null;

  const isDrawingPhase = game.phase === 'drawing';
  const isGuessingPhase = game.phase === 'guessing';
  const isRevealPhase = game.phase === 'reveal';
  const isGameOver = game.phase === 'game_over';
  const urgent = timeLeft < 10000 && !isGameOver;
  const bannerText = isDrawingPhase ? 'DRAW!' : isGuessingPhase ? 'LAST CHANCE TO GUESS!' : null;

  return (
    <div className="hh-fastdraw">
      {/* Left column: canvas + toolbar */}
      <DrawingCanvas
        isDrawer={game.isDrawer}
        currentDrawer={game.currentDrawer}
        strokeSnapshot={game.strokeSnapshot}
        disabled={!isDrawingPhase}
        onStrokeComplete={game.syncCanvas}
      />

      {/* Right column: game info */}
      <div className="hh-fastdraw__side">
        <div className="hh-fastdraw__header">
          <span>Round {game.roundNumber}</span>
          <span>{game.isDrawer ? (isGuessingPhase ? "Time's up — guesses still open!" : 'Your turn to draw!') : (isGuessingPhase ? 'Last chance to guess!' : `${game.currentDrawer} is drawing`)}</span>
        </div>

        {bannerText && (
          <div className={`hh-game-banner${urgent ? ' hh-game-banner--urgent' : ''}`}>
            {bannerText}
          </div>
        )}

        <div className="hh-fastdraw__scores">
          {Object.entries(game.scores)
            .sort(([, a], [, b]) => b - a)
            .map(([identity, score]) => (
              <div key={identity} className="hh-fastdraw__score-row">
                <span>{identity}{identity === game.currentDrawer ? ' ✏️' : ''}</span>
                <span>{game.winners.length > 0 ? '✓' : score}</span>
              </div>
            ))}
        </div>

        <div className="hh-fastdraw__word-row">
          <WordHint
            word={game.word}
            wordLength={game.wordLength}
            phase={game.phase}
            revealedWord={game.revealedWord}
          />
          {(isDrawingPhase || isGuessingPhase) && (
            <span className={`hh-game-timer${urgent ? ' hh-game-timer--urgent' : ''}`}>
              {formatTime(timeLeft)}
            </span>
          )}
        </div>

        {!game.isDrawer && !game.isSpectator && (isDrawingPhase || isGuessingPhase) && (
          <form className="hh-fastdraw__guess-row" onSubmit={handleGuess}>
            <input
              className="hh-fastdraw__guess-input"
              value={guess}
              onChange={(e) => setGuess(e.target.value)}
              placeholder="Type your guess…"
              autoComplete="off"
            />
            <button className="hh-btn hh-btn--primary" type="submit">Go</button>
          </form>
        )}

        {game.error && <div className="hh-game-feedback">{game.error}</div>}

        {isRevealPhase && (
          <div className="hh-fastdraw__reveal">
            {game.guesser
              ? <><div>{game.guesser} got it!</div><div className="hh-fastdraw__reveal-word">{game.revealedWord}</div><div>+1 each</div></>
              : <><div>Time&apos;s up!</div><div className="hh-fastdraw__reveal-word">{game.revealedWord}</div></>
            }
            {isHost
              ? <button className="hh-btn hh-btn--primary hh-btn--small" onClick={() => void game.nextRound()}>Next Round</button>
              : <div className="hh-fastdraw__waiting">Waiting for host…</div>
            }
            {/* Own block-level line — must not crowd the button on the same row. */}
            <div className={`hh-fastdraw__reveal-countdown${urgent ? ' hh-game-timer--urgent' : ''}`}>
              Next round in {formatTime(timeLeft)}
            </div>
          </div>
        )}

        {isGameOver && (
          <div className="hh-fastdraw__reveal">
            <div className="hh-fastdraw__reveal-word">
              {game.winners.length === 1 ? `${game.winners[0]} wins!` : `Tie: ${game.winners.join(' & ')}!`}
            </div>
            {isHost && (
              <div className="hh-game-actions">
                <button className="hh-btn hh-btn--danger hh-btn--small" onClick={() => void game.endGame()}>
                  End Game
                </button>
              </div>
            )}
          </div>
        )}

        {isHost && !isGameOver && (
          <div className="hh-fastdraw__host-controls hh-game-actions">
            <button
              className="hh-btn hh-btn--danger hh-btn--small"
              onClick={() => void game.endGame()}
              disabled={game.isLoading}
            >
              End Game
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
