import { isImpulsive, blendAccuracy } from './evaluate';
import { PIECE_NAME } from './tactics';
import type {
  AnalysedGame,
  Color,
  EndReason,
  ErrorType,
  Insight,
  LossCause,
  Motif,
  MoveError,
  Outcome,
  Phase,
} from './types';

export interface Record3 {
  n: number;
  wins: number;
  draws: number;
  losses: number;
  /** Points scored as a percentage (win = 1, draw = 0.5). */
  score: number;
}

export interface OpeningRow extends Record3 {
  family: string;
  color: Color;
  accuracy: number | null;
}

export interface RatingBand extends Record3 {
  label: string;
  /** Score the rating difference predicts, as a percentage. */
  expected: number;
}

export interface HabitStats {
  games: number;
  neverCastled: number;
  neverCastledScore: number;
  avgCastleMove: number | null;
  earlyQueen: number;
  avgMinors: number;
}

export interface Summary extends Record3 {
  byColor: Record<Color, Record3 & { accuracy: number | null }>;
  accuracy: number | null;
  opponentAccuracy: number | null;
  phaseAccuracy: Record<Phase, { accuracy: number | null; moves: number }>;
  severityCounts: { inaccuracy: number; mistake: number; blunder: number };
  /** Mistakes + blunders by cause, and the winning chances each cause gave away (in game points). */
  typeCounts: Record<ErrorType, number>;
  typeCost: Record<ErrorType, number>;
  /** Tactical ideas the user fell for / failed to play. */
  motifsAllowed: Record<string, number>;
  motifsMissed: Record<string, number>;
  /** Positional slips by kind. */
  positionalKinds: Record<string, number>;
  /** What decided each lost game. */
  lossCauses: Partial<Record<LossCause, number>>;
  bands: RatingBand[];
  expectedScore: number;
  habits: HabitStats | null;
  /** Endgames entered from a level or better position. */
  endgames: { n: number; score: number; expected: number; byKind: Record<string, number> } | null;
  userMoves: number;
  winReasons: Partial<Record<EndReason, number>>;
  lossReasons: Partial<Record<EndReason, number>>;
  drawReasons: Partial<Record<EndReason, number>>;
  openings: OpeningRow[];
  ratingNow: number;
  ratingChange: number;
  avgOpponentRating: number;
  hasClocks: boolean;
  timeTroubleErrors: number;
  impulsiveErrors: number;
  /** Average seconds per move overall and on mistakes/blunders (live games only). */
  thinkTime: { all: number; errors: number } | null;
  seriousErrors: number;
}

export interface Strength {
  title: string;
  detail: string;
}

export interface Analysis {
  summary: Summary;
  insights: Insight[];
  strengths: Strength[];
}

function record(outcomes: Outcome[]): Record3 {
  const wins = outcomes.filter((o) => o === 'win').length;
  const draws = outcomes.filter((o) => o === 'draw').length;
  const losses = outcomes.length - wins - draws;
  const n = outcomes.length;
  return { n, wins, draws, losses, score: n ? ((wins + draws / 2) / n) * 100 : 0 };
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

const pct = (x: number) => `${Math.round(x)}%`;
const plural = (n: number, word: string, pluralWord = `${word}s`) => `${n} ${n === 1 ? word : pluralWord}`;
const clamp = (x: number) => Math.max(0, Math.min(100, x));
const rate = (x: number) => (x >= 1 ? x.toFixed(1) : x.toFixed(2));
/** Winning chances given away, in game points. */
const costOf = (es: MoveError[]) => es.reduce((s, e) => s + e.loss, 0) / 100;

export const MOTIF_LABEL: Record<string, string> = {
  fork: 'Forks',
  pin: 'Pins',
  skewer: 'Skewers',
  discovered: 'Discovered attacks',
  capture: 'Simple captures',
  back_rank: 'Back-rank mates',
  mate: 'Other mating attacks',
  combo: 'Longer combinations',
  pawn: 'Dropped a pawn',
  trade: 'Unfavourable exchanges',
  king_pawn: 'Weakened own king with a pawn move',
  development: 'Neglected development',
  technique: 'Imprecise endgame technique',
  plan: 'Wrong plan / passive move',
};
const motifKey = (e: MoveError): string =>
  e.motif ?? (e.type === 'allowed_mate' || e.type === 'missed_mate' ? 'mate' : 'combo');

const LICHESS = 'https://lichess.org/training/';
const PRACTICE: Record<string, { label: string; url: string }> = {
  hanging: { label: 'Hanging-piece puzzles', url: `${LICHESS}hangingPiece` },
  fork: { label: 'Fork puzzles', url: `${LICHESS}fork` },
  pin: { label: 'Pin puzzles', url: `${LICHESS}pin` },
  skewer: { label: 'Skewer puzzles', url: `${LICHESS}skewer` },
  discovered: { label: 'Discovered-attack puzzles', url: `${LICHESS}discoveredAttack` },
  back_rank: { label: 'Back-rank mate puzzles', url: `${LICHESS}backRankMate` },
  mate1: { label: 'Mate in 1', url: `${LICHESS}mateIn1` },
  mate2: { label: 'Mate in 2', url: `${LICHESS}mateIn2` },
  defensive: { label: 'Defensive-move puzzles', url: `${LICHESS}defensiveMove` },
  quiet: { label: 'Quiet-move puzzles', url: `${LICHESS}quietMove` },
  advantage: { label: '"Convert the advantage" puzzles', url: `${LICHESS}advantage` },
  endgame: { label: 'Endgame puzzles', url: `${LICHESS}endgame` },
  rookEndgame: { label: 'Rook endgame puzzles', url: `${LICHESS}rookEndgame` },
  pawnEndgame: { label: 'Pawn endgame puzzles', url: `${LICHESS}pawnEndgame` },
  endgamePractice: { label: 'Interactive endgame lessons', url: 'https://lichess.org/practice' },
  opening: { label: 'Opening-phase puzzles', url: `${LICHESS}opening` },
  explorer: { label: 'Opening explorer', url: 'https://www.chess.com/explorer' },
  mix: { label: 'Mixed puzzles (untimed)', url: `${LICHESS}mix` },
};

/** Worst examples first, spread across different games where possible. */
function pickExamples(errors: MoveError[], max = 9): MoveError[] {
  const sorted = [...errors].sort((a, b) => b.loss - a.loss);
  const picked: MoveError[] = [];
  const seen = new Set<string>();
  for (const e of sorted) {
    if (picked.length >= max) break;
    if (!seen.has(e.gameId)) {
      picked.push(e);
      seen.add(e.gameId);
    }
  }
  for (const e of sorted) {
    if (picked.length >= max) break;
    if (!picked.includes(e)) picked.push(e);
  }
  return picked;
}

function countBy<T>(items: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) out[key(it)] = (out[key(it)] ?? 0) + 1;
  return out;
}

