import { useState } from 'react';
import { useParticipants, useLocalParticipant } from '@livekit/components-react';
import { formatWordGuessRecap } from '@snapie/hangouts-core';
import { useWordGuess } from '../../hooks/useWordGuess.js';
import { getParticipantRole } from '../../hooks/useParticipantRole.js';
import { ParticipantTile } from './ParticipantTile.js';

const MEDALS = ['🥇', '🥈', '🥉'];

interface WordGuessStageProps {
  roomName: string;
  isHost: boolean;
  hostIdentity: string | null;
  videoEnabled?: boolean;
}

export function WordGuessStage({ roomName, isHost, hostIdentity, videoEnabled = false }: WordGuessStageProps) {
  const game = useWordGuess({ roomName });
  const participants = useParticipants();
  const { localParticipant } = useLocalParticipant();
  const myIdentity = localParticipant?.identity ?? '';
  const [guessInput, setGuessInput] = useState('');
  const [copied, setCopied] = useState(false);

  // Map identity → word so we can label each tile
  const wordMap = new Map(game.others.map((o) => [o.identity, o.word]));

  const badgeFor = (identity: string): { text: string; guessed: boolean } | undefined => {
    if (identity === myIdentity) {
      if (!game.participants.includes(identity)) return undefined;
      return game.hasGuessed
        ? { text: 'Guessed!', guessed: true }
        : { text: '???', guessed: false };
    }
    const word = wordMap.get(identity);
    if (!word) return undefined;
    const guessed = game.guessed.has(identity);
    return { text: guessed ? `${word} ✓` : word, guessed };
  };

  const handleGuess = (e: React.FormEvent) => {
    e.preventDefault();
    if (!guessInput.trim()) return;
    void game.guess(guessInput.trim());
    setGuessInput('');
  };

  const handleCopyRecap = async () => {
    if (!game.recap) return;
    try {
      await navigator.clipboard.writeText(formatWordGuessRecap(game.recap));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard permission denied — button just won't show the "Copied!" confirmation
    }
  };

  const isPlayer = game.participants.includes(myIdentity);
  const canGuess = isPlayer && !game.hasGuessed && game.active;
  const unsolvedEntries = game.recap
    ? Object.entries(game.recap.words).filter(
        ([identity]) => !game.recap!.leaderboard.some((e) => e.identity === identity),
      )
    : [];

  return (
    <div className="hh-wg-stage">
      <div className="hh-wg-stage__grid">
        {participants.map((p) => {
          const badge = badgeFor(p.identity);
          return (
            <div key={p.identity} className="hh-wg-stage__cell">
              <ParticipantTile
                participant={p}
                role={getParticipantRole(p, hostIdentity)}
                isCurrentUserHost={isHost}
                roomName={roomName}
                videoEnabled={videoEnabled}
                wordBadge={badge?.text}
                wordBadgeGuessed={badge?.guessed}
              />
            </div>
          );
        })}
      </div>

      <div className="hh-wg-stage__footer">
        {canGuess && (
          <form className="hh-wg-stage__guess-row" onSubmit={handleGuess}>
            <input
              className="hh-wg-stage__guess-input"
              value={guessInput}
              onChange={(e) => setGuessInput(e.target.value)}
              placeholder="Guess your word…"
              autoComplete="off"
            />
            <button className="hh-btn hh-btn--primary hh-btn--small" type="submit">
              Go
            </button>
          </form>
        )}
        {game.error && <div className="hh-game-feedback">{game.error}</div>}
        {game.events.length > 0 && (
          <div className="hh-wg-stage__events">
            {game.events.slice(-3).map((ev, i) => (
              <div
                key={i}
                className={`hh-wg-stage__event${ev.correct ? ' hh-wg-stage__event--correct' : ' hh-wg-stage__event--wrong'}`}
              >
                {ev.correct
                  ? `✅ ${ev.identity} guessed correctly!`
                  : `❌ ${ev.identity} guessed wrong`}
              </div>
            ))}
          </div>
        )}
        {game.recap && (
          <div className="hh-wg-recap">
            <div className="hh-wg-recap__title">🏁 Race Recap — {game.recap.theme}</div>
            <ol className="hh-wg-recap__list">
              {game.recap.leaderboard.map((entry, i) => (
                <li key={entry.identity} className="hh-wg-recap__row">
                  <span className="hh-wg-recap__place">{MEDALS[i] ?? `${entry.place}.`}</span>
                  <span className="hh-wg-recap__name">{entry.identity}</span>
                  <span className="hh-wg-recap__time">{(entry.solveTimeMs / 1000).toFixed(1)}s</span>
                  {entry.wrongAttempts > 0 && (
                    <span className="hh-wg-recap__tries">
                      {entry.wrongAttempts} {entry.wrongAttempts === 1 ? 'try' : 'tries'}
                    </span>
                  )}
                </li>
              ))}
            </ol>
            {unsolvedEntries.length > 0 && (
              <div className="hh-wg-recap__unsolved">
                Didn't finish: {unsolvedEntries.map(([id, w]) => `${id} (was ${w.toUpperCase()})`).join(', ')}
              </div>
            )}
            <div className="hh-wg-recap__reveal">
              🔍 {Object.entries(game.recap.words).map(([id, w]) => `${id}=${w.toUpperCase()}`).join(' · ')}
            </div>
            {isHost && (
              <button className="hh-btn hh-btn--secondary hh-btn--small" onClick={() => void handleCopyRecap()}>
                {copied ? '✅ Copied!' : '📋 Copy Recap'}
              </button>
            )}
          </div>
        )}

        {isHost && game.active && (
          <div className="hh-wg-stage__host-row hh-game-actions">
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
