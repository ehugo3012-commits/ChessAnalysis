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
  assert((await page.locator('tr.game-row').count()) === 20, '20 games listed (variants and other time classes filtered)');
  const insightCount = await page.locator('.insight').count();
  assert(insightCount >= 1, `${insightCount} weaknesses reported`);
  assert((await page.locator('.moment-board').count()) >= 1, 'example positions rendered');
  await page.waitForTimeout(500);
  await shot(page, '3-report.png', { fullPage: true });
  console.log(await page.locator('main').innerText());

  // Expand a game.
  await page.locator('tr.game-row').nth(1).click();
  await page.locator('.evalgraph svg').waitFor();
  await page.locator('.evalgraph svg').hover({ position: { x: 300, y: 60 } });
  await page.locator('.tooltip').waitFor();
  await page.locator('.game-detail').scrollIntoViewIfNeeded();
  await shot(page, '4-game.png');

  // Cached second run should be near-instant.
  const t1 = Date.now();
  await page.reload();
  await page.getByRole('heading', { name: 'Your key weaknesses' }).waitFor({ timeout: 20000 });
  assert(Date.now() - t1 < 15000, 'deep link + cached evaluations reload quickly');

  // Mobile + dark.
  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
  await mobile.route('https://api.chess.com/**', (route) =>
    route.fulfill({ json: fixture[route.request().url()] ?? {}, headers: { 'access-control-allow-origin': '*' } }),
  );
  await mobile.goto('http://localhost:4179/?user=fixtureplayer&tc=rapid');
  await mobile.getByRole('heading', { name: 'Your key weaknesses' }).waitFor({ timeout: 600000 });
  const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert(overflow <= 0, 'no horizontal overflow on a phone');
  await shot(mobile, '5-mobile-dark.png', { fullPage: true });

  assert(errors.length === 0, `no console errors ${errors.join(' | ')}`);
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
