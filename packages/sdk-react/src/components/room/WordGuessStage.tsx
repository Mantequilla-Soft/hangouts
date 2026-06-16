import { useState } from 'react';
import { useParticipants, useLocalParticipant } from '@livekit/components-react';
import { useWordGuess } from '../../hooks/useWordGuess.js';
import { getParticipantRole } from '../../hooks/useParticipantRole.js';
import { ParticipantTile } from './ParticipantTile.js';

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

  const isPlayer = game.participants.includes(myIdentity);
  const canGuess = isPlayer && !game.hasGuessed && game.active;

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
        {game.error && <div className="hh-wg-stage__error">{game.error}</div>}
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
        {isHost && (
          <div className="hh-wg-stage__host-row">
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
