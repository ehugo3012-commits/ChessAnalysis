import { useMemo, useState } from 'react';
import type { Analysis } from '../lib/insights';
import type { AnalysedGame, EndReason, Game, GameReport, Insight, MoveError, Outcome } from '../lib/types';
import { ERROR_TYPE_LABEL, SEVERITY_SYMBOL, endReasonLabel, formatDate, moveLabel } from '../lib/format';
import { BarList, EvalGraph, ResultBar, type BarRow } from './Charts';
import { MomentBoard } from './MomentBoard';

const fmt1 = (x: number | null) => (x === null ? '–' : x.toFixed(1));

function impact(severity: number): { label: string; cls: string } {
  if (severity >= 55) return { label: 'High impact', cls: 'high' };
  if (severity >= 30) return { label: 'Medium impact', cls: 'medium' };
  return { label: 'Lower impact', cls: 'low' };
}

/** One concrete routine per weakness, used to build the training plan. */
const DRILLS: Record<string, { focus: string; routine: string }> = {
  'hung-pieces': { focus: 'Blunder check', routine: '15 min of fast, easy puzzles daily + a "what can they take?" check before every move.' },
  'allowed-mate': { focus: 'King safety', routine: '10 mate-in-1/2 puzzles daily, solved from the defender’s side: name the threat before the solution.' },
  'missed-wins': { focus: 'Calculation', routine: '5 harder puzzles daily with no timer — write down the full line before moving a piece.' },
  'time-trouble': { focus: 'Clock discipline', routine: 'Play with checkpoints (half your time left at move 15) and review your clock usage after each game.' },
  'too-fast': { focus: 'Slowing down', routine: 'In every game, pick the three sharpest moments and spend at least 3× your normal time on each.' },
  conversion: { focus: 'Converting wins', routine: 'Replay each thrown win from the winning position against the computer until you win it twice.' },
  opening: { focus: 'Opening basics', routine: 'After each game, check your first 10 moves against an opening explorer and note the first deviation.' },
  'phase-endgame': { focus: 'Endgames', routine: 'Two 20-minute endgame sessions a week: king-and-pawn basics first, then rook endings.' },
  'phase-middlegame': { focus: 'Middlegame plans', routine: 'Review one loss per day without an engine: find the turning point and write what you were thinking.' },
  'color-gap': { focus: 'Repertoire', routine: 'Fix one opening for your weaker colour and play only that for the next 30 games.' },
  'bad-opening': { focus: 'Problem opening', routine: 'Study one model game per week in the opening that keeps failing — or replace it.' },
  tilt: { focus: 'Session rules', routine: 'Stop after two losses in a row. Decide the number of games before you start.' },
};

function InsightBody({ insight, games }: { insight: Insight; games: Map<string, Game> }) {
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
      {insight.examples.length > 0 && (
        <>
          <h4>From your games</h4>
          <div className="moments">
            {insight.examples.map((e) => (
              <MomentBoard key={`${e.gameId}-${e.plyIndex}`} error={e} game={games.get(e.gameId)} />
            ))}
          </div>
        </>
      )}
    </>
  );
}

function InsightCard({ insight, rank, games }: { insight: Insight; rank: number; games: Map<string, Game> }) {
  const imp = impact(insight.severity);
  return (
    <article className="card insight">
      <header className="insight-head">
        <span className="rank">{rank}</span>
        <div>
          <h3>{insight.title}</h3>
          <span className={`pill ${imp.cls}`}>{imp.label}</span>
        </div>
      </header>
      <p className="insight-summary">{insight.summary}</p>
      <InsightBody insight={insight} games={games} />
    </article>
  );
}

