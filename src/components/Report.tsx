import { useEffect, useMemo, useState } from 'react';
import { MOTIF_LABEL, type Analysis } from '../lib/insights';
import { makeSnapshot, previousSnapshot, saveSnapshot } from '../lib/history';
import type { AnalysedGame, EndReason, ErrorType, Game, GameReport, Insight, LossCause, Outcome } from '../lib/types';
import { ERROR_TYPE_LABEL, LOSS_CAUSE_LABEL, SEVERITY_SYMBOL, endReasonLabel, formatDate, moveLabel } from '../lib/format';
import { ARROW, LineBoard, StaticBoard, type ArrowSpec } from './Board';
import { BarList, EvalGraph, ResultBar, type BarRow } from './Charts';
import { Practice, type Puzzle } from './Practice';

const fmt1 = (x: number | null) => (x === null ? '–' : x.toFixed(1));
type Tab = 'overview' | 'practice' | 'stats' | 'games';

function impact(severity: number): { label: string; cls: string } {
  if (severity >= 55) return { label: 'High impact', cls: 'high' };
  if (severity >= 30) return { label: 'Medium impact', cls: 'medium' };
  return { label: 'Lower impact', cls: 'low' };
}

/** One concrete routine per weakness, used to build the training plan. */
const DRILLS: Record<string, { focus: string; routine: string; check?: string }> = {
  'hung-pieces': { check: 'Is the square I am moving to attacked — and what was this piece defending?', focus: 'Blunder check', routine: '15 minutes of fast, easy puzzles daily, plus a "what can they take?" check before every move you play.' },
  'allowed-tactics': { check: 'What is their most forcing reply (check, capture, threat), and what comes after it?', focus: 'Seeing their threats', routine: '10 puzzles a day solved from the defender’s side: name the threat first, then find the move.' },
  'allowed-mate': { check: 'What checks do they have against my king after this move?', focus: 'King safety', routine: '10 mate-in-1/2 puzzles a day until the common mating patterns are automatic.' },
  'missed-tactics': { check: 'Do I have a check, capture or threat that wins something right now?', focus: 'Calculation', routine: '5 harder puzzles a day with no timer — work out the full line before moving a piece.' },
  positional: { check: 'Does this move improve my worst piece, or am I just moving?', focus: 'Planning', routine: 'After each game, pick the position where you had no plan and write one sentence on what the engine’s move achieves.' },
  'time-trouble': { check: 'Clock check: do I have more than half my time at move 15?', focus: 'Clock discipline', routine: 'Play with checkpoints (half your time left at move 15) and note your clock at moves 15 and 30 after each game.' },
  'too-fast': { check: 'Is this position sharp? If pieces can be taken, I slow down.', focus: 'Slowing down', routine: 'In every game, pick the three sharpest moments and spend at least three times your normal time on each.' },
  conversion: { check: 'I am winning: what is their only counterplay, and how do I stop it?', focus: 'Converting wins', routine: 'Replay each thrown win from the winning position against the computer until you win it twice.' },
  opening: { check: 'Have I developed a new piece this move, and is my king castled?', focus: 'Opening basics', routine: 'After each game, compare your first 10 moves with an opening explorer and note the first deviation.' },
  endgame: { check: 'Is my king as active as it can be?', focus: 'Endgames', routine: 'Two 20-minute endgame sessions a week: king-and-pawn basics first, then rook endings.' },
  'color-gap': { focus: 'Repertoire', routine: 'Fix one opening for your weaker colour and play only that for the next 30 games.' },
  'bad-opening': { focus: 'Problem opening', routine: 'Study one model game per week in the opening that keeps failing — or replace it.' },
  'lower-rated': { check: 'Would I play this move against a stronger opponent?', focus: 'Playing the board', routine: 'Hide opponent ratings for a month (chess.com has a Focus Mode) and play every game the same way.' },
  'resign-early': { check: 'Before resigning: count the material and find my most active move.', focus: 'Fighting on', routine: 'Rule: never resign before counting material and playing your three most active moves.' },
  tilt: { check: 'Did I just lose? If it was two in a row, I stop here.', focus: 'Session rules', routine: 'Stop after two losses in a row. Decide the number of games before you start.' },
};

