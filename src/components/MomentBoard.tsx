import { Chessboard } from 'react-chessboard';
import type { Game, MoveError } from '../lib/types';
import { ERROR_TYPE_LABEL, SEVERITY_SYMBOL, formatClock, moveLabel } from '../lib/format';

const PLAYED = 'rgba(208, 59, 59, 0.9)';
const BEST = 'rgba(12, 163, 12, 0.9)';

/** A position from the user's own game: what they played vs. what the engine wanted. */
export function MomentBoard({ error, game }: { error: MoveError; game: Game | undefined }) {
  const arrows = [{ startSquare: error.uci.slice(0, 2), endSquare: error.uci.slice(2, 4), color: PLAYED }];
  if (error.bestUci && error.bestUci !== error.uci) {
    arrows.push({ startSquare: error.bestUci.slice(0, 2), endSquare: error.bestUci.slice(2, 4), color: BEST });
  }
  const played = moveLabel(error.moveNumber, error.color, error.san) + SEVERITY_SYMBOL[error.severity];
  return (
    <figure className="moment">
      <div className="moment-board" aria-label={`Position before ${played}`}>
        <Chessboard
          options={{
            id: `m-${error.gameId}-${error.plyIndex}`,
            position: error.fenBefore,
            boardOrientation: error.color === 'w' ? 'white' : 'black',
            allowDragging: false,
            allowDrawingArrows: false,
            showAnimations: false,
            showNotation: false,
            arrows,
            darkSquareStyle: { backgroundColor: '#7d8fa3' },
            lightSquareStyle: { backgroundColor: '#e3e8ee' },
          }}
        />
      </div>
      <figcaption>
        <div className="moment-moves">
          <span>
            <i className="swatch" style={{ background: PLAYED }} /> You played <b>{played}</b>
          </span>
          {error.bestSan && (
            <span>
              <i className="swatch" style={{ background: BEST }} /> Best was <b>{error.bestSan}</b>
            </span>
          )}
        </div>
        <div className="moment-meta">
          {ERROR_TYPE_LABEL[error.type]}
          {error.refutationSan && error.type !== 'missed_win' ? ` — punished by ${error.refutationSan}` : ''}. Winning
          chances {Math.round(error.winBefore)}% → {Math.round(error.winAfter)}%.
          {error.clockBefore !== undefined && (
            <>
              {' '}
              Clock {formatClock(error.clockBefore)}, spent {formatClock(error.spent)}.
            </>
          )}
        </div>
        {game && (
          <a href={game.url} target="_blank" rel="noreferrer">
            vs {game.opponent} ({game.opponentRating}) ↗
          </a>
        )}
      </figcaption>
    </figure>
  );
}
