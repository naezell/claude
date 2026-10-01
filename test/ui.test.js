// Interface tests: load the page in headless Chromium and use it the way a bookkeeper would.
// The libraries load from vendor/ like on the live site, and every outside request is refused, so
// the page must work without other servers. Skipped when playwright-core or a Chromium build is
// not available (run `npm install` first).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PAGE = `file://${path.join(ROOT, 'index.html')}`;
const SAMPLE = path.join(ROOT, 'sample-data', 'harbor-pine-transaction-detail.csv');
const TABS = ['audit', 'close', 'growth', 'cash', 'breakeven', 'trends', 'budget', 'vendors', 'benchmarks', 'advisory', 'assets'];

// The page opens on Home; most tests work on the sample data.
async function showSample(page) {
  await page.locator('button', { hasText: /sample data/i }).first().click();
  await page.waitForSelector('#tab-audit');
}

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
  const outside = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (setup) await setup(page);
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    if (url.startsWith('file:')) return route.continue();
    if (serve && await serve(route, url)) return;
    outside.push(url);
    return route.abort();
  });
  await page.goto(PAGE);
  await showSample(page);
  return { page, errors, outside };
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
    const { page, errors, outside } = await openPage({ colorScheme, viewport: { width, height: 900 } });
    // Libraries and fonts come from the site itself, not outside servers.
    assert.deepEqual(outside, [], 'requests to outside servers');
    await page.evaluate(() => document.fonts.ready);
    assert.ok(await page.evaluate(() => document.fonts.check('500 14px "IBM Plex Sans"')), 'IBM Plex Sans loaded');
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

// A stand-in for Google sign-in and the Drive API, holding files in memory. Pages opened
// with the same stand-in share one Drive, like Mark's laptop and phone.
function fakeGoogle() {
  const files = new Map();
  const calls = [];
  let n = 0;
  const gis = `window.google = { accounts: { oauth2: {
    initTokenClient: (cfg) => ({ requestAccessToken: () => setTimeout(() => cfg.callback({ access_token: 'tok', expires_in: 3600 }), 10) }),
    revoke: (t, cb) => cb && cb(),
  } } };`;
  const cors = { 'access-control-allow-origin': '*' };
  // A multipart upload: the metadata part, then the content part (both JSON text here).
  const parseMultipart = (text) => {
    const parts = text.split(/--ll\w+/).filter((p) => p.includes('{'));
    const meta = JSON.parse(parts[0].slice(parts[0].indexOf('{')));
    const body = parts[1].slice(parts[1].indexOf('{')).trim();
    return { meta, body };
  };
  const serve = async (route, url) => {
    const req = route.request();
    if (url.startsWith('https://accounts.google.com/gsi/client')) { await route.fulfill({ body: gis, contentType: 'application/javascript' }); return true; }
    if (!url.startsWith('https://www.googleapis.com/')) return false;
    if (req.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers: { ...cors, 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } }); return true; }
    const auth = req.headers().authorization;
    calls.push(`${req.method()} ${url.replace(/\?.*$/, '')}`);
    if (auth !== 'Bearer tok') { await route.fulfill({ status: 401, body: '{}' }); return true; }
    const json = (obj) => route.fulfill({ body: JSON.stringify(obj), contentType: 'application/json', headers: cors });
    const u = new URL(url);
    if (req.method() === 'GET' && u.pathname === '/drive/v3/files') {
      const want = (/value='([^']+)'/.exec(u.searchParams.get('q') || '') || [])[1];
      const hits = [...files.entries()].filter(([, f]) => !want || (f.meta.appProperties || {}).ledgerLens === want);
      await json({ files: hits.map(([id, f]) => ({ id, name: f.name, modifiedTime: f.modified, appProperties: f.meta.appProperties })) });
      return true;
    }
    const one = u.pathname.match(/^\/drive\/v3\/files\/(\w+)$/);
    if (req.method() === 'GET' && one) { await route.fulfill({ body: files.get(one[1]).body, contentType: 'application/json', headers: cors }); return true; }
    if (req.method() === 'DELETE' && one) { files.delete(one[1]); await route.fulfill({ status: 204, headers: cors }); return true; }
    if (req.method() === 'POST' && u.pathname === '/upload/drive/v3/files') {
      const { meta, body } = parseMultipart(req.postData());
      const id = `f${++n}`;
      files.set(id, { name: meta.name, body, modified: new Date().toISOString(), meta });
      await json({ id, modifiedTime: files.get(id).modified });
      return true;
    }
    const patch = u.pathname.match(/^\/upload\/drive\/v3\/files\/(\w+)$/);
    if (req.method() === 'PATCH' && patch) {
      const f = files.get(patch[1]);
      if (u.searchParams.get('uploadType') === 'multipart') {
        const { meta, body } = parseMultipart(req.postData());
        f.body = body; f.meta = { ...f.meta, ...meta };
      } else f.body = req.postData();
      f.modified = new Date().toISOString();
      await json({ id: patch[1], modifiedTime: f.modified });
      return true;
    }
    return false;
  };
  const backup = () => [...files.values()].find((f) => f.name === 'Ledger Lens backup.json');
  const clientFiles = () => [...files.values()].filter((f) => (f.meta.appProperties || {}).ledgerLens === 'client-files');
  return { files, calls, serve, backup, clientFiles };
}

const until = async (page, check, what, ms = 20000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await page.waitForTimeout(250);
  }
};

