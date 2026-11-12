import { blendAccuracy, isImpulsive } from './evaluate';
import type { AnalysedGame, Color, EndReason, ErrorType, Insight, MoveError, Outcome, Phase } from './types';

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

export interface Summary extends Record3 {
  byColor: Record<Color, Record3 & { accuracy: number | null }>;
  accuracy: number | null;
  opponentAccuracy: number | null;
  phaseAccuracy: Record<Phase, { accuracy: number | null; moves: number }>;
  severityCounts: { inaccuracy: number; mistake: number; blunder: number };
  /** Mistakes + blunders by cause. */
  typeCounts: Record<ErrorType, number>;
  userMoves: number;
  winReasons: Partial<Record<EndReason, number>>;
  lossReasons: Partial<Record<EndReason, number>>;
  drawReasons: Partial<Record<EndReason, number>>;
  openings: OpeningRow[];
  ratingNow: number;
  ratingChange: number;
  avgOpponentRating: number;
  hasClocks: boolean;
  /** Mistakes + blunders made with under ~10% of the clock left. */
  timeTroubleErrors: number;
  impulsiveErrors: number;
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

export function summarise(games: AnalysedGame[]): Summary {
  const chrono = [...games].sort((a, b) => a.game.endTime - b.game.endTime);
  const all = record(games.map((g) => g.game.outcome));

  const colorStat = (c: Color) => {
    const gs = games.filter((g) => g.game.userColor === c);
    return {
      ...record(gs.map((g) => g.game.outcome)),
      accuracy: mean(gs.flatMap((g) => (g.report.accuracy === null ? [] : [g.report.accuracy]))),
    };
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
  const typeCounts: Record<ErrorType, number> = { hung: 0, missed_win: 0, allowed_mate: 0, other: 0 };
  serious.forEach((e) => typeCounts[e.type]++);

  const reasons = (o: Outcome) => {
    const out: Partial<Record<EndReason, number>> = {};
    games.filter((g) => g.game.outcome === o).forEach((g) => (out[g.game.endReason] = (out[g.game.endReason] ?? 0) + 1));
    return out;
  };

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
      accuracy: mean(gs.flatMap((g) => (g.report.accuracy === null ? [] : [g.report.accuracy]))),
    }))
    .sort((a, b) => b.n - a.n || a.family.localeCompare(b.family));

  const userMoves = games.reduce(
    (s, g) => s + g.report.phases.opening.moves + g.report.phases.middlegame.moves + g.report.phases.endgame.moves,
    0,
  );

  return {
    ...all,
    byColor: { w: colorStat('w'), b: colorStat('b') },
    accuracy: mean(games.flatMap((g) => (g.report.accuracy === null ? [] : [g.report.accuracy]))),
    opponentAccuracy: mean(games.flatMap((g) => (g.report.opponentAccuracy === null ? [] : [g.report.opponentAccuracy]))),
    phaseAccuracy,
    severityCounts: {
      inaccuracy: errors.filter((e) => e.severity === 'inaccuracy').length,
      mistake: errors.filter((e) => e.severity === 'mistake').length,
      blunder: errors.filter((e) => e.severity === 'blunder').length,
    },
    typeCounts,
    userMoves,
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
    seriousErrors: serious.length,
  };
}

const PHASE_LABEL: Record<Phase, string> = { opening: 'opening', middlegame: 'middlegame', endgame: 'endgame' };