const topEntries = (counts: Record<string, number>) => Object.entries(counts).sort((a, b) => b[1] - a[1]);

export function summarise(games: AnalysedGame[]): Summary {
  const chrono = [...games].sort((a, b) => a.game.endTime - b.game.endTime);
  const all = record(games.map((g) => g.game.outcome));
  const accOf = (gs: AnalysedGame[]) => mean(gs.flatMap((g) => (g.report.accuracy === null ? [] : [g.report.accuracy])));

  const colorStat = (c: Color) => {
    const gs = games.filter((g) => g.game.userColor === c);
    return { ...record(gs.map((g) => g.game.outcome)), accuracy: accOf(gs) };
  };

  const phaseAccuracy = {} as Summary['phaseAccuracy'];
  for (const p of ['opening', 'middlegame', 'endgame'] as Phase[]) {
    const stat = { moves: 0, accuracySum: 0, inverseSum: 0 };
    for (const g of games) {
      stat.moves += g.report.phases[p].moves;
      stat.accuracySum += g.report.phases[p].accuracySum;
      stat.inverseSum += g.report.phases[p].inverseSum;
    }
    phaseAccuracy[p] = { moves: stat.moves, accuracy: blendAccuracy(stat) };
  }

  const errors = games.flatMap((g) => g.report.errors);
  const serious = errors.filter((e) => e.severity !== 'inaccuracy');
  const types: ErrorType[] = ['hung', 'allowed_tactic', 'allowed_mate', 'missed_tactic', 'missed_mate', 'positional'];
  const typeCounts = {} as Record<ErrorType, number>;
  const typeCost = {} as Record<ErrorType, number>;
  for (const t of types) {
    const es = serious.filter((e) => e.type === t);
    typeCounts[t] = es.length;
    typeCost[t] = costOf(es);
  }

  const reasons = (o: Outcome) => countBy(games.filter((g) => g.game.outcome === o), (g) => g.game.endReason);

  const openingMap = new Map<string, AnalysedGame[]>();
  for (const g of games) {
    const key = `${g.game.userColor}|${g.game.opening.family}`;
    openingMap.set(key, [...(openingMap.get(key) ?? []), g]);
  }
  const openings: OpeningRow[] = [...openingMap.entries()]
    .map(([key, gs]) => ({
      family: key.split('|')[1],
      color: key.split('|')[0] as Color,
      ...record(gs.map((g) => g.game.outcome)),
      accuracy: accOf(gs),
    }))
    .sort((a, b) => b.n - a.n || a.family.localeCompare(b.family));

  // Results against stronger / similar / weaker opposition, against what ratings predict.
  const expect = (g: AnalysedGame) => 1 / (1 + 10 ** ((g.game.opponentRating - g.game.userRating) / 400));
  const band = (label: string, test: (diff: number) => boolean): RatingBand => {
    const gs = games.filter((g) => test(g.game.opponentRating - g.game.userRating));
    return { label, ...record(gs.map((g) => g.game.outcome)), expected: (mean(gs.map(expect)) ?? 0) * 100 };
  };
  const bands = [
    band('Higher rated (+25 or more)', (d) => d >= 25),
    band('Similar rating', (d) => Math.abs(d) < 25),
    band('Lower rated (−25 or more)', (d) => d <= -25),
  ].filter((b) => b.n > 0);

  const withHabits = games.filter((g) => g.report.habits);
  const never = withHabits.filter((g) => g.report.habits!.castledAt === null);
  const habits: HabitStats | null = withHabits.length
    ? {
        games: withHabits.length,
        neverCastled: never.length,
        neverCastledScore: record(never.map((g) => g.game.outcome)).score,
        avgCastleMove: mean(withHabits.flatMap((g) => (g.report.habits!.castledAt === null ? [] : [g.report.habits!.castledAt]))),
        earlyQueen: withHabits.filter((g) => g.report.habits!.earlyQueen).length,
        avgMinors: mean(withHabits.map((g) => g.report.habits!.minorsDeveloped)) ?? 0,
      }
    : null;

  const levelEndgames = games.filter((g) => g.report.endgame && g.report.endgame.winAtEntry >= 40);
  const endgames = levelEndgames.length
    ? {
        n: levelEndgames.length,
        score: record(levelEndgames.map((g) => g.game.outcome)).score,
        expected: mean(levelEndgames.map((g) => g.report.endgame!.winAtEntry)) ?? 0,
        byKind: countBy(levelEndgames, (g) => g.report.endgame!.kind),
      }
    : null;

  return {
    ...all,
    byColor: { w: colorStat('w'), b: colorStat('b') },
    accuracy: accOf(games),
    opponentAccuracy: mean(games.flatMap((g) => (g.report.opponentAccuracy === null ? [] : [g.report.opponentAccuracy]))),
    phaseAccuracy,
    severityCounts: {
      inaccuracy: errors.filter((e) => e.severity === 'inaccuracy').length,
      mistake: errors.filter((e) => e.severity === 'mistake').length,
      blunder: errors.filter((e) => e.severity === 'blunder').length,
    },
    typeCounts,
    typeCost,
    motifsAllowed: countBy(serious.filter((e) => e.type === 'allowed_tactic' || e.type === 'allowed_mate'), motifKey),
    motifsMissed: countBy(serious.filter((e) => e.type === 'missed_tactic' || e.type === 'missed_mate'), motifKey),
    positionalKinds: countBy(serious.filter((e) => e.type === 'positional'), (e) => e.motif ?? 'plan'),
    lossCauses: countBy(games.filter((g) => g.report.decisive), (g) => g.report.decisive!.cause),
    bands,
    expectedScore: (mean(games.map(expect)) ?? 0) * 100,
    habits,
    endgames,
    userMoves: games.reduce(
      (s, g) => s + g.report.phases.opening.moves + g.report.phases.middlegame.moves + g.report.phases.endgame.moves,
      0,
    ),
    winReasons: reasons('win'),
    lossReasons: reasons('loss'),
    drawReasons: reasons('draw'),
    openings,
    ratingNow: chrono[chrono.length - 1]?.game.userRating ?? 0,
    ratingChange: chrono.length ? chrono[chrono.length - 1].game.userRating - chrono[0].game.userRating : 0,
    avgOpponentRating: Math.round(mean(games.map((g) => g.game.opponentRating)) ?? 0),
    hasClocks: games.some((g) => g.game.hasClocks),
    timeTroubleErrors: serious.filter((e) => e.inTimeTrouble).length,
    impulsiveErrors: serious.filter((e) => e.impulsive).length,
    thinkTime: (() => {
      const all = mean(
        games.flatMap((g) => g.game.plies.filter((p) => p.color === g.game.userColor && p.spent !== undefined).map((p) => p.spent!)),
      );
      const onErrors = mean(serious.flatMap((e) => (e.spent === undefined ? [] : [e.spent])));
      return all !== null && onErrors !== null ? { all, errors: onErrors } : null;
    })(),
    seriousErrors: serious.length,
  };
}

