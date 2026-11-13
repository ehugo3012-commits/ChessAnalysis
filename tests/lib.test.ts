import { describe, expect, it } from 'vitest';
import fixture from './fixtures/chesscom.json';
import evalFixture from './fixtures/evals.json';
import { isValidUsername, normaliseUsername } from '../src/lib/chesscom';
import { buildReport, moveAccuracy, severityOf, winPct } from '../src/lib/evaluate';
import { analyse } from '../src/lib/insights';
import { detectMotif, detectMotifInLine, isBackRankMate, lineToSan, materialSwing } from '../src/lib/tactics';
import { extractClocks, outcomeOf, parseGame, parseOpening, parseTimeControl } from '../src/lib/parse';
import type { AnalysedGame, Game, GameEval, GameReport, MoveError, RawGame } from '../src/lib/types';

const USER = 'fixtureplayer';
const rawGames = Object.values(fixture as Record<string, { games?: RawGame[] }>).flatMap((v) => v.games ?? []);

describe('chess.com helpers', () => {
  it('normalises and validates usernames', () => {
    expect(normaliseUsername('  @Hikaru ')).toBe('hikaru');
    expect(isValidUsername('magnus_carlsen-1')).toBe(true);
    expect(isValidUsername('a')).toBe(false);
    expect(isValidUsername('bad name/../x')).toBe(false);
  });

  it('parses time controls', () => {
    expect(parseTimeControl('600')).toEqual({ base: 600, increment: 0 });
    expect(parseTimeControl('180+2')).toEqual({ base: 180, increment: 2 });
    expect(parseTimeControl('1/86400')).toEqual({ base: 86400, increment: 0 });
  });

  it('maps result codes to outcomes', () => {
    expect(outcomeOf('win')).toBe('win');
    expect(outcomeOf('checkmated')).toBe('loss');
    expect(outcomeOf('timeout')).toBe('loss');
    expect(outcomeOf('repetition')).toBe('draw');
    expect(outcomeOf('timevsinsufficient')).toBe('draw');
  });

  it('turns opening URLs into names and families', () => {
    expect(parseOpening('https://www.chess.com/openings/Sicilian-Defense-Open-Najdorf-Variation-6.Be2-e5')).toEqual({
      name: 'Sicilian Defense Open Najdorf Variation',
      family: 'Sicilian Defense',
    });
    expect(parseOpening('https://www.chess.com/openings/Queens-Gambit-Declined-3.Nf3').family).toBe("Queen's Gambit Declined");
    expect(parseOpening('https://www.chess.com/openings/Italian-Game-Two-Knights-Defense').family).toBe('Italian Game');
    expect(parseOpening('https://www.chess.com/openings/Kings-Pawn-Opening-1...e5').name).toBe("King's Pawn Opening");
    expect(parseOpening(undefined).family).toBe('Unknown opening');
  });

  it('extracts clocks from PGN comments', () => {
    expect(extractClocks('1. e4 {[%clk 0:09:58.3]} 1... e5 {[%clk 1:00:00]}')).toEqual([598.3, 3600]);
  });
});

describe('parseGame', () => {
  const games = rawGames.filter((g) => g.rules === 'chess' && g.time_class === 'rapid').map((g) => parseGame(g, USER)!);

  it('parses every fixture game from the user’s side', () => {
    expect(games.length).toBeGreaterThanOrEqual(20);
    for (const g of games) {
      expect(g).not.toBeNull();
      expect(g.plies.length).toBeGreaterThan(1);
      expect(g.hasClocks).toBe(true);
      expect(g.baseTime).toBe(600);
      // Clocks only ever go down without increment, and time spent adds up.
      for (const p of g.plies) {
        expect(p.spent).toBeGreaterThanOrEqual(0);
        expect(p.clockAfter!).toBeLessThanOrEqual(p.clockBefore!);
      }
    }
  });

  it('assigns phases monotonically', () => {
    const order = { opening: 0, middlegame: 1, endgame: 2 };
    for (const g of games) {
      for (let i = 1; i < g.plies.length; i++) {
        expect(order[g.plies[i].phase]).toBeGreaterThanOrEqual(order[g.plies[i - 1].phase]);
      }
    }
  });

  it('rejects games the user did not play in', () => {
    expect(parseGame(rawGames[0], 'someone-else')).toBeNull();
  });
});

