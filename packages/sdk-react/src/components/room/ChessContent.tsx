import { Chessboard } from 'react-chessboard';
import type { PieceDropHandlerArgs } from 'react-chessboard';
import { useChess } from '../../hooks/useChess.js';
import type { ChessGameStatus } from '../../hooks/useChess.js';

interface ChessContentProps {
  roomName: string;
  isHost: boolean;
}

function chessStatusText(
  status: ChessGameStatus,
  winner: string | null,
  players: { w: string; b: string } | null,
  isMyTurn: boolean,
  isSpectator: boolean,
): string {
  if (status === 'checkmate') return winner ? `Checkmate! ${winner} wins.` : 'Checkmate!';
  if (status === 'resigned') return winner ? `${winner} wins by resignation.` : 'Game over.';
  if (status === 'draw') return "It's a draw!";
  if (status === 'stalemate') return "Stalemate — draw!";
  if (isSpectator && players) return `${players.w} (white) vs ${players.b} (black)`;
  if (isMyTurn) return 'Your turn';
  return "Opponent's turn…";
}

function formatMoveHistory(history: string[]): Array<{ n: number; w: string; b?: string }> {
  const pairs: Array<{ n: number; w: string; b?: string }> = [];
  for (let i = 0; i < history.length; i += 2) {
    pairs.push({ n: Math.floor(i / 2) + 1, w: history[i]!, b: history[i + 1] });
  }
  return pairs;
}

export function ChessContent({ roomName, isHost }: ChessContentProps) {
  const game = useChess({ roomName });

  const orientation = game.myColor === 'b' ? 'black' : 'white';
  const opponent = game.players
    ? (orientation === 'white' ? game.players.b : game.players.w)
    : '—';
  const self = game.players
    ? (orientation === 'white' ? game.players.w : game.players.b)
    : (game.isSpectator ? 'Spectating' : '—');

  const gameOver = game.status !== 'playing';
  const statusText = chessStatusText(game.status, game.winner, game.players, game.isMyTurn, game.isSpectator);
  const movePairs = formatMoveHistory(game.moveHistory);

  const handlePieceDrop = ({ sourceSquare, targetSquare }: PieceDropHandlerArgs): boolean => {
    if (!targetSquare) return false;
    return game.makeMove(sourceSquare, targetSquare);
  };

  return (
    <div className="hh-chess">
      <div className="hh-chess__player hh-chess__player--top">{opponent}</div>

      <div className="hh-chess__board">
        <Chessboard
          options={{
            position: game.fen,
            boardOrientation: orientation,
            onPieceDrop: handlePieceDrop,
            allowDragging: game.isMyTurn && !gameOver,
            boardStyle: { borderRadius: '4px', boxShadow: '0 2px 8px rgba(0,0,0,.3)' },
          }}
        />
      </div>

      <div className="hh-chess__player hh-chess__player--bottom">{self}</div>

      <div className={`hh-chess__status${gameOver ? ' hh-chess__status--gameover' : ''}`}>
        {statusText}
      </div>

      {game.error && (
        <div className="hh-chess__error">{game.error}</div>
      )}

      {movePairs.length > 0 && (
        <div className="hh-chess__history">
          {movePairs.map(({ n, w, b }) => (
            <span key={n} className="hh-chess__move-pair">
              <span className="hh-chess__move-num">{n}.</span>
              <span className="hh-chess__move">{w}</span>
              {b && <span className="hh-chess__move">{b}</span>}
            </span>
          ))}
        </div>
      )}

      <div className="hh-chess__actions">
        {!game.isSpectator && game.myColor && !gameOver && (
          <button
            className="hh-btn hh-btn--secondary hh-btn--small"
            onClick={() => void game.resign()}
            disabled={game.isLoading}
          >
            Resign
          </button>
        )}
        {isHost && !gameOver && (
          <button
            className="hh-btn hh-btn--danger hh-btn--small"
            onClick={() => void game.endGame()}
            disabled={game.isLoading}
          >
            End Game
          </button>
        )}
      </div>
    </div>
  );
}
