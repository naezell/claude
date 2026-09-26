// The built site served over HTTP with Netlify's headers: nothing is blocked by the
// Content-Security-Policy. Skipped without playwright-core or Chromium, like ui.test.js.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const site = require('./helpers/site-server.js');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'sample-data', 'harbor-pine-transaction-detail.csv');
let chromium = null;
try { ({ chromium } = require('playwright-core')); } catch (e) { /* not installed */ }

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
let server = null;
let base = '';
let skip = chromium ? false : 'playwright-core is not installed (run npm install)';

before(async () => {
  if (skip) return;
  for (const executablePath of candidates()) {
    try { browser = await chromium.launch(executablePath ? { executablePath } : {}); break; } catch (e) { /* try the next */ }
  }
  if (!browser) { skip = 'no Chromium build found (set CHROMIUM_PATH)'; return; }
  site.build();
  ({ server, url: base } = await site.start());
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });

// Opens a page with violations of the policy recorded in window.__csp. Requests to Google are
// answered by `google` (or refused).
async function open(pathname, google) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith(base)) return route.continue();
    if (google && await google(route, url)) return;
    return route.abort();
  });
  await page.goto(base + pathname);
  return { page, errors };
}

test('netlify.toml sets a Content-Security-Policy that only allows this site and Google', () => {
  const csp = site.siteHeaders()['Content-Security-Policy'];
  assert.ok(csp, 'Content-Security-Policy header');
  assert.match(csp, /script-src 'self' https:\/\/accounts\.google\.com\/gsi\/client;/);
  assert.ok(!/unsafe-eval/.test(csp));
  assert.match(csp, /frame-ancestors 'none'/);
});

test('the app works under the policy: every tab, a report preview, an Excel upload', async (t) => {
  if (skip) return t.skip(skip);
  const { page, errors } = await open('/');
  await page.waitForSelector('#tab-audit');
  for (const tab of ['audit', 'close', 'growth', 'cash', 'breakeven', 'trends', 'budget', 'vendors', 'benchmarks', 'advisory']) {
    await page.click(`#tab-${tab}`);
    await page.waitForSelector(`main[aria-labelledby="tab-${tab}"] section`);
  }
  await page.click('button:has-text("Client report")');
  await page.waitForSelector('.report-shadow');
  await page.click('.drawer-head button');
  const XLSX = require('xlsx');
  const buffer = XLSX.write(XLSX.read(fs.readFileSync(SAMPLE, 'utf8'), { type: 'string' }), { type: 'buffer', bookType: 'xlsx' });
  await page.setInputFiles('#csv-upload', { name: 'harbor-pine.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer });
  await page.waitForSelector('button:has-text("Load sample")');
  assert.equal(await page.evaluate(() => document.fonts.check('500 14px "IBM Plex Sans"')), true);
  assert.deepEqual(await page.evaluate(() => window.__csp), []);
  assert.deepEqual(errors, []);
  await page.close();
});

test('the sign-in page works under the policy', async (t) => {
  if (skip) return t.skip(skip);
  const gis = 'window.google = { accounts: { id: { initialize() {}, disableAutoSelect() {}, renderButton(el) { const b = document.createElement("button"); b.textContent = "Sign in with Google"; el.appendChild(b); } } } };';
  const { page, errors } = await open('/login', async (route, url) => {
    if (url.startsWith('https://accounts.google.com/gsi/client')) { await route.fulfill({ body: gis, contentType: 'application/javascript' }); return true; }
    return false;
  });
  await page.waitForSelector('#button button:has-text("Sign in with Google")');
  assert.equal(await page.locator('img.logo').evaluate((img) => img.naturalWidth > 0), true);
  assert.deepEqual(await page.evaluate(() => window.__csp), []);
  assert.deepEqual(errors, []);
  await page.close();
});