test('Google Drive sync: laptop and phone share clients, their files, changes and removals', async (t) => {
  if (skip) return t.skip(skip);
  const g = fakeGoogle();
  const setup = (p) => p.addInitScript(() => { window.LedgerConfig = { googleClientId: 'test-client.apps.googleusercontent.com', googleOrigins: [] }; });
  // The laptop connects, then works on a client: it syncs on its own a few seconds later.
  const laptop = await openPage({}, setup, g.serve);
  await laptop.page.click('button:has-text("Clients")');
  await laptop.page.click('button:has-text("Connect Google Drive")');
  await laptop.page.waitForSelector('button:has-text("Sync now"):enabled');
  await until(laptop.page, () => g.backup(), 'the backup file');
  assert.deepEqual(g.backup().meta.appProperties, { ledgerLens: 'clients-backup' });
  assert.equal(JSON.parse(g.backup().body).format, 'ledger-lens-clients');
  await laptop.page.click('.drawer-head button');
  await laptop.page.setInputFiles('#csv-upload', SAMPLE);
  await laptop.page.waitForSelector('button:has-text("Load sample")');
  const panel = (page) => page.locator('section.panel', { has: page.locator('h2', { hasText: 'Uncategorized transactions' }) });
  await panel(laptop.page).locator('select.review-select').first().selectOption('ok');
  await until(laptop.page, () => Object.keys(JSON.parse(g.backup().body).clients).length === 1 && g.clientFiles().length === 1, 'the laptop to sync the client and its files');
  const [clientId] = Object.keys(JSON.parse(g.backup().body).clients);
  // The files are stored under a scrambled id, compressed, never under the client's name.
  assert.doesNotMatch(g.clientFiles()[0].name, /harbor/i);
  assert.equal(JSON.parse(g.clientFiles()[0].body).enc, 'gzip');
  assert.equal(g.files.size, 2);

  // The phone connects and gets the client, and can open it from the synced files.
  const phone = await openPage({ viewport: { width: 400, height: 900 } }, setup, g.serve);
  await phone.page.click('button:has-text("Clients")');
  await phone.page.click('button:has-text("Connect Google Drive")');
  await phone.page.waitForSelector('button:has-text("Sync now"):enabled');
  await phone.page.locator('.dash-row button:has-text("Open")').first().click();
  await phone.page.waitForSelector('.source:has-text("harbor-pine")');
  const reviews = (page) => page.evaluate((id) => Object.keys((window.LedgerStore.ClientStore.get(id) || {}).reviewed || {}).length, clientId);
  assert.equal(await reviews(phone.page), 1, 'the review mark came across');
  const flagged = (page) => page.locator('#tab-audit .count').innerText();
  assert.equal(await flagged(phone.page), await flagged(laptop.page));
  // A change on the phone goes back to Drive, and the laptop picks it up on its next sync.
  await panel(phone.page).locator('select.review-select').first().selectOption('ok');
  await until(phone.page, () => Object.keys(JSON.parse(g.backup().body).clients[clientId].reviewed).length === 2, 'the phone to sync its change');
  await laptop.page.click('button:has-text("Clients")');
  await laptop.page.click('button:has-text("Sync now")');
  await laptop.page.waitForSelector('.backup-status:has-text("brought in")');
  await laptop.page.click('.drawer-head button');
  await laptop.page.waitForSelector('.banner:has-text("from your other device")');
  assert.equal(await reviews(laptop.page), 2);
  assert.equal(await flagged(laptop.page), await flagged(phone.page), 'the open client reloaded with the phone\'s change');
  // Nothing changed since: another sync uploads nothing.
  const writes = g.calls.filter((c) => !c.startsWith('GET')).length;
  await laptop.page.click('button:has-text("Clients")');
  await laptop.page.click('button:has-text("Sync now")');
  await laptop.page.waitForSelector('.backup-status:has-text("up to date")');
  assert.equal(g.calls.filter((c) => !c.startsWith('GET')).length, writes, 'an unchanged sync writes nothing');

  // Forgetting the client on the phone removes it from the laptop too, and its files from Drive.
  await phone.page.locator('button', { hasText: 'Home' }).first().click();
  await phone.page.click('button:has-text("Clients")');
  await phone.page.locator('.dash-row button:has-text("Forget")').first().click();
  await phone.page.locator('.confirm button:has-text("Forget")').click();
  await until(phone.page, () => !Object.keys(JSON.parse(g.backup().body).clients).length && g.clientFiles().length === 0, 'the phone to sync the removal');
  await laptop.page.click('button:has-text("Sync now")');
  await laptop.page.waitForSelector('.dash-row', { state: 'detached' });
  assert.deepEqual(laptop.errors, []);
  assert.deepEqual(phone.errors, []);
  await laptop.page.close();
  await phone.page.close();
});

test('Google Drive sync paused: a device that synced before offers to reconnect', async (t) => {
  if (skip) return t.skip(skip);
  const g = fakeGoogle();
  const { page, errors } = await openPage({}, (p) => p.addInitScript(() => {
    window.LedgerConfig = { googleClientId: 'test-client.apps.googleusercontent.com', googleOrigins: [] };
    localStorage.setItem('ll.drive.used', 'yes');
  }), g.serve);
  await page.waitForSelector('.banner:has-text("Sync paused")');
  await page.locator('.banner:has-text("Sync paused") button:has-text("Connect")').click();
  await page.waitForSelector('.banner:has-text("Sync paused")', { state: 'detached' });
  await until(page, () => g.backup(), 'the first sync');
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
  await panel.locator('.pill', { hasText: '1 of 16 done' }).waitFor();
  // Everything is saved with the client and comes back after a reload.
  await page.waitForTimeout(400);
  await page.reload();
  await page.setInputFiles('#csv-upload', SAMPLE);
  await page.click('#tab-close');
  await panel.locator('.pill', { hasText: '1 of 16 done' }).waitFor();
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
  assert.match(text, /Jun 2026: 1\/16/);
  assert.deepEqual(errors, []);
  await page.close();
});

