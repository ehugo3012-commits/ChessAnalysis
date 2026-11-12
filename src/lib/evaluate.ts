import { Chess, type Square } from 'chess.js';
import type { ErrorType, Game, GameEval, GameReport, MoveError, Phase, PhaseStat, Ply, Severity } from './types';

/** Win-probability loss (percentage points) at which a move gets flagged. */
export const THRESHOLDS = { inaccuracy: 5, mistake: 10, blunder: 15 } as const;

const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };

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

function uciToSan(fen: string, uci: string | null): string | null {
  if (!uci) return null;
  try {
    const chess = new Chess(fen);
    const mv = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    return mv.san;
  } catch {
    return null;
  }
}

/**
 * True when the opponent's best reply simply takes a piece that was left
 * undefended, under-defended, or attackable by something cheaper.
 */
function isHungPiece(fenAfter: string, refutation: string | null, userCapturedValue: number): boolean {
  if (!refutation) return false;
  const chess = new Chess(fenAfter);
  const to = refutation.slice(2, 4) as Square;
  const from = refutation.slice(0, 2) as Square;
  const target = chess.get(to);
  const capturer = chess.get(from);
  if (!target || !capturer || target.color === capturer.color) return false;
  const targetValue = PIECE_VALUE[target.type];
  if (targetValue < 3) return false;
  // A fair trade the user started is a bad decision, not a hung piece.
  if (userCapturedValue >= targetValue - 1) return false;
  const attackers = chess.attackers(to, capturer.color).length;
  const defenders = chess.attackers(to, target.color).length;
  return defenders === 0 || PIECE_VALUE[capturer.type] < targetValue || attackers > defenders;
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
    const window = win.slice(Math.max(0, start), Math.max(0, start) + size);
    weights.push(Math.max(0.5, Math.min(12, stddev(window))));
  }
  return weights;
}

/** Turns raw engine output into a per-game report from the user's point of view. */
export function buildReport(game: Game, ev: GameEval): GameReport {
  const userIsWhite = game.userColor === 'w';
  const win = ev.cp.map((cp) => (userIsWhite ? winPct(cp) : 100 - winPct(cp)));
  const userMate = ev.mate.map((m) => (m === null ? null : userIsWhite ? m : -m));

  const phases: Record<Phase, PhaseStat> = {
    opening: { moves: 0, accuracySum: 0, inverseSum: 0 },
    middlegame: { moves: 0, accuracySum: 0, inverseSum: 0 },
    endgame: { moves: 0, accuracySum: 0, inverseSum: 0 },
  };
  const weights = volatilityWeights(win);
  const side = () => ({ stat: { moves: 0, accuracySum: 0, inverseSum: 0 }, weighted: 0, weight: 0 });
  const totals = { user: side(), opponent: side() };
  const errors: MoveError[] = [];
  let prevOpponentLoss = 0;

  game.plies.forEach((ply, i) => {
    const isUser = ply.color === game.userColor;
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
    if (!isUser) {
      prevOpponentLoss = loss;
      return;
    }
    phases[ply.phase].moves++;
    phases[ply.phase].accuracySum += acc;
    phases[ply.phase].inverseSum += 1 / Math.max(acc, 1);

    const severity = severityOf(loss);
    if (!severity) return;

    const mateBefore = userMate[i];
    const mateAfter = userMate[i + 1];
    const missedMate = mateBefore !== null && mateBefore > 0 && mateBefore <= 5 && !(mateAfter !== null && mateAfter > 0);
    const allowedMate =
      mateAfter !== null && mateAfter < 0 && mateAfter >= -6 && !(mateBefore !== null && mateBefore < 0);

    const refutation = ev.best[i + 1];
    const capturedValue = (() => {
      const piece = new Chess(ply.fenBefore).get(ply.to as Square);
      return piece ? PIECE_VALUE[piece.type] : 0;
    })();

    let type: ErrorType = 'other';
    if (allowedMate) type = 'allowed_mate';
    else if (isHungPiece(ply.fenAfter, refutation, capturedValue)) type = 'hung';
    else if (missedMate || (before >= 65 && prevOpponentLoss >= THRESHOLDS.mistake)) type = 'missed_win';

    const inTimeTrouble =
      game.hasClocks && ply.clockBefore !== undefined && ply.clockBefore < timeTroubleThreshold(game.baseTime);
    const impulsive = isImpulsive(game, ply);

    errors.push({
      gameId: game.id,
      plyIndex: i,
      moveNumber: ply.moveNumber,
      color: ply.color,
      san: ply.san,
      uci: ply.uci,
      bestUci: ev.best[i],
      bestSan: uciToSan(ply.fenBefore, ev.best[i]),
      refutationUci: refutation,
      refutationSan: uciToSan(ply.fenAfter, refutation),
      fenBefore: ply.fenBefore,
      winBefore: before,
      winAfter: after,
      loss,
      severity,
      type,
      phase: ply.phase,
      missedMate,
      inTimeTrouble,
      impulsive,
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
  };
}
