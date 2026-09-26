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
const TABS = ['audit', 'close', 'growth', 'cash', 'breakeven', 'trends', 'budget', 'vendors', 'benchmarks', 'advisory'];

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

// `setup(page)` runs before the page loads (init scripts); `serve(route, url)` may answer a
// request itself and return true.
async function openPage(opts, setup, serve) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, ...(opts || {}) });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (setup) await setup(page);
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('file:')) return route.continue();
    if (serve && await serve(route, url)) return;
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

test('branding: firm name and logo in the header and on the report', async (t) => {
  if (skip) return t.skip(skip);
  const { page, errors } = await openPage();
  assert.equal(await page.locator('.brand h1').innerText(), '7D Business Solutions');
  assert.equal(await page.locator('.brand-logo').count(), 1);
  await page.click('button:has-text("Help")');
  assert.match(await page.locator('.drawer').innerText(), /Transaction Detail by Account/);
  await page.click('.drawer-head button');
  await page.click('button:has-text("Client report")');
  await page.fill('#preparer', 'Jordan Lee');
  await page.waitForFunction(() => { const h = document.querySelector('.drawer .report-shadow'); return h && h.shadowRoot && /Jordan Lee/.test(h.shadowRoot.textContent); });
  const info = await page.evaluate(() => {
    const root = document.querySelector('.drawer .report-shadow').shadowRoot;
    return { brand: root.querySelector('.brand').textContent, logo: !!root.querySelector('img.logo[src^="data:image/png"]'), firm: root.querySelector('.firm').textContent };
  });
  assert.equal(info.brand, '7D Business Solutions');
  assert.ok(info.logo, 'logo embedded in the report');
  assert.match(info.firm, /Jordan Lee, 7D Business Solutions · www\.7dbusinesssolutions\.com/);
  assert.deepEqual(errors, []);
  await page.close();
});

// A stand-in for Google sign-in and the Drive API, holding files in memory.
function fakeGoogle() {
  const files = new Map();
  const calls = [];
  let n = 0;
  const gis = `window.google = { accounts: { oauth2: {
    initTokenClient: (cfg) => ({ requestAccessToken: () => setTimeout(() => cfg.callback({ access_token: 'tok', expires_in: 3600 }), 10) }),
    revoke: (t, cb) => cb && cb(),
  } } };`;
  const serve = async (route, url) => {
    const req = route.request();
    if (url.startsWith('https://accounts.google.com/gsi/client')) { await route.fulfill({ body: gis, contentType: 'application/javascript' }); return true; }
    if (!url.startsWith('https://www.googleapis.com/')) return false;
    const auth = req.headers().authorization;
    calls.push(`${req.method()} ${url.replace(/\?.*$/, '')}`);
    if (auth !== 'Bearer tok') { await route.fulfill({ status: 401, body: '{}' }); return true; }
    const json = (obj) => route.fulfill({ body: JSON.stringify(obj), contentType: 'application/json', headers: { 'access-control-allow-origin': '*' } });
    const u = new URL(url);
    if (req.method() === 'GET' && u.pathname === '/drive/v3/files') { await json({ files: [...files.entries()].map(([id, f]) => ({ id, name: f.name, modifiedTime: f.modified })) }); return true; }
    const get = u.pathname.match(/^\/drive\/v3\/files\/(\w+)$/);
    if (req.method() === 'GET' && get) { await route.fulfill({ body: files.get(get[1]).body, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' } }); return true; }
    if (req.method() === 'POST' && u.pathname === '/upload/drive/v3/files') {
      const text = req.postData();
      const parts = text.split(/--ll\w+/).filter((p) => p.includes('{'));
      const meta = JSON.parse(parts[0].slice(parts[0].indexOf('{')));
      const body = parts[1].slice(parts[1].indexOf('{')).trim();
      const id = `f${++n}`;
      files.set(id, { name: meta.name, body, modified: new Date().toISOString(), meta });
      await json({ id, modifiedTime: files.get(id).modified });
      return true;
    }
    const patch = u.pathname.match(/^\/upload\/drive\/v3\/files\/(\w+)$/);
    if (req.method() === 'PATCH' && patch) {
      const f = files.get(patch[1]);
      f.body = req.postData(); f.modified = new Date().toISOString();
      await json({ id: patch[1], modifiedTime: f.modified });
      return true;
    }
    if (req.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } }); return true; }
    return false;
  };
  return { files, calls, serve };
}