function InsightBody({ insight, games, onPractice }: { insight: Insight; games: Map<string, Game>; onPractice: () => void }) {
  return (
    <>
      <div className="insight-cols">
        <div>
          <h4>The evidence</h4>
          <ul>
            {insight.evidence.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
        <div>
          <h4>How to fix it</h4>
          <ul>
            {insight.advice.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </div>
      </div>
      {(insight.target || insight.practice) && (
        <div className="goal">
          {insight.target && (
            <p>
              <b>Your target:</b> {insight.target}
            </p>
          )}
          {insight.practice && insight.practice.length > 0 && (
            <p>
              <b>Practise exactly this:</b>{' '}
              {insight.practice.map((p, i) => (
                <span key={p.url}>
                  {i > 0 && ' · '}
                  <a href={p.url} target="_blank" rel="noreferrer">
                    {p.label} ↗
                  </a>
                </span>
              ))}
            </p>
          )}
        </div>
      )}
      {insight.examples.length > 0 && (
        <>
          <div className="examples-head">
            <h4>From your games — step through what happened</h4>
            <button className="secondary small" onClick={onPractice}>
              Try these positions yourself →
            </button>
          </div>
          <div className="moments">
            {insight.examples.map((e) => (
              <LineBoard key={`${e.gameId}-${e.plyIndex}`} error={e} game={games.get(e.gameId)} />
            ))}
          </div>
        </>
      )}
    </>
  );
}

function CostChip({ insight }: { insight: Insight }) {
  if (insight.cost === undefined || insight.cost < 0.3) return null;
  return (
    <span className="pill cost" title="Winning chances given away to this weakness, expressed in game points">
      ≈ {insight.cost.toFixed(1)} points lost
    </span>
  );
}

function InsightCard(props: { insight: Insight; rank: number; games: Map<string, Game>; onPractice: () => void }) {
  const { insight, rank } = props;
  const imp = impact(insight.severity);
  return (
    <article className="card insight">
      <header className="insight-head">
        <span className="rank">{rank}</span>
        <div>
          <h3>{insight.title}</h3>
          <span className={`pill ${imp.cls}`}>{imp.label}</span>
          <CostChip insight={insight} />
        </div>
      </header>
      <p className="insight-summary">{insight.summary}</p>
      <InsightBody {...props} />
    </article>
  );
}

/** Lower-priority weaknesses: one line each, details on demand. */
function MinorInsight(props: { insight: Insight; games: Map<string, Game>; onPractice: () => void }) {
  const { insight } = props;
  return (
    <details className="card minor">
      <summary>
        <b>{insight.title}</b>
        <span className="muted"> — {insight.summary}</span>
      </summary>
      <InsightBody {...props} />
    </details>
  );
}

function ColorChip({ color }: { color: 'w' | 'b' }) {
  return (
    <span className={`chip ${color}`} title={color === 'w' ? 'You had White' : 'You had Black'}>
      {color === 'w' ? 'W' : 'B'}
    </span>
  );
}

function reasonRows(reasons: Partial<Record<EndReason, number>>, outcome: Outcome): BarRow[] {
  return Object.entries(reasons)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, value]) => ({
      label: endReasonLabel(reason as EndReason, outcome),
      value,
      tone: outcome === 'win' ? 'good' : outcome === 'loss' ? 'bad' : 'muted',
    }));
}

const countRows = (counts: Record<string, number>, labels: Record<string, string>): BarRow[] =>
  Object.entries(counts)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, value]) => ({ label: labels[k] ?? k, value }));

