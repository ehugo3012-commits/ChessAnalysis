import { Chess } from 'chess.js';
import type { Color, EndReason, Game, Opening, Outcome, Phase, Ply, RawGame, TimeClass } from './types';

const DRAW_RESULTS = new Set([
  'agreed',
  'repetition',
  'stalemate',
  'insufficient',
  '50move',
  'timevsinsufficient',
]);

export function outcomeOf(result: string): Outcome {
  if (result === 'win') return 'win';
  return DRAW_RESULTS.has(result) ? 'draw' : 'loss';
}

function endReasonOf(whiteResult: string, blackResult: string): EndReason {
  // The non-"win" side carries the reason; for draws both sides carry it.
  const r = whiteResult === 'win' ? blackResult : whiteResult;
  switch (r) {
    case 'checkmated':
      return 'checkmate';
    case 'resigned':
      return 'resignation';
    case 'timeout':
      return 'timeout';
    case 'abandoned':
      return 'abandonment';
    case 'stalemate':
      return 'stalemate';
    case 'repetition':
      return 'repetition';
    case 'agreed':
      return 'agreement';
    case 'insufficient':
      return 'insufficient';
    case '50move':
      return 'fifty-move';
    case 'timevsinsufficient':
      return 'timeout-vs-insufficient';
    default:
      return 'other';
  }
}

/** "600" | "180+2" | "1/86400" -> seconds. */
export function parseTimeControl(tc: string): { base: number; increment: number } {
  if (tc.includes('/')) {
    const [, secs] = tc.split('/');
    return { base: Number(secs) || 0, increment: 0 };
  }
  const [base, inc] = tc.split('+');
  return { base: Number(base) || 0, increment: Number(inc) || 0 };
}

const FAMILY_END = /^(Defense|Defence|Opening|Game|Gambit|Attack|System|Countergambit)$/;
const POSSESSIVE: Record<string, string> = {
  Queens: "Queen's",
  Kings: "King's",
  Bishops: "Bishop's",
  Petrovs: "Petrov's",
  Alekhines: "Alekhine's",
  Birds: "Bird's",
  Larsens: "Larsen's",
  Reti: 'Réti',
  Grunfeld: 'Grünfeld',
};

/** Turns a chess.com opening URL into a readable name and a family for grouping. */
export function parseOpening(ecoUrl: string | undefined): Opening {
  if (!ecoUrl) return { name: 'Unknown opening', family: 'Unknown opening' };
  const slug = decodeURIComponent(ecoUrl.split('/').pop() ?? '');
  const words: string[] = [];
  for (const w of slug.split('-')) {
    // Stop at the trailing move list ("...3.Nf3-Nc6", "4...e5") or a bare "with".
    if (/\d\./.test(w) || /^(O-O|[KQRBN]?[a-h]?x?[a-h][1-8])$/.test(w)) break;
    if (w) words.push(POSSESSIVE[w] ?? w);
  }
  while (words.length && /^(with|and)$/i.test(words[words.length - 1])) words.pop();
  if (!words.length) return { name: 'Unknown opening', family: 'Unknown opening' };

  let end = words.findIndex((w) => FAMILY_END.test(w));
  if (end === -1) end = Math.min(words.length, 3) - 1;
  if (/^(Declined|Accepted)$/.test(words[end + 1] ?? '')) end++;
  return { name: words.join(' '), family: words.slice(0, end + 1).join(' ') };
}

const CLOCK_RE = /\[%clk\s+(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)\]/g;

export function extractClocks(pgn: string): number[] {
  const clocks: number[] = [];
  for (const m of pgn.matchAll(CLOCK_RE)) {
    clocks.push(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
  }
  return clocks;
}

function header(pgn: string, name: string): string | undefined {
  const m = pgn.match(new RegExp(`\\[${name} "([^"]*)"\\]`));
  return m?.[1];
}

/** Number of knights, bishops, rooks and queens on the board (both sides). */
function pieceCount(fen: string): number {
  const board = fen.split(' ')[0];
  let n = 0;
  for (const ch of board) if ('nbrqNBRQ'.includes(ch)) n++;
  return n;
}

/**
 * Converts a chess.com game into our model. Returns null for games we cannot
 * analyse (no moves, unreadable PGN, user not a participant).
 */
export function parseGame(raw: RawGame, username: string): Game | null {
  const user = username.toLowerCase();
  const isWhite = raw.white.username.toLowerCase() === user;
  const isBlack = raw.black.username.toLowerCase() === user;
  if ((!isWhite && !isBlack) || !raw.pgn) return null;
  const userColor: Color = isWhite ? 'w' : 'b';
  const me = isWhite ? raw.white : raw.black;
  const opp = isWhite ? raw.black : raw.white;

  const chess = new Chess();
  try {
    chess.loadPgn(raw.pgn);
  } catch {
    return null;
  }
  const history = chess.history({ verbose: true });
  if (history.length < 2) return null;

  const { base, increment } = parseTimeControl(raw.time_control);
  const isDaily = raw.time_class === 'daily';
  const clocks = isDaily ? [] : extractClocks(raw.pgn);
  const hasClocks = clocks.length === history.length;

  let endgameReached = false;
  const plies: Ply[] = history.map((m, i) => {
    const moveNumber = Math.floor(i / 2) + 1;
    if (!endgameReached && pieceCount(m.before) <= 6) endgameReached = true;
    const phase: Phase = endgameReached ? 'endgame' : moveNumber <= 10 ? 'opening' : 'middlegame';
    const ply: Ply = {
      index: i,
      moveNumber,
      color: m.color,
      san: m.san,
      uci: m.from + m.to + (m.promotion ?? ''),
      from: m.from,
      to: m.to,
      fenBefore: m.before,
      fenAfter: m.after,
      phase,
    };
    if (hasClocks) {
      const before = i >= 2 ? clocks[i - 2] : base;
      ply.clockBefore = before;
      ply.clockAfter = clocks[i];
      ply.spent = Math.max(0, before + increment - clocks[i]);
    }
    return ply;
  });

  return {
    id: raw.url,
    url: raw.url,
    endTime: raw.end_time,
    rated: raw.rated,
    timeClass: raw.time_class as TimeClass,
    baseTime: base,
    increment,
    userColor,
    userRating: me.rating,
    opponent: opp.username,
    opponentRating: opp.rating,
    outcome: outcomeOf(me.result),
    endReason: endReasonOf(raw.white.result, raw.black.result),
    opening: parseOpening(header(raw.pgn, 'ECOUrl') ?? raw.eco),
    plies,
    hasClocks,
    terminal: chess.isCheckmate() ? 'checkmate' : chess.isStalemate() ? 'stalemate' : null,
  };
}