describe('evaluation maths', () => {
  it('converts centipawns to win probability', () => {
    expect(winPct(0)).toBeCloseTo(50);
    expect(winPct(10000)).toBeGreaterThan(99);
    expect(winPct(-300)).toBeCloseTo(100 - winPct(300));
    expect(winPct(100)).toBeGreaterThan(55);
  });

  it('classifies moves by win probability lost', () => {
    expect(severityOf(2)).toBeNull();
    expect(severityOf(7)).toBe('inaccuracy');
    expect(severityOf(12)).toBe('mistake');
    expect(severityOf(30)).toBe('blunder');
    expect(moveAccuracy(0)).toBeCloseTo(100, 0);
    expect(moveAccuracy(50)).toBeLessThan(15);
  });
});

/** Builds a game from SAN moves with the user as White. */
function gameFromMoves(moves: string[], color: 'w' | 'b' = 'w'): Game {
  const body = moves.map((m, i) => `${i % 2 ? '' : `${i / 2 + 1}. `}${m}`).join(' ');
  const raw: RawGame = {
    url: 'https://www.chess.com/game/live/1',
    pgn: `[Event "x"]\n\n${body} *`,
    time_control: '600',
    end_time: 1,
    rated: true,
    time_class: 'rapid',
    rules: 'chess',
    white: { username: color === 'w' ? USER : 'opp', rating: 1200, result: 'resigned' },
    black: { username: color === 'w' ? 'opp' : USER, rating: 1200, result: 'win' },
  };
  return parseGame(raw, USER)!;
}

describe('buildReport', () => {
  it('flags a hung queen as a one-move giveaway', () => {
    // 1.e4 e5 2.Qh5 Nc6 3.Qxf7+?? Kxf7
    const game = gameFromMoves(['e4', 'e5', 'Qh5', 'Nc6', 'Qxf7+', 'Kxf7']);
    const ev: GameEval = {
      cp: [20, 20, 0, 0, 10, -900, -900],
      mate: [null, null, null, null, null, null, null],
      best: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'e8f7', 'g1f3'],
      pv: [],
    };
    const report = buildReport(game, ev);
    expect(report.errors).toHaveLength(1);
    const e = report.errors[0];
    expect(e.san).toBe('Qxf7+');
    expect(e.severity).toBe('blunder');
    expect(e.type).toBe('hung');
    expect(e.bestSan).toBe('Bc4');
    expect(e.refutationSan).toBe('Kxf7');
    expect(report.hadLost).toBe(true);
    expect(report.accuracy!).toBeLessThan(60);
  });

  it('flags allowing mate and scores from Black’s side', () => {
    // Fool's mate with the user as White: 1.f3 e5 2.g4?? Qh4#
    const game = gameFromMoves(['f3', 'e5', 'g4', 'Qh4#']);
    expect(game.terminal).toBe('checkmate');
    const ev: GameEval = {
      cp: [20, -60, -80, -9990, -10000],
      mate: [null, null, null, -1, 0],
      best: ['e2e4', 'e7e5', 'e2e4', 'd8h4', null],
      pv: [],
    };
    const report = buildReport(game, ev);
    const blunder = report.errors.find((e) => e.san === 'g4')!;
    expect(blunder.type).toBe('allowed_mate');
    expect(report.finalWin).toBeLessThan(1);

    const asBlack = buildReport(gameFromMoves(['f3', 'e5', 'g4', 'Qh4#'], 'b'), ev);
    expect(asBlack.errors).toHaveLength(0);
    expect(asBlack.finalWin).toBeGreaterThan(99);
    expect(asBlack.opponentAccuracy!).toBeLessThan(asBlack.accuracy!);
  });

  it('flags a missed free piece and explains it', () => {
    const game = gameFromMoves(['e4', 'e5', 'Nf3', 'Qh4', 'a3', 'Qxe4+']);
    const ev: GameEval = {
      cp: [20, 20, 20, 20, 600, 0, -100],
      mate: Array(7).fill(null),
      best: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f3h4', 'h4e4', 'f1e2'],
      pv: [],
    };
    const e = buildReport(game, ev).errors.find((x) => x.san === 'a3')!;
    expect(e.type).toBe('missed_tactic');
    expect(e.motif).toBe('capture');
    expect(e.bestSan).toBe('Nxh4');
    expect(e.explanation).toContain('Nxh4');
    expect(e.explanation).toContain('queen');
  });

  it('attributes a lost game to its turning point', () => {
    const game = gameFromMoves(['e4', 'e5', 'Qh5', 'Nc6', 'Qxf7+', 'Kxf7']);
    const ev: GameEval = {
      cp: [20, 20, 0, 0, 10, -900, -900],
      mate: Array(7).fill(null),
      best: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f1c4', 'e8f7', 'g1f3'],
      pv: [],
    };
    const report = buildReport(game, ev);
    expect(report.decisive?.cause).toBe('hung');
    expect(report.decisive?.error?.san).toBe('Qxf7+');
    expect(report.errors[0].lostPiece).toBe('q');
    expect(report.errors[0].explanation).toContain('queen');
  });
});

