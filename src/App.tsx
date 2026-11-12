import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChessComError, fetchRecentGames, isValidUsername, normaliseUsername } from './lib/chesscom';
import { analyseGames, type AnalysisHandle, type EngineProgress } from './lib/engine';
import { buildReport } from './lib/evaluate';
import { analyse } from './lib/insights';
import { parseGame } from './lib/parse';
import type { AnalysedGame, Game, GameReport, TimeClass } from './lib/types';
import { formatTimeControl } from './lib/format';
import { GamesTable, Report } from './components/Report';

const GAME_COUNT = 20;
const TIME_CLASSES: { id: TimeClass; label: string; hint: string }[] = [
  { id: 'bullet', label: 'Bullet', hint: 'under 3 min' },
  { id: 'blitz', label: 'Blitz', hint: '3–5 min' },
  { id: 'rapid', label: 'Rapid', hint: '10–30 min' },
  { id: 'daily', label: 'Daily', hint: 'days per move' },
];
const DEPTHS = [
  { depth: 10, label: 'Quick' },
  { depth: 12, label: 'Standard' },
  { depth: 15, label: 'Deep (slower)' },
];

type Status =
  | { kind: 'idle' }
  | { kind: 'fetching'; note: string }
  | { kind: 'analysing'; progress: EngineProgress }
  | { kind: 'done' }
  | { kind: 'error'; message: string };

function readQuery(): { user: string; tc: TimeClass } {
  const q = new URLSearchParams(window.location.search);
  const tc = q.get('tc') as TimeClass | null;
  return {
    user: q.get('user') ?? '',
    tc: tc && TIME_CLASSES.some((t) => t.id === tc) ? tc : 'rapid',
  };
}

