import { useRef, useState } from 'react';
import type { Game, GameReport, MoveError } from '../lib/types';
import { SEVERITY_SYMBOL, moveLabel } from '../lib/format';

export interface BarRow {
  label: string;
  value: number;
  /** Text shown at the end of the bar; defaults to the value. */
  display?: string;
  tone?: 'default' | 'good' | 'bad' | 'muted';
}

/** Horizontal bars with direct value labels. One measure, one hue. */
export function BarList({ rows, max, empty }: { rows: BarRow[]; max?: number; empty?: string }) {
  if (!rows.length) return <p className="muted small">{empty ?? 'No data.'}</p>;
  const top = max ?? Math.max(...rows.map((r) => r.value), 1);
  return (
    <div className="barlist" role="list">
      {rows.map((r) => (
        <div className="barlist-row" role="listitem" key={r.label}>
          <span className="barlist-label">{r.label}</span>
          <span className="barlist-track">
            <span
              className={`barlist-fill tone-${r.tone ?? 'default'}`}
              style={{ width: `${Math.max(r.value > 0 ? 1.5 : 0, (r.value / top) * 100)}%` }}
            />
          </span>
          <span className="barlist-value">{r.display ?? r.value}</span>
        </div>
      ))}
    </div>
  );
}

/** Win / draw / loss as a single stacked bar. */
export function ResultBar({ wins, draws, losses }: { wins: number; draws: number; losses: number }) {
  const n = wins + draws + losses || 1;
  const seg = (count: number, cls: string, name: string) =>
    count > 0 && (
      <span className={`resultbar-seg ${cls}`} style={{ flexGrow: count }} title={`${count} ${name} (${Math.round((count / n) * 100)}%)`}>
        {count}
      </span>
    );
  return (
    <div className="resultbar" role="img" aria-label={`${wins} wins, ${draws} draws, ${losses} losses`}>
      {seg(wins, 'win', 'wins')}
      {seg(draws, 'draw', 'draws')}
      {seg(losses, 'loss', 'losses')}
    </div>
  );
}

const W = 640;
const H = 150;
const PAD = { l: 34, r: 8, t: 8, b: 18 };

/** The user's winning chances over the course of one game, with their errors marked. */
export function EvalGraph({
  game,
  report,
  selected,
  onSelect,
}: {
  game: Game;
  report: GameReport;
  selected: MoveError | null;
  onSelect: (e: MoveError) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const n = report.win.length;
  const x = (i: number) => PAD.l + (i / Math.max(1, n - 1)) * (W - PAD.l - PAD.r);
  const y = (w: number) => PAD.t + (1 - w / 100) * (H - PAD.t - PAD.b);
  const line = report.win.map((w, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(w).toFixed(1)}`).join('');
  const area = `${line}L${x(n - 1).toFixed(1)},${y(50)}L${x(0)},${y(50)}Z`;
  const marks = report.errors.filter((e) => e.severity !== 'inaccuracy');

  const onMove = (ev: React.PointerEvent) => {
    const rect = ref.current!.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  const hoverPly = hover !== null && hover > 0 ? game.plies[hover - 1] : null;
  const tipLeft = hover !== null ? (x(hover) / W) * 100 : 0;

  return (
    <div className="evalgraph">
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Your winning chances over the game"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {[0, 50, 100].map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} className={v === 50 ? 'grid mid' : 'grid'} />
            <text x={PAD.l - 6} y={y(v) + 3.5} textAnchor="end" className="axis">
              {v}%
            </text>
          </g>
        ))}
        {[10, 20, 30, 40, 50, 60, 70, 80].filter((m) => m * 2 < n).map((m) => (
          <text key={m} x={x(m * 2)} y={H - 4} textAnchor="middle" className="axis">
            {m}
          </text>
        ))}
        <path d={area} className="area" />
        <path d={line} className="line" />
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} className="crosshair" />}
        {marks.map((e) => (
          <circle
            key={e.plyIndex}
            cx={x(e.plyIndex + 1)}
            cy={y(report.win[e.plyIndex + 1])}
            r={selected === e ? 6.5 : 4.5}
            className={`mark ${e.severity}`}
          />
        ))}
        {/* Larger invisible hit targets for the markers. */}
        {marks.map((e) => (
          <circle
            key={`hit-${e.plyIndex}`}
            cx={x(e.plyIndex + 1)}
            cy={y(report.win[e.plyIndex + 1])}
            r={12}
            fill="transparent"
            style={{ cursor: 'pointer' }}
            onClick={() => onSelect(e)}
          />
        ))}
      </svg>
      {hover !== null && (
        <div className="tooltip" style={{ left: `${tipLeft}%`, transform: `translateX(${tipLeft > 70 ? '-105%' : '8px'})` }}>
          <b>{hoverPly ? moveLabel(hoverPly.moveNumber, hoverPly.color, hoverPly.san) : 'Start'}</b>
          {(() => {
            const err = hoverPly && report.errors.find((e) => e.plyIndex === hoverPly.index);
            return err ? <span className={`sev ${err.severity}`}> {SEVERITY_SYMBOL[err.severity]}</span> : null;
          })()}
          <br />
          Winning chances {Math.round(report.win[hover])}%
        </div>
      )}
      <div className="evalgraph-legend small muted">
        <span>
          <i className="dot blunder" /> Blunder
        </span>
        <span>
          <i className="dot mistake" /> Mistake
        </span>
        <span>Your winning chances by move — click a marker to see the position</span>
      </div>
    </div>
  );
}
