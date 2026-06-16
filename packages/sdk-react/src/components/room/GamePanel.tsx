import { useState, useRef, useEffect } from 'react';
import { useWordGuess } from '../../hooks/useWordGuess.js';
import { useHangoutsContext } from '../../context/HangoutsContext.js';
import { ChessContent } from './ChessContent.js';
import { FastDrawContent } from './FastDrawContent.js';

export interface GamePanelProps {
  roomName: string;
  isHost: boolean;
  onClose?: () => void;
  activeGameId?: string | null;
}

interface CollectionOption {
  id: string;
  name: string;
  wordCount: number;
}

interface GameOption {
  id: string;
  name: string;
  description: string;
}

// ─── Word Guess active content ─────────────────────────────────────────────

function WordGuessContent({ roomName, isHost }: { roomName: string; isHost: boolean }) {
  const game = useWordGuess({ roomName });
  const [guessInput, setGuessInput] = useState('');
  const eventsBottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    eventsBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [game.events.length]);

  const handleGuess = (e: React.FormEvent) => {
    e.preventDefault();
    if (!guessInput.trim()) return;
    void game.guess(guessInput);
    setGuessInput('');
  };

  return (
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

      {game.error && <p className="hh-game-panel__error">{game.error}</p>}

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
  );
}

// ─── Idle content (game picker) ────────────────────────────────────────────

