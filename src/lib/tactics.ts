import { Chess, type Color, type Move, type PieceSymbol, type Square } from 'chess.js';

export const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
export const PIECE_NAME: Record<string, string> = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
  k: 'king',
};

const FILES = 'abcdefgh';
const other = (c: Color): Color => (c === 'w' ? 'b' : 'w');

export function applyUci(chess: Chess, uci: string): Move | null {
  try {
    return chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  } catch {
    return null;
  }
}

/** Converts a UCI line into SAN, stopping at the first move that does not apply. */
export function lineToSan(fen: string, line: string[]): string[] {
  const chess = new Chess(fen);
  const out: string[] = [];
  for (const uci of line) {
    const mv = applyUci(chess, uci);
    if (!mv) break;
    out.push(mv.san);
  }
  return out;
}

/** FEN after each move of a line; index 0 is the starting position. */
export function lineFens(fen: string, line: string[]): string[] {
  const chess = new Chess(fen);
  const out = [fen];
  for (const uci of line) {
    if (!applyUci(chess, uci)) break;
    out.push(chess.fen());
  }
  return out;
}

function pieces(chess: Chess, color: Color): { square: Square; type: PieceSymbol }[] {
  const out: { square: Square; type: PieceSymbol }[] = [];
  for (const row of chess.board()) {
    for (const p of row) if (p && p.color === color) out.push({ square: p.square, type: p.type });
  }
  return out;
}

/** Material for `color` minus material for the other side, in pawns. */
function balance(chess: Chess, color: Color): number {
  let total = 0;
  for (const row of chess.board()) {
    for (const p of row) {
      if (!p || p.type === 'k') continue;
      total += p.color === color ? PIECE_VALUE[p.type] : -PIECE_VALUE[p.type];
    }
  }
  return total;
}

/**
 * How much material `color` gains (positive) or loses over an engine line.
 * If the cut-off falls in the middle of an exchange, the captures are played out.
 */
export function materialSwing(fen: string, line: string[], color: Color, maxPlies = 6): number {
  const chess = new Chess(fen);
  const start = balance(chess, color);
  let lastWasCapture = false;
  for (let i = 0; i < line.length; i++) {
    if (i >= maxPlies && (!lastWasCapture || i >= maxPlies + 4)) break;
    const mv = applyUci(chess, line[i]);
    if (!mv) break;
    lastWasCapture = mv.captured !== undefined;
  }
  return balance(chess, color) - start;
}

export interface MotifHit {
  motif: 'fork' | 'pin' | 'skewer' | 'discovered' | 'capture';
  /** Squares of the pieces the tactic is aimed at. */
  targets: Square[];
}

const DIRS: Record<string, [number, number][]> = {
  b: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
  r: [[1, 0], [-1, 0], [0, 1], [0, -1]],
  q: [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]],
};

/** The first two pieces met when walking from `from` in one direction. */
function ray(chess: Chess, from: Square, [df, dr]: [number, number]) {
  const hits: { square: Square; type: PieceSymbol; color: Color }[] = [];
  let f = FILES.indexOf(from[0]) + df;
  let r = Number(from[1]) + dr;
  while (f >= 0 && f < 8 && r >= 1 && r <= 8 && hits.length < 2) {
    const square = `${FILES[f]}${r}` as Square;
    const p = chess.get(square);
    if (p) hits.push({ square, type: p.type, color: p.color });
    f += df;
    r += dr;
  }
  return hits;
}

/**
 * Names the tactical idea behind a move, from the mover's point of view.
 * The move is assumed to be sound (it comes from an engine line), so this only
 * has to recognise the geometry, not prove that it works.
 */
