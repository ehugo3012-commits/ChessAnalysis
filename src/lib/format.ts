import type { EndReason, ErrorType, Outcome, Severity } from './types';

export function formatClock(seconds: number | undefined): string {
  if (seconds === undefined) return '–';
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatTimeControl(base: number, increment: number, daily: boolean): string {
  if (daily) return `${Math.round(base / 86400)} day/move`;
  const mins = base % 60 === 0 ? String(base / 60) : (base / 60).toFixed(1);
  return increment ? `${mins}+${increment}` : `${mins} min`;
}

export function endReasonLabel(reason: EndReason, outcome: Outcome): string {
  switch (reason) {
    case 'checkmate':
      return outcome === 'win' ? 'Checkmate' : 'Checkmated';
    case 'resignation':
      return outcome === 'win' ? 'Opponent resigned' : 'Resigned';
    case 'timeout':
      return outcome === 'win' ? 'Opponent ran out of time' : 'Ran out of time';
    case 'abandonment':
      return outcome === 'win' ? 'Opponent abandoned' : 'Abandoned';
    case 'stalemate':
      return 'Stalemate';
    case 'repetition':
      return 'Repetition';
    case 'agreement':
      return 'Draw agreed';
    case 'insufficient':
      return 'Insufficient material';
    case 'fifty-move':
      return '50-move rule';
    case 'timeout-vs-insufficient':
      return 'Timeout vs insufficient material';
    default:
      return 'Other';
  }
}

export const ERROR_TYPE_LABEL: Record<ErrorType, string> = {
  hung: 'Gave away material in one move',
  missed_win: 'Missed a winning chance',
  allowed_mate: 'Allowed a forced mate',
  other: 'Deeper tactical or positional error',
};

export const SEVERITY_SYMBOL: Record<Severity, string> = { inaccuracy: '?!', mistake: '?', blunder: '??' };

/** "23. Qd2" for White, "23… Qd2" for Black. */
export function moveLabel(moveNumber: number, color: 'w' | 'b', san: string): string {
  return `${moveNumber}${color === 'w' ? '.' : '…'} ${san}`;
}
