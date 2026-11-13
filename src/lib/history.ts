import type { Analysis } from './insights';

/** A small record of one analysis, kept in localStorage so the next run can show progress. */
export interface Snapshot {
  /** End time of the newest game in the sample (identifies the sample). */
  latestGame: number;
  savedAt: number;
  games: number;
  score: number;
  accuracy: number | null;
  seriousPerGame: number;
  metrics: Record<string, { title: string; value: number; unit: string }>;
}

const key = (user: string, tc: string) => `chess-insight:history:v1:${user}:${tc}`;

function read(user: string, tc: string): Snapshot[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key(user, tc)) ?? '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function makeSnapshot(analysis: Analysis, latestGame: number): Snapshot {
  const s = analysis.summary;
  const metrics: Snapshot['metrics'] = {};
  for (const i of analysis.insights) if (i.metric) metrics[i.id] = { title: i.title, ...i.metric };
  return {
    latestGame,
    savedAt: Date.now(),
    games: s.n,
    score: s.score,
    accuracy: s.accuracy,
    seriousPerGame: s.n ? s.seriousErrors / s.n : 0,
    metrics,
  };
}

/** The most recent earlier analysis that was based on an older set of games. */
export function previousSnapshot(user: string, tc: string, latestGame: number): Snapshot | null {
  const older = read(user, tc).filter((s) => s.latestGame < latestGame);
  return older.sort((a, b) => b.latestGame - a.latestGame)[0] ?? null;
}

export function saveSnapshot(user: string, tc: string, snap: Snapshot): void {
  try {
    const rest = read(user, tc).filter((s) => s.latestGame !== snap.latestGame);
    const all = [...rest, snap].sort((a, b) => a.latestGame - b.latestGame).slice(-12);
    localStorage.setItem(key(user, tc), JSON.stringify(all));
  } catch {
    // History is optional.
  }
}