test('Google Drive: connect, save, save automatically after a change, and restore', async (t) => {
  if (skip) return t.skip(skip);
  const g = fakeGoogle();
  const { page, errors } = await openPage({}, (p) => p.addInitScript(() => { window.LedgerConfig = { googleClientId: 'test-client.apps.googleusercontent.com', googleOrigins: [] }; }), g.serve);
  await page.click('button:has-text("Clients")');
  await page.click('button:has-text("Connect Google Drive")');
  await page.waitForSelector('button:has-text("Save to Drive now")');
  await page.click('button:has-text("Save to Drive now")');
  await page.waitForFunction(() => /last saved today/.test(document.querySelector('.drawer').innerText));
  assert.equal(g.files.size, 1);
  const [id, file] = [...g.files.entries()][0];
  assert.equal(file.name, 'Ledger Lens backup.json');
  assert.deepEqual(file.meta.appProperties, { ledgerLens: 'clients-backup' });
  assert.equal(JSON.parse(file.body).format, 'ledger-lens-clients');

  // A review mark on an uploaded client is saved to Drive a few seconds later.
  await page.click('.drawer-head button');
  await page.setInputFiles('#csv-upload', SAMPLE);
  await page.waitForSelector('button:has-text("Load sample")');
  const panel = page.locator('section.panel', { has: page.locator('h2', { hasText: 'Uncategorized transactions' }) });
  await panel.locator('select.review-select').first().selectOption('ok');
  const deadline = Date.now() + 15000;
  while (!Object.keys(JSON.parse(g.files.get(id).body).clients).length && Date.now() < deadline) await page.waitForTimeout(250);
  const saved = JSON.parse(g.files.get(id).body).clients;
  assert.equal(Object.keys(saved).length, 1, 'the uploaded client was saved automatically');
  assert.ok(g.calls.some((c) => c.startsWith('PATCH')), 'the existing file is updated, not duplicated');
  assert.equal(g.files.size, 1);

  // Restoring brings in a client that only exists in the Drive copy.
  const data = JSON.parse(g.files.get(id).body);
  data.clients['other co'] = { name: 'Other Co', accountClass: {}, reviewed: { a: { status: 'ok' } }, updatedAt: '2030-01-01T00:00:00.000Z' };
  g.files.get(id).body = JSON.stringify(data);
  await page.click('button:has-text("Clients")');
  await page.click('button:has-text("Restore from Drive")');
  await page.waitForSelector('.dash-row:has-text("Other Co")');
  assert.deepEqual(errors, []);
  await page.close();
});

test('Google Drive is only offered on the registered address; elsewhere the app points there', async (t) => {
  if (skip) return t.skip(skip);
  const { page, errors } = await openPage();
  await page.click('button:has-text("Clients")');
  const text = await page.locator('.drawer').innerText();
  assert.match(text, /7d-ledger-lens\.netlify\.app/);
  assert.equal(await page.locator('button:has-text("Connect Google Drive")').count(), 0);
  assert.deepEqual(errors, []);
  await page.close();
});

