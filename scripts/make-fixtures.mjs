// Generates tests/fixtures/chesscom.json: synthetic games in the exact shape of the
// chess.com public API, played by Stockfish with injected human-style errors.
// Used by the unit tests and for running the app offline (see README).
//
//   node scripts/make-fixtures.mjs
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const USER = 'fixtureplayer';
const BASE = 600;

// Deterministic RNG so the fixture is reproducible.
let seed = 20261112;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 32;
};
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];

const OPENINGS = [
  { eco: 'C50', slug: 'Italian-Game-Giuoco-Pianissimo-Variation', moves: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'd3'] },
  { eco: 'B20', slug: 'Sicilian-Defense-Bowdler-Attack', moves: ['e4', 'c5', 'Bc4'] },
  { eco: 'B50', slug: 'Sicilian-Defense-Modern-Variations', moves: ['e4', 'c5', 'Nf3', 'd6'] },
  { eco: 'D30', slug: 'Queens-Gambit-Declined-3.Nf3', moves: ['d4', 'd5', 'c4', 'e6', 'Nf3'] },
  { eco: 'B10', slug: 'Caro-Kann-Defense-2.d4-d5', moves: ['e4', 'c6', 'd4', 'd5'] },
  { eco: 'D02', slug: 'London-System', moves: ['d4', 'd5', 'Bf4', 'Nf6', 'e3'] },
  { eco: 'B01', slug: 'Scandinavian-Defense-Mieses-Kotrc-Variation', moves: ['e4', 'd5', 'exd5', 'Qxd5', 'Nc3'] },
  { eco: 'C00', slug: 'French-Defense-Knight-Variation', moves: ['e4', 'e6', 'Nf3', 'd5'] },
];

const enginePath = require('stockfish').findEngine('lite-single');
const proc = spawn(process.execPath, [enginePath], { stdio: ['pipe', 'pipe', 'ignore'] });
let buffer = '';
let onLine = null;
proc.stdout.on('data', (d) => {
  buffer += d;
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const l of lines) onLine?.(l.trim());
});
const send = (cmd) => proc.stdin.write(cmd + '\n');
const waitFor = (token) =>
  new Promise((resolve) => {
    onLine = (l) => l.startsWith(token) && resolve();
  });

/** Returns up to 4 candidate moves with scores (centipawns, side to move). */
function search(fen) {
  return new Promise((resolve) => {
    const pvs = new Map();
    onLine = (l) => {
      const m = l.match(/multipv (\d+) score (cp|mate) (-?\d+).* pv (\S+)/);
      if (m) pvs.set(Number(m[1]), { cp: m[2] === 'cp' ? Number(m[3]) : Math.sign(Number(m[3]) || -1) * 9000, move: m[4] });
      else if (l.startsWith('bestmove')) resolve([...pvs.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]));
    };
    send(`position fen ${fen}`);
    send('go depth 7');
  });
}

