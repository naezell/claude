// Interface tests: load the page in headless Chromium and use it the way a bookkeeper would.
// The CDN scripts are served from node_modules, so no network is needed. Skipped when
// playwright-core or a Chromium build is not available (run `npm install` first).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PAGE = `file://${path.join(ROOT, 'index.html')}`;
const SAMPLE = path.join(ROOT, 'sample-data', 'harbor-pine-transaction-detail.csv');
const NM = path.join(ROOT, 'node_modules');
const CDN = {
  'react.production.min.js': 'react/umd/react.production.min.js',
  'react-dom.production.min.js': 'react-dom/umd/react-dom.production.min.js',
  'prop-types.min.js': 'prop-types/prop-types.min.js',
  'Recharts.js': 'recharts/umd/Recharts.js',
  'htm.umd.js': 'htm/dist/htm.umd.js',
};
const TABS = ['audit', 'growth', 'cash', 'breakeven', 'trends', 'budget', 'vendors', 'benchmarks', 'advisory'];

let chromium = null;
try { ({ chromium } = require('playwright-core')); } catch (e) { /* not installed */ }

// Playwright's own browser first, then any Chromium under PLAYWRIGHT_BROWSERS_PATH or CHROMIUM_PATH.
function candidates() {
  const out = [undefined];
  if (process.env.CHROMIUM_PATH) out.unshift(process.env.CHROMIUM_PATH);
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (base && fs.existsSync(base)) {
    for (const d of fs.readdirSync(base).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
      const exe = path.join(base, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(exe)) out.push(exe);
    }
  }
  return out;
}

let browser = null;
let skip = chromium ? false : 'playwright-core is not installed (run npm install)';
const missingLibs = Object.values(CDN).filter((f) => !fs.existsSync(path.join(NM, f)));
if (!skip && missingLibs.length) skip = `missing ${missingLibs.join(', ')} (run npm install)`;

before(async () => {
  if (skip) return;
  for (const executablePath of candidates()) {
    try { browser = await chromium.launch(executablePath ? { executablePath } : {}); return; } catch (e) { /* try the next */ }
  }
  skip = 'no Chromium build found (set CHROMIUM_PATH)';
});
after(async () => { if (browser) await browser.close(); });

async function openPage(opts) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, ...(opts || {}) });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith('file:')) return route.continue();
    const hit = Object.keys(CDN).find((k) => url.endsWith(k));
    return hit ? route.fulfill({ path: path.join(NM, CDN[hit]), contentType: 'application/javascript' }) : route.abort();
  });
  await page.goto(PAGE);
  await page.waitForSelector('#tab-audit');
  return { page, errors };
}

const kpi = (page, label) => page.locator('.kpi', { has: page.locator('.kpi-label', { hasText: label }) }).locator('.kpi-value').first().innerText();
// Waits for a KPI tile to show something other than `from`. Labels are matched on textContent
// because the tiles upper-case them with CSS.
const kpiChange = (page, label, from) => page.waitForFunction(([l, f]) => {
  const k = [...document.querySelectorAll('.kpi')].find((x) => x.querySelector('.kpi-label').textContent === l);
  return k && k.querySelector('.kpi-value').innerText !== f;
}, [label, from]);

test('every tab renders without errors or sideways scrolling, light and dark, desktop and phone', async (t) => {
  if (skip) return t.skip(skip);
  for (const [colorScheme, width] of [['light', 1280], ['dark', 400]]) {
    const { page, errors } = await openPage({ colorScheme, viewport: { width, height: 900 } });
    for (const tab of TABS) {
      await page.click(`#tab-${tab}`);
      await page.waitForSelector(`main[aria-labelledby="tab-${tab}"] section`);
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      assert.equal(sideways, false, `${tab} scrolls sideways at ${width}px`);
    }
    assert.deepEqual(errors, [], `${colorScheme} ${width}px`);
    await page.close();
  }
});

test('uploading an export shows its counts, and marking a flag clears it', async (t) => {
  if (skip) return t.skip(skip);
  const { page, errors } = await openPage();
  await page.setInputFiles('#csv-upload', SAMPLE);
  await page.waitForSelector('button:has-text("Load sample")');
  assert.equal(await kpi(page, 'Uncategorized'), '11');
  assert.equal(await kpi(page, 'Potential duplicates'), '3');
  const panel = page.locator('section.panel', { has: page.locator('h2', { hasText: 'Uncategorized transactions' }) });
  await panel.locator('select.review-select').first().selectOption('ok');
  await kpiChange(page, 'Uncategorized', '11');
  assert.equal(await kpi(page, 'Uncategorized'), '10');
  assert.deepEqual(errors, []);
  await page.close();
});

test('unusual activity and vendor price increases show the seeded cases', async (t) => {
  if (skip) return t.skip(skip);
  const { page, errors } = await openPage();
  const unusual = page.locator('section.panel', { has: page.locator('h2', { hasText: 'Unusual activity' }) });
  await unusual.waitFor();
  const text = await unusual.innerText();
  assert.match(text, /Comcast Business/);
  assert.match(text, /Out of pattern/);
  assert.match(text, /Advertising & Marketing/);
  await page.click('#tab-vendors');
  const prices = page.locator('section.panel', { has: page.locator('h2', { hasText: 'Vendor price increases' }) });
  await prices.waitFor();
  assert.equal(await prices.locator('tbody tr').count(), 4);
  assert.match(await prices.innerText(), /\$2,841 a year/);
  assert.deepEqual(errors, []);
  await page.close();
});

test('a what-if scenario changes the forecast and keeps the baseline', async (t) => {
  if (skip) return t.skip(skip);
  const { page, errors } = await openPage();
  await page.click('#tab-cash');
  await page.waitForSelector('#add-lever');
  const before = await kpi(page, 'Cash at week 13');
  await page.selectOption('#add-lever', 'lose');
  await kpiChange(page, 'Cash at week 13', before);
  const banner = await page.locator('.banner', { hasText: 'With these changes' }).innerText();
  assert.ok(banner.includes(`was ${before}`), 'the baseline is shown next to the new figure');
  await page.click('button:has-text("Clear all")');
  await page.waitForFunction((b) => {
    const k = [...document.querySelectorAll('.kpi')].find((x) => x.querySelector('.kpi-label').textContent === 'Cash at week 13');
    return k && k.querySelector('.kpi-value').innerText === b;
  }, before);
  assert.deepEqual(errors, []);
  await page.close();
});

test('client report and client questions drawers build their documents', async (t) => {
  if (skip) return t.skip(skip);
  const { page, errors } = await openPage();
  await page.click('button:has-text("Client report")');
  await page.waitForSelector('.drawer');
  const shadowText = () => page.evaluate(() => {
    const host = document.querySelector('.drawer .report-shadow');
    return host && host.shadowRoot ? host.shadowRoot.textContent : '';
  });
  await page.waitForFunction(() => { const h = document.querySelector('.drawer .report-shadow'); return h && h.shadowRoot && h.shadowRoot.textContent.length > 100; });
  const owner = await shadowText();
  for (const s of ['How the business is doing', 'What we recommend']) assert.ok(owner.includes(s), s);
  assert.ok(owner.includes('What we need from you'));
  await page.click('.drawer-head button');
  await page.click('button:has-text("Client questions")');
  await page.waitForSelector('.drawer');
  const q = await page.locator('.drawer').innerText();
  assert.match(q, /Unusual payments/i);
  assert.match(q, /Comcast Business/);
  assert.deepEqual(errors, []);
  await page.close();
});
