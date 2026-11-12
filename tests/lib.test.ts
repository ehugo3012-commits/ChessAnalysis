import { describe, expect, it } from 'vitest';
import fixture from './fixtures/chesscom.json';
import { isValidUsername, normaliseUsername } from '../src/lib/chesscom';
import { buildReport, moveAccuracy, severityOf, winPct } from '../src/lib/evaluate';
import { analyse } from '../src/lib/insights';
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

  it('flags a missed chance after an opponent blunder', () => {
    const game = gameFromMoves(['e4', 'e5', 'Nf3', 'Qh4', 'a3', 'Qxe4+']);
    const ev: GameEval = {
      cp: [20, 20, 20, 20, 600, 0, -100],
      mate: Array(7).fill(null),
      best: ['e2e4', 'e7e5', 'g1f3', 'b8c6', 'f3h4', 'h4e4', 'f1e2'],
    };
    const e = buildReport(game, ev).errors.find((x) => x.san === 'a3')!;
    expect(e.type).toBe('missed_win');
    expect(e.bestSan).toBe('Nxh4');
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
    missedMate: false,
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
          errors: i < 6 ? [fakeError(`g${i}`, { type: 'other', inTimeTrouble: true, winBefore: 90, winAfter: 40 })] : [],
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

  it('handles an empty sample', () => {
    expect(analyse([]).insights).toEqual([]);
  });
});