describe('tactical motifs', () => {
  it('recognises a knight fork', () => {
    // Nc7+ hits the king on e8 and the rook on a8.
    const hit = detectMotif('r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1', 'b5c7');
    expect(hit?.motif).toBe('fork');
    expect(hit?.targets.sort()).toEqual(['a8', 'e8']);
  });

  it('recognises a pin and a skewer', () => {
    // Bb5 pins the knight on c6 to the king on e8.
    expect(detectMotif('4k3/8/2n5/8/8/8/8/4KB2 w - - 0 1', 'f1b5')?.motif).toBe('pin');
    // Ra8+ skewers the king on d8 and the queen on h8.
    expect(detectMotif('3k3q/8/8/8/8/8/8/R3K3 w - - 0 1', 'a1a8')?.motif).toBe('skewer');
  });

  it('recognises a discovered attack', () => {
    // The knight leaves the e-file with check, uncovering the rook against the queen on e7.
    const hit = detectMotif('6k1/4q3/8/4N3/8/8/8/4R1K1 w - - 0 1', 'e5g6');
    expect(hit?.motif).toBe('discovered');
  });

  it('measures material won over a line', () => {
    // Nc7+ Kd8 Nxa8 wins a rook for nothing.
    expect(materialSwing('r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1', ['b5c7', 'e8d8', 'c7a8'], 'w')).toBe(5);
    expect(materialSwing('r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1', ['b5c7', 'e8d8', 'c7a8'], 'b')).toBe(-5);
  });

  it('spots a back-rank mate', () => {
    expect(isBackRankMate('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1', ['a1a8'])).toBe(true);
  });
});

function fakeError(gameId: string, patch: Partial<MoveError>): MoveError {
  return {
    gameId,
    plyIndex: 30,
    moveNumber: 16,
    color: 'w',
    san: 'Qd2',
    uci: 'd1d2',
    bestSan: 'Nf3',
    bestUci: 'g1f3',
    refutationSan: 'Bxd2',
    refutationUci: 'g5d2',
    fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    winBefore: 60,
    winAfter: 20,
    loss: 40,
    severity: 'blunder',
    type: 'hung',
    phase: 'middlegame',
    motif: null,
    lostPiece: 'n',
    bestLine: ['g1f3'],
    playedLine: ['d1d2', 'g5d2'],
    explanation: 'Qd2 leaves your knight undefended.',
    inTimeTrouble: false,
    impulsive: false,
    ...patch,
  };
}