function IdleContent({ roomName, isHost }: { roomName: string; isHost: boolean }) {
  const { apiClient } = useHangoutsContext();
  const wordGame = useWordGuess({ roomName });

  const [games, setGames] = useState<GameOption[]>([]);
  const [selectedGame, setSelectedGame] = useState('word-guess');
  const [selectedWinThreshold, setSelectedWinThreshold] = useState(5);
  const [selectedRoundDuration, setSelectedRoundDuration] = useState(60);
  const [selectedTimeControl, setSelectedTimeControl] = useState(0);

  const [collections, setCollections] = useState<CollectionOption[]>([]);
  const [collectionsLoading, setCollectionsLoading] = useState(true);
  const [selectedTheme, setSelectedTheme] = useState('');

  useEffect(() => {
    apiClient.listGames()
      .then((list) => {
        setGames(list);
        if (list.length > 0 && !list.find((g) => g.id === selectedGame)) {
          setSelectedGame(list[0]!.id);
        }
      })
      .catch(() => {
        setGames([
          { id: 'word-guess', name: 'Word Guess', description: '' },
          { id: 'chess', name: 'Chess', description: '' },
          { id: 'fast-draw', name: 'Fast Draw', description: '' },
        ]);
      });

    setCollectionsLoading(true);
    apiClient.listWordCollections()
      .then((cols) => {
        setCollections(cols);
        if (cols.length > 0 && !selectedTheme) setSelectedTheme(cols[0]!.id);
      })
      .catch(() => {
        const fallback: CollectionOption[] = [
          { id: 'animals', name: 'Animals', wordCount: 0 },
          { id: 'food', name: 'Food', wordCount: 0 },
          { id: 'movies', name: 'Movies', wordCount: 0 },
        ];
        setCollections(fallback);
        if (!selectedTheme) setSelectedTheme('animals');
      })
      .finally(() => setCollectionsLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!isHost) {
    return (
      <p className="hh-game-panel__idle-hint">
        Waiting for the host to start a game…
      </p>
    );
  }

  const handleStart = () => {
    if (selectedGame === 'word-guess') {
      void wordGame.startGame({ theme: selectedTheme });
    } else if (selectedGame === 'chess') {
      const config = selectedTimeControl > 0 ? { timeControl: selectedTimeControl } : {};
      void apiClient.startGame(roomName, 'chess', config);
    } else if (selectedGame === 'fast-draw') {
      void apiClient.startGame(roomName, 'fast-draw', {
        theme: selectedTheme,
        winThreshold: selectedWinThreshold,
        roundDuration: selectedRoundDuration,
      });
    }
  };

  return (
    <>
      {games.length > 1 && (
        <div className="hh-game-panel__game-picker">
          {games.map((g) => (
            <button
              key={g.id}
              className={`hh-game-panel__game-btn${selectedGame === g.id ? ' hh-game-panel__game-btn--active' : ''}`}
              onClick={() => setSelectedGame(g.id)}
            >
              {g.name}
            </button>
          ))}
        </div>
      )}

      {selectedGame === 'word-guess' && (
        <>
          <p className="hh-game-panel__idle-hint">
            Each player is secretly assigned a word. Everyone can see everyone
            else's word — but not their own. Ask questions and guess yours!
          </p>
          <label className="hh-game-panel__label">
            Theme
            {collectionsLoading ? (
              <span className="hh-game-panel__select-loading">Loading…</span>
            ) : (
              <select
                className="hh-game-panel__select"
                value={selectedTheme}
                onChange={(e) => setSelectedTheme(e.target.value)}
              >
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}{c.wordCount > 0 ? ` (${c.wordCount})` : ''}
                  </option>
                ))}
              </select>
            )}
          </label>
        </>
      )}

      {selectedGame === 'chess' && (
        <>
          <p className="hh-game-panel__idle-hint">
            Classic 2-player chess. Colors are assigned randomly at game start.
            The host and one other participant play; everyone else watches.
          </p>
          <label className="hh-game-panel__label">
            Time control
            <select
              className="hh-game-panel__select"
              value={selectedTimeControl}
              onChange={(e) => setSelectedTimeControl(Number(e.target.value))}
            >
              <option value={0}>Untimed</option>
              <option value={180}>3 min — Blitz</option>
              <option value={300}>5 min — Blitz</option>
              <option value={600}>10 min — Rapid</option>
              <option value={1200}>20 min — Rapid</option>
            </select>
          </label>
        </>
      )}

      {selectedGame === 'fast-draw' && (
        <>
          <p className="hh-game-panel__idle-hint">
            One player draws a word, everyone else guesses. Drawer and first correct
            guesser each score a point. First to the win threshold wins!
          </p>
          <label className="hh-game-panel__label">
            Theme
            {collectionsLoading ? (
              <span className="hh-game-panel__select-loading">Loading…</span>
            ) : (
              <select
                className="hh-game-panel__select"
                value={selectedTheme}
                onChange={(e) => setSelectedTheme(e.target.value)}
              >
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}{c.wordCount > 0 ? ` (${c.wordCount})` : ''}
                  </option>
                ))}
              </select>
            )}
          </label>
          <label className="hh-game-panel__label">
            Points to win
            <select
              className="hh-game-panel__select"
              value={selectedWinThreshold}
              onChange={(e) => setSelectedWinThreshold(Number(e.target.value))}
            >
              {[3, 5, 7, 10].map((n) => <option key={n} value={n}>{n} points</option>)}
            </select>
          </label>
          <label className="hh-game-panel__label">
            Round time
            <select
              className="hh-game-panel__select"
              value={selectedRoundDuration}
              onChange={(e) => setSelectedRoundDuration(Number(e.target.value))}
            >
              <option value={30}>30 seconds</option>
              <option value={60}>60 seconds</option>
              <option value={90}>90 seconds</option>
            </select>
          </label>
        </>
      )}

      <button
        className="hh-btn hh-btn--primary"
        onClick={handleStart}
        disabled={wordGame.isLoading || (selectedGame === 'word-guess' && (collectionsLoading || !selectedTheme))}
      >
        {wordGame.isLoading ? 'Starting…' : `Start ${games.find((g) => g.id === selectedGame)?.name ?? selectedGame}`}
      </button>

      {wordGame.error && <p className="hh-game-panel__error">{wordGame.error}</p>}
    </>
  );
}

// ─── Panel shell ───────────────────────────────────────────────────────────

export function GamePanel({ roomName, isHost, onClose, activeGameId }: GamePanelProps) {
  const isActive = !!activeGameId;

  return (
    <div className={`hh-game-panel${!onClose ? ' hh-game-panel--center' : ''}`}>
      <div className="hh-game-panel__header">
        <span className="hh-game-panel__title">
          {activeGameId === 'chess' ? 'Chess' : activeGameId === 'word-guess' ? 'Word Guess' : activeGameId === 'fast-draw' ? 'Fast Draw' : 'Games'}
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

      {!isActive ? (
        <div className="hh-game-panel__idle">
          <IdleContent roomName={roomName} isHost={isHost} />
        </div>
      ) : activeGameId === 'chess' ? (
        <ChessContent roomName={roomName} isHost={isHost} />
      ) : activeGameId === 'fast-draw' ? (
        <FastDrawContent roomName={roomName} isHost={isHost} />
      ) : (
        <WordGuessContent roomName={roomName} isHost={isHost} />
      )}
    </div>
  );
}
