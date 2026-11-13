import type { Game, GameEval } from './types';

const ENGINE_URL = `${import.meta.env.BASE_URL}engine/stockfish-19-lite-single.js`;
const CACHE_PREFIX = 'chess-insight:eval:v2';
const PV_LENGTH = 10;
export const MATE_CP = 10000;

interface SearchResult {
  /** From the side to move. */
  cp: number;
  mate: number | null;
  best: string | null;
  pv: string[];
}

/** One Stockfish instance in a Web Worker, driven over UCI. */
class EngineWorker {
  private worker: Worker;
  private onLine: ((line: string) => void) | null = null;

  constructor() {
    this.worker = new Worker(ENGINE_URL);
    this.worker.onmessage = (ev: MessageEvent) => {
      const data = typeof ev.data === 'string' ? ev.data : '';
      for (const line of data.split('\n')) this.onLine?.(line.trim());
    };
  }

  private send(cmd: string) {
    this.worker.postMessage(cmd);
  }

  private waitFor(token: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The chess engine did not respond.')), timeoutMs);
      this.onLine = (line) => {
        if (line.startsWith(token)) {
          clearTimeout(timer);
          this.onLine = null;
          resolve();
        }
      };
    });
  }

  async init(): Promise<void> {
    const failed = new Promise<never>((_, reject) => {
      this.worker.onerror = () => reject(new Error('The chess engine failed to load.'));
    });
    const ready = this.waitFor('uciok', 30000);
    this.send('uci');
    await Promise.race([ready, failed]);
    this.send('setoption name Hash value 16');
    const ok = this.waitFor('readyok', 30000);
    this.send('isready');
    await Promise.race([ok, failed]);
  }

  newGame() {
    this.send('ucinewgame');
  }

  search(fen: string, depth: number): Promise<SearchResult> {
    return new Promise((resolve) => {
      const result: SearchResult = { cp: 0, mate: null, best: null, pv: [] };
      this.onLine = (line) => {
        if (line.startsWith('info ') && line.includes(' score ')) {
          // Bound-only lines are intermediate aspiration-window results; skip them.
          if (line.includes('lowerbound') || line.includes('upperbound')) return;
          const m = line.match(/ score (cp|mate) (-?\d+)/);
          if (!m) return;
          const v = Number(m[2]);
          const pv = line.match(/ pv (.+)$/);
          if (pv) result.pv = pv[1].split(/\s+/).slice(0, PV_LENGTH);
          if (m[1] === 'cp') {
            result.cp = v;
            result.mate = null;
          } else {
            result.mate = v;
            result.cp = v > 0 ? MATE_CP - v * 10 : v < 0 ? -MATE_CP - v * 10 : -MATE_CP;
          }
        } else if (line.startsWith('bestmove')) {
          const mv = line.split(/\s+/)[1];
          result.best = mv && mv !== '(none)' ? mv : null;
          this.onLine = null;
          resolve(result);
        }
      };
      this.send(`position fen ${fen}`);
      this.send(`go depth ${depth}`);
    });
  }

  terminate() {
    this.worker.terminate();
  }
}

function cacheKey(gameId: string, depth: number) {
  return `${CACHE_PREFIX}:${depth}:${gameId}`;
}

function readCache(game: Game, depth: number): GameEval | null {
  try {
    const raw = localStorage.getItem(cacheKey(game.id, depth));
    if (!raw) return null;
    const ev = JSON.parse(raw) as GameEval;
    return ev.cp.length === game.plies.length + 1 && Array.isArray(ev.pv) ? ev : null;
  } catch {
    return null;
  }
}

function writeCache(game: Game, depth: number, ev: GameEval) {
  const value = JSON.stringify(ev);
  try {
    localStorage.setItem(cacheKey(game.id, depth), value);
  } catch {
    // Storage full or unavailable: drop our older entries and try once more.
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith(CACHE_PREFIX))
        .forEach((k) => localStorage.removeItem(k));
      localStorage.setItem(cacheKey(game.id, depth), value);
    } catch {
      // Caching is only an optimisation.
    }
  }
}

