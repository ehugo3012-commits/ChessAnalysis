export type TimeClass = 'bullet' | 'blitz' | 'rapid' | 'daily';
export type Color = 'w' | 'b';
export type Outcome = 'win' | 'draw' | 'loss';
export type Phase = 'opening' | 'middlegame' | 'endgame';

/** A game exactly as returned by the chess.com public API (fields we use). */
export interface RawPlayer {
  username: string;
  rating: number;
  result: string;
}
export interface RawGame {
  url: string;
  pgn?: string;
  time_control: string;
  end_time: number;
  rated: boolean;
  time_class: string;
  rules: string;
  white: RawPlayer;
  black: RawPlayer;
  eco?: string;
}

export type EndReason =
  | 'checkmate'
  | 'resignation'
  | 'timeout'
  | 'abandonment'
  | 'stalemate'
  | 'repetition'
  | 'agreement'
  | 'insufficient'
  | 'fifty-move'
  | 'timeout-vs-insufficient'
  | 'other';

export interface Ply {
  index: number;
  moveNumber: number;
  color: Color;
  san: string;
  uci: string;
  from: string;
  to: string;
  fenBefore: string;
  fenAfter: string;
  /** Seconds left on the mover's clock before / after this move (live games only). */
  clockBefore?: number;
  clockAfter?: number;
  /** Seconds spent thinking on this move. */
  spent?: number;
  phase: Phase;
}

export interface Opening {
  /** Full variation name, e.g. "Sicilian Defense Open Najdorf Variation". */
  name: string;
  /** Opening family used for grouping, e.g. "Sicilian Defense". */
  family: string;
}

export interface Game {
  id: string;
  url: string;
  endTime: number;
  rated: boolean;
  timeClass: TimeClass;
  /** Base time in seconds (per move for daily). */
  baseTime: number;
  increment: number;
  userColor: Color;
  userRating: number;
  opponent: string;
  opponentRating: number;
  outcome: Outcome;
  endReason: EndReason;
  opening: Opening;
  plies: Ply[];
  hasClocks: boolean;
  /** Set when the final position is checkmate/stalemate so the engine can skip it. */
  terminal: 'checkmate' | 'stalemate' | null;
}

/** Raw engine output for one game: one entry per position (plies.length + 1). */
export interface GameEval {
  /** Centipawns from White's point of view. Mates are mapped to large values. */
  cp: number[];
  /** Mate distance from White's point of view (positive = White mates), or null. */
  mate: (number | null)[];
  /** Engine's best move (UCI) in each position, or null for terminal positions. */
  best: (string | null)[];
}

export type Severity = 'inaccuracy' | 'mistake' | 'blunder';
export type ErrorType = 'hung' | 'missed_win' | 'allowed_mate' | 'other';

/** A user move that lost a meaningful amount of winning chances. */
export interface MoveError {
  gameId: string;
  plyIndex: number;
  moveNumber: number;
  color: Color;
  san: string;
  uci: string;
  bestSan: string | null;
  bestUci: string | null;
  /** Opponent's engine-recommended reply to the move played. */
  refutationSan: string | null;
  refutationUci: string | null;
  fenBefore: string;
  /** Win probability (0-100) for the user before and after the move. */
  winBefore: number;
  winAfter: number;
  loss: number;
  severity: Severity;
  type: ErrorType;
  phase: Phase;
  missedMate: boolean;
  inTimeTrouble: boolean;
  impulsive: boolean;
  clockBefore?: number;
  spent?: number;
}

export interface PhaseStat {
  moves: number;
  accuracySum: number;
  /** Sum of 1/accuracy, for the harmonic mean. */
  inverseSum: number;
}

/** Everything derived from the engine for one game, from the user's point of view. */
export interface GameReport {
  gameId: string;
  /** User's win probability (0-100) at every position. */
  win: number[];
  accuracy: number | null;
  opponentAccuracy: number | null;
  phases: Record<Phase, PhaseStat>;
  /** All flagged user moves (inaccuracies, mistakes and blunders). */
  errors: MoveError[];
  /** User reached a clearly winning / clearly lost position at some point. */
  hadWinning: boolean;
  hadLost: boolean;
  /** Evaluation from the user's side (centipawns, clamped) once the opening is over. */
  openingEval: number | null;
  /** User's win probability in the final position. */
  finalWin: number;
}

export interface AnalysedGame {
  game: Game;
  report: GameReport;
}

export type InsightCategory = 'tactics' | 'time' | 'conversion' | 'opening' | 'phase' | 'mindset';

export interface Insight {
  id: string;
  category: InsightCategory;
  title: string;
  /** 0-100. Roughly: how many points this is costing. */
  severity: number;
  summary: string;
  evidence: string[];
  advice: string[];
  examples: MoveError[];
}