export function analyse(games: AnalysedGame[]): Analysis {
  const summary = summarise(games);
  const N = games.length;
  const insights: Insight[] = [];
  const strengths: Strength[] = [];
  if (!N) return { summary, insights, strengths };

  const errors = games.flatMap((g) => g.report.errors);
  const serious = errors.filter((e) => e.severity !== 'inaccuracy');
  const gamesWith = (es: MoveError[]) => new Set(es.map((e) => e.gameId)).size;
  const lostIds = new Set(games.filter((g) => g.game.outcome === 'loss').map((g) => g.game.id));

  // --- Tactics: pieces left en prise -------------------------------------------------
  const hung = serious.filter((e) => e.type === 'hung');
  if (hung.length >= 3) {
    const inLosses = gamesWith(hung.filter((e) => lostIds.has(e.gameId)));
    insights.push({
      id: 'hung-pieces',
      category: 'tactics',
      title: 'You give away material in one move',
      severity: clamp((hung.length / N) * 90),
      summary: `${plural(hung.length, 'time')} in ${plural(N, 'game')} you played a move that let your opponent simply take a piece — one that was undefended, under-defended, or attacked by something cheaper.`,
      evidence: [
        `It happened in ${gamesWith(hung)} of ${N} games${inLosses ? `, including ${inLosses} of your ${plural(lostIds.size, 'loss', 'losses')}` : ''}.`,
        `Each one cost you ${pct(mean(hung.map((e) => e.loss)) ?? 0)} winning chances on average.`,
        `${pct((hung.length / Math.max(1, serious.length)) * 100)} of all your mistakes and blunders are of this type.`,
      ],
      advice: [
        'Before every move, run a three-second safety check: after my move, what can they capture, and what checks do they have?',
        'After your opponent moves, ask "what does that piece attack now that it did not before?" before thinking about your own plans.',
        'Do 10–15 minutes a day of easy puzzles at speed (themes: hanging piece, fork, discovered attack). The goal is pattern recognition, not difficulty.',
      ],
      examples: pickExamples(hung),
    });
  }

  // --- Tactics: walking into mate ----------------------------------------------------
  const mated = serious.filter((e) => e.type === 'allowed_mate');
  if (mated.length >= 2) {
    insights.push({
      id: 'allowed-mate',
      category: 'tactics',
      title: 'You miss threats against your king',
      severity: clamp((mated.length / N) * 130),
      summary: `${plural(mated.length, 'time')} you played a move that allowed a forced checkmate that was not there before.`,
      evidence: [
        `It happened in ${gamesWith(mated)} of ${N} games.`,
        `On average you still had ${pct(mean(mated.map((e) => e.winBefore)) ?? 0)} winning chances right before the move.`,
      ],
      advice: [
        'Whenever enemy pieces gather near your king, stop and list every check your opponent has — then follow each one move further.',
        'Give your king an escape square (a "luft" pawn move like h3/h6) once the position calms down, to rule out back-rank tricks.',
        'Practise mate-in-1 and mate-in-2 puzzles from the defender’s side: look at a position and ask what the mating threat is.',
      ],
      examples: pickExamples(mated),
    });
  }

  // --- Tactics: missed chances -------------------------------------------------------
  const missed = serious.filter((e) => e.type === 'missed_win');
  if (missed.length >= 3) {
    const mates = missed.filter((e) => e.missedMate).length;
    insights.push({
      id: 'missed-wins',
      category: 'tactics',
      title: 'You let opponents off the hook',
      severity: clamp((missed.length / N) * 70),
      summary: `${plural(missed.length, 'time')} your opponent made a serious error and you had a clearly strong reply available, but you played something else and lost most of the advantage.`,
      evidence: [
        `It happened in ${gamesWith(missed)} of ${N} games.`,
        ...(mates ? [`${plural(mates, 'of these was', 'of these were')} a missed forced checkmate.`] : []),
        `Average swing: from ${pct(mean(missed.map((e) => e.winBefore)) ?? 0)} to ${pct(mean(missed.map((e) => e.winAfter)) ?? 0)} winning chances.`,
      ],
      advice: [
        'After every opponent move ask "what did that move stop defending?" — most of these chances appear right after a careless move.',
        'Look at forcing moves first, in this order: checks, captures, threats. Only then consider quiet moves.',
        'Solve harder puzzles slowly (no timer), and only move once you have calculated the full line. This trains you to recognise that a tactic exists.',
      ],
      examples: pickExamples(missed),
    });
  }

  // --- Time: time trouble ------------------------------------------------------------
  const clockGames = games.filter((g) => g.game.hasClocks);
  const flagged = games.filter((g) => g.game.outcome === 'loss' && g.game.endReason === 'timeout');
  const flaggedNotLost = flagged.filter((g) => g.report.finalWin >= 40);
  const ttErrors = serious.filter((e) => e.inTimeTrouble);
  if (clockGames.length >= 5) {
    const share = serious.length ? ttErrors.length / serious.length : 0;
    if (flagged.length >= 3 || (ttErrors.length >= 3 && share >= 0.25)) {
      insights.push({
        id: 'time-trouble',
        category: 'time',
        title: 'Time trouble is costing you games',
        severity: clamp((flagged.length / N) * 150 + (flaggedNotLost.length / N) * 100 + share * 50),
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
          'Play the opening from memory and spend your big thinks on critical moments only (when pieces come into contact). In quiet positions, pick a sensible move within a few seconds.',
          'If time trouble keeps happening, try a time control with increment so you always have a few seconds per move.',
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
          'Time is a resource: unused clock at the end of a lost game is wasted. When the position becomes sharp (captures, checks or threats are possible), deliberately slow down.',
          'Sit on your hands: once you have chosen a move, take one more breath and check what your opponent’s best reply is before playing it.',
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
    insights.push({
      id: 'conversion',
      category: 'conversion',
      title: 'You struggle to convert winning positions',
      severity: clamp((thrown.length / N) * 260),
      summary: `You reached a clearly winning position in ${winning.length} games but failed to win ${thrown.length} of them.`,
      evidence: [
        `Conversion rate: ${pct(((winning.length - thrown.length) / winning.length) * 100)} of winning positions turned into wins.`,
        `Winning those games would have been worth about ${plural(thrown.filter((g) => g.game.outcome === 'loss').length + thrown.filter((g) => g.game.outcome === 'draw').length * 0.5, 'extra point')} in this sample.`,
        ...(lostOnTime ? [`${plural(lostOnTime, 'of these was', 'of these were')} lost on the clock.`] : []),
      ],
      advice: [
        'When you are clearly ahead, switch goals: stop looking for the fastest win and start asking "what is my opponent’s only counterplay?" — then remove it.',
        'Trade pieces (not pawns) when ahead in material. Every exchange makes the extra material count for more and reduces tricks.',
        'Stay just as alert as when the game is equal — most thrown wins come from relaxing, not from difficult positions.',
      ],
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
  const evalByColor = (c: Color) =>
    mean(games.filter((g) => g.game.userColor === c).flatMap((g) => (g.report.openingEval === null ? [] : [g.report.openingEval])));
  const openingErrors = serious.filter((e) => e.phase === 'opening');
  const openingWeakest =
    phases.length === 3 && pa.opening.accuracy! < pa.middlegame.accuracy! && pa.opening.accuracy! < pa.endgame.accuracy!;
  const badOpeningEval = openingEvals.length >= 8 && avgOpeningEval !== null && avgOpeningEval <= -40;
  if (badOpeningEval || openingWeakest || openingErrors.length >= Math.max(4, N * 0.4)) {
    const w = evalByColor('w');
    const b = evalByColor('b');
    const fmt = (cp: number) => `${cp >= 0 ? '+' : '−'}${(Math.abs(cp) / 100).toFixed(1)}`;
    insights.push({
      id: 'opening',
      category: 'opening',
      title: 'You come out of the opening in trouble',
      severity: clamp(
        (badOpeningEval ? 20 + Math.abs(avgOpeningEval!) / 6 : 0) + (openingErrors.length / N) * 40 + (openingWeakest ? 10 : 0),
      ),
      summary: `You made ${plural(openingErrors.length, 'mistake or blunder', 'mistakes and blunders')} in the first 10 moves across ${N} games${avgOpeningEval !== null ? `, and your average position after move 10 is ${fmt(avgOpeningEval)} pawns` : ''}.`,
      evidence: [
        ...(w !== null && b !== null ? [`Average evaluation after move 10: ${fmt(w)} with White, ${fmt(b)} with Black.`] : []),
        ...(pa.opening.accuracy !== null && pa.opening.accuracy < (summary.accuracy ?? 0) ? [`Opening accuracy: ${pa.opening.accuracy.toFixed(1)} (your overall accuracy: ${(summary.accuracy ?? 0).toFixed(1)}).`] : []),
        `${gamesWith(openingErrors)} of ${N} games contained a serious error before move 11.`,
      ],
      advice: [
        'Pick one opening with White and one defence each against 1.e4 and 1.d4, and play only those for the next month. Fewer openings, known deeper.',
        'Stick to principles when out of book: develop a new piece every move, castle by move 10, and do not move the same piece twice or grab pawns with the queen.',
        'After every game, compare your first 10 moves with an opening explorer and note the first move where you left theory. One note per game adds up fast.',
      ],
      examples: pickExamples(openingErrors),
    });
  }

  // --- Weakest phase (middlegame / endgame) ------------------------------------------
  if (phases.length === 3) {
    for (const p of ['middlegame', 'endgame'] as Phase[]) {
      const others = phases.filter((x) => x !== p);
      const gap = (mean(others.map((x) => pa[x].accuracy!)) ?? 0) - pa[p].accuracy!;
      const isLowest = others.every((x) => pa[x].accuracy! > pa[p].accuracy!);
      // The middlegame is the least accurate phase for most players, so it needs a bigger gap to be news.
      if (!isLowest || gap < (p === 'middlegame' ? 7 : 4)) continue;
      const phaseErrors = serious.filter((e) => e.phase === p);
      insights.push({
        id: `phase-${p}`,
        category: 'phase',
        title: p === 'endgame' ? 'Your endgames lag behind the rest of your game' : 'The middlegame is where your games slip',
        // A phase says where errors happen, not why, so it never outranks a concrete cause.
        severity: Math.min(45, gap * 2.5 + (phaseErrors.length / N) * 10),
        summary: `Your ${PHASE_LABEL[p]} accuracy is ${pa[p].accuracy!.toFixed(1)}, ${gap.toFixed(1)} points below the other phases.`,
        evidence: [
          `Accuracy by phase — opening ${pa.opening.accuracy!.toFixed(1)}, middlegame ${pa.middlegame.accuracy!.toFixed(1)}, endgame ${pa.endgame.accuracy!.toFixed(1)}.`,
          `${plural(phaseErrors.length, 'mistake or blunder', 'mistakes and blunders')} in the ${PHASE_LABEL[p]} (${(phaseErrors.length / N).toFixed(1)} per game).`,
        ],
        advice:
          p === 'endgame'
            ? [
                'Activate your king the moment queens come off — in the endgame the king is a fighting piece, and walking it to the centre is usually the best move.',
                'Learn the essential theoretical positions first: king and pawn vs king (opposition, the square rule), then the Lucena and Philidor rook endings.',
                'Play out endgame drills against the computer (chess.com has them) until winning a pawn-up rook ending feels routine.',
              ]
            : [
                'When you do not know what to do, improve your worst-placed piece. A concrete small plan beats a random pawn push.',
                'Before committing to a plan, identify the pawn breaks for both sides — they decide where the game will be fought.',
                'Review your own losses without an engine first: find the move where the game turned and write down what you were thinking, then check it.',
              ],
        examples: pickExamples(phaseErrors),
      });
    }
    const best = [...phases].sort((a, b) => pa[b].accuracy! - pa[a].accuracy!)[0];
    const rest = phases.filter((x) => x !== best);
    if (best !== 'opening' && pa[best].accuracy! - (mean(rest.map((x) => pa[x].accuracy!)) ?? 0) >= 4) {
      strengths.push({
        title: `Strong ${PHASE_LABEL[best]} play`,
        detail: `The ${PHASE_LABEL[best]} is your most accurate phase (${pa[best].accuracy!.toFixed(1)}), well ahead of the rest of your game.`,
      });
    }
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
              'Choose one solid, well-defined defence against 1.e4 and one against 1.d4 and learn the first 6–8 moves and the typical plans.',
              'With Black, equalise first: finish development and castle before looking for activity.',
              'Review your Black losses and look for a shared pattern — the same opening line, or the same kind of attack you did not handle.',
            ]
          : [
              'Build a simple White repertoire around one first move and a system you can reach against most replies.',
              'With White you start half a move ahead — spend it on development and central control, not on early attacks that need your opponent’s help.',
              'Review your White losses and look for a shared pattern, such as the same defence giving you problems.',
            ],
      examples: [],
    });
  }

  // --- A specific opening that keeps failing -----------------------------------------
  const badOpening = summary.openings
    .filter((o) => o.n >= 3 && o.score <= 30 && o.score <= summary.score - 20 && o.family !== 'Unknown opening')
    .sort((a, c) => a.score - c.score || c.n - a.n)[0];
  if (badOpening) {
    const colorName = badOpening.color === 'w' ? 'White' : 'Black';
    insights.push({
      id: 'bad-opening',
      category: 'opening',
      title: `The ${badOpening.family} is not working for you`,
      severity: clamp(20 + badOpening.n * 6 + (summary.score - badOpening.score) * 0.3),
      summary: `You scored ${badOpening.wins}W ${badOpening.draws}D ${badOpening.losses}L in ${badOpening.n} games with ${colorName} in the ${badOpening.family}, against ${pct(summary.score)} overall.`,
      evidence: [
        ...(badOpening.accuracy !== null && summary.accuracy !== null
          ? [`Your accuracy in these games is ${badOpening.accuracy.toFixed(1)} (overall ${summary.accuracy.toFixed(1)}).`]
          : []),
      ],
      advice: [
        `Either invest in it or drop it: watch one good introductory video or read one chapter on the ${badOpening.family} and learn the main plans for your side.`,
        'Go through these games and find where you first felt uncomfortable — that position is what you need to study.',
        badOpening.color === 'b'
          ? 'If it keeps going wrong, switch to a simpler set-up against that first move that leads to positions you understand.'
          : 'If it keeps going wrong, switch to a different first move or a system opening that avoids it.',
      ],
      examples: pickExamples(serious.filter((e) => games.some((g) => g.game.id === e.gameId && g.game.opening.family === badOpening.family && g.game.userColor === badOpening.color))),
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
    const other = record(rest);
    if (al.n >= 5 && other.n >= 5 && other.score - al.score >= 25) {
      insights.push({
        id: 'tilt',
        category: 'mindset',
        title: 'Losses snowball within a session',
        severity: clamp((other.score - al.score) * 0.8 + al.n * 1.5),
        summary: `In games started right after a loss you score ${pct(al.score)} (${al.wins}W ${al.draws}D ${al.losses}L), against ${pct(other.score)} in your other games.`,
        evidence: [
          `${al.n} of ${N} games were played straight after a loss.`,
          ...(longestStreak >= 3 ? [`Longest losing run in one session: ${longestStreak} games.`] : []),
        ],
        advice: [
          'Adopt a hard stop rule: after two losses in a row, end the session or take at least a 15-minute break away from the screen.',
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
      detail: `You saved ${saved.length} of ${lostPos.length} games in which you were clearly losing at some point. Keep making it hard for opponents.`,
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