async function analyseGame(
  engine: EngineWorker,
  game: Game,
  depth: number,
  isCancelled: () => boolean,
  onPosition: () => void,
): Promise<GameEval | null> {
  const n = game.plies.length;
  const ev: GameEval = { cp: new Array(n + 1), mate: new Array(n + 1), best: new Array(n + 1), pv: new Array(n + 1) };
  engine.newGame();
  for (let i = 0; i <= n; i++) {
    if (isCancelled()) return null;
    const whiteToMove = i % 2 === 0;
    if (i === n && game.terminal) {
      // No legal moves: the side to move is either mated or stalemated.
      const mated = game.terminal === 'checkmate';
      ev.cp[i] = mated ? (whiteToMove ? -MATE_CP : MATE_CP) : 0;
      ev.mate[i] = mated ? 0 : null;
      ev.best[i] = null;
      ev.pv[i] = [];
    } else {
      const fen = i === n ? game.plies[n - 1].fenAfter : game.plies[i].fenBefore;
      const r = await engine.search(fen, depth);
      const sign = whiteToMove ? 1 : -1;
      ev.cp[i] = r.cp * sign;
      ev.mate[i] = r.mate === null ? null : r.mate * sign;
      ev.best[i] = r.best;
      // The PV belongs to the final iteration only if it starts with the move actually chosen.
      ev.pv[i] = r.best && r.pv[0] === r.best ? r.pv : r.best ? [r.best] : [];
    }
    onPosition();
  }
  return ev;
}

export interface EngineProgress {
  gamesDone: number;
  gamesTotal: number;
  positionsDone: number;
  positionsTotal: number;
}

export interface AnalysisHandle {
  promise: Promise<Map<string, GameEval>>;
  cancel: () => void;
}

/**
 * Evaluates every position of every game with a small pool of Stockfish workers.
 * Each game stays on one worker so the transposition table helps on consecutive positions.
 */
export function analyseGames(
  games: Game[],
  depth: number,
  onProgress: (p: EngineProgress) => void,
  onGameDone?: (game: Game, ev: GameEval) => void,
): AnalysisHandle {
  let cancelled = false;
  const workers: EngineWorker[] = [];
  const results = new Map<string, GameEval>();
  const progress: EngineProgress = {
    gamesDone: 0,
    gamesTotal: games.length,
    positionsDone: 0,
    positionsTotal: games.reduce((s, g) => s + g.plies.length + 1, 0),
  };

  const queue: Game[] = [];
  for (const g of games) {
    const cached = readCache(g, depth);
    if (cached) {
      results.set(g.id, cached);
      progress.gamesDone++;
      progress.positionsDone += g.plies.length + 1;
      onGameDone?.(g, cached);
    } else {
      queue.push(g);
    }
  }
  onProgress({ ...progress });

  const run = async (): Promise<Map<string, GameEval>> => {
    if (!queue.length) return results;
    const cores = navigator.hardwareConcurrency || 4;
    const size = Math.max(1, Math.min(queue.length, cores - 1, 6));
    const loop = async () => {
      const engine = new EngineWorker();
      workers.push(engine);
      await engine.init();
      while (!cancelled) {
        const game = queue.shift();
        if (!game) break;
        const ev = await analyseGame(
          engine,
          game,
          depth,
          () => cancelled,
          () => {
            progress.positionsDone++;
            onProgress({ ...progress });
          },
        );
        if (!ev) break;
        results.set(game.id, ev);
        writeCache(game, depth, ev);
        progress.gamesDone++;
        onProgress({ ...progress });
        onGameDone?.(game, ev);
      }
    };
    try {
      await Promise.all(Array.from({ length: size }, loop));
    } finally {
      workers.forEach((w) => w.terminate());
    }
    if (cancelled) throw new DOMException('Analysis cancelled', 'AbortError');
    return results;
  };

  return {
    promise: run(),
    cancel: () => {
      cancelled = true;
      workers.forEach((w) => w.terminate());
    },
  };
}

/**
 * A single on-demand engine for checking a move the user tries in practice mode.
 * Returns the side-to-move's centipawn score after the move has been played.
 */
export class MoveJudge {
  private engine: EngineWorker | null = null;
  private ready: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  /** Score (centipawns, mate mapped to large values) for the player who just moved. */
  scoreAfter(fenAfter: string, depth = 12): Promise<number> {
    const job = this.queue.then(async () => {
      if (!this.engine) {
        this.engine = new EngineWorker();
        this.ready = this.engine.init();
      }
      await this.ready;
      const r = await this.engine.search(fenAfter, depth);
      // No legal reply: the mover delivered mate (best is null with a mate score) or stalemate.
      return -r.cp;
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  dispose() {
    this.engine?.terminate();
    this.engine = null;
  }
}
