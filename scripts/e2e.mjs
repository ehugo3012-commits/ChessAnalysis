// End-to-end smoke test: serves the production build, mocks the chess.com API with
// the fixture games and runs a full analysis with the real Stockfish worker.
//
//   npm run build && NODE_PATH=$(npm root -g) node scripts/e2e.mjs [screenshot-dir]
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import { createRequire } from 'node:module';

// Playwright is not a project dependency: use a global install (NODE_PATH) or `npm i -D playwright`.
const { chromium } = createRequire(import.meta.url)('playwright');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = JSON.parse(readFileSync(join(root, 'tests', 'fixtures', 'chesscom.json'), 'utf8'));
const shots = process.argv[2];
if (shots) mkdirSync(shots, { recursive: true });
const shot = (page, name, opts = {}) => (shots ? page.screenshot({ path: join(shots, name), ...opts }) : null);
const assert = (cond, msg) => {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
  console.log(`ok - ${msg}`);
};

const server = await preview({ root, preview: { port: 4179, strictPort: true }, logLevel: 'silent' });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // The 404 for the unknown player is expected.
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('404') && errors.push(m.text()));
  await page.route('https://api.chess.com/**', (route) => {
    const body = fixture[route.request().url()];
    return body
      ? route.fulfill({ json: body, headers: { 'access-control-allow-origin': '*' } })
      : route.fulfill({ status: 404, json: { code: 0, message: 'not found' }, headers: { 'access-control-allow-origin': '*' } });
  });

  await page.goto('http://localhost:4179/');
  await shot(page, '1-landing.png');

  // Unknown player -> friendly error.
  await page.getByLabel('chess.com username').fill('nobody-here');
  await page.getByRole('button', { name: 'Analyse my games' }).click();
  await page.getByRole('alert').waitFor();
  assert((await page.getByRole('alert').innerText()).includes('No chess.com player'), 'unknown player shows an error');

  // Wrong time control -> friendly error.
  await page.getByLabel('chess.com username').fill('FixturePlayer');
  await page.getByText('Bullet', { exact: true }).click();
  await page.getByRole('button', { name: 'Analyse my games' }).click();
  await page.getByRole('alert').waitFor();
  assert((await page.getByRole('alert').innerText()).includes('no bullet games'), 'empty time control shows an error');

  // Full run.
  await page.getByText('Rapid', { exact: true }).click();
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Analyse my games' }).click();
  await page.getByText('Stockfish is analysing').waitFor();
  await page.waitForTimeout(1500);
  await shot(page, '2-analysing.png');
  await page.getByRole('heading', { name: 'Your key weaknesses' }).waitFor({ timeout: 600000 });
  console.log(`analysis took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const insightCount = await page.locator('.insight').count();
  assert(insightCount >= 1, `${insightCount} weaknesses reported`);
  assert((await page.locator('.moment-board').count()) >= 1, 'example positions rendered');
  assert((await page.locator('.moment-why').first().innerText()).length > 20, 'each example explains what went wrong');
  await page.waitForTimeout(500);
  await shot(page, '3-report.png', { fullPage: true });
  console.log(await page.locator('main').innerText());

  // Step through a line on a lesson board.
  const lesson = page.locator('.moment').first();
  await lesson.getByRole('tab', { name: /^Better/ }).click();
  assert((await lesson.locator('button.san.current').count()) === 1, 'lesson board steps through the better line');

  // Practice: a wrong move is rejected by the engine, the best move is accepted.
  await page.getByRole('tab', { name: /^Practice/ }).click();
  const puzzle = await page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.includes(':eval:'));
    return k ? JSON.parse(localStorage.getItem(k)).best.length : 0;
  });
  assert(puzzle > 0, 'engine lines are cached with evaluations');
  await page.locator('.practice-board').waitFor();
  await shot(page, '4-practice.png');
  await page.getByRole('button', { name: 'Show answer' }).click();
  await page.locator('.practice-msg.revealed').waitFor();
  const answer = (await page.locator('.practice-msg').innerText()).match(/was (\S+?)\.?$/)?.[1];
  assert(!!answer, `answer is revealed (${answer})`);
  assert((await page.locator('.pdot').count()) === 13, 'a missed position is queued again at the end');
  await page.getByRole('button', { name: 'Next position' }).click();
  // Play the engine move by clicking squares.
  const squares = await page.locator('.practice-main').getAttribute('data-best');
  if (squares) {
    await page.locator(`.practice-board [data-square="${squares.slice(0, 2)}"]`).click();
    await page.locator(`.practice-board [data-square="${squares.slice(2, 4)}"]`).click();
    await page.locator('.practice-msg.correct').waitFor({ timeout: 20000 });
    assert(true, 'best move is accepted as solved');
  }
  await page.getByRole('button', { name: 'Next position' }).click();
  assert(page.url().endsWith('#practice'), 'open tab is kept in the address');
  // Repeat the move from the game: the engine must reject it.
  const bad = await page.locator('.practice-main').getAttribute('data-played');
  if (bad) {
    await page.locator(`.practice-board [data-square="${bad.slice(0, 2)}"]`).click();
    await page.locator(`.practice-board [data-square="${bad.slice(2, 4)}"]`).click();
    await page.locator('.practice-msg.wrong, .practice-msg.correct').waitFor({ timeout: 30000 });
    assert((await page.locator('.practice-msg.wrong').count()) === 1, 'the move played in the game is rejected by the engine');
    await shot(page, '5-practice-wrong.png');
  }

  // Statistics.
  await page.getByRole('tab', { name: 'Statistics' }).click();
  await page.getByRole('heading', { name: 'Tactics you fall for' }).waitFor();
  await shot(page, '6-stats.png', { fullPage: true });

  // Games: replay one.
  await page.getByRole('tab', { name: /^Games/ }).click();
  assert((await page.locator('tr.game-row').count()) === 20, '20 games listed (variants and other time classes filtered)');
  await page.locator('tr.game-row').nth(0).click();
  await page.locator('.evalgraph svg').waitFor();
  const before = await page.locator('.viewer-move').innerText();
  await page.locator('.viewer').focus();
  await page.keyboard.press('ArrowRight');
  assert((await page.locator('.viewer-move').innerText()) !== before, 'arrow keys step through the game');
  await page.locator('.moment-btn').first().click();
  await page.locator('.callout').waitFor();
  await page.locator('.evalgraph svg').hover({ position: { x: 300, y: 60 } });
  await page.locator('.tooltip').waitFor();
  await page.locator('.game-detail').scrollIntoViewIfNeeded();
  await shot(page, '7-game.png');

  // Cached second run should be near-instant.
  await page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.includes(':history:'));
    const [snap] = JSON.parse(localStorage.getItem(k));
    const older = { ...snap, latestGame: snap.latestGame - 86400 * 30, savedAt: snap.savedAt - 86400e3 * 30, accuracy: snap.accuracy - 4, seriousPerGame: snap.seriousPerGame + 0.6 };
    older.metrics = { ...older.metrics, tilt: { title: 'Losses snowball within a session', value: 30, unit: '%' } };
    for (const m of Object.values(older.metrics)) m.value = m.value * 1.3;
    localStorage.setItem(k, JSON.stringify([older, snap]));
  });
  const t1 = Date.now();
  await page.reload();
  await page.getByRole('heading', { name: 'Games', exact: true }).waitFor({ timeout: 20000 });
  assert(await page.getByRole('tab', { name: /^Games/ }).getAttribute('aria-selected') === 'true', 'reload reopens the same tab');
  assert(Date.now() - t1 < 15000, 'deep link + cached evaluations reload quickly');
  await page.getByRole('tab', { name: 'Weaknesses' }).click();
  await page.getByRole('heading', { name: /^Progress since/ }).waitFor();
  assert((await page.locator('.checklist li').count()) >= 2, 'personal pre-move checklist is shown');
  assert((await page.locator('.delta.better').count()) >= 2, 'progress against the previous analysis is shown');
  await shot(page, '8-progress.png');

  // Mobile + dark.
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  await mobile.route('https://api.chess.com/**', (route) =>
    route.fulfill({ json: fixture[route.request().url()] ?? {}, headers: { 'access-control-allow-origin': '*' } }),
  );
  await mobile.goto('http://localhost:4179/?user=fixtureplayer&tc=rapid');
  await mobile.getByRole('heading', { name: 'Your key weaknesses' }).waitFor({ timeout: 600000 });
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert(overflow <= 0, 'no horizontal overflow on a phone');
  await shot(mobile, '9-mobile-dark.png', { fullPage: true });
  await mobile.getByRole('tab', { name: /^Practice/ }).click();
  await mobile.locator('.practice-board').waitFor();
  await mobile.locator('.practice-board').scrollIntoViewIfNeeded();
  await shot(mobile, '10-mobile-practice.png');
  await mobile.getByRole('tab', { name: /^Games/ }).click();
  await mobile.locator('tr.game-row').first().click();
  await mobile.locator('.viewer-controls').scrollIntoViewIfNeeded();
  assert((await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, 'game replay fits a phone');
  await shot(mobile, '11-mobile-game.png');

  assert(errors.length === 0, `no console errors ${errors.join(' | ')}`);
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