export default function App() {
  const initial = useMemo(readQuery, []);
  const [username, setUsername] = useState(initial.user);
  const [timeClass, setTimeClass] = useState<TimeClass>(initial.tc);
  const [depth, setDepth] = useState(12);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [games, setGames] = useState<Game[]>([]);
  const [reports, setReports] = useState<Map<string, GameReport>>(new Map());
  const [subject, setSubject] = useState<{ user: string; tc: TimeClass } | null>(null);

  const runRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const engineRef = useRef<AnalysisHandle | null>(null);

  const stop = useCallback(() => {
    runRef.current++;
    abortRef.current?.abort();
    engineRef.current?.cancel();
  }, []);

  const run = useCallback(
    async (rawUser: string, tc: TimeClass, searchDepth: number) => {
      const user = normaliseUsername(rawUser);
      if (!isValidUsername(user)) {
        setStatus({ kind: 'error', message: 'Enter a valid chess.com username (letters, numbers, - and _).' });
        return;
      }
      stop();
      const runId = runRef.current;
      const live = () => runRef.current === runId;
      const abort = new AbortController();
      abortRef.current = abort;

      setGames([]);
      setReports(new Map());
      setSubject({ user, tc });
      setStatus({ kind: 'fetching', note: 'Looking up games on chess.com…' });
      const url = new URL(window.location.href);
      url.searchParams.set('user', user);
      url.searchParams.set('tc', tc);
      window.history.replaceState(null, '', url);

      try {
        const raw = await fetchRecentGames(
          user,
          tc,
          GAME_COUNT,
          (p) => live() && setStatus({ kind: 'fetching', note: `Found ${p.found} ${tc} games so far (checked ${p.monthsScanned} of up to ${p.monthsTotal} months)…` }),
          abort.signal,
        );
        if (!live()) return;
        const parsed = raw.flatMap((g) => parseGame(g, user) ?? []).slice(0, GAME_COUNT);
        if (!parsed.length) {
          setStatus({
            kind: 'error',
            message: `${user} has no ${tc} games in the last three years. Try a different time control.`,
          });
          return;
        }
        setGames(parsed);

        let last = 0;
        const collected = new Map<string, GameReport>();
        const handle = analyseGames(
          parsed,
          searchDepth,
          (progress) => {
            // Position-level updates arrive very fast; repaint at most ~10x a second.
            const now = performance.now();
            if (live() && (now - last > 100 || progress.positionsDone === progress.positionsTotal)) {
              last = now;
              setStatus({ kind: 'analysing', progress });
            }
          },
          (game, ev) => {
            collected.set(game.id, buildReport(game, ev));
            if (live()) setReports(new Map(collected));
          },
        );
        engineRef.current = handle;
        await handle.promise;
        if (live()) setStatus({ kind: 'done' });
      } catch (e) {
        if (!live() || (e as Error).name === 'AbortError') return;
        setStatus({
          kind: 'error',
          message: e instanceof ChessComError || e instanceof Error ? e.message : 'Something went wrong.',
        });
      }
    },
    [stop],
  );

  // Deep link: /?user=name&tc=blitz starts straight away.
  useEffect(() => {
    if (initial.user) void run(initial.user, initial.tc, 12);
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const analysed: AnalysedGame[] = useMemo(
    () => games.flatMap((g) => (reports.has(g.id) ? [{ game: g, report: reports.get(g.id)! }] : [])),
    [games, reports],
  );
  const analysis = useMemo(() => (status.kind === 'done' ? analyse(analysed) : null), [status.kind, analysed]);
  const busy = status.kind === 'fetching' || status.kind === 'analysing';
  const first = games[0];

  return (
    <div className="app">
      <header className="hero">
        <h1>
          <span aria-hidden="true">♞</span> Chess Insight
        </h1>
        <p>Find out what is actually costing you games. Enter your chess.com username and get an engine-backed breakdown of your last {GAME_COUNT} games.</p>
        <form
          className="search"
          onSubmit={(e) => {
            e.preventDefault();
            void run(username, timeClass, depth);
          }}
        >
          <div className="search-row">
            <label className="field grow">
              <span>chess.com username</span>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="e.g. magnuscarlsen"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                required
              />
            </label>
            <label className="field">
              <span>Analysis</span>
              <select value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
                {DEPTHS.map((d) => (
                  <option key={d.depth} value={d.depth}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="search-row">
            <fieldset className="segmented">
              <legend>Time control</legend>
              {TIME_CLASSES.map((t) => (
                <label key={t.id} className={timeClass === t.id ? 'active' : ''}>
                  <input type="radio" name="tc" value={t.id} checked={timeClass === t.id} onChange={() => setTimeClass(t.id)} />
                  <b>{t.label}</b>
                  <small>{t.hint}</small>
                </label>
              ))}
            </fieldset>
            {busy ? (
              <button type="button" className="primary ghost" onClick={() => { stop(); setStatus({ kind: 'idle' }); }}>
                Cancel
              </button>
            ) : (
              <button type="submit" className="primary">
                Analyse my games
              </button>
            )}
          </div>
        </form>
      </header>

      <main>
        {status.kind === 'error' && (
          <div className="card error" role="alert">
            {status.message}
          </div>
        )}

        {status.kind === 'fetching' && (
          <div className="card progress" role="status">
            <span className="spinner" /> {status.note}
          </div>
        )}

        {status.kind === 'analysing' && (
          <div className="card progress" role="status">
            <div className="progress-head">
              <span>
                <span className="spinner" /> Stockfish is analysing every move — game {Math.min(status.progress.gamesDone + 1, status.progress.gamesTotal)} of{' '}
                {status.progress.gamesTotal}
              </span>
              <span className="muted">{Math.round((status.progress.positionsDone / Math.max(1, status.progress.positionsTotal)) * 100)}%</span>
            </div>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${(status.progress.positionsDone / Math.max(1, status.progress.positionsTotal)) * 100}%` }} />
            </div>
            <p className="muted small">Everything runs in your browser. This usually takes under a minute or two depending on your device; results are cached for next time.</p>
          </div>
        )}

        {status.kind === 'idle' && (
          <section className="how">
            <div className="card">
              <h3>1 · Your real games</h3>
              <p>Pulls your latest {GAME_COUNT} games in the time control you choose, straight from chess.com’s public API.</p>
            </div>
            <div className="card">
              <h3>2 · Every move checked</h3>
              <p>Stockfish evaluates each position in your browser, then every error is sorted by cause: hung pieces, missed tactics, time trouble and more.</p>
            </div>
            <div className="card">
              <h3>3 · A plan, not a number</h3>
              <p>See your biggest weaknesses ranked by cost, with positions from your own games and concrete training advice.</p>
            </div>
          </section>
        )}

        {games.length > 0 && subject && first && (
          <>
            <div className="subject">
              <h2>
                {subject.user} · <span className="cap">{subject.tc}</span>
              </h2>
              <span className="muted">
                {games.length < GAME_COUNT ? `Only ${games.length} games found` : `Last ${games.length} games`} · most recent{' '}
                {new Date(first.endTime * 1000).toLocaleDateString()} · {formatTimeControl(first.baseTime, first.increment, first.timeClass === 'daily')}
              </span>
            </div>
            {analysis && <Report analysis={analysis} games={analysed} />}
            <section>
              <h2>Games</h2>
              <p className="section-note">Click a game to see how your winning chances moved and where it turned.</p>
              <GamesTable games={games} reports={reports} />
            </section>
          </>
        )}
      </main>

      <footer>
        Not affiliated with chess.com. Game data from the chess.com public API; analysis by Stockfish running locally in your browser.
        Accuracy figures are estimates and will differ from chess.com’s own.
      </footer>
    </div>
  );
}