function fakeGame(i: number, patch: Partial<Game>, report: Partial<GameReport>): AnalysedGame {
  const id = `g${i}`;
  return {
    game: {
      id,
      url: id,
      endTime: 1_700_000_000 + i * 86400,
      rated: true,
      timeClass: 'rapid',
      baseTime: 600,
      increment: 0,
      userColor: i % 2 ? 'b' : 'w',
      userRating: 1200 + i,
      opponent: 'opp',
      opponentRating: 1200,
      outcome: 'win',
      endReason: 'resignation',
      opening: { name: 'Italian Game', family: 'Italian Game' },
      plies: [],
      hasClocks: true,
      terminal: null,
      ...patch,
    },
    report: {
      gameId: id,
      win: [50, 50],
      accuracy: 80,
      opponentAccuracy: 78,
      phases: {
        opening: { moves: 10, accuracySum: 900, inverseSum: 10 / 90 },
        middlegame: { moves: 15, accuracySum: 1200, inverseSum: 15 / 80 },
        endgame: { moves: 10, accuracySum: 800, inverseSum: 10 / 80 },
      },
      errors: [],
      hadWinning: false,
      hadLost: false,
      openingEval: 10,
      finalWin: 50,
      habits: null,
      endgame: null,
      decisive: null,
      ...report,
    },
  };
}

describe('analyse', () => {
  it('surfaces hung pieces as the top weakness when they dominate', () => {
    const games = Array.from({ length: 20 }, (_, i) =>
      fakeGame(i, { outcome: i < 8 ? 'win' : 'loss' }, { errors: i >= 8 ? [fakeError(`g${i}`, {})] : [] }),
    );
    const { insights, summary } = analyse(games);
    expect(summary.wins).toBe(8);
    expect(summary.typeCounts.hung).toBe(12);
    expect(insights[0].id).toBe('hung-pieces');
    expect(insights[0].examples.length).toBe(3);
    expect(insights[0].cost).toBeCloseTo(4.8);
    expect(insights[0].practice?.length).toBeGreaterThan(0);
    expect(new Set(insights[0].examples.map((e) => e.gameId)).size).toBe(3);
  });

  it('detects thrown wins and time trouble, and stays quiet on clean play', () => {
    const games = Array.from({ length: 20 }, (_, i) =>
      fakeGame(
        i,
        { outcome: i < 6 ? 'loss' : 'win', endReason: i < 4 ? 'timeout' : 'resignation' },
        {
          hadWinning: i < 10,
          finalWin: i < 4 ? 70 : 50,
          errors: i < 6 ? [fakeError(`g${i}`, { type: 'positional', inTimeTrouble: true, winBefore: 90, winAfter: 40 })] : [],
        },
      ),
    );
    const ids = analyse(games).insights.map((x) => x.id);
    expect(ids).toContain('conversion');
    expect(ids).toContain('time-trouble');
    expect(ids).not.toContain('hung-pieces');

    const clean = analyse(Array.from({ length: 20 }, (_, i) => fakeGame(i, {}, { hadWinning: true })));
    expect(clean.insights).toHaveLength(0);
    expect(clean.strengths.map((s) => s.title)).toContain('Clinical when ahead');
  });

  it('detects a colour gap and a failing opening', () => {
    const games = Array.from({ length: 20 }, (_, i) =>
      fakeGame(i, {
        outcome: i % 2 ? 'loss' : 'win',
        opening: i % 2 ? { name: 'Sicilian Defense', family: 'Sicilian Defense' } : { name: 'Italian Game', family: 'Italian Game' },
      }, {}),
    );
    const { insights, strengths } = analyse(games);
    const ids = insights.map((x) => x.id);
    expect(ids).toContain('color-gap');
    expect(ids).toContain('bad-opening');
    expect(insights.find((x) => x.id === 'color-gap')!.title).toContain('Black');
    expect(strengths.some((s) => s.title.includes('Italian Game'))).toBe(true);
  });

  it('names the dominant motif and flags opening habits and weak endgames', () => {
    const games = Array.from({ length: 20 }, (_, i) =>
      fakeGame(
        i,
        { outcome: i < 10 ? 'loss' : 'win' },
        {
          errors: i < 8 ? [fakeError(`g${i}`, { type: 'allowed_tactic', motif: i < 6 ? 'fork' : 'pin' })] : [],
          habits: { castledAt: i < 9 ? null : 8, earlyQueen: false, minorsDeveloped: 2 },
          openingEval: -60,
          endgame: i < 8 ? { kind: 'rook', winAtEntry: 60 } : null,
          decisive: i < 8 ? { cause: 'allowed_tactic', error: null } : null,
        },
      ),
    );
    const { insights, summary } = analyse(games);
    const tactic = insights.find((x) => x.id === 'allowed-tactics')!;
    expect(tactic.title).toContain('forks');
    expect(tactic.evidence.join(' ')).toContain('turning point in 8 of your 10 losses');
    expect(summary.motifsAllowed).toEqual({ fork: 6, pin: 2 });
    expect(summary.lossCauses).toEqual({ allowed_tactic: 8 });
    const opening = insights.find((x) => x.id === 'opening')!;
    expect(opening.advice[0]).toContain('Castle by move 10');
    const endgame = insights.find((x) => x.id === 'endgame')!;
    expect(endgame.summary).toContain('8 endgames');
    expect(endgame.advice.join(' ')).toContain('Lucena');
  });

  it('handles an empty sample', () => {
    expect(analyse([]).insights).toEqual([]);
  });
});