test('closed months: close the books, load an edited export, see the change, accept it', async (t) => {
  if (skip) return t.skip(skip);
  const { page, errors } = await openPage();
  await page.setInputFiles('#csv-upload', SAMPLE);
  await page.waitForSelector('button:has-text("Load sample")');
  const panel = page.locator('section.panel', { has: page.locator('h2', { hasText: 'Closed months' }) });
  await panel.locator('select').selectOption('2026-05');
  await panel.locator('button', { hasText: 'Close books' }).click();
  await panel.locator('.pill', { hasText: 'Closed through May 2026' }).waitFor();
  // The same client's next export has a March amount changed.
  const edited = fs.readFileSync(SAMPLE, 'utf8').split('\n').map((l) => (l.includes('03/20/2026') && l.includes('Studio supplies') ? l.replace(',100.19,', ',150.19,') : l)).join('\n');
  await page.setInputFiles('#csv-upload', { name: 'harbor-pine-july.csv', mimeType: 'text/csv', buffer: Buffer.from(edited) });
  await panel.locator('.pill', { hasText: 'since closing' }).waitFor();
  const text = await panel.innerText();
  assert.match(text, /March 2026/);
  assert.match(text, /Office Supplies \+\$50\.00/);
  assert.match(text, /The Home Depot/);
  await panel.locator('button', { hasText: 'Accept changes' }).click();
  await panel.locator('.pill', { hasText: 'Closed through May 2026' }).waitFor();
  // The close is saved with the client, so it survives a reload.
  await page.reload();
  await page.setInputFiles('#csv-upload', { name: 'harbor-pine-july.csv', mimeType: 'text/csv', buffer: Buffer.from(edited) });
  await panel.locator('.pill', { hasText: 'Closed through May 2026' }).waitFor();
  assert.deepEqual(errors, []);
  await page.close();
});

test('balance sheet check and job costing gaps show the seeded problems', async (t) => {
  if (skip) return t.skip(skip);
  const { page, errors } = await openPage();
  const bs = page.locator('section.panel', { has: page.locator('h2', { hasText: 'Balance sheet check' }) });
  await bs.waitFor();
  const bsText = await bs.innerText();
  for (const s of ['Undeposited Funds', 'Opening Balance Equity', 'Customer credit', 'Old open bill']) assert.ok(bsText.includes(s), s);
  await bs.locator('button', { hasText: 'Show balances' }).click();
  assert.match(await bs.innerText(), /SBA Loan/);
  await page.click('#tab-growth');
  const jc = page.locator('section.panel', { has: page.locator('h2', { hasText: 'Job costing gaps' }) });
  await jc.waitFor();
  const jcText = await jc.innerText();
  assert.match(jcText, /Harborview Hotel/);
  assert.match(jcText, /Pinecrest Winery/);
  assert.deepEqual(errors, []);
  await page.close();
});

test('month-end close checklist and the all-clients dashboard', async (t) => {
  if (skip) return t.skip(skip);
  const { page, errors } = await openPage();
  await page.setInputFiles('#csv-upload', SAMPLE);
  await page.waitForSelector('button:has-text("Load sample")');
  await page.click('#tab-close');
  const panel = page.locator('section.panel', { has: page.locator('h2', { hasText: 'Month-end close' }) });
  await panel.waitFor();
  assert.match(await panel.innerText(), /11 still open/, 'automatic steps read the analysis');
  await page.click('#step-feeds');
  await page.fill('#new-step', 'Reconcile the PayPal account');
  await page.click('button:has-text("Add step")');
  await page.fill('#close-notes', 'Waiting on May statement');
  await panel.locator('.pill', { hasText: '1 of 15 done' }).waitFor();
  // Everything is saved with the client and comes back after a reload.
  await page.waitForTimeout(400);
  await page.reload();
  await page.setInputFiles('#csv-upload', SAMPLE);
  await page.click('#tab-close');
  await panel.locator('.pill', { hasText: '1 of 15 done' }).waitFor();
  assert.equal(await page.locator('#step-feeds').isChecked(), true);
  assert.match(await panel.innerText(), /Reconcile the PayPal account/);
  assert.equal(await page.inputValue('#close-notes'), 'Waiting on May statement');
  // The dashboard lists the client with its open items and close progress.
  await page.click('button:has-text("Clients")');
  const row = page.locator('.dash-row', { hasText: 'Harbor & Pine Design Co.' });
  await row.waitFor();
  const text = await row.innerText();
  assert.match(text, /Needs attention/);
  assert.match(text, /11 uncategorized/);
  assert.match(text, /4 balance sheet/);
  assert.match(text, /Jun 2026: 1\/15/);
  assert.deepEqual(errors, []);
  await page.close();
});
