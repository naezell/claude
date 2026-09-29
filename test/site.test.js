// The built site served over HTTP with Netlify's headers: nothing is blocked by the
// Content-Security-Policy. Skipped without playwright-core or Chromium, like ui.test.js.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const site = require('./helpers/site-server.js');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'sample-data', 'harbor-pine-transaction-detail.csv');
// The page opens on Home; most tests work on the sample data.
async function showSample(page) {
  await page.locator('button', { hasText: /sample data/i }).first().click();
  await page.waitForSelector('#tab-audit');
}

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
let portalStore = null;
let tickets = null;
let skip = chromium ? false : 'playwright-core is not installed (run npm install)';

before(async () => {
  if (skip) return;
  for (const executablePath of candidates()) {
    try { browser = await chromium.launch(executablePath ? { executablePath } : {}); break; } catch (e) { /* try the next */ }
  }
  if (!browser) { skip = 'no Chromium build found (set CHROMIUM_PATH)'; return; }
  site.build();
  ({ server, url: base, portalStore, tickets } = await site.start());
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });

// Opens a page with violations of the policy recorded in window.__csp. Requests to Google are
// answered by `google` (or refused).
async function open(pathname, google, config) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (config) await page.addInitScript((c) => { window.LedgerConfig = c; }, config);
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
  await showSample(page);
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

const kpi = (page, label) => page.locator('.kpi', { has: page.locator('.kpi-label', { hasText: label }) }).locator('.kpi-value').first().innerText();

test('large exports are read and analyzed in the background worker', async (t) => {
  if (skip) return t.skip(skip);
  // Treat anything over 100 rows as large, so the sample goes through the worker.
  const { page, errors } = await open('/', null, { backgroundRows: 100 });
  await showSample(page);
  assert.equal(await page.evaluate(() => window.LedgerWork.available()), true);
  // Count messages to the worker to prove the work happens there.
  await page.evaluate(() => {
    window.__toWorker = [];
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (m, ...rest) { window.__toWorker.push(m.op); return post.call(this, m, ...rest); };
  });
  await page.setInputFiles('#csv-upload', SAMPLE);
  await page.waitForSelector('button:has-text("Load sample")');
  await page.waitForFunction(() => !document.querySelector('.working'));
  assert.equal(await kpi(page, 'Uncategorized'), '11');
  const ops = await page.evaluate(() => window.__toWorker);
  assert.ok(ops.includes('read') && ops.includes('data') && ops.includes('analyze'), ops.join(','));
  // A review updates the figures through the worker without resending the data.
  const before = ops.filter((o) => o === 'data').length;
  const panel = page.locator('section.panel', { has: page.locator('h2', { hasText: 'Uncategorized transactions' }) });
  await panel.locator('select.review-select').first().selectOption('ok');
  await page.waitForFunction(() => [...document.querySelectorAll('.kpi')].some((k) => k.querySelector('.kpi-label').textContent === 'Uncategorized' && k.querySelector('.kpi-value').innerText === '10'));
  assert.equal((await page.evaluate(() => window.__toWorker)).filter((o) => o === 'data').length, before);
  // Closing the books asks the worker for the snapshot.
  const closed = page.locator('section.panel', { has: page.locator('h2', { hasText: 'Closed months' }) });
  await closed.locator('button', { hasText: 'Close books' }).click();
  await page.waitForFunction(() => window.__toWorker.includes('closeBooks'));
  await closed.locator('text=Closed through').first().waitFor();
  assert.deepEqual(await page.evaluate(() => window.__csp), []);
  assert.deepEqual(errors, []);
  await page.close();
});

test('if the worker cannot start, the page does the work itself', async (t) => {
  if (skip) return t.skip(skip);
  const { page, errors } = await open('/', null, { backgroundRows: 100 });
  // A browser that refuses to start the worker (blocked by policy, out of memory).
  await page.evaluate(() => { window.Worker = function () { throw new Error('workers are blocked'); }; });
  await showSample(page);
  await page.setInputFiles('#csv-upload', SAMPLE);
  await page.waitForSelector('button:has-text("Load sample")');
  await page.waitForFunction(() => !document.querySelector('.working'));
  assert.equal(await kpi(page, 'Uncategorized'), '11');
  assert.equal(await page.evaluate(() => window.LedgerWork.available()), false);
  assert.deepEqual(errors, []);
  await page.close();
});

// A tiny PNG, as a phone photo stand-in.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAGUlEQVR4nGP4z8DAwMDAxMDAwMDAwMAAAB3sA/1kC2LZAAAAAElFTkSuQmCC', 'base64');

