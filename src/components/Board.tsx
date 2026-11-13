import { useMemo, useState } from 'react';
import { Chessboard } from 'react-chessboard';
import type { Game, MoveError } from '../lib/types';
import { lineFens, lineToSan } from '../lib/tactics';
import { SEVERITY_SYMBOL, formatClock, moveLabel } from '../lib/format';

export const ARROW = {
  played: 'rgba(208, 59, 59, 0.9)',
  best: 'rgba(12, 163, 12, 0.9)',
  reply: 'rgba(236, 131, 90, 0.95)',
  last: 'rgba(42, 120, 214, 0.75)',
};
export const BOARD_STYLE = {
  darkSquareStyle: { backgroundColor: '#7d8fa3' },
  lightSquareStyle: { backgroundColor: '#e3e8ee' },
};

/** Element ids must not contain URL characters (game ids are URLs). */
export const boardId = (raw: string) => raw.replace(/[^a-zA-Z0-9_-]+/g, '-');

export interface ArrowSpec {
  uci: string;
  color: string;
}

/** A read-only board. */
export function StaticBoard({ id, fen, orientation, arrows }: { id: string; fen: string; orientation: 'w' | 'b'; arrows: ArrowSpec[] }) {
  return (
    <div className="board-box">
    <Chessboard
      options={{
        id: boardId(id),
        position: fen,
        boardOrientation: orientation === 'w' ? 'white' : 'black',
        allowDragging: false,
        allowDrawingArrows: false,
        showAnimations: false,
        showNotation: false,
        arrows: arrows.map((a) => ({ startSquare: a.uci.slice(0, 2), endSquare: a.uci.slice(2, 4), color: a.color })),
        ...BOARD_STYLE,
      }}
    />
    </div>
  );
}

/** "16. Kd2 Qxh5 17. Nf3" with correct move numbers, starting from any ply. */
function numbered(sans: string[], moveNumber: number, color: 'w' | 'b'): { label: string; san: string }[] {
  let n = moveNumber;
  let c = color;
  return sans.map((san, i) => {
    const label = c === 'w' ? `${n}.` : i === 0 ? `${n}…` : '';
    if (c === 'b') n++;
    c = c === 'w' ? 'b' : 'w';
    return { label, san };
  });
}

/**
 * One of the user's errors as a small lesson: the position, a sentence saying what
 * went wrong, and two lines to step through — what happened, and what was better.
 */
export function LineBoard({ error, game, startOn = 'played' }: { error: MoveError; game?: Game; startOn?: 'played' | 'best' }) {
  const [mode, setMode] = useState<'played' | 'best'>(startOn);
  const [step, setStep] = useState(0);
  const line = mode === 'played' ? error.playedLine : error.bestLine;
  const fens = useMemo(() => lineFens(error.fenBefore, line), [error.fenBefore, line]);
  const sans = useMemo(() => lineToSan(error.fenBefore, line), [error.fenBefore, line]);
  const tokens = numbered(sans, error.moveNumber, error.color);
  const max = fens.length - 1;
  const at = Math.min(step, max);

  const arrows: ArrowSpec[] =
    at === 0
      ? [
          { uci: error.uci, color: ARROW.played },
          ...(error.bestUci && error.bestUci !== error.uci ? [{ uci: error.bestUci, color: ARROW.best }] : []),
        ]
      : [{ uci: line[at - 1], color: mode === 'best' ? ARROW.best : at === 1 ? ARROW.played : at % 2 === 0 ? ARROW.reply : ARROW.last }];

  const played = moveLabel(error.moveNumber, error.color, error.san) + SEVERITY_SYMBOL[error.severity];
  const pick = (m: 'played' | 'best') => {
    setMode(m);
    setStep(1);
  };

  return (
    <figure className="moment">
      <div className="moment-board" aria-label={`Position before ${played}`}>
        <StaticBoard id={`l-${error.gameId}-${error.plyIndex}`} fen={fens[at]} orientation={error.color} arrows={arrows} />
      </div>
      <figcaption>
        <p className="moment-why">{error.explanation}</p>
        <div className="line-tabs" role="tablist">
          <button role="tab" aria-selected={mode === 'played'} className={mode === 'played' ? 'active played' : 'played'} onClick={() => pick('played')}>
            You played {error.san}
          </button>
          {error.bestSan && (
            <button role="tab" aria-selected={mode === 'best'} className={mode === 'best' ? 'active best' : 'best'} onClick={() => pick('best')}>
              Better: {error.bestSan}
            </button>
          )}
        </div>
        <div className="line-moves">
          <button className="step" onClick={() => setStep(Math.max(0, at - 1))} disabled={at === 0} aria-label="Previous move">
            ◀
          </button>
          <span className="line-sans">
            {tokens.map((t, i) => (
              <button key={i} className={`san ${i + 1 === at ? 'current' : ''}`} onClick={() => setStep(i + 1)}>
                {t.label && <span className="muted">{t.label} </span>}
                {t.san}
              </button>
            ))}
          </span>
          <button className="step" onClick={() => setStep(Math.min(max, at + 1))} disabled={at === max} aria-label="Next move">
            ▶
          </button>
        </div>
        <div className="moment-meta">
          Winning chances {Math.round(error.winBefore)}% → {Math.round(error.winAfter)}%
          {error.clockBefore !== undefined && (
            <>
              {' '}
              · clock {formatClock(error.clockBefore)}, you spent {formatClock(error.spent)}
            </>
          )}
          {game && (
            <>
              {' · '}
              <a href={game.url} target="_blank" rel="noreferrer">
                vs {game.opponent} ↗
              </a>
            </>
          )}
        </div>
      </figcaption>
    </figure>
  );
}