export function analyse(games: AnalysedGame[]): Analysis {
  const summary = summarise(games);
  const N = games.length;
  const insights: Insight[] = [];
  const strengths: Strength[] = [];
  if (!N) return { summary, insights, strengths };

  const errors = games.flatMap((g) => g.report.errors);
  const serious = errors.filter((e) => e.severity !== 'inaccuracy');
  const gamesWith = (es: MoveError[]) => new Set(es.map((e) => e.gameId)).size;
  const lost = games.filter((g) => g.game.outcome === 'loss');
  const decidedBy = (...causes: LossCause[]) => lost.filter((g) => g.report.decisive && causes.includes(g.report.decisive.cause)).length;
  const decidedLine = (n: number) => (n && lost.length ? [`It was the turning point in ${n} of your ${plural(lost.length, 'loss', 'losses')}.`] : []);
  const costLine = (c: number) => `Together these gave away winning chances worth about ${c.toFixed(1)} game points.`;
  /** Common currency for ranking: game points given away per game played. */
  const severityOfCost = (c: number) => clamp((c / N) * 250);
  const halve = (perGame: number) => `Get this under ${rate(Math.max(0.05, perGame / 2))} per game in your next ${N} games (now ${rate(perGame)}).`;
  const motifList = (es: MoveError[]) =>
    topEntries(countBy(es, motifKey))
      .map(([k, n]) => `${n} ${MOTIF_LABEL[k].toLowerCase()}`)
      .join(', ');
  const motifPractice = (es: MoveError[], fallback: string[]) => {
    const keys = topEntries(countBy(es, motifKey))
      .map(([k]) => k)
      .filter((k) => PRACTICE[k]);
    return [...new Set([...keys, ...fallback])].slice(0, 3).map((k) => PRACTICE[k]);
  };

  // --- Pieces left en prise ----------------------------------------------------------
  const hung = serious.filter((e) => e.type === 'hung');
  if (hung.length >= 3) {
    const c = costOf(hung);
    const byPiece = topEntries(countBy(hung, (e) => e.lostPiece ?? '?')).filter(([p]) => PIECE_NAME[p]);
    const movedInto = hung.filter((e) => e.refutationUci?.slice(2, 4) === e.uci.slice(2, 4)).length;
    insights.push({
      id: 'hung-pieces',
      category: 'tactics',
      title: 'You give away pieces in one move',
      severity: severityOfCost(c),
      cost: c,
      metric: { value: hung.length / N, unit: 'per game' },
      target: halve(hung.length / N),
      summary: `${plural(hung.length, 'time')} in ${plural(N, 'game')} you played a move that let your opponent simply take a piece — undefended, under-defended, or attacked by something cheaper.`,
      evidence: [
        `It happened in ${gamesWith(hung)} of ${N} games. ${costLine(c)}`,
        ...decidedLine(decidedBy('hung')),
        ...(byPiece.length ? [`Pieces lost this way: ${byPiece.map(([p, n]) => `${PIECE_NAME[p]} ×${n}`).join(', ')}.`] : []),
        `${movedInto} of ${hung.length} times you moved the piece onto the attacked square yourself; the rest of the time you left a piece behind unprotected.`,
      ],
      advice: [
        'Before you let go of a piece, look at the square it is landing on: is it attacked, and by what? Then look at what the piece was defending before it moved.',
        'After every opponent move ask: "what does that piece attack now that it did not attack before?" Do this before thinking about your own plan.',
        'Do 10–15 minutes a day of easy puzzles at speed. The goal is instant recognition of loose pieces, not difficulty.',
      ],
      practice: [PRACTICE.hanging, PRACTICE.fork, PRACTICE.defensive],
      examples: pickExamples(hung),
    });
  }

  // --- Walking into tactics ----------------------------------------------------------
  const allowed = serious.filter((e) => e.type === 'allowed_tactic');
  if (allowed.length >= 3) {
    const c = costOf(allowed);
    const [topMotif, topCount] = topEntries(countBy(allowed, motifKey))[0];
    const dominant = topCount >= 3 && topCount / allowed.length >= 0.5 && topMotif !== 'combo';
    insights.push({
      id: 'allowed-tactics',
      category: 'tactics',
      title: dominant ? `You keep walking into ${MOTIF_LABEL[topMotif].toLowerCase()}` : 'You miss your opponent’s tactical shots',
      severity: severityOfCost(c),
      cost: c,
      metric: { value: allowed.length / N, unit: 'per game' },
      target: halve(allowed.length / N),
      summary: `${plural(allowed.length, 'time')} your move allowed a forcing sequence that won material — not a piece left hanging, but a two- or three-move idea you did not see coming.`,
      evidence: [
        `What you fell for: ${motifList(allowed)}.`,
        `${costLine(c)}`,
        ...decidedLine(decidedBy('allowed_tactic')),
      ],
      advice: [
        'Before each move, find your opponent’s most forcing reply — every check and every capture — and play it out one move further in your head.',
        'Notice the warning signs: two of your pieces on the same line or diagonal, pieces a knight-hop apart, an undefended piece, a king with no escape square.',
        'Solve puzzles from the losing side: look at the position and ask "what is the threat?" before looking for your own move.',
      ],
      practice: motifPractice(allowed, ['defensive', 'fork', 'pin']),
      examples: pickExamples(allowed),
    });
  }

  // --- Walking into mate -------------------------------------------------------------
  const mated = serious.filter((e) => e.type === 'allowed_mate');
  if (mated.length >= 2) {
    const c = costOf(mated);
    const backRank = mated.filter((e) => e.motif === 'back_rank').length;
    insights.push({
      id: 'allowed-mate',
      category: 'tactics',
      title: backRank >= 2 ? 'Your back rank keeps getting you mated' : 'You miss threats against your king',
      severity: severityOfCost(c * 1.2),
      cost: c,
      metric: { value: mated.length / N, unit: 'per game' },
      target: `Zero allowed mates in your next ${N} games (now ${mated.length}).`,
      summary: `${plural(mated.length, 'time')} you played a move that allowed a forced checkmate that was not there before.`,
      evidence: [
        `It happened in ${gamesWith(mated)} of ${N} games${backRank ? `; ${backRank} were back-rank mates` : ''}.`,
        `On average you still had ${pct(mean(mated.map((e) => e.winBefore)) ?? 0)} winning chances right before the move.`,
        ...decidedLine(decidedBy('allowed_mate')),
      ],
      advice: [
        'Whenever enemy pieces gather near your king, stop and list every check your opponent has — then follow each one move further.',
        'Give your king an escape square (a pawn move like h3 or h6) once the position calms down, to rule out back-rank tricks.',
        'Practise mate-in-1 and mate-in-2 puzzles until the common mating patterns are automatic — you can only defend against patterns you recognise.',
      ],
      practice: [backRank ? PRACTICE.back_rank : PRACTICE.mate1, PRACTICE.mate2, PRACTICE.defensive],
      examples: pickExamples(mated),
    });
  }

  // --- Missed tactics ----------------------------------------------------------------
  const missed = serious.filter((e) => e.type === 'missed_tactic' || e.type === 'missed_mate');
  if (missed.length >= 3) {
    const c = costOf(missed);
    const mates = missed.filter((e) => e.type === 'missed_mate').length;
    const free = missed.filter((e) => e.motif === 'capture').length;
    insights.push({
      id: 'missed-tactics',
      category: 'tactics',
      title: free >= 3 && free / missed.length >= 0.5 ? 'You do not take free material' : 'You miss winning tactics',
      severity: severityOfCost(c * 0.8),
      cost: c,
      metric: { value: missed.length / N, unit: 'per game' },
      target: halve(missed.length / N),
      summary: `${plural(missed.length, 'time')} you had a move that won material or forced mate, and played something else.`,
      evidence: [
        `What you missed: ${motifList(missed)}.`,
        ...(free ? [`${plural(free, 'of these was a piece', 'of these were pieces')} you could simply have taken.`] : []),
        ...(mates ? [`${plural(mates, 'was a forced checkmate', 'were forced checkmates')}.`] : []),
        `Average swing: from ${pct(mean(missed.map((e) => e.winBefore)) ?? 0)} to ${pct(mean(missed.map((e) => e.winAfter)) ?? 0)} winning chances.`,
      ],
      advice: [
        'After every opponent move ask "what did that move stop defending?" — most chances appear right after a careless move.',
        'Look at forcing moves first, in this order: checks, captures, threats. Only then consider quiet moves.',
        'Solve harder puzzles slowly, with no timer, and only move once you have calculated the whole line.',
      ],
      practice: motifPractice(missed, ['mix', 'fork']),
      examples: pickExamples(missed),
    });
  }

  // --- Positional drift --------------------------------------------------------------
  const positional = serious.filter((e) => e.type === 'positional');
  if (positional.length >= 5 && positional.length / serious.length >= 0.35) {
    const c = costOf(positional);
    const kinds = topEntries(countBy(positional, (e) => e.motif ?? 'plan'));
    const mainKind = kinds[0][0];
    const kindAdvice: Record<string, string> = {
      pawn: 'Pawns are material too: before each move, check which of your pawns is attacked more often than it is defended.',
      trade: 'Before any exchange, ask who benefits. Do not swap your active piece for a passive one, and do not release the tension without a reason.',
      king_pawn: 'Leave the pawns in front of your castled king alone unless you have a concrete reason — every push creates a hole that cannot be undone.',
      development: 'In the opening, each move should bring a new piece out or get your king castled. Count your developed pieces against your opponent’s.',
      technique: 'In endgames, activate the king and rooks first and count tempi before pushing pawns.',
      plan: 'When you do not know what to do, find your worst-placed piece and improve it. A small concrete plan beats a random pawn push.',
    };
    insights.push({
      id: 'positional',
      category: 'strategy',
      title: kinds[0][1] >= 4 && kinds[0][1] / positional.length >= 0.5 ? POSITIONAL_TITLE[mainKind] : 'Your position slips without a clear blunder',
      severity: severityOfCost(c * 0.7),
      cost: c,
      metric: { value: positional.length / N, unit: 'per game' },
      target: halve(positional.length / N),
      summary: `${positional.length} of your ${serious.length} mistakes and blunders were not tactical oversights — no piece was lost, but the move left you clearly worse.`,
      evidence: [
        `What they were: ${kinds.map(([k, n]) => `${n}× ${MOTIF_LABEL[k].toLowerCase()}`).join(', ')}.`,
        `${costLine(c)}`,
        ...decidedLine(decidedBy('positional', 'outplayed')),
      ],
      advice: [
        kindAdvice[mainKind],
        ...(kinds[1] ? [kindAdvice[kinds[1][0]]] : [kindAdvice.plan]),
        'Step through the examples below: for each, say in one sentence what the better move does that yours does not.',
      ].filter((x, i, arr) => arr.indexOf(x) === i),
      practice: [mainKind === 'technique' ? PRACTICE.endgame : PRACTICE.quiet, PRACTICE.defensive],
      examples: pickExamples(positional),
    });
  }

  // --- Time: time trouble ------------------------------------------------------------
  const clockGames = games.filter((g) => g.game.hasClocks);
  const flagged = lost.filter((g) => g.game.endReason === 'timeout');
  const flaggedNotLost = flagged.filter((g) => g.report.finalWin >= 40);
  const ttErrors = serious.filter((e) => e.inTimeTrouble);
  if (clockGames.length >= 5) {
    const share = serious.length ? ttErrors.length / serious.length : 0;
    if (flagged.length >= 3 || (ttErrors.length >= 3 && share >= 0.25)) {
      const c = costOf(ttErrors) + flaggedNotLost.reduce((s, g) => s + g.report.finalWin / 100, 0);
      insights.push({
        id: 'time-trouble',
        category: 'time',
        title: 'Time trouble is costing you games',
        severity: clamp(severityOfCost(c) + (flagged.length / N) * 60),
        cost: c,
        metric: { value: (ttErrors.length + flagged.length) / N, unit: 'time-trouble errors and flags per game' },
        target: `No more than ${Math.max(0, Math.floor(flagged.length / 2))} losses on time in your next ${N} games (now ${flagged.length}).`,
        summary:
          flagged.length >= 3
            ? `You lost ${flagged.length} of ${N} games on the clock, and your play drops sharply once you are low on time.`
            : `${pct(share * 100)} of your mistakes and blunders happen when you have less than a tenth of your time left.`,
        evidence: [
          `${plural(flagged.length, 'loss', 'losses')} on time${flaggedNotLost.length ? ` — in ${flaggedNotLost.length} of them the position itself was not lost` : ''}.`,
          `${ttErrors.length} of your ${serious.length} mistakes and blunders came with under 10% of your clock remaining.`,
        ],
        advice: [
          'Set clock checkpoints: aim to have at least half your time left at move 15 and a quarter at move 30. Glance at the clock after every move.',
          'Play the opening from memory and save your long thinks for moments when pieces come into contact. In quiet positions, pick a sensible move within a few seconds.',
          'If it keeps happening, switch to a time control with increment so you always have a few seconds per move.',
        ],
        examples: pickExamples(ttErrors),
      });
    }

    // --- Time: playing too fast ------------------------------------------------------
    const impulsive = serious.filter((e) => e.impulsive);
    const impulsiveShare = serious.length ? impulsive.length / serious.length : 0;
    const lostWithTime = clockGames
      .filter((g) => g.game.outcome === 'loss' && g.game.endReason !== 'timeout' && g.game.baseTime >= 180)
      .map((g) => {
        const last = [...g.game.plies].reverse().find((p) => p.color === g.game.userColor);
        return (last?.clockAfter ?? 0) / g.game.baseTime;
      });
    const avgLeft = mean(lostWithTime) ?? 0;
    const unusedTime = lostWithTime.length >= 3 && avgLeft >= 0.45;
    // Compare like with like: how often is a fast move a serious error vs. a considered one?
    let fastMoves = 0;
    let slowMoves = 0;
    for (const g of clockGames) {
      for (const p of g.game.plies) {
        if (p.color !== g.game.userColor) continue;
        if (isImpulsive(g.game, p)) fastMoves++;
        else slowMoves++;
      }
    }
    const fastRate = fastMoves ? impulsive.length / fastMoves : 0;
    const slowRate = slowMoves ? (serious.length - impulsive.length) / slowMoves : 0;
    const fastIsCostly = impulsive.length >= 4 && impulsiveShare >= 0.3 && fastRate >= slowRate * 1.25;
    if (fastIsCostly || unusedTime) {
      insights.push({
        id: 'too-fast',
        category: 'time',
        title: fastIsCostly ? 'You move too fast in critical moments' : 'You lose with most of your clock unused',
        severity: clamp((fastIsCostly ? impulsiveShare * 70 : 0) + (unusedTime ? avgLeft * 50 : 0)),
        metric: { value: avgLeft * 100, unit: '% of clock unused in losses' },
        target: `Finish lost games with under ${Math.round(Math.max(20, avgLeft * 50))}% of your clock left (now ${pct(avgLeft * 100)}).`,
        summary: fastIsCostly
          ? `${impulsive.length} of your ${serious.length} mistakes and blunders were played almost instantly, with plenty of time on the clock.`
          : `In the games you lost, you still had ${pct(avgLeft * 100)} of your starting time left at the end. That time could have gone into the moves that decided the game.`,
        evidence: [
          ...(fastIsCostly
            ? [`${(fastRate * 100).toFixed(1)}% of your instant moves are mistakes or blunders, against ${(slowRate * 100).toFixed(1)}% of the moves you take time over.`]
            : [`${impulsive.length} of your ${serious.length} mistakes and blunders were played almost instantly.`]),
          ...(lostWithTime.length >= 3
            ? [`In the games you lost (not on time), you finished with ${pct(avgLeft * 100)} of your starting time unused on average.`]
            : []),
        ],
        advice: [
          'Unused clock at the end of a lost game is wasted. When the position becomes sharp — captures, checks or threats are possible — deliberately slow down.',
          'Sit on your hands: once you have chosen a move, take one more breath and find your opponent’s best reply before you play it.',
          'Be most careful on recaptures and "obvious" moves — look for an in-between move first.',
        ],
        examples: pickExamples(impulsive),
      });
    }
  }

  // --- Conversion --------------------------------------------------------------------
  const winning = games.filter((g) => g.report.hadWinning);
  const thrown = winning.filter((g) => g.game.outcome !== 'win');
  if (winning.length >= 3 && thrown.length >= 2 && thrown.length / winning.length >= 0.25) {
    const thrownIds = new Set(thrown.map((g) => g.game.id));
    const throwMoves = serious.filter((e) => thrownIds.has(e.gameId) && e.winBefore >= 75);
    const lostOnTime = thrown.filter((g) => g.game.endReason === 'timeout').length;
    const c = thrown.reduce((s, g) => s + (g.game.outcome === 'loss' ? 1 : 0.5), 0);
    const convRate = (winning.length - thrown.length) / winning.length;
    insights.push({
      id: 'conversion',
      category: 'conversion',
      title: 'You struggle to convert winning positions',
      severity: clamp((c / N) * 260),
      cost: c,
      metric: { value: (1 - convRate) * 100, unit: '% of winning positions not won' },
      target: `Convert at least ${Math.round(Math.min(95, convRate * 100 + 20))}% of your winning positions (now ${pct(convRate * 100)}).`,
      summary: `You reached a clearly winning position in ${winning.length} games but failed to win ${thrown.length} of them.`,
      evidence: [
        `Conversion rate: ${pct(convRate * 100)} of winning positions turned into wins.`,
        `Winning those games would have been worth ${c} extra ${c === 1 ? 'point' : 'points'} in this sample.`,
        ...(throwMoves.length ? [`How the wins were thrown: ${topEntries(countBy(throwMoves, (e) => TYPE_SHORT[e.type])).map(([k, n]) => `${n}× ${k}`).join(', ')}.`] : []),
        ...(lostOnTime ? [`${plural(lostOnTime, 'of these was', 'of these were')} lost on the clock.`] : []),
      ],
      advice: [
        'When you are clearly ahead, change the question from "how do I win faster?" to "what is my opponent’s only counterplay?" — then remove it.',
        'Trade pieces (not pawns) when ahead in material. Every exchange makes the extra material count for more and removes tricks.',
        'Stay as alert as in an equal game — thrown wins come from relaxing, not from difficult positions.',
      ],
      practice: [PRACTICE.advantage, PRACTICE.endgame],
      examples: pickExamples(throwMoves),
    });
  } else if (winning.length >= 4 && thrown.length === 0) {
    strengths.push({
      title: 'Clinical when ahead',
      detail: `You converted all ${winning.length} of your clearly winning positions into wins.`,
    });
  }

  // --- Opening -----------------------------------------------------------------------
  const pa = summary.phaseAccuracy;
  const phases = (['opening', 'middlegame', 'endgame'] as Phase[]).filter((p) => pa[p].moves >= 30 && pa[p].accuracy !== null);
  const openingEvals = games.flatMap((g) => (g.report.openingEval === null ? [] : [g.report.openingEval]));
  const avgOpeningEval = mean(openingEvals);
  const evalByColor = (col: Color) =>
    mean(games.filter((g) => g.game.userColor === col).flatMap((g) => (g.report.openingEval === null ? [] : [g.report.openingEval])));
  const openingErrors = serious.filter((e) => e.phase === 'opening');
  const badOpeningEval = openingEvals.length >= 8 && avgOpeningEval !== null && avgOpeningEval <= -40;
  const h = summary.habits;
  const lateCastling = !!h && h.games >= 6 && h.neverCastled / h.games >= 0.3;
  const slowDevelopment = !!h && h.games >= 6 && h.avgMinors < 3;
  const queenRaids = !!h && h.games >= 6 && h.earlyQueen / h.games >= 0.3;
  if (badOpeningEval || openingErrors.length >= Math.max(4, N * 0.4) || ((lateCastling || slowDevelopment || queenRaids) && (avgOpeningEval ?? 0) < 0)) {
    const w = evalByColor('w');
    const b = evalByColor('b');
    const fmt = (cp: number) => `${cp >= 0 ? '+' : '−'}${(Math.abs(cp) / 100).toFixed(1)}`;
    const c = costOf(openingErrors);
    const habitAdvice = [
      ...(lateCastling
        ? [`Castle by move 10. You never castled in ${h!.neverCastled} of ${h!.games} games and scored ${pct(h!.neverCastledScore)} in them — a king in the centre is what most early attacks feed on.`]
        : []),
      ...(slowDevelopment
        ? [`Get your knights and bishops out before anything else. After 10 moves you have ${h!.avgMinors.toFixed(1)} of 4 developed on average; aim for all four.`]
        : []),
      ...(queenRaids
        ? [`Keep the queen at home early. You moved it twice or more in the first 8 moves in ${h!.earlyQueen} of ${h!.games} games — each of those moves is a developing move you did not make.`]
        : []),
    ];
    insights.push({
      id: 'opening',
      category: 'opening',
      title: 'You come out of the opening in trouble',
      severity: clamp(severityOfCost(c) * 0.6 + (badOpeningEval ? 15 + Math.abs(avgOpeningEval!) / 8 : 0) + habitAdvice.length * 5),
      // No cost figure here: these errors are already counted under their causes above.
      metric: { value: openingErrors.length / N, unit: 'opening errors per game' },
      target: `Reach move 10 no worse than level on average${avgOpeningEval !== null ? ` (now ${fmt(avgOpeningEval)})` : ''}.`,
      summary: `You made ${plural(openingErrors.length, 'mistake or blunder', 'mistakes and blunders')} in the first 10 moves across ${N} games${avgOpeningEval !== null ? `, and your average position after move 10 is ${fmt(avgOpeningEval)} pawns` : ''}.`,
      evidence: [
        ...(w !== null && b !== null ? [`Average evaluation after move 10: ${fmt(w)} with White, ${fmt(b)} with Black.`] : []),
        `${gamesWith(openingErrors)} of ${N} games contained a serious error before move 11.`,
        ...(h
          ? [
              `Opening habits: castled in ${h.games - h.neverCastled} of ${h.games} games${h.avgCastleMove !== null ? ` (on move ${h.avgCastleMove.toFixed(0)} on average)` : ''}; ${h.avgMinors.toFixed(1)} of 4 minor pieces developed by move 10; early queen moves in ${h.earlyQueen}.`,
            ]
          : []),
        ...(openingErrors.length ? [`What goes wrong: ${topEntries(countBy(openingErrors, (e) => TYPE_SHORT[e.type])).map(([k, n]) => `${n}× ${k}`).join(', ')}.`] : []),
      ],
      advice: [
        ...habitAdvice,
        'Pick one opening with White and one defence each against 1.e4 and 1.d4, and play only those for the next month. Fewer openings, known deeper.',
        'After every game, compare your first 10 moves with an opening explorer and note the first move where you left theory.',
        'When out of book: develop a new piece with every move and do not move the same piece twice.',
      ].slice(0, 3),
      practice: [PRACTICE.explorer, PRACTICE.opening],
      examples: pickExamples(openingErrors),
    });
  } else if (h && h.games >= 8 && h.neverCastled === 0 && h.avgMinors >= 3.5 && (avgOpeningEval ?? 0) >= 0) {
    strengths.push({
      title: 'Sound opening habits',
      detail: `You castled in every game, develop ${h.avgMinors.toFixed(1)} of 4 minor pieces by move 10 and come out of the opening level or better.`,
    });
  }

  // --- Endgame -----------------------------------------------------------------------
  const eg = summary.endgames;
  const endgameErrors = serious.filter((e) => e.phase === 'endgame');
  const egShortfall = eg && eg.n >= 4 ? eg.expected - eg.score : 0;
  const egAccuracyGap =
    phases.length === 3 && pa.endgame.accuracy! < pa.opening.accuracy! && pa.endgame.accuracy! < pa.middlegame.accuracy!
      ? (pa.opening.accuracy! + pa.middlegame.accuracy!) / 2 - pa.endgame.accuracy!
      : 0;
  if (egShortfall >= 15 || egAccuracyGap >= 4) {
    const kinds = eg ? topEntries(eg.byKind) : [];
    const mainKind = kinds[0]?.[0];
    const c = eg && egShortfall > 0 ? (egShortfall / 100) * eg.n : costOf(endgameErrors);
    insights.push({
      id: 'endgame',
      category: 'phase',
      title: 'You lose ground in the endgame',
      severity: clamp((egShortfall > 0 ? severityOfCost(c) : 0) + egAccuracyGap * 3),
      cost: c,
      metric: { value: endgameErrors.length / N, unit: 'endgame errors per game' },
      target: eg ? `Score at least ${pct(eg.expected)} from level-or-better endgames (now ${pct(eg.score)}).` : `Under ${rate(Math.max(0.05, endgameErrors.length / N / 2))} endgame errors per game.`,
      summary: eg
        ? `You entered ${plural(eg.n, 'endgame')} from a level or better position (${pct(eg.expected)} winning chances on average) but scored only ${pct(eg.score)} from them.`
        : `Your endgame accuracy is ${pa.endgame.accuracy!.toFixed(1)}, ${egAccuracyGap.toFixed(1)} points below the rest of your game.`,
      evidence: [
        ...(kinds.length ? [`Endgame types: ${kinds.map(([k, n]) => `${n} ${ENDGAME_LABEL[k]}`).join(', ')}.`] : []),
        ...(phases.length === 3 ? [`Accuracy by phase — opening ${pa.opening.accuracy!.toFixed(1)}, middlegame ${pa.middlegame.accuracy!.toFixed(1)}, endgame ${pa.endgame.accuracy!.toFixed(1)}.`] : []),
        `${plural(endgameErrors.length, 'mistake or blunder', 'mistakes and blunders')} in the endgame.`,
      ],
      advice: [
        'Activate your king the moment queens come off — in the endgame the king is a fighting piece, and walking it to the centre is usually the best move.',
        mainKind === 'rook'
          ? 'Most of your endgames are rook endings: learn the Lucena and Philidor positions, and keep your rook active behind passed pawns rather than passively defending.'
          : mainKind === 'pawn'
            ? 'Most of your endgames are pawn endings: learn the opposition, the square of the pawn and key squares — they decide these endings by force.'
            : 'Learn the essentials first: king and pawn vs king (opposition, the square rule), then the Lucena and Philidor rook endings.',
        'Play out theoretical positions against the computer until winning them feels routine.',
      ],
      practice: [mainKind === 'rook' ? PRACTICE.rookEndgame : mainKind === 'pawn' ? PRACTICE.pawnEndgame : PRACTICE.endgame, PRACTICE.endgamePractice],
      examples: pickExamples(endgameErrors),
    });
  } else if (eg && eg.n >= 4 && eg.score - eg.expected >= 15) {
    strengths.push({
      title: 'Strong endgame technique',
      detail: `From ${eg.n} level-or-better endgames you scored ${pct(eg.score)}, more than the positions promised (${pct(eg.expected)}).`,
    });
  }

  // --- Colour gap --------------------------------------------------------------------
  const { w, b } = summary.byColor;
  if (w.n >= 6 && b.n >= 6 && Math.abs(w.score - b.score) >= 25) {
    const weak: Color = w.score < b.score ? 'w' : 'b';
    const name = weak === 'w' ? 'White' : 'Black';
    const ws = summary.byColor[weak];
    const ss = summary.byColor[weak === 'w' ? 'b' : 'w'];
    const worst = summary.openings.filter((o) => o.color === weak && o.n >= 2).sort((a, c) => a.score - c.score)[0];
    insights.push({
      id: 'color-gap',
      category: 'opening',
      title: `You score much worse with ${name}`,
      severity: clamp(Math.abs(w.score - b.score) * 0.7),
      metric: { value: Math.abs(w.score - b.score), unit: 'point gap between colours (%)' },
      target: `Close the gap to under 15 points (now ${Math.round(Math.abs(w.score - b.score))}).`,
      summary: `You score ${pct(ws.score)} with ${name} (${ws.wins}W ${ws.draws}D ${ws.losses}L) against ${pct(ss.score)} with the other colour.`,
      evidence: [
        ...(ws.accuracy !== null && ss.accuracy !== null
          ? [`Accuracy with ${name}: ${ws.accuracy.toFixed(1)} vs ${ss.accuracy.toFixed(1)} with the other colour.`]
          : []),
        ...(worst ? [`Your most troublesome ${name} opening: ${worst.family} (${worst.wins}W ${worst.draws}D ${worst.losses}L).`] : []),
      ],
      advice:
        weak === 'b'
          ? [
              'Choose one solid defence against 1.e4 and one against 1.d4 and learn the first 6–8 moves and the typical plans.',
              'With Black, equalise first: finish development and castle before looking for activity.',
              'Review your Black losses side by side and look for a shared pattern — the same line, or the same kind of attack.',
            ]
          : [
              'Build a simple White repertoire around one first move and a set-up you can reach against most replies.',
              'With White you start half a move ahead — spend it on development and the centre, not on early attacks that need your opponent’s help.',
              'Review your White losses side by side and look for a shared pattern, such as one defence that keeps giving you problems.',
            ],
      practice: [PRACTICE.explorer],
      examples: [],
    });
  }

  // --- A specific opening that keeps failing -----------------------------------------
  const badOpening = summary.openings
    .filter((o) => o.n >= 3 && o.score <= 30 && o.score <= summary.score - 20 && o.family !== 'Unknown opening')
    .sort((a, c) => a.score - c.score || c.n - a.n)[0];
  if (badOpening) {
    const colorName = badOpening.color === 'w' ? 'White' : 'Black';
    const inIt = (e: MoveError) =>
      games.some((g) => g.game.id === e.gameId && g.game.opening.family === badOpening.family && g.game.userColor === badOpening.color);
    insights.push({
      id: 'bad-opening',
      category: 'opening',
      title: `The ${badOpening.family} is not working for you`,
      severity: clamp(20 + badOpening.n * 6 + (summary.score - badOpening.score) * 0.3),
      metric: { value: 100 - badOpening.score, unit: `% of points lost in the ${badOpening.family}` },
      target: `Score at least ${pct(summary.score)} — your overall average — in your next ${badOpening.n} games with it.`,
      summary: `You scored ${badOpening.wins}W ${badOpening.draws}D ${badOpening.losses}L in ${badOpening.n} games with ${colorName} in the ${badOpening.family}, against ${pct(summary.score)} overall.`,
      evidence: [
        ...(badOpening.accuracy !== null && summary.accuracy !== null
          ? [`Your accuracy in these games is ${badOpening.accuracy.toFixed(1)} (overall ${summary.accuracy.toFixed(1)}).`]
          : []),
      ],
      advice: [
        `Either invest in it or drop it: go through one well-annotated master game in the ${badOpening.family} and learn the main plans for your side.`,
        'Open these games in the Games tab and find where you first felt uncomfortable — that position is what you need to study.',
        badOpening.color === 'b'
          ? 'If it keeps going wrong, switch to a simpler set-up against that first move that leads to positions you understand.'
          : 'If it keeps going wrong, switch to a different first move or a system opening that avoids it.',
      ],
      practice: [PRACTICE.explorer],
      examples: pickExamples(serious.filter(inIt)),
    });
  }

  // --- Dropping points against lower-rated opposition --------------------------------
  const lower = summary.bands.find((x) => x.label.startsWith('Lower'));
  if (lower && lower.n >= 5 && lower.expected - lower.score >= 15) {
    insights.push({
      id: 'lower-rated',
      category: 'mindset',
      title: 'You drop points against lower-rated opponents',
      severity: clamp((lower.expected - lower.score) * 0.9),
      cost: ((lower.expected - lower.score) / 100) * lower.n,
      metric: { value: lower.expected - lower.score, unit: 'points below expectation vs lower-rated (%)' },
      target: `Score at least ${pct(lower.expected)} against lower-rated opponents (now ${pct(lower.score)}).`,
      summary: `Against lower-rated opponents you scored ${pct(lower.score)} (${lower.wins}W ${lower.draws}D ${lower.losses}L) where the ratings predict ${pct(lower.expected)}.`,
      evidence: summary.bands.map((x) => `${x.label}: ${x.wins}W ${x.draws}D ${x.losses}L — scored ${pct(x.score)}, expected ${pct(x.expected)}.`),
      advice: [
        'Play the board, not the rating: use the same safety checks you would use against a stronger player.',
        'Do not force matters. Against a weaker opponent, solid moves are enough — they will usually make the first serious mistake.',
        'Avoid speculative sacrifices and "trick" moves that only work if the opponent misses them.',
      ],
      examples: [],
    });
  } else {
    const higher = summary.bands.find((x) => x.label.startsWith('Higher'));
    if (higher && higher.n >= 5 && higher.score - higher.expected >= 15) {
      strengths.push({
        title: 'You punch above your rating',
        detail: `Against higher-rated opponents you scored ${pct(higher.score)} where the ratings predict ${pct(higher.expected)}.`,
      });
    }
  }

  // --- Resigning too early -----------------------------------------------------------
  const resignedEarly = lost.filter((g) => g.report.decisive?.cause === 'resigned_early');
  if (resignedEarly.length >= 2) {
    const avgWin = mean(resignedEarly.map((g) => g.report.finalWin)) ?? 0;
    insights.push({
      id: 'resign-early',
      category: 'mindset',
      title: 'You resign positions that are not lost',
      severity: clamp((resignedEarly.reduce((s, g) => s + g.report.finalWin / 100, 0) / N) * 250),
      cost: resignedEarly.reduce((s, g) => s + g.report.finalWin / 100, 0),
      metric: { value: resignedEarly.length, unit: 'early resignations' },
      target: `No resignations in level positions in your next ${N} games (now ${resignedEarly.length}).`,
      summary: `${plural(resignedEarly.length, 'game')} ended with you resigning or leaving while the position was still playable.`,
      evidence: [`On average you still had ${pct(avgWin)} winning chances in the final position.`],
      advice: [
        'Never resign straight after a shock. Take ten seconds, count the material, and look for your most active move.',
        'At club level a lost position is rarely lost: make your opponent prove it for at least ten more moves.',
        'If you must leave, offer a draw first rather than abandoning.',
      ],
      examples: [],
    });
  }

  // --- Tilt --------------------------------------------------------------------------
  const chrono = [...games].sort((a, b2) => a.game.endTime - b2.game.endTime);
  if (chrono[0].game.timeClass !== 'daily') {
    const afterLoss: Outcome[] = [];
    const rest: Outcome[] = [];
    let streak = 0;
    let longestStreak = 0;
    chrono.forEach((g, i) => {
      const prev = chrono[i - 1];
      const sameSession =
        prev && g.game.endTime - prev.game.endTime <= 2 * (g.game.baseTime + 40 * g.game.increment) + 600;
      if (sameSession && prev.game.outcome === 'loss') afterLoss.push(g.game.outcome);
      else rest.push(g.game.outcome);
      streak = g.game.outcome === 'loss' && (sameSession || streak === 0) ? streak + 1 : g.game.outcome === 'loss' ? 1 : 0;
      longestStreak = Math.max(longestStreak, streak);
    });
    const al = record(afterLoss);
    const others = record(rest);
    if (al.n >= 5 && others.n >= 5 && others.score - al.score >= 25) {
      insights.push({
        id: 'tilt',
        category: 'mindset',
        title: 'Losses snowball within a session',
        severity: clamp((others.score - al.score) * 0.8 + al.n * 1.5),
        metric: { value: others.score - al.score, unit: 'point drop after a loss (%)' },
        target: 'Never start a third game after two straight losses.',
        summary: `In games started right after a loss you score ${pct(al.score)} (${al.wins}W ${al.draws}D ${al.losses}L), against ${pct(others.score)} in your other games.`,
        evidence: [
          `${al.n} of ${N} games were played straight after a loss.`,
          ...(longestStreak >= 3 ? [`Longest losing run in one session: ${longestStreak} games.`] : []),
        ],
        advice: [
          'Adopt a hard stop rule: after two losses in a row, end the session or take at least 15 minutes away from the screen.',
          'Never hit "new game" within a minute of a painful loss — that is when judgement is worst.',
          'Decide the number of games before you sit down, rather than playing until you "win it back".',
        ],
        examples: [],
      });
    }
  }

  // --- Strengths ---------------------------------------------------------------------
  const lostPos = games.filter((g) => g.report.hadLost);
  const saved = lostPos.filter((g) => g.game.outcome !== 'loss');
  if (saved.length >= 2 && saved.length / lostPos.length >= 0.3) {
    strengths.push({
      title: 'Resilient defender',
      detail: `You saved ${saved.length} of ${lostPos.length} games in which you were clearly losing at some point.`,
    });
  }
  if (clockGames.length >= 5 && flagged.length === 0 && serious.length >= 5 && ttErrors.length / serious.length < 0.1) {
    strengths.push({
      title: 'Good clock management',
      detail: 'No losses on time, and almost none of your errors happen in time trouble.',
    });
  }
  if (summary.accuracy !== null && summary.opponentAccuracy !== null && summary.accuracy - summary.opponentAccuracy >= 3) {
    strengths.push({
      title: 'More accurate than your opponents',
      detail: `Your average accuracy is ${summary.accuracy.toFixed(1)} against ${summary.opponentAccuracy.toFixed(1)} for your opponents.`,
    });
  }
  const bestOpening = summary.openings
    .filter((o) => o.n >= 3 && o.score >= 70 && o.family !== 'Unknown opening')
    .sort((a, c) => c.score - a.score || c.n - a.n)[0];
  if (bestOpening) {
    strengths.push({
      title: `The ${bestOpening.family} suits you`,
      detail: `${bestOpening.wins}W ${bestOpening.draws}D ${bestOpening.losses}L with ${bestOpening.color === 'w' ? 'White' : 'Black'} — keep playing it.`,
    });
  }
  if (serious.length && hung.length / N < 0.15 && N >= 8) {
    strengths.push({
      title: 'You rarely hang pieces',
      detail: `Only ${plural(hung.length, 'simple material giveaway')} in ${N} games.`,
    });
  }

  insights.sort((a, b2) => b2.severity - a.severity);
  // Show each position once: the highest-ranked weakness gets first pick of examples.
  const used = new Set<string>();
  for (const ins of insights) {
    const key = (e: MoveError) => `${e.gameId}:${e.plyIndex}`;
    const fresh = ins.examples.filter((e) => !used.has(key(e)));
    ins.examples = (fresh.length ? fresh : ins.examples.slice(0, 1)).slice(0, 3);
    ins.examples.forEach((e) => used.add(key(e)));
  }
  return { summary, insights, strengths };
}

const TYPE_SHORT: Record<ErrorType, string> = {
  hung: 'piece given away',
  allowed_tactic: 'tactic allowed',
  allowed_mate: 'mate allowed',
  missed_tactic: 'tactic missed',
  missed_mate: 'mate missed',
  positional: 'positional slip',
};

const POSITIONAL_TITLE: Record<string, string> = {
  pawn: 'You shed pawns without noticing',
  trade: 'Your exchanges favour your opponent',
  king_pawn: 'You weaken your own king',
  development: 'You fall behind in development',
  technique: 'Your endgame technique leaks half-points',
  plan: 'You drift when there is no obvious move',
};

const ENDGAME_LABEL: Record<string, string> = {
  pawn: 'pawn',
  rook: 'rook',
  minor: 'minor-piece',
  queen: 'queen',
  mixed: 'mixed',
};

export type { Motif };