/** Board + graph + move-by-move stepping for one game. */
function GameViewer({ game, report }: { game: Game; report: GameReport }) {
  const serious = report.errors.filter((e) => e.severity !== 'inaccuracy');
  const decisive = report.decisive?.error ?? null;
  const n = game.plies.length;
  const [pos, setPos] = useState((decisive ?? serious[0])?.plyIndex ?? 0);
  const seek = (p: number) => setPos(Math.max(0, Math.min(n, p)));
  const fen = pos === n ? game.plies[n - 1].fenAfter : game.plies[pos].fenBefore;
  const error = report.errors.find((e) => e.plyIndex === pos) ?? null;
  const last = pos > 0 ? game.plies[pos - 1] : null;
  const arrows: ArrowSpec[] = error
    ? [
        { uci: error.uci, color: ARROW.played },
        ...(error.bestUci && error.bestUci !== error.uci ? [{ uci: error.bestUci, color: ARROW.best }] : []),
      ]
    : last
      ? [{ uci: last.uci, color: ARROW.last }]
      : [];
  const next = pos < n ? game.plies[pos] : null;

  return (
    <div
      className="viewer"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') seek(pos - 1);
        else if (e.key === 'ArrowRight') seek(pos + 1);
        else return;
        e.preventDefault();
      }}
    >
      <EvalGraph game={game} report={report} cursor={pos} onSeek={seek} />
      <div className="detail-cols">
        <div className="viewer-board">
          <StaticBoard id={`v-${game.id}`} fen={fen} orientation={game.userColor} arrows={arrows} />
          <div className="viewer-controls">
            <button className="step" onClick={() => seek(0)} disabled={pos === 0} aria-label="First move">
              ⏮
            </button>
            <button className="step" onClick={() => seek(pos - 1)} disabled={pos === 0} aria-label="Previous move">
              ◀
            </button>
            <span className="viewer-move">
              {last ? moveLabel(last.moveNumber, last.color, last.san) : 'Start'}
              <span className="muted"> · {Math.round(report.win[pos])}%</span>
            </span>
            <button className="step" onClick={() => seek(pos + 1)} disabled={pos === n} aria-label="Next move">
              ▶
            </button>
            <button className="step" onClick={() => seek(n)} disabled={pos === n} aria-label="Last move">
              ⏭
            </button>
          </div>
          <p className="muted small center">Use ← → to step through the game.</p>
        </div>
        <div>
          {error && next ? (
            <div className={`callout ${error.severity}`}>
              <b>
                {moveLabel(next.moveNumber, next.color, next.san)}
                {SEVERITY_SYMBOL[error.severity]}
              </b>{' '}
              <span className="muted small">
                {ERROR_TYPE_LABEL[error.type]} · −{Math.round(error.loss)}%
              </span>
              <p>{error.explanation}</p>
              {error.bestSan && (
                <p className="small">
                  <i className="swatch" style={{ background: ARROW.played }} /> played {error.san} · <i className="swatch" style={{ background: ARROW.best }} /> better{' '}
                  {error.bestSan}
                </p>
              )}
            </div>
          ) : (
            next && (
              <p className="muted small">
                {next.color === game.userColor ? 'You' : game.opponent} played {moveLabel(next.moveNumber, next.color, next.san)} next.
              </p>
            )
          )}
          <h4>Key moments</h4>
          {report.decisive && !report.decisive.error && (
            <p className="small">
              <b>What decided it:</b> {LOSS_CAUSE_LABEL[report.decisive.cause]}.
            </p>
          )}
          {serious.length === 0 && <p className="muted small">No mistakes or blunders — a clean game.</p>}
          <ul className="moment-list">
            {serious.map((e) => (
              <li key={e.plyIndex}>
                <button className={`moment-btn ${pos === e.plyIndex ? 'active' : ''}`} onClick={() => seek(e.plyIndex)}>
                  <b>
                    {moveLabel(e.moveNumber, e.color, e.san)}
                    <span className={`sev ${e.severity}`}>{SEVERITY_SYMBOL[e.severity]}</span>
                    {e === decisive && <span className="tag">turning point</span>}
                  </b>
                  <span className="muted small">
                    {ERROR_TYPE_LABEL[e.type]} · −{Math.round(e.loss)}%
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <a href={game.url} target="_blank" rel="noreferrer" className="small">
            Open game on chess.com ↗
          </a>
        </div>
      </div>
    </div>
  );
}

function GameRow({ game, report }: { game: Game; report: GameReport | undefined }) {
  const [open, setOpen] = useState(false);
  const count = (s: string) => report?.errors.filter((e) => e.severity === s).length ?? 0;
  const cause: LossCause | undefined = report?.decisive?.cause;
  return (
    <>
      <tr className={`game-row ${open ? 'open' : ''}`} onClick={() => report && setOpen(!open)} aria-expanded={open}>
        <td className="nowrap hide-sm">{formatDate(game.endTime)}</td>
        <td>
          <span className="opp">
            <ColorChip color={game.userColor} />
            <span className="opp-name">{game.opponent}</span> <span className="muted">({game.opponentRating})</span>
          </span>
        </td>
        <td>
          <span className={`result ${game.outcome}`}>{game.outcome === 'win' ? 'Won' : game.outcome === 'loss' ? 'Lost' : 'Draw'}</span>
          <span className="muted small hide-sm"> · {cause ? LOSS_CAUSE_LABEL[cause] : endReasonLabel(game.endReason, game.outcome)}</span>
        </td>
        <td className="hide-sm">{game.opening.family}</td>
        <td className="num">{report ? fmt1(report.accuracy) : <span className="spinner" aria-label="Analysing" />}</td>
        <td className="num nowrap">
          {report && (
            <>
              <span className="sev blunder">{count('blunder')}</span> / <span className="sev mistake">{count('mistake')}</span>
            </>
          )}
        </td>
        <td className="num">
          <button className="link" aria-label={open ? 'Hide game' : 'Show game'} disabled={!report}>
            {open ? '▾' : '▸'}
          </button>
        </td>
      </tr>
      {open && report && (
        <tr className="game-detail">
          <td colSpan={7}>
            <GameViewer game={game} report={report} />
          </td>
        </tr>
      )}
    </>
  );
}

export function GamesTable({ games, reports }: { games: Game[]; reports: Map<string, GameReport> }) {
  return (
    <div className="card table-card">
      <table className="games">
        <thead>
          <tr>
            <th className="hide-sm">Date</th>
            <th>Opponent</th>
            <th>Result</th>
            <th className="hide-sm">Opening</th>
            <th className="num">Accuracy</th>
            <th className="num" title="Blunders / mistakes">
              ?? / ?
            </th>
            <th />
          </tr>
        </thead>
        <tbody>
          {games.map((g) => (
            <GameRow key={g.id} game={g} report={reports.get(g.id)} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Rates like 0.85 need two decimals; percentages like 75 need none. */
const digitsFor = (v: number) => (Math.abs(v) >= 10 ? 0 : 2);

function Delta({ now, before, lowerIsBetter, digits = 1 }: { now: number; before: number; lowerIsBetter: boolean; digits?: number }) {
  const diff = now - before;
  if (Math.abs(diff) < 10 ** -digits / 2) return <span className="muted">no change</span>;
  const better = lowerIsBetter ? diff < 0 : diff > 0;
  return (
    <span className={better ? 'delta better' : 'delta worse'}>
      {diff > 0 ? '▲' : '▼'} {Math.abs(diff).toFixed(digits)} {better ? 'better' : 'worse'}
    </span>
  );
}

function Progress({ analysis, user, tc, latestGame }: { analysis: Analysis; user: string; tc: string; latestGame: number }) {
  const previous = useMemo(() => previousSnapshot(user, tc, latestGame), [user, tc, latestGame]);
  useEffect(() => saveSnapshot(user, tc, makeSnapshot(analysis, latestGame)), [analysis, user, tc, latestGame]);
  if (!previous) {
    return (
      <p className="muted small progress-note">
        This analysis is saved on this device. Run it again after your next batch of games to see whether each weakness is shrinking.
      </p>
    );
  }
  const s = analysis.summary;
  const current = new Map(analysis.insights.map((i) => [i.id, i]));
  const gone = Object.entries(previous.metrics).filter(([id]) => !current.has(id));
  return (
    <section>
      <h2>Progress since {new Date(previous.savedAt).toLocaleDateString()}</h2>
      <div className="card">
        <table className="progress-table">
          <tbody>
            {s.accuracy !== null && previous.accuracy !== null && (
              <tr>
                <td>Accuracy</td>
                <td className="num">
                  {previous.accuracy.toFixed(1)} → <b>{s.accuracy.toFixed(1)}</b>
                </td>
                <td>
                  <Delta now={s.accuracy} before={previous.accuracy} lowerIsBetter={false} />
                </td>
              </tr>
            )}
            <tr>
              <td>Mistakes + blunders per game</td>
              <td className="num">
                {previous.seriousPerGame.toFixed(1)} → <b>{(s.seriousErrors / s.n).toFixed(1)}</b>
              </td>
              <td>
                <Delta now={s.seriousErrors / s.n} before={previous.seriousPerGame} lowerIsBetter />
              </td>
            </tr>
            {analysis.insights
              .filter((i) => i.metric && previous.metrics[i.id])
              .map((i) => (
                <tr key={i.id}>
                  <td>
                    {i.title} <span className="muted small">({i.metric!.unit})</span>
                  </td>
                  <td className="num">
                    {previous.metrics[i.id].value.toFixed(digitsFor(i.metric!.value))} → <b>{i.metric!.value.toFixed(digitsFor(i.metric!.value))}</b>
                  </td>
                  <td>
                    <Delta now={i.metric!.value} before={previous.metrics[i.id].value} lowerIsBetter digits={digitsFor(i.metric!.value)} />
                  </td>
                </tr>
              ))}
            {gone.map(([id, m]) => (
              <tr key={id}>
                <td>{m.title}</td>
                <td className="num">
                  {m.value.toFixed(digitsFor(m.value))} → <b>–</b>
                </td>
                <td>
                  <span className="delta better">✓ no longer showing up</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function Report({ analysis, games, user, tc }: { analysis: Analysis; games: AnalysedGame[]; user: string; tc: string }) {
  const { summary: s, insights, strengths } = analysis;
  const [tab, setTabState] = useState<Tab>(() => {
    const h = window.location.hash.slice(1) as Tab;
    return (['overview', 'practice', 'stats', 'games'] as Tab[]).includes(h) ? h : 'overview';
  });
  const setTab = (t: Tab) => {
    setTabState(t);
    // Keep the open tab in the address so a reload or a shared link lands in the same place.
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${t === 'overview' ? '' : `#${t}`}`);
  };
  const gameMap = useMemo(() => new Map(games.map((g) => [g.game.id, g.game])), [games]);
  const top = insights.slice(0, 3);
  const minor = insights.slice(3, 7);
  const mainOpenings = s.openings.filter((o) => o.n >= 2);
  const onceOnly = s.openings.length - mainOpenings.length;
  const plan = top.flatMap((i) => (DRILLS[i.id] ? [{ insight: i, ...DRILLS[i.id] }] : []));
  const checklist = insights.slice(0, 5).flatMap((i) => (DRILLS[i.id]?.check ? [DRILLS[i.id].check!] : [])).slice(0, 4);
  // Where study time should go, from where the winning chances actually went.
  const studySplit = (() => {
    const tactical = s.typeCost.hung + s.typeCost.allowed_tactic + s.typeCost.allowed_mate + s.typeCost.missed_tactic + s.typeCost.missed_mate;
    const total = tactical + s.typeCost.positional;
    if (total < 1) return null;
    const share = Math.round((tactical / total) * 100);
    const tacticalLosses = (['hung', 'allowed_tactic', 'allowed_mate'] as const).reduce((n, c) => n + (s.lossCauses[c] ?? 0), 0);
    const lossNote = s.losses ? ` ${tacticalLosses} of your ${s.losses} losses turned on a tactical oversight.` : '';
    if (share >= 65) {
      return `${share}% of the winning chances you gave away went to tactical oversights.${lossNote} Until that changes, put most of your chess time into tactics and blunder-checking — opening study will not move your rating nearly as much.`;
    }
    if (share <= 40) {
      return `Only ${share}% of the winning chances you gave away were tactical — your errors are mostly about plans, exchanges and technique.${lossNote} Spend most of your time on annotated games and endgames rather than puzzles.`;
    }
    return `Your lost winning chances split about ${share}% tactical / ${100 - share}% positional.${lossNote} Divide your study time the same way.`;
  })();
  const seriousPerGame = s.n ? s.seriousErrors / s.n : 0;
  const latestGame = Math.max(...games.map((g) => g.game.endTime));

  // The user's own worst moments as puzzles: turning points first, then by damage done.
  const puzzles: Puzzle[] = useMemo(() => {
    const all = games.flatMap((g) =>
      g.report.errors
        .filter((e) => e.severity !== 'inaccuracy' && e.bestUci)
        .map((e) => ({ error: e, game: g.game, weight: e.loss + (g.report.decisive?.error === e ? 30 : 0) })),
    );
    return all.sort((a, b) => b.weight - a.weight).slice(0, 12);
  }, [games]);

  const goPractice = () => {
    setTab('practice');
    document.querySelector('.tabs')?.scrollIntoView({ block: 'start' });
  };
  const select = (t: Tab) => {
    setTab(t);
    const bar = document.querySelector('.tabs');
    if (bar && bar.getBoundingClientRect().top <= 0) bar.scrollIntoView({ block: 'start' });
  };

  const phaseRows: BarRow[] = (['opening', 'middlegame', 'endgame'] as const)
    .filter((p) => s.phaseAccuracy[p].accuracy !== null)
    .map((p) => ({
      label: p[0].toUpperCase() + p.slice(1),
      value: s.phaseAccuracy[p].accuracy!,
      display: s.phaseAccuracy[p].accuracy!.toFixed(1),
    }));
  const typeRows: BarRow[] = (Object.keys(s.typeCounts) as ErrorType[])
    .filter((t) => s.typeCounts[t] > 0)
    .map((t) => ({ label: ERROR_TYPE_LABEL[t], value: s.typeCost[t], display: `${s.typeCounts[t]}× · ${s.typeCost[t].toFixed(1)} pts` }))
    .sort((a, b) => b.value - a.value);
  const causeRows: BarRow[] = countRows(s.lossCauses as Record<string, number>, LOSS_CAUSE_LABEL).map((r) => ({ ...r, tone: 'bad' }));
  const bandRows = s.bands.map((b) => ({
    label: `${b.label.replace(/ \(.*\)/, '')} · ${b.n} games`,
    value: b.score,
    display: `${Math.round(b.score)}% vs ${Math.round(b.expected)}%`,
    tone: (b.score >= b.expected ? 'good' : 'bad') as BarRow['tone'],
  }));

  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Weaknesses' },
    { id: 'practice', label: `Practice (${puzzles.length})` },
    { id: 'stats', label: 'Statistics' },
    { id: 'games', label: `Games (${games.length})` },
  ];

  return (
    <>
      <section className="tiles">
        <div className="tile">
          <span className="tile-label">Record</span>
          <span className="tile-value">
            {s.wins}–{s.draws}–{s.losses}
          </span>
          <ResultBar wins={s.wins} draws={s.draws} losses={s.losses} />
          <span className="tile-note">
            Wins – draws – losses · {Math.round(s.score)}% (ratings predict {Math.round(s.expectedScore)}%)
          </span>
        </div>
        <div className="tile">
          <span className="tile-label">Accuracy</span>
          <span className="tile-value">{fmt1(s.accuracy)}</span>
          <span className="tile-note">Opponents: {fmt1(s.opponentAccuracy)}</span>
        </div>
        <div className="tile">
          <span className="tile-label">Mistakes + blunders</span>
          <span className="tile-value">{seriousPerGame.toFixed(1)}</span>
          <span className="tile-note">
            per game · {s.severityCounts.blunder} blunders, {s.severityCounts.mistake} mistakes
          </span>
        </div>
        <div className="tile">
          <span className="tile-label">Rating</span>
          <span className="tile-value">{s.ratingNow}</span>
          <span className="tile-note">
            {s.ratingChange === 0 ? 'No change' : `${s.ratingChange > 0 ? '▲ +' : '▼ −'}${Math.abs(s.ratingChange)}`} over these games ·
            avg opponent {s.avgOpponentRating}
          </span>
        </div>
      </section>

      <nav className="tabs" role="tablist" aria-label="Report sections">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'active' : ''} onClick={() => select(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'overview' && (
        <>
          <Progress analysis={analysis} user={user} tc={tc} latestGame={latestGame} />
          {causeRows.length > 0 && (
            <section>
              <h2>What decided your {s.losses} losses</h2>
              <p className="section-note">Each lost game is traced back to the move, or the reason, that turned it.</p>
              <div className="card">
                <BarList rows={causeRows} max={s.losses} />
              </div>
            </section>
          )}
          <section>
            <h2>Your key weaknesses</h2>
            <p className="section-note">
              Ranked by the winning chances they cost you. Based on {s.n} games — treat these as strong hints, not verdicts.
            </p>
            {s.n < 10 && (
              <div className="card caution">
                Only {s.n} games were available in this time control. Patterns need repetition to show up, so some real weaknesses will
                not appear yet and the ones below are tentative. The Practice and Games tabs are just as useful with few games.
              </div>
            )}
            {top.length === 0 && (
              <div className="card">
                <p>
                  No single pattern stands out in these {s.n} games — your errors are spread evenly rather than concentrated in one area.
                  The Statistics tab shows where the remaining mistakes come from, and Practice lets you replay them.
                </p>
              </div>
            )}
            {top.map((ins, i) => (
              <InsightCard key={ins.id} insight={ins} rank={i + 1} games={gameMap} onPractice={goPractice} />
            ))}
            {minor.length > 0 && (
              <>
                <h4 className="minor-head">Also worth watching</h4>
                {minor.map((ins) => (
                  <MinorInsight key={ins.id} insight={ins} games={gameMap} onPractice={goPractice} />
                ))}
              </>
            )}
          </section>

          {plan.length > 0 && (
            <section>
              <h2>Your training plan</h2>
              <div className="card">
                {studySplit && <p className="study-split">{studySplit}</p>}
                <ol className="plan">
                  {plan.map((p) => (
                    <li key={p.insight.id}>
                      <b>{p.focus}.</b> {p.routine}
                      {p.insight.target && <div className="muted small">Goal: {p.insight.target}</div>}
                    </li>
                  ))}
                  <li>
                    <b>Your own mistakes.</b> Solve the {puzzles.length} positions in the{' '}
                    <button className="inline-link" onClick={goPractice}>
                      Practice tab
                    </button>{' '}
                    until you get each one right first try.
                  </li>
                </ol>
                <p className="muted small">
                  Work on the first item until it stops showing up in your games, then run this analysis again. One leak at a time beats
                  working on everything at once.
                </p>
              </div>
              {checklist.length > 0 && (
                <div className="card checklist">
                  <h3>Your pre-move checklist</h3>
                  <p className="muted small">Built from your own weaknesses. Ask these, in this order, before you play a move — keep it next to the board.</p>
                  <ol>
                    {checklist.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ol>
                </div>
              )}
            </section>
          )}

          {strengths.length > 0 && (
            <section>
              <h2>What you do well</h2>
              <div className="strengths">
                {strengths.map((st) => (
                  <div className="card strength" key={st.title}>
                    <h3>
                      <span aria-hidden="true">✓</span> {st.title}
                    </h3>
                    <p>{st.detail}</p>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}

      {tab === 'practice' && (
        <section>
          <h2>Practise your own mistakes</h2>
          <p className="section-note">
            These are the positions from your games where you lost the most. Finding the right move yourself is what makes the pattern
            stick — far more than reading about it.
          </p>
          <Practice puzzles={puzzles} />
        </section>
      )}

      {tab === 'stats' && (
        <section>
          <h2>The numbers</h2>
          <div className="grid2">
            <div className="card">
              <h3>Where your mistakes come from</h3>
              <p className="muted small">
                Mistakes and blunders by cause, sized by winning chances given away ({s.seriousErrors} in total; 1 pt = one game)
              </p>
              <BarList rows={typeRows} />
              {s.hasClocks && (
                <p className="small muted chart-foot">
                  {s.timeTroubleErrors} made in time trouble · {s.impulsiveErrors} played almost instantly
                  {s.thinkTime && ` · you think ${s.thinkTime.errors.toFixed(0)}s on these moves, ${s.thinkTime.all.toFixed(0)}s on an average move`}
                </p>
              )}
            </div>
            <div className="card">
              <h3>Tactics you fall for</h3>
              <p className="muted small">The idea behind each tactic or mate you allowed</p>
              <BarList rows={countRows(s.motifsAllowed, MOTIF_LABEL)} empty="You did not walk into any multi-move tactics." />
              <h3 className="spaced">Tactics you miss</h3>
              <p className="muted small">Winning ideas that were available to you</p>
              <BarList rows={countRows(s.motifsMissed, MOTIF_LABEL)} empty="You did not miss any clear winning tactics." />
            </div>
            <div className="card">
              <h3>Positional slips by kind</h3>
              <p className="muted small">Mistakes where no piece was lost, sorted by what went wrong</p>
              <BarList rows={countRows(s.positionalKinds, MOTIF_LABEL)} empty="No positional mistakes or blunders." />
            </div>
            <div className="card">
              <h3>Accuracy by phase</h3>
              <p className="muted small">Average move accuracy, 0–100</p>
              <BarList rows={phaseRows} max={100} />
              <p className="small muted chart-foot">
                With White {fmt1(s.byColor.w.accuracy)} ({s.byColor.w.wins}W {s.byColor.w.draws}D {s.byColor.w.losses}L) · with Black{' '}
                {fmt1(s.byColor.b.accuracy)} ({s.byColor.b.wins}W {s.byColor.b.draws}D {s.byColor.b.losses}L)
              </p>
            </div>
            <div className="card">
              <h3>Results by opponent strength</h3>
              <p className="muted small">Your score vs. the score the rating difference predicts (higher/lower = 25+ points apart)</p>
              <BarList rows={bandRows} max={100} />
            </div>
            {s.habits && (
              <div className="card">
                <h3>Opening habits</h3>
                <p className="muted small">From the {s.habits.games} games that lasted at least 10 moves</p>
                <BarList
                  max={s.habits.games}
                  rows={[
                    { label: 'Castled', value: s.habits.games - s.habits.neverCastled, display: `${s.habits.games - s.habits.neverCastled} of ${s.habits.games}`, tone: 'good' },
                    { label: 'Never castled', value: s.habits.neverCastled, display: `${s.habits.neverCastled} · scored ${Math.round(s.habits.neverCastledScore)}%`, tone: 'bad' },
                    { label: 'Queen out early', value: s.habits.earlyQueen, display: `${s.habits.earlyQueen} of ${s.habits.games}`, tone: 'muted' },
                  ]}
                />
                <p className="small muted chart-foot">
                  {s.habits.avgMinors.toFixed(1)} of 4 knights and bishops developed by move 10
                  {s.habits.avgCastleMove !== null && ` · castles on move ${s.habits.avgCastleMove.toFixed(0)} on average`}
                </p>
              </div>
            )}
            <div className="card">
              <h3>How your games end</h3>
              <BarList rows={[...reasonRows(s.winReasons, 'win'), ...reasonRows(s.drawReasons, 'draw'), ...reasonRows(s.lossReasons, 'loss')]} max={s.n} />
              <p className="small muted chart-foot">Green: wins · grey: draws · red: losses</p>
            </div>
          </div>

          <h2>Openings</h2>
          <div className="card table-card">
            <table className="openings">
              <thead>
                <tr>
                  <th>Opening</th>
                  <th className="num">Games</th>
                  <th>Results</th>
                  <th className="num">Accuracy</th>
                </tr>
              </thead>
              <tbody>
                {(mainOpenings.length ? mainOpenings : s.openings).map((o) => (
                  <tr key={`${o.color}-${o.family}`}>
                    <td>
                      <span className="opp">
                        <ColorChip color={o.color} />
                        <span>{o.family}</span>
                      </span>
                    </td>
                    <td className="num">{o.n}</td>
                    <td className="results-cell">
                      <ResultBar wins={o.wins} draws={o.draws} losses={o.losses} />
                    </td>
                    <td className="num">{fmt1(o.accuracy)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {mainOpenings.length > 0 && onceOnly > 0 && (
              <p className="muted small table-foot">
                Plus {onceOnly} opening{onceOnly === 1 ? '' : 's'} played only once — too few games to say anything about.
              </p>
            )}
          </div>
        </section>
      )}

      {tab === 'games' && (
        <section>
          <h2>Games</h2>
          <p className="section-note">Open a game to replay it move by move and see where it turned.</p>
          <GamesTable games={games.map((g) => g.game)} reports={new Map(games.map((g) => [g.game.id, g.report]))} />
        </section>
      )}
    </>
  );
}
