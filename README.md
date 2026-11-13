# Chess Insight

A web app that analyses your latest 20 chess.com games in a chosen time control and tells
you what is actually costing you points — with positions from your own games and a
concrete plan to fix it.

Everything runs in the browser: games come from the chess.com public API and every move
is checked by Stockfish (WebAssembly) in Web Workers. There is no backend.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173
```

`npm run build` produces a static site in `dist/` that can be hosted anywhere
(relative asset paths, so sub-folders such as GitHub Pages work).
Deep links work too: `/?user=<username>&tc=blitz`.

## What it does

1. **Fetch** – walks the player's monthly archives newest-first until it has 20
   standard-chess games in the selected time class (bullet / blitz / rapid / daily).
2. **Evaluate** – Stockfish scores every position and keeps its best line. Scores become
   win probabilities, and each move is graded by how much winning chance it gave away
   (inaccuracy ≥ 5, mistake ≥ 10, blunder ≥ 15 percentage points — the Lichess thresholds).
3. **Classify** – every mistake/blunder gets a cause by comparing where the engine's line
   and the game line end up materially:
   piece given away in one move · walked into a tactic · allowed a forced mate ·
   missed a winning tactic · missed a forced mate · positional slip.
   Tactics are named where the geometry is recognisable (fork, pin, skewer, discovered
   attack, back-rank mate, free capture); positional slips are sorted into dropped pawn,
   unfavourable exchange, king-weakening pawn move, neglected development, endgame
   technique, or wrong plan. Each error also gets a one-sentence plain-language explanation.
4. **Attribute** – each lost game is traced to its turning point (or to the clock, or to
   an early resignation), so the report can say what actually decides the player's losses.
5. **Find patterns** – detectors cover hung pieces, allowed and missed tactics, mating
   threats, positional drift, time trouble, unused clock, thrown wins, opening results and
   habits (castling, development, early queen moves), endgames entered from level
   positions, colour gaps, failing openings, results against stronger/weaker opposition,
   early resignations and tilt. Move-based weaknesses are ranked by one common currency:
   winning chances given away, in game points.
6. **Teach** – each weakness comes with evidence, a measurable target, links to puzzle
   sets on exactly that theme, and positions from the player's own games that can be
   stepped through (what happened vs. the better line). A Practice tab turns the worst
   moments into puzzles: any move that keeps the winning chances is accepted, checked live
   by the engine, and missed positions come back. A personal pre-move checklist and a
   training plan are generated from the top weaknesses.
7. **Track** – a summary of each analysis is kept in the browser, so the next run on newer
   games shows whether each weakness is shrinking.

## Project layout

| Path | Purpose |
|---|---|
| `src/lib/chesscom.ts` | chess.com API client |
| `src/lib/parse.ts` | PGN → moves, clocks, phases, opening names |
| `src/lib/engine.ts` | Stockfish worker pool + evaluation cache (localStorage) |
| `src/lib/evaluate.ts` | Win probability, accuracy, error classification and explanations, loss attribution |
| `src/lib/tactics.ts` | Material over a line, motif recognition (fork, pin, skewer, …) |
| `src/lib/insights.ts` | Aggregation, weakness detectors, strengths |
| `src/lib/history.ts` | Saved summaries for progress tracking |
| `src/components/` | Report tabs, charts, lesson board, practice mode, game replay |
| `scripts/make-fixtures.mjs` | Generates synthetic chess.com-format games for tests |
| `tests/fixtures/evals.json` | Recorded engine output for those games, so the whole pipeline is unit-testable |
| `scripts/e2e.mjs` | Browser smoke test against the fixtures (needs Playwright) |

## Tests

```bash
npm test                                             # unit tests
npm run build && NODE_PATH=$(npm root -g) node scripts/e2e.mjs   # full browser run
```

## Notes and limits

- Accuracy uses Lichess's published method, so numbers will differ from chess.com's CAPS.
- Motif recognition and the positional categories are heuristics on top of engine lines:
  they name the common cases and fall back to "longer combination" / "wrong plan" otherwise.
- Twenty games is a small sample. Detectors require repeated evidence before reporting
  anything, but treat results as strong hints rather than verdicts.
- Stockfish is GPLv3. It is copied from the `stockfish` npm package into `public/engine`
  at dev/build time and is not part of this repository; if you distribute a build, the
  GPL applies to the engine files you ship.
- Not affiliated with chess.com.