const clk = (s) => {
  const t = Math.max(0.1, s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = (t % 60).toFixed(1).padStart(4, '0');
  return `${h}:${String(m).padStart(2, '0')}:${sec}`;
};

async function playGame(index, endTime) {
  const userWhite = index % 2 === 0;
  const opening = pick(OPENINGS);
  // A slow, careless profile for some games and a fast one for others.
  const slow = index % 5 === 3;
  const chess = new Chess();
  const clocks = { w: BASE, b: BASE };
  const moves = [];
  const losingStreak = { w: 0, b: 0 };
  let result = null; // { white, black }

  for (let ply = 0; ply < 240 && !result; ply++) {
    const turn = chess.turn();
    const isUser = (turn === 'w') === userWhite;
    let san;
    if (ply < opening.moves.length) {
      san = opening.moves[ply];
    } else {
      const pvs = await search(chess.fen());
      const cp = pvs[0]?.cp ?? 0;
      losingStreak[turn] = cp < -650 ? losingStreak[turn] + 1 : 0;
      if (losingStreak[turn] >= 3 && rnd() < 0.5) {
        result = turn === 'w' ? { white: 'resigned', black: 'win' } : { white: 'win', black: 'resigned' };
        break;
      }
      const lowOnTime = clocks[turn] < 45;
      const blunderRate = (isUser ? 0.085 : 0.06) + (lowOnTime ? 0.15 : 0);
      const r = rnd();
      let uci;
      if (r < blunderRate) uci = null; // random legal move
      else if (r < blunderRate + 0.3 && pvs.length > 1) uci = pick(pvs.slice(1)).move;
      else uci = pvs[0].move;
      const mv = uci
        ? chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
        : chess.move(pick(chess.moves()));
      san = mv.san;
      chess.undo();
    }
    chess.move(san);
    const spent =
      ply < 10 ? 1 + rnd() * 3 : isUser ? (slow ? 6 + rnd() * 34 : 0.6 + rnd() * rnd() * 16) : 2 + rnd() * rnd() * 30;
    clocks[turn] -= spent;
    if (clocks[turn] <= 0) {
      chess.undo();
      result = turn === 'w' ? { white: 'timeout', black: 'win' } : { white: 'win', black: 'timeout' };
      break;
    }
    moves.push({ san, clock: clocks[turn] });
    if (chess.isCheckmate()) result = turn === 'w' ? { white: 'win', black: 'checkmated' } : { white: 'checkmated', black: 'win' };
    else if (chess.isStalemate()) result = { white: 'stalemate', black: 'stalemate' };
    else if (chess.isInsufficientMaterial()) result = { white: 'insufficient', black: 'insufficient' };
    else if (chess.isThreefoldRepetition()) result = { white: 'repetition', black: 'repetition' };
  }
  result ??= { white: 'agreed', black: 'agreed' };

  const score = result.white === 'win' ? '1-0' : result.black === 'win' ? '0-1' : '1/2-1/2';
  const opp = `opponent${String(index + 1).padStart(2, '0')}`;
  const userRating = 1240 + Math.round((rnd() - 0.5) * 60);
  const oppRating = 1240 + Math.round((rnd() - 0.5) * 160);
  const white = { username: userWhite ? USER : opp, rating: userWhite ? userRating : oppRating, result: result.white };
  const black = { username: userWhite ? opp : USER, rating: userWhite ? oppRating : userRating, result: result.black };
  const date = new Date(endTime * 1000).toISOString().slice(0, 10).replace(/-/g, '.');
  const url = `https://www.chess.com/game/live/${9000000000 + index}`;
  const ecoUrl = `https://www.chess.com/openings/${opening.slug}`;
  const body = moves
    .map((m, i) => `${Math.floor(i / 2) + 1}${i % 2 ? '...' : '.'} ${m.san} {[%clk ${clk(m.clock)}]}`)
    .join(' ');
  const pgn = [
    '[Event "Live Chess"]',
    '[Site "Chess.com"]',
    `[Date "${date}"]`,
    '[Round "-"]',
    `[White "${white.username}"]`,
    `[Black "${black.username}"]`,
    `[Result "${score}"]`,
    `[ECO "${opening.eco}"]`,
    `[ECOUrl "${ecoUrl}"]`,
    `[WhiteElo "${white.rating}"]`,
    `[BlackElo "${black.rating}"]`,
    `[TimeControl "${BASE}"]`,
    `[Link "${url}"]`,
    '',
    `${body} ${score}`,
    '',
  ].join('\n');
  return { url, pgn, time_control: String(BASE), end_time: endTime, rated: true, time_class: 'rapid', rules: 'chess', white, black, eco: ecoUrl };
}

send('uci');
await waitFor('uciok');
send('setoption name MultiPV value 4');
send('isready');
await waitFor('readyok');

const nov = [];
const oct = [];
const start = Date.UTC(2026, 9, 26, 18, 0, 0) / 1000;
for (let i = 0; i < 22; i++) {
  // Three or four games per evening session, sessions two days apart.
  const endTime = start + Math.floor(i / 4) * 2 * 86400 + (i % 4) * 1500;
  const game = await playGame(i, endTime);
  (new Date(endTime * 1000).getUTCMonth() === 10 ? nov : oct).push(game);
  process.stdout.write('.');
}
// Distractors the app must filter out: another time class and a variant.
nov.push({ ...nov[0], url: nov[0].url + '1', time_class: 'blitz', time_control: '180' });
oct.push({ ...oct[0], url: oct[0].url + '2', rules: 'chess960' });
proc.kill();

const api = 'https://api.chess.com/pub/player/' + USER;
const fixture = {
  [`${api}/games/archives`]: { archives: [`${api}/games/2026/10`, `${api}/games/2026/11`] },
  [`${api}/games/2026/10`]: { games: oct },
  [`${api}/games/2026/11`]: { games: nov },
};
mkdirSync(join(root, 'tests', 'fixtures'), { recursive: true });
writeFileSync(join(root, 'tests', 'fixtures', 'chesscom.json'), JSON.stringify(fixture, null, 1));
console.log(`\nWrote ${oct.length} + ${nov.length} games`);
