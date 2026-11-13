import { useEffect, useMemo, useRef, useState } from 'react';
import { Chess, type Square } from 'chess.js';
import { Chessboard } from 'react-chessboard';
import { MoveJudge } from '../lib/engine';
import { winPct } from '../lib/evaluate';
import { ERROR_TYPE_LABEL } from '../lib/format';
import type { ErrorType, Game, MoveError } from '../lib/types';
import { BOARD_STYLE, LineBoard } from './Board';

export interface Puzzle {
  error: MoveError;
  game: Game;
}

const PROMPT: Record<ErrorType, string> = {
  hung: 'In the game your move here lost a piece on the spot. Find a move that keeps everything safe.',
  allowed_tactic: 'In the game your move here walked into a tactic. Find a move that does not allow it.',
  allowed_mate: 'In the game your move here allowed a forced mate. Find the move that keeps your king safe.',
  missed_tactic: 'You had a way to win material here and missed it. Find it.',
  missed_mate: 'You had a forced checkmate here and missed it. Find the first move.',
  positional: 'Your move in the game made your position clearly worse. Find a better plan.',
};

type Status = 'idle' | 'checking' | 'wrong' | 'correct' | 'revealed';

/** How many times in a row each position has been solved first try, kept across visits. */
const STORE = 'chess-insight:practice:v1';
const puzzleKey = (p: Puzzle) => `${p.error.gameId}:${p.error.plyIndex}`;
function loadStreaks(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? '{}') ?? {};
  } catch {
    return {};
  }
}
function saveStreak(key: string, streak: number) {
  try {
    localStorage.setItem(STORE, JSON.stringify({ ...loadStreaks(), [key]: streak }));
  } catch {
    // Optional.
  }
}

/** Largest drop in winning chances we still accept as "a good move". */
const TOLERANCE = 6;

/**
 * The user's own mistakes as puzzles. Any move that keeps (nearly) all the winning
 * chances counts as solved — the engine checks alternatives live.
 */
