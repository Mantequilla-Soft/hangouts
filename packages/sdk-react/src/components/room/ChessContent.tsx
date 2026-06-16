import { useState, useEffect, useRef } from 'react';
import { Chessboard } from 'react-chessboard';
import type { PieceDropHandlerArgs, SquareHandlerArgs } from 'react-chessboard';
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
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  const historyBottomRef = useRef<HTMLDivElement>(null);

  // Clear selection when the turn changes (move was accepted) or game ends
  useEffect(() => {
    setSelectedSquare(null);
  }, [game.turn, game.status]);

  // Auto-scroll move history to latest move
  useEffect(() => {
    historyBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [game.moveHistory.length]);

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

  // Drag-and-drop handler (desktop)
  const handlePieceDrop = ({ sourceSquare, targetSquare }: PieceDropHandlerArgs): boolean => {
    if (!targetSquare) return false;
    const moved = game.makeMove(sourceSquare, targetSquare);
    if (moved) setSelectedSquare(null);
    return moved;
  };

  // Tap-to-move handler (mobile + desktop fallback)
  const handleSquareClick = ({ piece, square }: SquareHandlerArgs) => {
    if (!game.isMyTurn || gameOver || game.isSpectator) return;

    if (selectedSquare) {
      if (square === selectedSquare) {
        // Tap same square — deselect
        setSelectedSquare(null);
        return;
      }
      // Try to move from selectedSquare to tapped square
      const moved = game.makeMove(selectedSquare, square);
      if (moved) {
        setSelectedSquare(null);
        return;
      }
      // Move failed — maybe tapping a different own piece to re-select
      if (piece && game.myColor && piece.pieceType.startsWith(game.myColor)) {
        setSelectedSquare(square);
      } else {
        setSelectedSquare(null);
      }
    } else {
      // Select own piece
      if (piece && game.myColor && piece.pieceType.startsWith(game.myColor)) {
        setSelectedSquare(square);
      }
    }
  };

  const squareStyles: Record<string, React.CSSProperties> = {};
  if (selectedSquare) {
    squareStyles[selectedSquare] = { backgroundColor: 'rgba(255, 214, 0, 0.5)' };
  }

  return (
    <div className="hh-chess">
      {/* Left column: opponent → board → self */}
      <div className="hh-chess__board-col">
        <div className="hh-chess__player hh-chess__player--top">{opponent}</div>
        <div className="hh-chess__board">
          <div className="hh-chess__board-inner">
            <Chessboard
              options={{
                position: game.fen,
                boardOrientation: orientation,
                onPieceDrop: handlePieceDrop,
                onSquareClick: handleSquareClick,
                allowDragging: game.isMyTurn && !gameOver,
                squareStyles,
                boardStyle: { borderRadius: '4px', boxShadow: '0 2px 8px rgba(0,0,0,.3)' },
              }}
            />
          </div>
        </div>
        <div className="hh-chess__player hh-chess__player--bottom">{self}</div>
      </div>

      {/* Right column: status, move history, action buttons */}
      <div className="hh-chess__side">
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
            <div ref={historyBottomRef} />
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
    </div>
  );
}