/** Lower-priority weaknesses: one line each, details on demand. */
function MinorInsight({ insight, games }: { insight: Insight; games: Map<string, Game> }) {
  return (
    <details className="card minor">
      <summary>
        <b>{insight.title}</b>
        <span className="muted"> — {insight.summary}</span>
      </summary>
      <InsightBody insight={insight} games={games} />
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

function GameRow({ game, report }: { game: Game; report: GameReport | undefined }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<MoveError | null>(null);
  const serious = report?.errors.filter((e) => e.severity !== 'inaccuracy') ?? [];
  const count = (s: string) => report?.errors.filter((e) => e.severity === s).length ?? 0;
  const current = selected ?? serious[0] ?? null;
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
          <span className="muted small hide-sm"> · {endReasonLabel(game.endReason, game.outcome)}</span>
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
          <button className="link" aria-label={open ? 'Hide details' : 'Show details'} disabled={!report}>
            {open ? '▾' : '▸'}
          </button>
        </td>
      </tr>
      {open && report && (
        <tr className="game-detail">
          <td colSpan={7}>
            <EvalGraph game={game} report={report} selected={current} onSelect={setSelected} />
            <div className="detail-cols">
              <div>
                <h4>Key moments</h4>
                {serious.length === 0 && <p className="muted small">No mistakes or blunders — a clean game.</p>}
                <ul className="moment-list">
                  {serious.map((e) => (
                    <li key={e.plyIndex}>
                      <button className={`moment-btn ${current === e ? 'active' : ''}`} onClick={() => setSelected(e)}>
                        <b>
                          {moveLabel(e.moveNumber, e.color, e.san)}
                          <span className={`sev ${e.severity}`}>{SEVERITY_SYMBOL[e.severity]}</span>
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
              {current && <MomentBoard error={current} game={undefined} />}
            </div>
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

export function Report({ analysis, games }: { analysis: Analysis; games: AnalysedGame[] }) {
  const { summary: s, insights, strengths } = analysis;
  const gameMap = useMemo(() => new Map(games.map((g) => [g.game.id, g.game])), [games]);
  const top = insights.slice(0, 3);
  const minor = insights.slice(3, 6);
  const mainOpenings = s.openings.filter((o) => o.n >= 2);
  const onceOnly = s.openings.length - mainOpenings.length;
  const plan = top.flatMap((i) => (DRILLS[i.id] ? [{ id: i.id, ...DRILLS[i.id] }] : []));
  const seriousPerGame = s.n ? s.seriousErrors / s.n : 0;

  const phaseRows: BarRow[] = (['opening', 'middlegame', 'endgame'] as const)
    .filter((p) => s.phaseAccuracy[p].accuracy !== null)
    .map((p) => ({
      label: p[0].toUpperCase() + p.slice(1),
      value: s.phaseAccuracy[p].accuracy!,
      display: s.phaseAccuracy[p].accuracy!.toFixed(1),
    }));
  const typeRows: BarRow[] = (Object.keys(s.typeCounts) as (keyof typeof s.typeCounts)[])
    .map((t) => ({ label: ERROR_TYPE_LABEL[t], value: s.typeCounts[t] }))
    .sort((a, b) => b.value - a.value);

  return (
    <>
      <section className="tiles">
        <div className="tile">
          <span className="tile-label">Record</span>
          <span className="tile-value">
            {s.wins}–{s.draws}–{s.losses}
          </span>
          <ResultBar wins={s.wins} draws={s.draws} losses={s.losses} />
          <span className="tile-note">Wins – draws – losses · {Math.round(s.score)}% score</span>
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

      <section>
        <h2>Your key weaknesses</h2>
        <p className="section-note">
          Ranked by how many points they are costing you. Based on {s.n} games — treat these as strong hints, not verdicts.
        </p>
        {top.length === 0 && (
          <div className="card">
            <p>
              No single pattern stands out in these {s.n} games — your errors are spread evenly rather than concentrated in one
              area. The breakdown below shows where the remaining mistakes come from.
            </p>
          </div>
        )}
        {top.map((ins, i) => (
          <InsightCard key={ins.id} insight={ins} rank={i + 1} games={gameMap} />
        ))}
        {minor.length > 0 && (
          <>
            <h4 className="minor-head">Also worth watching</h4>
            {minor.map((ins) => (
              <MinorInsight key={ins.id} insight={ins} games={gameMap} />
            ))}
          </>
        )}
      </section>

      {plan.length > 0 && (
        <section>
          <h2>Your training plan</h2>
          <div className="card">
            <ol className="plan">
              {plan.map((p) => (
                <li key={p.id}>
                  <b>{p.focus}.</b> {p.routine}
                </li>
              ))}
            </ol>
            <p className="muted small">
              Work on the first item until it stops showing up in your games, then re-run this analysis. Fixing one leak at a time
              beats working on everything at once.
            </p>
          </div>
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

      <section>
        <h2>The numbers</h2>
        <div className="grid2">
          <div className="card">
            <h3>Where your mistakes come from</h3>
            <p className="muted small">Mistakes and blunders by cause ({s.seriousErrors} in total)</p>
            <BarList rows={typeRows} />
            {s.hasClocks && (
              <p className="small muted chart-foot">
                {s.timeTroubleErrors} made in time trouble · {s.impulsiveErrors} played almost instantly
              </p>
            )}
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
            <h3>How you win</h3>
            <BarList rows={reasonRows(s.winReasons, 'win')} max={s.n} empty="No wins in this sample." />
            {Object.keys(s.drawReasons).length > 0 && (
              <>
                <h3 className="spaced">How you draw</h3>
                <BarList rows={reasonRows(s.drawReasons, 'draw')} max={s.n} />
              </>
            )}
          </div>
          <div className="card">
            <h3>How you lose</h3>
            <BarList rows={reasonRows(s.lossReasons, 'loss')} max={s.n} empty="No losses in this sample." />
          </div>
        </div>
      </section>

      <section>
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
    </>
  );
}
