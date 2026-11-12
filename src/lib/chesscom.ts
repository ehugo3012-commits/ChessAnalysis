import type { RawGame, TimeClass } from './types';

const API = 'https://api.chess.com/pub';

/** How far back we are willing to look for games in the chosen time control. */
const MAX_MONTHS = 36;

export class ChessComError extends Error {
  kind: 'not-found' | 'rate-limited' | 'blocked' | 'network' | 'invalid';
  constructor(kind: ChessComError['kind'], message: string) {
    super(message);
    this.kind = kind;
  }
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ChessComError('network', 'Could not reach chess.com. Check your connection and try again.');
  }
  if (res.status === 404) throw new ChessComError('not-found', 'Not found');
  if (res.status === 429) {
    throw new ChessComError('rate-limited', 'chess.com is rate-limiting requests right now. Wait a minute and try again.');
  }
  if (!res.ok) {
    throw new ChessComError(
      'blocked',
      `chess.com refused the request (HTTP ${res.status}). This usually clears up after a short wait.`,
    );
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new ChessComError('blocked', 'chess.com returned an unexpected response. Try again shortly.');
  }
}

export function normaliseUsername(input: string): string {
  return input.trim().replace(/^@/, '').toLowerCase();
}

export function isValidUsername(username: string): boolean {
  return /^[a-z0-9_-]{2,30}$/.test(username);
}

export interface FetchProgress {
  monthsScanned: number;
  monthsTotal: number;
  found: number;
}

/**
 * Returns at least `count` of the user's most recent standard-chess games in one time
 * class (when that many exist), newest first. The caller trims after parsing.
 * Monthly archives are fetched one at a time, newest first, and we stop as soon as
 * we have enough, so a typical lookup is 2-3 requests.
 */
export async function fetchRecentGames(
  username: string,
  timeClass: TimeClass,
  count: number,
  onProgress?: (p: FetchProgress) => void,
  signal?: AbortSignal,
): Promise<RawGame[]> {
  const user = encodeURIComponent(username);
  let archives: string[];
  try {
    const data = await getJson<{ archives?: string[] }>(`${API}/player/${user}/games/archives`, signal);
    archives = data.archives ?? [];
  } catch (e) {
    if (e instanceof ChessComError && e.kind === 'not-found') {
      throw new ChessComError('not-found', `No chess.com player called "${username}" was found.`);
    }
    throw e;
  }

  const months = archives.slice(-MAX_MONTHS).reverse();
  const games: RawGame[] = [];
  for (let i = 0; i < months.length && games.length < count; i++) {
    // Archive URLs come from the API; only follow ones that point back at it.
    if (!months[i].startsWith(`${API}/`)) continue;
    const data = await getJson<{ games?: RawGame[] }>(months[i], signal);
    const monthGames = (data.games ?? [])
      .filter((g) => g.time_class === timeClass && g.rules === 'chess' && typeof g.pgn === 'string')
      .sort((a, b) => b.end_time - a.end_time);
    games.push(...monthGames);
    onProgress?.({ monthsScanned: i + 1, monthsTotal: months.length, found: Math.min(games.length, count) });
  }
  return games;
}
