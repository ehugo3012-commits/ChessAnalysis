import { Chess, type Square } from 'chess.js';
import { PIECE_NAME, PIECE_VALUE, detectMotifInLine, isBackRankMate, lineToSan, materialSwing, pieceAt, type MotifHit } from './tactics';
import type {
  EndgameEntry,
  ErrorType,
  Game,
  GameEval,
  GameReport,
  LossCause,
  Motif,
  MoveError,
  OpeningHabits,
  Phase,
  PhaseStat,
  Ply,
  Severity,
} from './types';

/** Win-probability loss (percentage points) at which a move gets flagged. */
export const THRESHOLDS = { inaccuracy: 5, mistake: 10, blunder: 15 } as const;

/** Win probability (0-100) for White given a centipawn score. Same curve Lichess uses. */
export function winPct(cpWhite: number): number {
  const cp = Math.max(-1500, Math.min(1500, cpWhite));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

/** Per-move accuracy (0-100) from the win probability a move gave away. */
export function moveAccuracy(loss: number): number {
  const acc = 103.1668 * Math.exp(-0.04354 * loss) - 3.1669;
  return Math.max(0, Math.min(100, acc));
}

export function severityOf(loss: number): Severity | null {
  if (loss >= THRESHOLDS.blunder) return 'blunder';
  if (loss >= THRESHOLDS.mistake) return 'mistake';
  if (loss >= THRESHOLDS.inaccuracy) return 'inaccuracy';
  return null;
}

/**
 * When the opponent's best reply simply takes a piece that was left undefended,
 * under-defended, or attackable by something cheaper, returns that piece.
 */
function hungPiece(
  fenAfter: string,
  refutation: string | null,
  userCapturedValue: number,
): { square: string; piece: string; undefended: boolean } | null {
  if (!refutation) return null;
  const chess = new Chess(fenAfter);
  const to = refutation.slice(2, 4) as Square;
  const from = refutation.slice(0, 2) as Square;
  const target = chess.get(to);
  const capturer = chess.get(from);
  if (!target || !capturer || target.color === capturer.color) return null;
  const targetValue = PIECE_VALUE[target.type];
  if (targetValue < 3) return null;
  // A fair trade the user started is a bad decision, not a hung piece.
  if (userCapturedValue >= targetValue - 1) return null;
  const attackers = chess.attackers(to, capturer.color).length;
  const defenders = chess.attackers(to, target.color).length;
  if (defenders === 0 || PIECE_VALUE[capturer.type] < targetValue || attackers > defenders) {
    return { square: to, piece: target.type, undefended: defenders === 0 };
  }
  return null;
}

export function timeTroubleThreshold(baseTime: number): number {
  return Math.max(10, baseTime * 0.1);
}

/** A move played almost instantly although there was plenty of time to think. */
export function isImpulsive(game: Game, ply: Ply): boolean {
  return (
    game.hasClocks &&
    game.baseTime >= 180 &&
    ply.spent !== undefined &&
    ply.clockBefore !== undefined &&
    ply.spent <= Math.max(2, game.baseTime / 100) &&
    ply.clockBefore >= game.baseTime * 0.25
  );
}

/**
 * Blends the arithmetic and harmonic mean of move accuracies. The harmonic part
 * makes a few terrible moves count for more than many fine ones, like real games do.
 */
export function blendAccuracy(stat: PhaseStat, weightedMean?: number): number | null {
  if (!stat.moves) return null;
  const harmonic = stat.moves / stat.inverseSum;
  return ((weightedMean ?? stat.accuracySum / stat.moves) + harmonic) / 2;
}

function stddev(xs: number[]): number {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

/**
 * Per-move weights following Lichess's accuracy method: moves made while the
 * evaluation is swinging (sharp positions) count for more than moves in dead-calm ones.
 */
function volatilityWeights(win: number[]): number[] {
  const moves = win.length - 1;
  const size = Math.max(2, Math.min(8, Math.floor(moves / 10)));
  const weights: number[] = [];
  for (let i = 0; i < moves; i++) {
    const start = Math.max(0, Math.min(i - (size - 2), win.length - size));
    weights.push(Math.max(0.5, Math.min(12, stddev(win.slice(start, start + size)))));
  }
  return weights;
}

const pieceOn = (fen: string, sq: string) => {
  const t = pieceAt(fen, sq);
  return t ? `${PIECE_NAME[t]} on ${sq}` : sq;
};

/** One sentence, in plain language, that says what was wrong with the move. */
function explain(e: {
  type: ErrorType;
  san: string;
  bestSan: string | null;
  refutationSan: string | null;
  hit: MotifHit | null;
  motif: Motif;
  fenForTargets: string;
  hung: { square: string; piece: string; undefended: boolean } | null;
  movedTo: string;
  mateIn: number | null;
  loss: number;
}): string {
  const ref = e.refutationSan ?? 'the reply';
  const best = e.bestSan ?? 'the best move';
  const t = (e.hit?.targets ?? []).map((sq) => pieceOn(e.fenForTargets, sq));
  switch (e.type) {
    case 'hung':
      if (!e.hung) return `${e.san} loses material to ${ref}.`;
      return e.hung.square === e.movedTo
        ? `${e.san} puts your ${PIECE_NAME[e.hung.piece]} on a square where it can simply be taken: ${ref}.`
        : `${e.san} leaves your ${PIECE_NAME[e.hung.piece]} on ${e.hung.square} ${e.hung.undefended ? 'undefended' : 'without enough protection'} — ${ref} wins it.`;
    case 'allowed_mate':
      return `${e.san} allows a forced checkmate${e.mateIn ? ` in ${e.mateIn}` : ''}${e.motif === 'back_rank' ? ' on your back rank' : ''}, starting with ${ref}.`;
    case 'allowed_tactic':
      switch (e.motif) {
        case 'fork':
          return `${e.san} allows ${ref}, a fork that hits your ${t.join(' and your ')} at the same time.`;
        case 'pin':
          return `${e.san} allows ${ref}, pinning your ${t[0]} to your ${t[1]}.`;
        case 'skewer':
          return `${e.san} allows ${ref}, a skewer: your ${t[0]} has to move and the ${t[1]} behind it falls.`;
        case 'discovered':
          return `${e.san} allows ${ref}, which uncovers an attack on your ${t[0]}.`;
        case 'capture':
          return `${e.san} allows ${ref}, winning your ${t[0]}.`;
        default:
          return `${e.san} allows a sequence starting with ${ref} that wins material by force.`;
      }
    case 'missed_mate':
      return `You had a forced checkmate${e.mateIn ? ` in ${e.mateIn}` : ''} starting with ${best}${e.motif === 'back_rank' ? ' (a back-rank mate)' : ''}.`;
    case 'missed_tactic':
      switch (e.motif) {
        case 'capture':
          return `${best} simply wins the ${t[0]} — it was there for the taking.`;
        case 'fork':
          return `${best} was a fork, attacking the ${t.join(' and the ')} at once.`;
        case 'pin':
          return `${best} pins the ${t[0]} to the ${t[1]} and wins material.`;
        case 'skewer':
          return `${best} is a skewer: the ${t[0]} must move and the ${t[1]} behind it falls.`;
        case 'discovered':
          return `${best} uncovers an attack on the ${t[0]} and wins material.`;
        default:
          return `${best} starts a forcing sequence that wins material.`;
      }
    default:
      switch (e.motif) {
        case 'pawn':
          return `${e.san} drops a pawn after ${ref}; ${best} held the material.`;
        case 'trade':
          return `${e.san} starts an exchange that helps your opponent — once the pieces come off you are clearly worse. ${best} kept the tension.`;
        case 'king_pawn':
          return `${e.san} pushes a pawn in front of your own king and loosens its cover; ${best} kept the king safe.`;
        case 'development':
          return `${e.san} spends an opening move without bringing a new piece into play; ${best} continued development.`;
        case 'technique':
          return `In the endgame every tempo counts: ${e.san} is too slow, and ${best} was the precise move.`;
        default:
          return `${e.san} loses no material straight away but hands over about ${Math.round(e.loss)}% of your winning chances; ${best} was the better plan.`;
      }
  }
}

/** What kind of non-tactical mistake a move was, from cheap structural clues. */
function positionalKind(ply: Ply, bestUci: string | null, playedLine: string[], materialGap: number): Motif {
  if (materialGap >= 1) return 'pawn';
  const captured = pieceAt(ply.fenBefore, ply.to);
  if (captured && playedLine[1]?.slice(2, 4) === ply.to) return 'trade';
  const chess = new Chess(ply.fenBefore);
  const moved = chess.get(ply.from as Square);
  const homeRank = ply.color === 'w' ? '1' : '8';
  if (moved?.type === 'p') {
    const king = chess.board().flat().find((p) => p && p.type === 'k' && p.color === ply.color);
    const near = king && Math.abs(king.square.charCodeAt(0) - ply.from.charCodeAt(0)) <= 1;
    // Only a king that has left the centre has "cover" to weaken.
    if (king && near && king.square[1] === homeRank && !'de'.includes(king.square[0])) return 'king_pawn';
  }
  if (ply.phase === 'opening' && bestUci) {
    const develops = (uci: string) => {
      const p = chess.get(uci.slice(0, 2) as Square);
      if (!p) return false;
      const castles = p.type === 'k' && Math.abs(uci.charCodeAt(0) - uci.charCodeAt(2)) === 2;
      return castles || ('nb'.includes(p.type) && uci[1] === homeRank);
    };
    if (develops(bestUci) && !develops(ply.uci)) return 'development';
  }
  if (ply.phase === 'endgame') return 'technique';
  return 'plan';
}

function openingHabits(game: Game): OpeningHabits | null {
  if (game.plies.length < 20) return null;
  const mine = game.plies.filter((p) => p.color === game.userColor);
  const castle = mine.find((p) => p.san.startsWith('O-O'));
  const queenMoves = mine.filter((p) => p.moveNumber <= 8 && p.san.startsWith('Q')).length;
  // Position after ten full moves.
  const chess = new Chess(game.plies[20]?.fenBefore ?? game.plies[19].fenAfter);
  const rank = game.userColor === 'w' ? '1' : '8';
  const home: [string, string][] = [['b', 'n'], ['g', 'n'], ['c', 'b'], ['f', 'b']];
  const undeveloped = home.filter(([file, type]) => {
    const p = chess.get(`${file}${rank}` as Square);
    return p && p.color === game.userColor && p.type === type;
  }).length;
  return { castledAt: castle ? castle.moveNumber : null, earlyQueen: queenMoves >= 2, minorsDeveloped: 4 - undeveloped };
}

function endgameEntry(game: Game, win: number[]): EndgameEntry | null {
  const first = game.plies.find((p) => p.phase === 'endgame');
  if (!first) return null;
  const board = first.fenBefore.split(' ')[0].toLowerCase();
  const has = (c: string) => board.includes(c);
  const minor = has('n') || has('b');
  const kind: EndgameEntry['kind'] =
    !has('q') && !has('r') && !minor ? 'pawn' : has('r') && !has('q') && !minor ? 'rook' : minor && !has('q') && !has('r') ? 'minor' : has('q') && !has('r') && !minor ? 'queen' : 'mixed';
  return { kind, winAtEntry: win[first.index] };
}

/** For a lost game: the moment (or reason) the game was decided. */
function decisiveMoment(game: Game, win: number[], errors: MoveError[]): GameReport['decisive'] {
  if (game.outcome !== 'loss') return null;
  const serious = errors.filter((e) => e.severity !== 'inaccuracy');
  let lastOk = -1;
  for (let i = 0; i < win.length; i++) if (win[i] >= 45) lastOk = i;
  if (lastOk >= win.length - 2) {
    // Still fine at the very end: the position did not lose this game.
    if (game.endReason === 'timeout') return { cause: 'time', error: null };
    if (game.endReason === 'resignation' || game.endReason === 'abandonment') return { cause: 'resigned_early', error: null };
  }
  const byLoss = (a: MoveError, b: MoveError) => b.loss - a.loss;
  // The error that took the user below an even game for good.
  const turning = serious.filter((e) => Math.abs(e.plyIndex - lastOk) <= 1).sort(byLoss)[0];
  const fallback = serious.filter((e) => e.winBefore >= 35).sort(byLoss)[0];
  const error = turning ?? fallback ?? null;
  const cause: LossCause = error ? error.type : 'outplayed';
  return { cause, error };
}

/** Turns raw engine output into a per-game report from the user's point of view. */
export function buildReport(game: Game, ev: GameEval): GameReport {
  const user = game.userColor;
  const userIsWhite = user === 'w';
  const win = ev.cp.map((cp) => (userIsWhite ? winPct(cp) : 100 - winPct(cp)));
  const userMate = ev.mate.map((m) => (m === null ? null : userIsWhite ? m : -m));
  const pvAt = (i: number): string[] => {
    const pv = ev.pv?.[i];
    if (pv && pv.length) return pv;
    return ev.best[i] ? [ev.best[i]!] : [];
  };

  const phases: Record<Phase, PhaseStat> = {
    opening: { moves: 0, accuracySum: 0, inverseSum: 0 },
    middlegame: { moves: 0, accuracySum: 0, inverseSum: 0 },
    endgame: { moves: 0, accuracySum: 0, inverseSum: 0 },
  };
  const weights = volatilityWeights(win);
  const side = () => ({ stat: { moves: 0, accuracySum: 0, inverseSum: 0 }, weighted: 0, weight: 0 });
  const totals = { user: side(), opponent: side() };
  const errors: MoveError[] = [];

  game.plies.forEach((ply, i) => {
    const isUser = ply.color === user;
    // Loss from the mover's perspective.
    const before = isUser ? win[i] : 100 - win[i];
    const after = isUser ? win[i + 1] : 100 - win[i + 1];
    const loss = Math.max(0, before - after);
    const acc = moveAccuracy(loss);

    const total = isUser ? totals.user : totals.opponent;
    total.stat.moves++;
    total.stat.accuracySum += acc;
    total.stat.inverseSum += 1 / Math.max(acc, 1);
    total.weighted += acc * weights[i];
    total.weight += weights[i];
    if (!isUser) return;
    phases[ply.phase].moves++;
    phases[ply.phase].accuracySum += acc;
    phases[ply.phase].inverseSum += 1 / Math.max(acc, 1);

    const severity = severityOf(loss);
    if (!severity) return;

    const mateBefore = userMate[i];
    const mateAfter = userMate[i + 1];
    const missedMate = mateBefore !== null && mateBefore > 0 && mateBefore <= 5 && !(mateAfter !== null && mateAfter > 0);
    const allowedMate = mateAfter !== null && mateAfter < 0 && mateAfter >= -6 && !(mateBefore !== null && mateBefore < 0);

    const bestUci = ev.best[i];
    const bestLine = pvAt(i).slice(0, 6);
    const refutation = ev.best[i + 1];
    const playedLine = [ply.uci, ...pvAt(i + 1).slice(0, 5)];
    const capturedType = pieceAt(ply.fenBefore, ply.to);
    const hung = hungPiece(ply.fenAfter, refutation, capturedType ? PIECE_VALUE[capturedType] : 0);

    let type: ErrorType = 'positional';
    let hit: MotifHit | null = null;
    let motif: Motif = null;
    let fenForTargets = ply.fenAfter;
    if (allowedMate) {
      type = 'allowed_mate';
      if (isBackRankMate(ply.fenAfter, pvAt(i + 1))) motif = 'back_rank';
    } else if (hung) {
      type = 'hung';
    } else if (missedMate) {
      type = 'missed_mate';
      if (isBackRankMate(ply.fenBefore, pvAt(i))) motif = 'back_rank';
    } else if (severity !== 'inaccuracy') {
      // Was material at stake? Compare where the best line and the game line end up.
      const swingBest = materialSwing(ply.fenBefore, bestLine, user, 6);
      const swingPlayed = materialSwing(ply.fenBefore, playedLine, user, 6);
      if (swingBest - swingPlayed >= 2) {
        // Losing material is the story unless the chance you passed up was even bigger.
        if (swingPlayed < 0 && -swingPlayed >= Math.max(0, swingBest)) {
          type = 'allowed_tactic';
          hit = detectMotifInLine(ply.fenAfter, pvAt(i + 1));
        } else {
          type = 'missed_tactic';
          hit = detectMotifInLine(ply.fenBefore, pvAt(i));
          fenForTargets = ply.fenBefore;
        }
        motif = hit?.motif ?? null;
      } else {
        motif = positionalKind(ply, bestUci, playedLine, swingBest - swingPlayed);
      }
    }

    const bestSan = lineToSan(ply.fenBefore, bestUci ? [bestUci] : [])[0] ?? null;
    const refutationSan = lineToSan(ply.fenAfter, refutation ? [refutation] : [])[0] ?? null;
    errors.push({
      gameId: game.id,
      plyIndex: i,
      moveNumber: ply.moveNumber,
      color: ply.color,
      san: ply.san,
      uci: ply.uci,
      bestUci,
      bestSan,
      refutationUci: refutation,
      refutationSan,
      fenBefore: ply.fenBefore,
      winBefore: before,
      winAfter: after,
      loss,
      severity,
      type,
      motif,
      lostPiece: hung?.piece ?? null,
      bestLine,
      playedLine,
      explanation: explain({
        type,
        san: ply.san,
        bestSan,
        refutationSan,
        hit,
        motif,
        fenForTargets,
        hung,
        movedTo: ply.to,
        mateIn: type === 'allowed_mate' ? Math.abs(mateAfter!) : type === 'missed_mate' ? mateBefore : null,
        loss,
      }),
      phase: ply.phase,
      inTimeTrouble: game.hasClocks && ply.clockBefore !== undefined && ply.clockBefore < timeTroubleThreshold(game.baseTime),
      impulsive: isImpulsive(game, ply),
      clockBefore: ply.clockBefore,
      spent: ply.spent,
    });
  });

  let hadWinning = false;
  let hadLost = false;
  for (let i = 0; i + 1 < win.length; i++) {
    if (win[i] >= 85 && win[i + 1] >= 85) hadWinning = true;
    if (win[i] <= 15 && win[i + 1] <= 15) hadLost = true;
  }

  let openingEval: number | null = null;
  if (ev.cp.length > 20) {
    const cp = Math.max(-600, Math.min(600, ev.cp[20]));
    openingEval = userIsWhite ? cp : -cp;
  }

  return {
    gameId: game.id,
    win,
    accuracy: blendAccuracy(totals.user.stat, totals.user.weighted / (totals.user.weight || 1)),
    opponentAccuracy: blendAccuracy(totals.opponent.stat, totals.opponent.weighted / (totals.opponent.weight || 1)),
    phases,
    errors,
    hadWinning,
    hadLost,
    openingEval,
    finalWin: win[win.length - 1],
    habits: openingHabits(game),
    endgame: endgameEntry(game, win),
    decisive: decisiveMoment(game, win, errors),
  };
}