export function detectMotif(fen: string, uci: string | null): MotifHit | null {
  if (!uci) return null;
  const chess = new Chess(fen);
  const me = chess.turn();
  const them = other(me);
  const attackedBefore = new Map<Square, Set<Square>>();
  for (const p of pieces(chess, them)) attackedBefore.set(p.square, new Set(chess.attackers(p.square, me)));

  const mv = applyUci(chess, uci);
  if (!mv) return null;
  const to = mv.to;
  const mover = mv.promotion ?? mv.piece;

  // 1. Simply taking something that was free or worth more.
  if (mv.captured && PIECE_VALUE[mv.captured] >= 3) {
    const recapturable = chess.attackers(to, them).length > 0;
    if (!recapturable || PIECE_VALUE[mv.captured] > PIECE_VALUE[mv.piece]) return { motif: 'capture', targets: [to] };
  }

  const enemy = pieces(chess, them);
  const worthHitting = (p: { square: Square; type: PieceSymbol }, attackerValue: number) =>
    p.type === 'k' ||
    (p.type !== 'p' &&
      (PIECE_VALUE[p.type] > attackerValue ||
        // Loose, or attacked more often than it is defended.
        chess.attackers(p.square, them).length < Math.max(1, chess.attackers(p.square, me).length)));

  // 2. Fork: the moved piece attacks two things that matter.
  const forked = enemy.filter((p) => chess.attackers(p.square, me).includes(to) && worthHitting(p, PIECE_VALUE[mover]));
  if (forked.length >= 2) return { motif: 'fork', targets: forked.map((p) => p.square) };

  // 3. Discovered attack: moving out of the way opens a line for another piece.
  for (const p of enemy) {
    const before = attackedBefore.get(p.square);
    for (const a of chess.attackers(p.square, me)) {
      if (a === to || before?.has(a)) continue;
      const slider = chess.get(a);
      if (slider && 'brq'.includes(slider.type) && worthHitting(p, PIECE_VALUE[slider.type])) {
        return { motif: 'discovered', targets: [p.square] };
      }
    }
  }

  // 4. Pin / skewer along the moved piece's lines.
  for (const dir of DIRS[mover] ?? []) {
    const [first, second] = ray(chess, to, dir);
    if (!first || !second || first.color !== them || second.color !== them) continue;
    const v1 = PIECE_VALUE[first.type];
    const v2 = PIECE_VALUE[second.type];
    if (v1 > v2 && v2 >= 3 && (first.type === 'k' || v1 > PIECE_VALUE[mover])) {
      return { motif: 'skewer', targets: [first.square, second.square] };
    }
    if (v2 > v1 && v1 >= 3) return { motif: 'pin', targets: [first.square, second.square] };
  }
  return null;
}

/**
 * Looks for a recognisable idea in the attacker's first two moves of a line
 * (plies 0 and 2), since many tactics start with a preparatory check or capture.
 */
export function detectMotifInLine(fen: string, line: string[]): MotifHit | null {
  const chess = new Chess(fen);
  for (let i = 0; i < Math.min(line.length, 3); i++) {
    if (i % 2 === 0) {
      const hit = detectMotif(chess.fen(), line[i]);
      // A plain capture only counts as the idea when it is the very first move.
      if (hit && (hit.motif !== 'capture' || i === 0)) return hit;
    }
    if (!applyUci(chess, line[i])) break;
  }
  return null;
}

/** True when a line ends in mate delivered along the defender's own back rank. */
export function isBackRankMate(fen: string, line: string[]): boolean {
  const chess = new Chess(fen);
  let last: Move | null = null;
  for (const uci of line) {
    const mv = applyUci(chess, uci);
    if (!mv) break;
    last = mv;
  }
  if (!last || !chess.isCheckmate() || !'rq'.includes(last.piece)) return false;
  const matedColor = chess.turn();
  const king = pieces(chess, matedColor).find((p) => p.type === 'k');
  const homeRank = matedColor === 'w' ? '1' : '8';
  return !!king && king.square[1] === homeRank && last.to[1] === homeRank;
}

export function pieceAt(fen: string, square: string): string | null {
  const p = new Chess(fen).get(square as Square);
  return p ? p.type : null;
}
