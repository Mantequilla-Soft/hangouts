import { useState, useRef, useEffect } from 'react';
import { useWordGuess } from '../../hooks/useWordGuess.js';

export interface GamePanelProps {
  roomName: string;
  isHost: boolean;
  onClose?: () => void;
}

const THEMES = [
  { id: 'animals', label: 'Animals' },
  { id: 'food',    label: 'Food' },
  { id: 'movies',  label: 'Movies' },
];

export function GamePanel({ roomName, isHost, onClose }: GamePanelProps) {
  const game = useWordGuess({ roomName });
  const [selectedTheme, setSelectedTheme] = useState('animals');
  const [guessInput, setGuessInput] = useState('');
  const eventsBottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    eventsBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [game.events.length]);

  const handleStartGame = () => {
    void game.startGame({ theme: selectedTheme });
  };

  const handleGuess = (e: React.FormEvent) => {
    e.preventDefault();
    if (!guessInput.trim()) return;
    void game.guess(guessInput);
    setGuessInput('');
  };

  return (
    <div className="hh-game-panel">
      <div className="hh-game-panel__header">
        <span className="hh-game-panel__title">
          {game.active ? 'Word Guess' : 'Games'}
        </span>
        {onClose && (
          <button
            className="hh-game-panel__collapse"
            onClick={onClose}
            aria-label="Collapse game panel"
            title="Collapse"
          >
            ›
          </button>
        )}
      </div>

      {!game.active ? (
        <div className="hh-game-panel__idle">
          {isHost ? (
            <>
              <p className="hh-game-panel__idle-hint">
                Each player is secretly assigned a word. Everyone can see everyone
                else's word — but not their own. Ask questions and guess yours!
              </p>
              <label className="hh-game-panel__label">
                Theme
                <select
                  className="hh-game-panel__select"
                  value={selectedTheme}
                  onChange={(e) => setSelectedTheme(e.target.value)}
                >
                  {THEMES.map((t) => (
                    <option key={t.id} value={t.id}>{t.label}</option>
                  ))}
                </select>
              </label>
              <button
                className="hh-btn hh-btn--primary"
                onClick={handleStartGame}
                disabled={game.isLoading}
              >
                {game.isLoading ? 'Starting…' : 'Start Word Guess'}
              </button>
              {game.error && (
                <p className="hh-game-panel__error">{game.error}</p>
              )}
            </>
          ) : (
            <p className="hh-game-panel__idle-hint">
              Waiting for the host to start a game…
            </p>
          )}
        </div>
      ) : (
        <div className="hh-game-panel__body">
          <div className="hh-game-panel__my-word">
            <span className="hh-game-panel__my-word-label">Your word</span>
            <span className="hh-game-panel__my-word-value">
              {game.hasGuessed ? '✅ Guessed!' : '???'}
            </span>
          </div>

          <div className="hh-game-panel__others">
            <div className="hh-game-panel__others-label">Others' words</div>
            {game.others.map(({ identity, word }) => (
              <div
                key={identity}
                className={`hh-game-panel__other-row${game.guessed.has(identity) ? ' hh-game-panel__other-row--guessed' : ''}`}
              >
                <span className="hh-game-panel__other-identity">{identity}</span>
                <span className="hh-game-panel__other-word">{word.toUpperCase()}</span>
                {game.guessed.has(identity) && (
                  <span className="hh-game-panel__guessed-badge">✅</span>
                )}
              </div>
            ))}
          </div>

          {!game.hasGuessed && (
            <form className="hh-game-panel__guess-form" onSubmit={handleGuess}>
              <input
                className="hh-game-panel__guess-input"
                type="text"
                placeholder="Your guess…"
                value={guessInput}
                onChange={(e) => setGuessInput(e.target.value)}
                autoComplete="off"
              />
              <button
                className="hh-btn hh-btn--primary hh-btn--small"
                type="submit"
                disabled={game.isLoading || !guessInput.trim()}
              >
                Guess
              </button>
            </form>
          )}

          {game.error && (
            <p className="hh-game-panel__error">{game.error}</p>
          )}

          {game.events.length > 0 && (
            <div className="hh-game-panel__events">
              {game.events.map((ev, i) => (
                <div
                  key={i}
                  className={`hh-game-panel__event ${ev.correct ? 'hh-game-panel__event--correct' : 'hh-game-panel__event--wrong'}`}
                >
                  {ev.correct
                    ? `✅ ${ev.identity} guessed ${ev.word ? ev.word.toUpperCase() : 'correctly'}!`
                    : `❌ ${ev.identity} guessed wrong`}
                </div>
              ))}
              <div ref={eventsBottomRef} />
            </div>
          )}

          {isHost && (
            <div className="hh-game-panel__footer">
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
      )}
    </div>
  );
}