export function Practice({ puzzles }: { puzzles: Puzzle[] }) {
  const [streaks, setStreaks] = useState(loadStreaks);
  // Positions not yet mastered come first; anything you miss is queued again at the end.
  const [queue, setQueue] = useState<number[]>(() => {
    const s = loadStreaks();
    return puzzles.map((_, i) => i).sort((a, b) => (s[puzzleKey(puzzles[a])] ?? 0) - (s[puzzleKey(puzzles[b])] ?? 0) || a - b);
  });
  const [cursor, setCursor] = useState(0);
  const index = queue[cursor] ?? 0;
  const [status, setStatus] = useState<Status>('idle');
  const [fen, setFen] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [hint, setHint] = useState(false);
  const [attempts, setAttempts] = useState(0);
  /** Outcome per queue slot. */
  const [results, setResults] = useState<Record<number, 'first' | 'later' | 'shown'>>({});
  const judge = useRef<MoveJudge | null>(null);
  const token = useRef(0);

  useEffect(
    () => () => {
      judge.current?.dispose();
      judge.current = null;
    },
    [],
  );

  const puzzle = puzzles[index];
  const error = puzzle?.error;
  const done = Object.keys(results).length;
  const firstTry = Object.values(results).filter((r) => r === 'first').length;
  const legalTargets = useMemo(() => {
    if (!error || !selected) return [];
    try {
      return new Chess(error.fenBefore).moves({ square: selected as Square, verbose: true }).map((m) => m.to as string);
    } catch {
      return [];
    }
  }, [error, selected]);

  if (!puzzle || !error) {
    return (
      <div className="card">
        <p>No mistakes or blunders to practise in these games — nothing to drill.</p>
      </div>
    );
  }

  const go = (slot: number) => {
    token.current++;
    setCursor(slot);
    setStatus('idle');
    setFen(null);
    setMessage('');
    setSelected(null);
    setHint(false);
    setAttempts(0);
  };

  const finish = (how: 'solved' | 'shown', note: string) => {
    setStatus(how === 'solved' ? 'correct' : 'revealed');
    setMessage(note);
    setFen(null);
    if (results[cursor]) return;
    const outcome = how === 'shown' ? 'shown' : attempts === 0 ? 'first' : 'later';
    setResults((r) => ({ ...r, [cursor]: outcome }));
    const key = puzzleKey(puzzle);
    const streak = outcome === 'first' ? (streaks[key] ?? 0) + 1 : 0;
    saveStreak(key, streak);
    setStreaks((s) => ({ ...s, [key]: streak }));
    // Missed it: see it once more at the end of this session.
    if (outcome !== 'first' && queue.indexOf(index) === queue.lastIndexOf(index)) setQueue((q) => [...q, index]);
  };

  const tryMove = (from: string, to: string): boolean => {
    if (status !== 'idle' && status !== 'wrong') return false;
    const chess = new Chess(error.fenBefore);
    let mv;
    try {
      mv = chess.move({ from, to, promotion: 'q' });
    } catch {
      return false;
    }
    const uci = mv.from + mv.to + (mv.promotion ?? '');
    setSelected(null);
    if (uci === error.bestUci) {
      finish('solved', `${mv.san} — exactly right. That is the engine’s first choice.`);
      return true;
    }
    setFen(chess.fen());
    setStatus('checking');
    setMessage(`Checking ${mv.san}…`);
    const mine = ++token.current;
    judge.current ??= new MoveJudge();
    judge.current
      .scoreAfter(chess.fen())
      .then((cp) => {
        if (token.current !== mine) return;
        const loss = error.winBefore - winPct(cp);
        if (loss < TOLERANCE) {
          finish('solved', `${mv.san} works too — it keeps your winning chances. The engine’s first choice was ${error.bestSan}.`);
          return;
        }
        setAttempts((a) => a + 1);
        setStatus('wrong');
        setFen(null);
        setMessage(
          uci === error.uci
            ? `${mv.san} is what you played in the game — it costs about ${Math.round(loss)}% of your winning chances. Try something else.`
            : `${mv.san} is not it — that gives away about ${Math.round(loss)}% of your winning chances. Try again.`,
        );
      })
      .catch(() => {
        if (token.current !== mine) return;
        setStatus('wrong');
        setFen(null);
        setMessage('Could not check that move. Try again, or show the answer.');
      });
    return true;
  };

  const onSquare = (square: string, hasOwnPiece: boolean) => {
    if (status !== 'idle' && status !== 'wrong') return;
    if (selected && selected !== square && tryMove(selected, square)) return;
    setSelected(hasOwnPiece && selected !== square ? square : null);
  };

  const solved = status === 'correct' || status === 'revealed';
  const squareStyles: Record<string, React.CSSProperties> = {};
  if (selected) squareStyles[selected] = { boxShadow: 'inset 0 0 0 4px rgba(42,120,214,0.9)' };
  for (const t of legalTargets) squareStyles[t] = { backgroundImage: 'radial-gradient(circle, rgba(42,120,214,0.55) 22%, transparent 24%)' };
  if (hint && error.bestUci && !solved) squareStyles[error.bestUci.slice(0, 2)] = { boxShadow: 'inset 0 0 0 4px rgba(12,163,12,0.9)' };
  const side = error.color === 'w' ? 'White' : 'Black';

  return (
    <div className="practice">
      <div className="card practice-main" data-best={error.bestUci ?? undefined} data-played={error.uci}>
        <div className="practice-head">
          <div>
            <h3>
              Position {cursor + 1} of {queue.length} · {side} to move
            </h3>
            <span className="muted small">
              Move {error.moveNumber} vs {puzzle.game.opponent} · {ERROR_TYPE_LABEL[error.type]}
              {queue.indexOf(index) !== cursor
                ? ' · ↻ you missed this one earlier — second try'
                : (streaks[puzzleKey(puzzle)] ?? 0) > 0 && !results[cursor]
                  ? ` · solved first try ${streaks[puzzleKey(puzzle)]}× before`
                  : ''}
            </span>
          </div>
          <span className="practice-score" title="Solved on the first try / attempted">
            {firstTry}/{done} first try
          </span>
        </div>

        {!solved && <p className="practice-prompt">{PROMPT[error.type]}</p>}
        {!solved ? (
          <div className="practice-cols">
            <div className="practice-board board-box">
              <Chessboard
                options={{
                  id: `p-${cursor}`,
                  position: fen ?? error.fenBefore,
                  boardOrientation: error.color === 'w' ? 'white' : 'black',
                  allowDragging: status === 'idle' || status === 'wrong',
                  allowDrawingArrows: false,
                  animationDurationInMs: 150,
                  squareStyles,
                  canDragPiece: ({ piece }) => piece.pieceType[0] === error.color,
                  onPieceDrop: ({ sourceSquare, targetSquare }) => !!targetSquare && tryMove(sourceSquare, targetSquare),
                  onSquareClick: ({ square, piece }) => onSquare(square, !!piece && piece.pieceType[0] === error.color),
                  ...BOARD_STYLE,
                }}
              />
            </div>
            <div className="practice-side">
              <p className="muted small">Drag a piece, or tap it and then tap the square. Any strong move counts, not just the engine’s favourite.</p>
              <div className={`practice-msg ${status}`} role="status" aria-live="polite">
                {status === 'checking' && <span className="spinner" />}
                {message}
              </div>
              <div className="practice-actions">
                <button className="secondary" onClick={() => setHint(true)} disabled={hint}>
                  Hint: which piece?
                </button>
                <button className="secondary" onClick={() => finish('shown', `The best move was ${error.bestSan}.`)}>
                  Show answer
                </button>
                <button className="secondary" onClick={() => go((cursor + 1) % queue.length)}>
                  Skip
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="practice-cols">
            <LineBoard key={`a-${cursor}`} error={error} game={puzzle.game} startOn="best" />
            <div className="practice-side">
              <div className={`practice-msg ${status}`} role="status">
                {status === 'correct' ? '✓ ' : ''}
                {message}
              </div>
              <p className="muted small">Step through both lines on the board: what happened in the game, and the better continuation.</p>
              <div className="practice-actions">
                {cursor + 1 < queue.length ? (
                  <button className="primary" onClick={() => go(cursor + 1)}>
                    Next position
                  </button>
                ) : (
                  <span className="practice-done">
                    Session complete — {firstTry} of {puzzles.length} solved first try. Come back tomorrow: positions you missed are shown first.
                  </span>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="practice-dots" aria-label="Positions">
        {queue.map((p, i) => (
          <button
            key={i}
            className={`pdot ${i === cursor ? 'current' : ''} ${results[i] ?? ''}`}
            onClick={() => go(i)}
            aria-label={`Position ${i + 1}${results[i] ? ` (${results[i] === 'first' ? 'solved first try' : results[i] === 'later' ? 'solved after a miss' : 'answer shown'})` : ''}`}
          >
            {queue.indexOf(p) !== i ? '↻' : i + 1}
          </button>
        ))}
        <span className="muted small practice-legend">
          <i className="dot first" /> first try <i className="dot later" /> after a miss <i className="dot shown" /> answer shown
        </span>
      </div>
    </div>
  );
}