test('receipts panel and the client answers round trip', async (t) => {
  if (skip) return t.skip(skip);
  const { page, errors } = await openPage();
  const rc = page.locator('section.panel', { has: page.locator('h2', { hasText: /^Receipts$/ }) });
  await rc.waitFor();
  assert.match(await rc.innerText(), /4 missing/);
  // Download the spreadsheet (captured from the page), fill it in, load it back.
  await page.click('button:has-text("Client questions")');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Spreadsheet for the client")')]);
  const sheet = fs.readFileSync(await download.path(), 'utf8');
  const lines = sheet.replace(/^﻿/, '').trim().split('\r\n');
  const i = lines.findIndex((l) => l.includes('Receipts we need'));
  lines[1] = lines[1].replace(/,,$/, ',Office printer,');
  lines[i] = lines[i].replace(/,,$/, ',,Yes');
  await page.setInputFiles('#answers-file', { name: 'answers.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n')) });
  await page.locator('.drawer .status', { hasText: 'Loaded 2 answers' }).waitFor();
  await page.click('.drawer-head button');
  const ans = page.locator('section.panel', { has: page.locator('h2', { hasText: 'Client answers' }) });
  await ans.waitFor();
  assert.match(await ans.innerText(), /Office printer/);
  assert.match(await ans.innerText(), /Receipt sent/);
  assert.match(await rc.innerText(), /1 sent by the client/);
  assert.deepEqual(errors, []);
  await page.close();
});

// A stand-in for the browser's file picker: one file kept in memory.
const fakeFilePicker = () => {
  window.__file = { name: 'Ledger Lens backup.json', text: '' };
  const handle = {
    name: 'Ledger Lens backup.json',
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    createWritable: async () => { let buf = ''; return { write: async (t) => { buf += t; }, close: async () => { window.__file.text = buf; window.__file.writes = (window.__file.writes || 0) + 1; } }; },
    getFile: async () => ({ text: async () => window.__file.text }),
  };
  window.showSaveFilePicker = async () => handle;
  window.showOpenFilePicker = async () => [handle];
};

test('backup to a file on this computer: choose it, save automatically, restore from it', async (t) => {
  if (skip) return t.skip(skip);
  const { page, errors } = await openPage({}, (p) => p.addInitScript(fakeFilePicker));
  await page.click('button:has-text("Clients")');
  await page.click('button:has-text("Choose where to save")');
  await page.locator('.backup-block', { hasText: 'Saving automatically' }).waitFor();
  assert.equal(JSON.parse(await page.evaluate(() => window.__file.text)).format, 'ledger-lens-clients');
  // A review on an uploaded client is written to the file a few seconds later.
  await page.click('.drawer-head button');
  await page.setInputFiles('#csv-upload', SAMPLE);
  await page.waitForSelector('button:has-text("Load sample")');
  const panel = page.locator('section.panel', { has: page.locator('h2', { hasText: 'Uncategorized transactions' }) });
  await panel.locator('select.review-select').first().selectOption('ok');
  await page.waitForFunction(() => { try { return Object.values(JSON.parse(window.__file.text).clients).some((c) => Object.keys(c.reviewed || {}).length); } catch (e) { return false; } }, null, { timeout: 15000 });
  // Restoring merges a client that only exists in the file.
  await page.evaluate(() => { const d = JSON.parse(window.__file.text); d.clients['other co'] = { name: 'Other Co', updatedAt: '2030-01-01T00:00:00.000Z' }; window.__file.text = JSON.stringify(d); });
  await page.click('button:has-text("Clients")');
  await page.click('button:has-text("Restore from it")');
  await page.waitForSelector('.dash-row:has-text("Other Co")');
  assert.deepEqual(errors, []);
  await page.close();
});

test('without a file picker (Safari, Firefox) the panel explains and offers the download', async (t) => {
  if (skip) return t.skip(skip);
  const { page, errors } = await openPage({}, (p) => p.addInitScript(() => { delete window.showSaveFilePicker; window.showSaveFilePicker = undefined; }));
  await page.click('button:has-text("Clients")');
  const block = page.locator('.backup-block', { hasText: 'File on this computer' });
  assert.match(await block.innerText(), /Chrome and Edge/);
  assert.equal(await page.locator('button:has-text("Choose where to save")').count(), 0);
  assert.deepEqual(errors, []);
  await page.close();
});

test('Save backup file: explains when there is nothing yet, downloads once a client is saved', async (t) => {
  if (skip) return t.skip(skip);
  const { page, errors } = await openPage();
  await page.click('button:has-text("Clients")');
  await page.click('button:has-text("Save backup file")');
  await page.locator('.backup-status', { hasText: 'Nothing to back up yet' }).waitFor();
  await page.click('.drawer-head button');
  await page.setInputFiles('#csv-upload', SAMPLE);
  await page.waitForSelector('button:has-text("Load sample")');
  await page.click('button:has-text("Clients")');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('button:has-text("Save backup file")')]);
  assert.match(download.suggestedFilename(), /^ledger-lens-backup-\d{4}-\d{2}-\d{2}\.json$/);
  const data = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
  assert.equal(data.format, 'ledger-lens-clients');
  assert.ok(Object.values(data.clients).some((c) => c.name === 'Harbor & Pine Design Co.'));
  assert.deepEqual(errors, []);
  await page.close();
});

test('uploading several files says what each one was read as', async (t) => {
  if (skip) return t.skip(skip);
  const { page, errors } = await openPage();
  const D = path.join(ROOT, 'sample-data', 'test-clients');
  await page.setInputFiles('#csv-upload', ['transaction-detail', 'chart-of-accounts', 'profit-and-loss', 'expenses-with-attachments'].map((f) => path.join(D, `bloom-basil-${f}.csv`)));
  const note = page.locator('.banner', { hasText: '4 files uploaded' });
  await note.waitFor();
  const text = await note.innerText();
  for (const s of ['(transactions)', '(chart of accounts)', '(Profit and Loss)', '(expense list with attachments)']) assert.ok(text.includes(s), s);
  const src = await page.locator('.source').innerText();
  for (const s of ['Chart of accounts', 'Ties to QuickBooks P&L', 'Expense list (receipts)']) assert.ok(src.includes(s), s);
  assert.deepEqual(errors, []);
  await page.close();
});

