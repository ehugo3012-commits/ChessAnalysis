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
2. **Evaluate** – Stockfish scores every position. Scores become win probabilities, and
   each move is graded by how much winning chance it gave away (inaccuracy ≥ 5,
   mistake ≥ 10, blunder ≥ 15 percentage points — the Lichess thresholds).
3. **Classify** – each mistake/blunder gets a cause: gave away material in one move,
   allowed a forced mate, missed a winning chance, or a deeper error; plus context from
   the move clocks (time trouble, played instantly).
4. **Find patterns** – detectors look for hung pieces, missed threats and chances, time
   trouble, unused clock, thrown wins, opening problems, weak phases, colour gaps,
   failing openings and tilt. Each has a minimum-evidence bar and a severity; the top
   three become "key weaknesses" with examples and training advice.

## Project layout

| Path | Purpose |
|---|---|
| `src/lib/chesscom.ts` | chess.com API client |
| `src/lib/parse.ts` | PGN → moves, clocks, phases, opening names |
| `src/lib/engine.ts` | Stockfish worker pool + evaluation cache (localStorage) |
| `src/lib/evaluate.ts` | Win probability, accuracy, error classification |
| `src/lib/insights.ts` | Aggregation, weakness detectors, strengths |
| `src/components/` | Report, charts, boards |
| `scripts/make-fixtures.mjs` | Generates synthetic chess.com-format games for tests |
| `scripts/e2e.mjs` | Browser smoke test against the fixtures (needs Playwright) |

## Tests

```bash
npm test                                             # unit tests
npm run build && NODE_PATH=$(npm root -g) node scripts/e2e.mjs   # full browser run
```

## Notes and limits

- Accuracy uses Lichess's published method, so numbers will differ from chess.com's CAPS.
- Twenty games is a small sample. Detectors require repeated evidence before reporting
  anything, but treat results as strong hints rather than verdicts.
- Stockfish is GPLv3. It is copied from the `stockfish` npm package into `public/engine`
  at dev/build time and is not part of this repository; if you distribute a build, the
  GPL applies to the engine files you ship.
- Not affiliated with chess.com.