test('answer link: Mark sends it, the client answers with a photo, the answers come into Ledger Lens', async (t) => {
  if (skip) return t.skip(skip);
  const { page, errors } = await open('/');
  await showSample(page);
  await page.setInputFiles('#csv-upload', SAMPLE);
  await page.waitForSelector('button:has-text("Load sample")');
  await page.click('button:has-text("Client questions")');
  await page.fill('#p-email', 'owner@harborpine.test');
  await page.click('.portal-block button:has-text("Create answer link")');
  const link = await page.locator('.portal-link').inputValue();
  assert.match(link, new RegExp(`^${base}/portal#[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}$`));
  const mailto = decodeURIComponent(await page.locator('.portal-block a:has-text("Email to client")').getAttribute('href'));
  assert.ok(mailto.startsWith('mailto:owner@harborpine.test?subject=Questions about your books'), mailto.slice(0, 80));
  assert.ok(mailto.includes(link));
  // The site holds only sealed data.
  const stored = [...portalStore.values()].join('');
  assert.ok(stored.length > 0 && !/Amazon|Harbor|What was this for/.test(stored));

  // The client opens the link: no sign-in, questions readable, answers with a photo.
  const client = await open(link.slice(base.length));
  await client.page.waitForSelector('section.q');
  assert.match(await client.page.locator('header h1').innerText(), /Questions from 7D Business Solutions/);
  const first = client.page.locator('section.q').first();
  const firstQuestion = await first.locator('label.text').innerText();
  await first.locator('textarea').fill('Printer paper for the office');
  await first.locator('input[type=file]').setInputFiles({ name: 'receipt.png', mimeType: 'image/png', buffer: PNG });
  await first.locator('.thumb img').waitFor();
  await client.page.click('button:has-text("Send answers")');
  await client.page.locator('.msg.good', { hasText: 'Thank you' }).waitFor();
  assert.ok(!/Printer paper/.test([...portalStore.values()].join('')), 'answers are sealed on the site');
  assert.deepEqual(await client.page.evaluate(() => window.__csp), []);
  assert.deepEqual(client.errors, []);

  // Back in Ledger Lens: the answer comes in and the site copy is deleted.
  await page.click('.portal-block button:has-text("Check for answers")');
  await page.locator('.banner', { hasText: 'answered 1 question through the answer link' }).waitFor();
  assert.equal(portalStore.size, 0);
  await page.click('.drawer-head button');
  const panel = page.locator('section.panel', { has: page.locator('h2', { hasText: 'Client answers' }) });
  await panel.waitFor();
  assert.match(await panel.innerText(), /Printer paper for the office/);
  assert.ok((await panel.innerText()).includes(firstQuestion.slice(0, 30)));
  await panel.locator('.answer-photos img').waitFor();
  // The link no longer opens.
  await client.page.reload();
  await client.page.locator('h1', { hasText: 'can\u2019t be opened' }).waitFor();
  // Kept after a reload, photo included.
  await page.reload();
  await showSample(page);
  await page.setInputFiles('#csv-upload', SAMPLE);
  await page.waitForSelector('button:has-text("Load sample")');
  await panel.locator('.answer-photos img').waitFor();
  assert.deepEqual(await page.evaluate(() => window.__csp), []);
  assert.deepEqual(errors, []);
  await client.page.close();
  await page.close();
});

test('Flag a problem: pick a panel, the picture has amounts and names blanked, and it is filed as a ticket', async (t) => {
  if (skip) return t.skip(skip);
  const { page, errors } = await open('/');
  await showSample(page);
  // The redaction itself: digits and client names go, the app's own labels stay.
  const red = await page.evaluate(() => {
    const div = document.createElement('div');
    div.innerHTML = '<section class="panel"><div class="panel-head"><h2>Top customers</h2><p>Last 12 months, 3 customers</p></div><table><thead><tr><th>Customer</th></tr></thead><tbody><tr><td>Acme Dental</td><td class="num">$12,480.00</td></tr></tbody></table><svg><text>Acme Dental $4k</text></svg></section>';
    window.LedgerUI.redactTree(div, ['Acme Dental']);
    return { text: div.textContent, bars: div.querySelectorAll('.redacted').length };
  });
  assert.ok(!/\d|Acme/.test(red.text), red.text);
  assert.match(red.text, /Top customers/);
  assert.match(red.text, /Customer/);
  assert.equal(red.bars, 2);
  // The real thing, on the cash forecast.
  await page.click('#tab-cash');
  await page.click('button.flag-toggle');
  await page.waitForSelector('.flag-bar');
  await page.locator('main section.panel').first().click();
  await page.waitForSelector('#ticket-what');
  const shot = await page.locator('.ticket-shot img').getAttribute('src');
  assert.match(shot, /^data:image\/jpeg;base64,/);
  assert.ok(shot.length > 5000, 'a real picture');
  await page.fill('#ticket-what', 'The forecast line stops early.');
  await page.click('button:has-text("Send ticket")');
  await page.waitForSelector('text=Ticket #1 is in');
  assert.equal(tickets.length, 1);
  const issue = tickets[0];
  assert.equal(issue.url, 'https://api.github.com/repos/owner/repo/issues');
  assert.deepEqual(issue.labels, ['ticket']);
  assert.match(issue.title, /^Cash forecast › .+: The forecast line stops early\.$/);
  assert.match(issue.body, /> The forecast line stops early\./);
  assert.match(issue.body, /Version: /);
  const img = issue.body.match(/\((http[^)]+\.jpg)\)/)[1];
  const res = await fetch(img);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(await page.evaluate(() => window.__csp), []);
  assert.deepEqual(errors, []);
  await page.close();
});