test('saved clients move from the old storage into the browser database and survive a reload', async (t) => {
  if (skip) return t.skip(skip);
  const old = { 'old co': { name: 'Old Co', updatedAt: '2026-01-01T00:00:00.000Z', reviewed: { a: 'ok' } } };
  const { page, errors } = await openPage({}, (p) => p.addInitScript((data) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('ll.clients.v1', data); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(old)));
  assert.equal(await page.evaluate(() => window.LedgerStore.ClientStore.status.where), 'indexeddb');
  assert.equal(await page.evaluate(() => localStorage.getItem('ll.clients.v1')), null, 'old copy removed once moved');
  await page.reload();
  await showSample(page);
  await page.click('button:has-text("Clients")');
  await page.waitForSelector('.dash-row:has-text("Old Co")');
  assert.match(await page.locator('.storage-note').innerText(), /browser's database/);
  assert.deepEqual(errors, []);
  await page.close();
});

test('a failed save says so and points to a backup', async (t) => {
  if (skip) return t.skip(skip);
  const { page, errors } = await openPage();
  await page.evaluate(() => { IDBObjectStore.prototype.put = function () { throw new DOMException('full', 'QuotaExceededError'); }; });
  await page.setInputFiles('#csv-upload', SAMPLE);
  const banner = page.locator('.banner', { hasText: 'Not saving' });
  await banner.waitFor();
  assert.match(await banner.innerText(), /run out of space/);
  await banner.locator('button', { hasText: 'Back up now' }).click();
  assert.match(await page.locator('.storage-note').innerText(), /Not saving/);
  assert.deepEqual(errors, []);
  await page.close();
});

test('without the browser database, clients are saved in basic storage instead', async (t) => {
  if (skip) return t.skip(skip);
  const { page, errors } = await openPage({}, (p) => p.addInitScript(() => { Object.defineProperty(window, 'indexedDB', { value: undefined }); }));
  assert.equal(await page.evaluate(() => window.LedgerStore.ClientStore.status.where), 'localstorage');
  await page.setInputFiles('#csv-upload', SAMPLE);
  await page.waitForFunction(() => Object.values(JSON.parse(localStorage.getItem('ll.clients.v1') || '{}')).some((c) => c.name === 'Harbor & Pine Design Co.'));
  assert.equal(await page.locator('.banner', { hasText: 'Not saving' }).count(), 0);
  assert.deepEqual(errors, []);
  await page.close();
});

test('a client saved in one tab shows up in another open tab', async (t) => {
  if (skip) return t.skip(skip);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  const open = async () => {
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/*', (route) => (route.request().url().startsWith('file:') ? route.continue() : route.abort()));
    await page.goto(PAGE);
    await showSample(page);
    return page;
  };
  const a = await open();
  const b = await open();
  await b.click('button:has-text("Clients")');
  await b.locator('.empty', { hasText: 'No clients yet' }).waitFor();
  await a.setInputFiles('#csv-upload', SAMPLE);
  await b.waitForSelector('.dash-row:has-text("Harbor & Pine")');
  assert.deepEqual(errors, []);
  await context.close();
});

test('an Excel export is read with the Excel reader served by the site', async (t) => {
  if (skip) return t.skip(skip);
  const XLSX = require('xlsx');
  const rows = fs.readFileSync(SAMPLE, 'utf8');
  const wb = XLSX.read(rows, { type: 'string' });
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const { page, errors, outside } = await openPage();
  await page.setInputFiles('#csv-upload', { name: 'harbor-pine.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer });
  await page.waitForSelector('button:has-text("Load sample")');
  assert.equal(await kpi(page, 'Uncategorized'), '11');
  assert.deepEqual(outside, []);
  assert.deepEqual(errors, []);
  await page.close();
});

test('Report a problem: fills in an email with the description and recent errors, no client data', async (t) => {
  if (skip) return t.skip(skip);
  const { page, errors } = await openPage();
  await page.setInputFiles('#csv-upload', SAMPLE);
  await page.waitForSelector('button:has-text("Load sample")');
  await page.evaluate(() => window.LedgerProblem.note('error', 'Test failure', 'src/engine.js:1'));
  await page.click('footer button:has-text("Report a problem")');
  await page.fill('#problem-what', 'The cash chart is empty');
  const href = decodeURIComponent(await page.locator('a:has-text("Email the report")').getAttribute('href'));
  assert.match(href, /^mailto:nate\.ezell@gmail\.com\?subject=Ledger Lens problem report&body=/);
  assert.match(href, /The cash chart is empty/);
  assert.match(href, /Test failure \(src\/engine\.js:1\)/);
  assert.match(href, /Storage: indexeddb, 1 saved client/);
  assert.match(href, /Tab: audit/);
  assert.ok(!/Harbor|Pine/.test(href), 'no client name in the report');
  await page.click('button:has-text("Show what the report contains")');
  assert.match(await page.locator('.problem-details').innerText(), /Version: development copy/);
  assert.deepEqual(errors, []);
  await page.close();
});

test('a crash shows a way out instead of a blank page', async (t) => {
  if (skip) return t.skip(skip);
  // Break one tab's drawing on purpose.
  const { page } = await openPage({}, (p) => p.addInitScript(() => {
    Object.defineProperty(window, 'LedgerUI', { configurable: true, set(v) { Object.defineProperty(window, 'LedgerUI', { value: v, writable: true }); Object.defineProperty(v, 'TrendsTab', { configurable: true, get: () => () => { throw new Error('Boom'); }, set() {} }); }, get() { return undefined; } });
  }));
  await page.click('#tab-trends');
  await page.waitForSelector('.crashed h1:has-text("Something went wrong")');
  await page.click('.crashed button:has-text("Report a problem")');
  const text = decodeURIComponent(await page.locator('a:has-text("Email the report")').getAttribute('href'));
  assert.match(text, /crash: Boom/);
  assert.match(text, /Crashed with: Boom/);
  await page.close();
});

test('if the page cannot start, a plain message offers the report', async (t) => {
  if (skip) return t.skip(skip);
  const page = await browser.newPage();
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.endsWith('vendor/react-dom.production.min.js')) return route.abort();
    return url.startsWith('file:') ? route.continue() : route.abort();
  });
  await page.clock.install();
  await page.goto(PAGE);
  await page.clock.runFor(16000);
  await page.waitForSelector('h1:has-text("Ledger Lens did not load")');
  const pre = await page.locator('pre').innerText();
  assert.match(pre, /did not load: vendor\/react-dom\.production\.min\.js/);
  await page.close();
});

test('Open reloads a client from the files kept in this browser, even after a reload', async (t) => {
  if (skip) return t.skip(skip);
  const { page, errors } = await openPage();
  const D = path.join(ROOT, 'sample-data', 'test-clients');
  await page.setInputFiles('#csv-upload', ['transaction-detail', 'chart-of-accounts', 'profit-and-loss', 'expenses-with-attachments'].map((f) => path.join(D, `riverbend-${f}.csv`)));
  await page.locator('.banner', { hasText: '4 files uploaded' }).waitFor();
  await page.waitForFunction(() => window.LedgerStore.FileStore.info('riverbend plumbing & heating llc') || Object.keys(window.LedgerStore.ClientStore.all()).some((id) => window.LedgerStore.FileStore.info(id)));
  // Switch away to the sample, then come back with one click.
  await page.click('button:has-text("Load sample")');
  await page.reload();
  await showSample(page);
  await page.click('button:has-text("Clients")');
  const row = page.locator('.dash-row', { hasText: 'Riverbend' });
  assert.equal(await row.locator('button', { hasText: 'Open' }).count(), 1);
  await row.locator('button', { hasText: 'Open' }).click();
  await page.locator('.banner', { hasText: 'Opened Riverbend' }).waitFor();
  const src = await page.locator('.source').innerText();
  for (const s of ['riverbend-transaction-detail.csv', 'Chart of accounts', 'Ties to QuickBooks P&L', 'Expense list (receipts)']) assert.ok(src.includes(s), s);
  // The client shows as open now, with no Open button for itself.
  await page.click('button:has-text("Clients")');
  assert.equal(await page.locator('.dash-row', { hasText: 'Riverbend' }).locator('button', { hasText: 'Open' }).count(), 0);
  // Turning the option off deletes the copies.
  await page.locator('.keep-files input').uncheck();
  await page.waitForFunction(() => !Object.keys(window.LedgerStore.ClientStore.all()).some((id) => window.LedgerStore.FileStore.info(id)));
  assert.equal(await page.locator('.dash-row button:has-text("Open")').count(), 0);
  assert.deepEqual(errors, []);
  await page.close();
});

test('forgetting a client deletes its saved files too', async (t) => {
  if (skip) return t.skip(skip);
  const { page, errors } = await openPage();
  await page.setInputFiles('#csv-upload', SAMPLE);
  await page.waitForSelector('button:has-text("Load sample")');
  await page.waitForFunction(() => Object.keys(window.LedgerStore.ClientStore.all()).some((id) => window.LedgerStore.FileStore.info(id)));
  await page.click('button:has-text("Load sample")');
  await page.click('button:has-text("Clients")');
  const row = page.locator('.dash-row', { hasText: 'Harbor' });
  await row.locator('button', { hasText: 'Forget' }).click();
  await row.locator('.confirm button', { hasText: 'Forget' }).click();
  await page.waitForFunction(() => !Object.keys(window.LedgerStore.ClientStore.all()).length);
  const left = await page.evaluate(() => new Promise((resolve) => {
    const r = indexedDB.open('ledger-lens');
    r.onsuccess = () => { const q = r.result.transaction('files').objectStore('files').count(); q.onsuccess = () => resolve(q.result); };
  }));
  assert.equal(left, 0);
  assert.deepEqual(errors, []);
  await page.close();
});

test('a browser database from the previous version is upgraded with clients intact', async (t) => {
  if (skip) return t.skip(skip);
  const { page, errors } = await openPage();
  // Replace the database with a version-1 one holding a client, as the live site had it.
  await page.evaluate(() => new Promise((resolve, reject) => {
    const del = indexedDB.deleteDatabase('ledger-lens');
    del.onsuccess = () => {
      const r = indexedDB.open('ledger-lens', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('clients'); r.result.createObjectStore('meta'); };
      r.onsuccess = () => {
        const tx = r.result.transaction(['clients', 'meta'], 'readwrite');
        tx.objectStore('clients').put({ name: 'Earlier Co', updatedAt: '2026-09-01T00:00:00.000Z' }, 'earlier co');
        tx.objectStore('meta').put(1, 'schema');
        tx.oncomplete = () => { r.result.close(); resolve(); };
      };
    };
    del.onerror = () => reject(del.error);
  }));
  await page.reload();
  await showSample(page);
  assert.equal(await page.evaluate(() => window.LedgerStore.ClientStore.status.where), 'indexeddb');
  await page.click('button:has-text("Clients")');
  await page.waitForSelector('.dash-row:has-text("Earlier Co")');
  assert.equal(await page.locator('.keep-files input').isChecked(), true);
  assert.deepEqual(errors, []);
  await page.close();
});

test('Customize: move and hide sections and tabs, kept after a reload, Reset restores', async (t) => {
  if (skip) return t.skip(skip);
  const { page, errors } = await openPage();
  const titles = () => page.$$eval('main[aria-labelledby="tab-audit"] section.panel h2', (hs) => hs.map((h) => h.textContent.trim()));
  const before = await titles();
  assert.ok(before.indexOf('Uncategorized transactions') < before.indexOf('Potential duplicates'));
  await page.click('button:has-text("Customize")');
  await page.locator('.arrange-item[data-part="closed"] button', { hasText: 'Hide' }).click();
  await page.locator('.arrange-item[data-part="duplicates"] button[aria-label="Move Potential duplicates up"]').click();
  // Hide a tab too.
  await page.locator('.tab-arrange li', { hasText: 'Benchmarks' }).locator('button', { hasText: 'Hide' }).click();
  await page.click('.customize-bar button:has-text("Done")');
  const after = await titles();
  assert.ok(after.indexOf('Potential duplicates') < after.indexOf('Uncategorized transactions'), 'duplicates moved above uncategorized');
  assert.ok(!after.includes('Closed months'), 'closed months hidden');
  assert.equal(await page.locator('#tab-benchmarks').count(), 0);
  // Kept after a reload.
  await page.reload();
  await showSample(page);
  const reloaded = await titles();
  assert.deepEqual(reloaded, after);
  assert.equal(await page.locator('#tab-benchmarks').count(), 0);
  // The layout goes into backups.
  const layout = await page.evaluate(() => JSON.parse(JSON.parse(window.LedgerUI.Backup.build()).settings.layout));
  assert.deepEqual(layout.pages.audit.hidden, ['closed']);
  // Reset brings the page and tabs back.
  await page.click('button:has-text("Customize")');
  await page.click('.customize-bar button:has-text("Reset every page and tab")');
  await page.click('.customize-bar button:has-text("Done")');
  assert.deepEqual(await titles(), before);
  assert.equal(await page.locator('#tab-benchmarks').count(), 1);
  assert.deepEqual(errors, []);
  await page.close();
});

test('Customize works on every page without errors or sideways scrolling on a phone', async (t) => {
  if (skip) return t.skip(skip);
  const { page, errors } = await openPage({ viewport: { width: 400, height: 900 } });
  for (const tab of TABS) {
    await page.click(`#tab-${tab}`);
    await page.click('button:has-text("Customize")');
    await page.waitForSelector('.customize-bar');
    assert.ok(await page.locator('.arrange-item').count() > 0, `${tab} has movable sections`);
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    assert.equal(sideways, false, `${tab} scrolls sideways while customizing`);
    await page.click('.customize-bar button:has-text("Done")');
  }
  assert.deepEqual(errors, []);
  await page.close();
});

test('Home: opens first, lists clients with what is waiting on Mark and on clients', async (t) => {
  if (skip) return t.skip(skip);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/*', (route) => (route.request().url().startsWith('file:') ? route.continue() : route.abort()));
  await page.goto(PAGE);
  // A new browser: a welcome, no tabs.
  await page.locator('.home-empty', { hasText: 'Welcome to Ledger Lens' }).waitFor();
  assert.equal(await page.locator('#tab-audit').count(), 0);
  // Load a client, then go Home.
  const D = path.join(ROOT, 'sample-data', 'test-clients');
  await page.setInputFiles('#csv-upload', ['transaction-detail', 'chart-of-accounts', 'profit-and-loss', 'expenses-with-attachments'].map((f) => path.join(D, `riverbend-${f}.csv`)));
  await page.locator('.banner', { hasText: '4 files uploaded' }).waitFor();
  // The client asked for a loan package.
  await page.click('#tab-advisory');
  await page.check('#loan-requested');
  await page.waitForTimeout(300);
  // An answer link is out with them (as the portal leaves it in the profile).
  await page.evaluate(() => {
    const S = window.LedgerStore.ClientStore;
    const id = Object.keys(S.all())[0];
    S.put(id, { ...S.get(id), portal: { id: 'x', key: 'y', status: 'waiting', count: 6, createdAt: Date.now() - 9 * 864e5, expiresAt: Date.now() + 21 * 864e5, email: 'office@riverbend.test', refs: {} } });
  });
  await page.click('button:has-text("Home")');
  const mine = page.locator('section.panel', { has: page.locator('h2', { hasText: 'Waiting on you' }) });
  await mine.waitFor();
  const mineText = await mine.innerText();
  assert.match(mineText, /Loan package requested/);
  assert.match(mineText, /flags? to review/);
  const theirs = await page.locator('section.panel', { has: page.locator('h2', { hasText: 'Waiting on clients' }) }).innerText();
  assert.match(theirs, /6 questions sent, no answers yet/);
  assert.match(theirs, /Consider a reminder/);
  assert.match(await page.locator('.client-card').innerText(), /Riverbend Plumbing/);
  // Open from Home goes back to the client.
  await page.locator('.client-card button', { hasText: 'Open' }).click();
  await page.locator('.banner', { hasText: 'Opened Riverbend' }).waitFor();
  await page.waitForSelector('#tab-audit');
  // After a reload it opens on Home again, with the client still there.
  await page.reload();
  await page.locator('.client-card', { hasText: 'Riverbend' }).waitFor();
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  assert.equal(sideways, false);
  await page.setViewportSize({ width: 400, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, 'phone width');
  assert.deepEqual(errors, []);
  await page.close();
});

test('Loan package: flag the request, see what to fix, download the lender copy without review notes', async (t) => {
  if (skip) return t.skip(skip);
  const { page, errors } = await openPage();
  await page.setInputFiles('#csv-upload', SAMPLE);
  await page.waitForSelector('button:has-text("Load sample")');
  await page.click('#tab-advisory');
  const panel = page.locator('section.panel', { has: page.locator('h2', { hasText: 'Lender-ready package' }) });
  assert.equal(await panel.locator('button', { hasText: 'Create lender-ready package' }).count(), 0);
  await page.check('#loan-requested');
  await panel.locator('.pill', { hasText: 'Requested, not created yet' }).waitFor();
  await panel.locator('button', { hasText: 'Create lender-ready package' }).click();
  const drawer = page.locator('.drawer', { has: page.locator('h2', { hasText: 'Lender-ready package' }) });
  await drawer.waitFor();
  assert.match(await drawer.locator('.lender-issues').innerText(), /Wages without employer payroll taxes/);
  await page.fill('#l-lender', 'First Community Bank');
  await page.fill('#l-amount', '60000');
  await page.fill('#l-purpose', 'Studio build-out');
  const preview = () => page.evaluate(() => document.querySelector('.report-shadow').shadowRoot.textContent);
  await page.waitForFunction(() => /First Community Bank/.test(document.querySelector('.report-shadow').shadowRoot.textContent));
  assert.ok(!(await preview()).includes('Review notes'));
  const [download] = await Promise.all([page.waitForEvent('download'), drawer.locator('button', { hasText: 'Download for the lender' }).click()]);
  const doc = fs.readFileSync(await download.path(), 'utf8');
  assert.match(download.suggestedFilename(), /lender-package/);
  for (const s of ['Key measures lenders test', 'Studio build-out', '$60,000', 'Income statement']) assert.ok(doc.includes(s), s);
  assert.ok(!doc.includes('Review notes'));
  const [mine] = await Promise.all([page.waitForEvent('download'), drawer.locator('button', { hasText: 'Download my copy with notes' }).click()]);
  assert.ok(fs.readFileSync(await mine.path(), 'utf8').includes('Review notes (not for the lender)'));
  await page.click('.drawer-head button');
  await panel.locator('.pill', { hasText: 'Created' }).waitFor();
  assert.deepEqual(errors, []);
  await page.close();
});

test('a landscaper gets the Landscaping tab: winter cash, service lines, contracts, labor and equipment', async (t) => {
  if (skip) return t.skip(skip);
  const dir = path.join(ROOT, 'sample-data', 'test-clients');
  const files = ['transaction-detail', 'chart-of-accounts', 'profit-and-loss', 'expenses-with-attachments', 'customer-contact-list'].map((f) => path.join(dir, `greenway-${f}.csv`));
  for (const [colorScheme, width] of [['light', 1280], ['dark', 400]]) {
    const { page, errors } = await openPage({ colorScheme, viewport: { width, height: 900 } });
    assert.equal(await page.locator('#tab-landscape').count(), 0, 'the sample is not a landscaper');
    await page.setInputFiles('#csv-upload', files);
    await page.waitForSelector('#tab-landscape');
    await page.click('#tab-landscape');
    await page.waitForSelector('main[aria-labelledby="tab-landscape"] section');
    const text = await page.locator('main').innerText();
    for (const want of [/Off-season cash plan/, /Lakeview Office Park/, /Sunset Villas HOA/, /Maple Ridge HOA/, /Snow & ice lost/, /Exmark Lazer Z #3/, /zero-turn mower/, /Overtime spike/, /Profit playbook/, /fill-ups at gas stations/, /Rock Solid Stone Supply/, /turn right/, /Route density/, /Oak Ridge Dr/, /Only a billing office or PO box/]) assert.match(text, want);
    assert.equal(await kpi(page, 'Contract invoices not sent'), '2');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, `landscape tab scrolls sideways at ${width}px`);
    // Its sections can be arranged like any other page.
    await page.click('button.customize-toggle');
    assert.equal(await page.locator('.arrange-item').count() >= 5, true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, `customizing the landscape tab scrolls sideways at ${width}px`);
    await page.locator('button', { hasText: 'Done' }).first().click();
    if (width === 1280) {
      // The month-end checklist gains the landscaping steps.
      await page.click('#tab-close');
      assert.match(await page.locator('main').innerText(), /contract billed for the month/);
      // Benchmarks start on landscaping.
      await page.click('#tab-benchmarks');
      assert.equal(await page.locator('#bm-industry').inputValue(), '561730');
      // Set to General: the tab goes away; back to automatic brings it back.
      await page.selectOption('#industry-pick', 'general');
      await page.waitForSelector('#tab-landscape', { state: 'detached' });
      await page.selectOption('#industry-pick', '');
      await page.waitForSelector('#tab-landscape');
      // Home lists the missed contract invoices.
      await page.locator('button', { hasText: 'Home' }).first().click();
      assert.match(await page.locator('.home').innerText(), /2 contract invoices not sent/);
    }
    assert.deepEqual(errors, [], `${colorScheme} ${width}px`);
    await page.close();
  }
});

test('a landscaper gets the Fraud risk tab; the voided/deleted report and employee list unlock the rest', async (t) => {
  if (skip) return t.skip(skip);
  const dir = path.join(ROOT, 'sample-data', 'test-clients');
  const files = ['transaction-detail', 'chart-of-accounts', 'profit-and-loss', 'expenses-with-attachments', 'customer-contact-list'].map((f) => path.join(dir, `greenway-${f}.csv`));
  for (const [colorScheme, width] of [['light', 1280], ['dark', 400]]) {
    const { page, errors } = await openPage({ colorScheme, viewport: { width, height: 900 } });
    assert.equal(await page.locator('#tab-fraud').count(), 0, 'the sample is not a landscaper');
    await page.setInputFiles('#csv-upload', files);
    await page.waitForSelector('#tab-fraud');
    await page.click('#tab-fraud');
    await page.waitForSelector('main[aria-labelledby="tab-fraud"] .fraud-checks');
    assert.equal(await kpi(page, 'Reports to add'), '2');
    assert.equal(await page.locator('.fraud-check.needs').count(), 2);
    let text = await page.locator('main').innerText();
    for (const want of [/Skipped invoice numbers/, /Regular customers who stopped being billed/, /Kingsley Residence/, /Oak Ridge Dr/, /Jobs where materials outran the price/, /Prairie Stone & Mulch/, /Look-alike vendor names/, /Site One Landscape Supply/, /DR Landscape Services/, /Independence Day/, /Payroll outside the regular runs/]) assert.match(text, want);
    // The two extra reports, added to the client already open.
    await page.setInputFiles('#csv-add', ['voided-deleted', 'employee-details'].map((f) => path.join(dir, `greenway-${f}.csv`)));
    await page.waitForSelector('.source .pill:has-text("Employee list")');
    await page.waitForFunction(() => !document.querySelector('.fraud-check.needs'));
    assert.equal(await kpi(page, 'Reports to add'), '0');
    assert.match(await page.locator('.source').innerText(), /Voided\/deleted report/);
    text = await page.locator('main').innerText();
    for (const want of [/Deleted 06\/18\/2026 by Jenna/, /Walnut Creek Condos/, /Dan Ortiz, Mike Dawson/, /Payments to employees outside payroll/]) assert.match(text, want);
    // A long list opens on request; the job chart draws.
    const jobs = page.locator('.fraud-check[data-check="jobCosts"]');
    assert.equal(await jobs.locator('.recharts-surface').count() > 0, true);
    assert.match(await jobs.innerText(), /Castle Rock Winery › Tasting room patio/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, `fraud tab scrolls sideways at ${width}px`);
    await page.click('button.customize-toggle');
    assert.equal(await page.locator('.arrange-item').count(), 5);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, `customizing the fraud tab scrolls sideways at ${width}px`);
    await page.locator('button', { hasText: 'Done' }).first().click();
    assert.deepEqual(errors, [], `${colorScheme} ${width}px`);
    await page.close();
  }
});

test('Flag a problem: pick mode on a phone, then the email fallback away from the site', async (t) => {
  if (skip) return t.skip(skip);
  const { page, errors } = await openPage({ viewport: { width: 400, height: 900 } }, (p) => p.addInitScript(() => { window.LedgerConfig = { ...(window.LedgerConfig || {}), supportEmail: 'help@example.com' }; }));
  await page.click('#tab-trends');
  await page.click('button.flag-toggle');
  await page.waitForSelector('.flag-bar');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, 'pick mode scrolls sideways');
  // Taps pick instead of pressing buttons underneath.
  await page.locator('main .kpi').first().click();
  await page.waitForSelector('#ticket-what');
  assert.match(await page.locator('.drawer').innerText(), /Trends › /);
  assert.equal(await page.locator('button:has-text("Send ticket")').count(), 0, 'no ticket endpoint on file://');
  await page.fill('#ticket-what', 'This tile looks wrong');
  const mailto = decodeURIComponent(await page.locator('a:has-text("Email the report")').getAttribute('href'));
  assert.match(mailto, /^mailto:help@example\.com/);
  assert.match(mailto, /Flagged: Trends › .*This tile looks wrong/s);
  await page.click('.drawer-head button');
  await page.waitForSelector('.drawer', { state: 'detached' });
  assert.deepEqual(errors, []);
  await page.close();
});

test('Fixed assets: add a purchase found in the books, see its depreciation and journal entry, and it is saved', async (t) => {
  if (skip) return t.skip(skip);
  const dir = path.join(ROOT, 'sample-data', 'test-clients');
  const files = ['transaction-detail', 'chart-of-accounts', 'profit-and-loss', 'expenses-with-attachments'].map((f) => path.join(dir, `greenway-${f}.csv`));
  for (const [colorScheme, width] of [['light', 1280], ['dark', 400]]) {
    const { page, errors } = await openPage({ colorScheme, viewport: { width, height: 900 } });
    await page.setInputFiles('#csv-upload', files);
    await page.waitForSelector('#tab-landscape');
    await page.click('#tab-assets');
    const found = page.locator('section.panel', { has: page.locator('h2', { hasText: 'Found in the books' }) });
    await found.waitFor();
    const text = await found.innerText();
    for (const want of [/16 ft enclosed trailer/, /zero-turn mower/, /Backpack blowers/]) assert.match(text, want);
    assert.equal(await kpi(page, 'Found in the books'), '3');
    // Add the trailer: the form comes filled in from the purchase.
    await found.locator('tr', { hasText: 'trailer' }).locator('button:has-text("Add")').click();
    assert.equal(await page.locator('#af-cost').inputValue(), '8900');
    assert.equal(await page.locator('#af-cat').inputValue(), 'trailer');
    await page.click('button:has-text("Save asset")');
    const register = page.locator('section.panel', { has: page.locator('h2', { hasText: 'Asset register' }) });
    await register.locator('td', { hasText: '16 ft enclosed trailer' }).waitFor();
    assert.equal(await kpi(page, 'Found in the books'), '2');
    // Books hold $150,900 of equipment; the register only the trailer.
    assert.match(await register.innerText(), /Register incomplete/);
    // 5-year MACRS: 20% of $8,900 in 2025; book straight-line over 7 years.
    const years = page.locator('section.panel', { has: page.locator('h2', { hasText: 'Depreciation by year' }) });
    assert.match(await years.locator('tr', { hasText: '2025' }).innerText(), /\$1,780\.00/);
    await page.selectOption('#je-period', '2026-08');
    assert.match(await page.locator('section.panel', { has: page.locator('h2', { hasText: 'Depreciation journal entry' }) }).innerText(), /\$105\.95/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, `fixed assets tab scrolls sideways at ${width}px`);
    if (width === 1280) {
      // The close checklist gains the depreciation step; the register is saved with the client.
      await page.click('#tab-close');
      assert.match(await page.locator('main').innerText(), /Depreciation posted from the fixed asset register/);
      await page.reload();
      await page.locator('.client-card button:has-text("Open")').first().click();
      await page.waitForSelector('#tab-assets');
      await page.click('#tab-assets');
      await page.locator('td', { hasText: '16 ft enclosed trailer' }).waitFor();
    }
    assert.deepEqual(errors, [], `${colorScheme} ${width}px`);
    await page.close();
  }
});

test('Client report offers a free health check that leaves out the specifics', async (t) => {
  if (skip) return t.skip(skip);
  const { page, errors } = await openPage();
  await page.click('button:has-text("Client report")');
  await page.click('.seg button:has-text("Free health check")');
  await page.locator('.report-frame').locator('text=Get the full review').waitFor();
  const text = await page.evaluate(() => document.querySelector('.report-shadow').shadowRoot.textContent);
  assert.match(text, /Free books health check/);
  assert.match(text, /Uncategorized transactions/);
  assert.ok(!/Comcast Business/.test(text), 'no vendor names');
  assert.match(await page.locator('.drawer-foot').innerText(), /Download \.html/);
  assert.deepEqual(errors, []);
  await page.close();
});