describe('full pipeline on the fixture games (engine output recorded at depth 12)', () => {
  const evals = evalFixture as unknown as Record<string, GameEval>;
  const analysed: AnalysedGame[] = rawGames
    .filter((g) => evals[g.url] && g.rules === 'chess' && g.time_class === 'rapid')
    .map((g) => {
      const game = parseGame(g, USER)!;
      return { game, report: buildReport(game, evals[g.url]) };
    });
  const result = analyse(analysed);
  const serious = analysed.flatMap((g) => g.report.errors).filter((e) => e.severity !== 'inaccuracy');

  it('classifies every serious error and explains it with legal lines', () => {
    expect(analysed).toHaveLength(20);
    expect(serious.length).toBeGreaterThan(20);
    for (const e of serious) {
      expect(e.explanation.length).toBeGreaterThan(20);
      expect(e.explanation).not.toMatch(/undefined|null/);
      // Both lines must be playable from the position, starting with the right moves.
      expect(lineToSan(e.fenBefore, e.playedLine)[0]).toBe(e.san);
      expect(lineToSan(e.fenBefore, e.bestLine)[0]).toBe(e.bestSan);
      if (e.type === 'positional') expect(e.motif).not.toBeNull();
      if (e.type === 'hung') expect(e.lostPiece).not.toBeNull();
    }
    const total = Object.values(result.summary.typeCounts).reduce((a, b) => a + b, 0);
    expect(total).toBe(serious.length);
  });

  it('attributes every loss to a cause', () => {
    const losses = analysed.filter((g) => g.game.outcome === 'loss');
    expect(losses.every((g) => g.report.decisive)).toBe(true);
    const attributed = Object.values(result.summary.lossCauses).reduce((a, b) => a + (b ?? 0), 0);
    expect(attributed).toBe(losses.length);
    expect(analysed.filter((g) => g.game.outcome === 'win').every((g) => g.report.decisive === null)).toBe(true);
  });

  it('ranks weaknesses by cost and gives each one a target, practice and examples', () => {
    expect(result.insights.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < result.insights.length; i++) {
      expect(result.insights[i - 1].severity).toBeGreaterThanOrEqual(result.insights[i].severity);
    }
    expect(result.insights[0].id).toBe('hung-pieces');
    for (const ins of result.insights) {
      expect(ins.target).toBeTruthy();
      expect(ins.advice.length).toBeGreaterThanOrEqual(2);
    }
    const shown = result.insights.flatMap((i) => i.examples.map((e) => `${e.gameId}:${e.plyIndex}`));
    expect(new Set(shown).size).toBe(shown.length);
  });
});

describe('motifs inside a line', () => {
  it('finds a fork that comes with check on a loosely defended piece', () => {
    // Qxb4+ checks the king and hits the bishop on b5, which is attacked twice and defended once.
    const fen = 'rn2kb1r/pp1bpppp/3p1n2/qBP5/1P2P3/5N2/P1P1QPPP/RNB1K2R b KQkq - 0 7';
    expect(detectMotifInLine(fen, ['a5b4', 'b1d2', 'b4b5'])?.motif).toBe('fork');
  });
});
