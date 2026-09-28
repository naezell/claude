// The test clients in sample-data/test-clients: the saved files match the generator, and
// the app finds what was planted in them (a contractor and a cafe, unlike the built-in sample).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const E = require('../src/engine.js');
const { riverbend, cafe, greenway, transactionDetail } = require('../scripts/make-test-clients.js');

const dir = path.join(__dirname, '..', 'sample-data', 'test-clients');
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const load = (pre) => {
  const att = E.parseAttachmentList(read(`${pre}-expenses-with-attachments.csv`));
  return E.analyze(E.parseTransactions(read(`${pre}-transaction-detail.csv`)), {
    chart: E.parseChartOfAccounts(read(`${pre}-chart-of-accounts.csv`)),
    pnl: E.parseProfitAndLoss(read(`${pre}-profit-and-loss.csv`)),
    attachments: att.entries,
  });
};

test('saved test-client files match the generator', () => {
  const rb = riverbend();
  assert.equal(read('riverbend-transaction-detail.csv'), transactionDetail(rb.b, rb.openings, 'January 2025 - August 2026'));
  const cf = cafe();
  assert.equal(read('bloom-basil-transaction-detail.csv'), transactionDetail(cf.b, cf.openings, 'January 2025 - August 2026', true));
  const gw = greenway();
  assert.equal(read('greenway-transaction-detail.csv'), transactionDetail(gw.b, gw.openings, 'January 2024 - August 2026', true));
});

test('Riverbend Plumbing: contractor problems are all found', () => {
  const r = load('riverbend');
  assert.equal(r.meta.company, 'Riverbend Plumbing & Heating LLC');
  assert.equal(r.tieOut.ties, true);
  const bs = r.balanceSheet.items.map((i) => `${i.kind}|${i.account}`);
  for (const k of ['Undeposited Funds|Undeposited Funds', 'Wrong-sign balance|Capital One Spark (5521)', 'Wrong-sign balance|Sales Tax Payable', 'Customer credit|Hillside HOA', 'Old open bill|Winsupply']) assert.ok(bs.includes(k), k);
  assert.match(r.balanceSheet.items.find((i) => i.kind === 'Undeposited Funds').detail, /since Mar \d+, 2026/);
  assert.ok(r.audit.duplicates.some((g) => /F2606-4/.test(g.reason)));
  assert.ok(r.audit.duplicates.some((g) => g.rows[0].name === 'Shell'));
  assert.equal(r.audit.open.uncategorized, 4);
  assert.equal(r.jobCosts.mode, 'tracked');
  assert.ok(r.jobCosts.jobs.some((j) => j.kind === 'Costs, no billing' && j.name === 'Oak Ridge Senior Living'));
  assert.ok(r.unusual.txns.some((t) => t.kind === 'New payee' && /Transmission Pros/.test(t.detail)));
  assert.deepEqual(r.vendors.prices.rows.map((x) => x.name).sort(), ['Riverside Properties LLC', 'ServiceTitan', 'Verizon Wireless']);
  assert.ok(r.subs.list.some((x) => x.vendor === 'Jobber' && x.flags.some((f) => f.kind === 'Overlapping tool')), 'two field-service tools');
  assert.ok(r.receipts.counts.missing >= 3);
  // 1099s: the subcontractors and the landlord, not suppliers, insurers, utilities or the lender.
  const y25 = r.vendors.tax.find((y) => y.year === 2025).vendors.filter((v) => v.status === 'Review').map((v) => v.vendor).sort();
  assert.deepEqual(y25, ['Mike Delaney Excavating', 'Precision Electric LLC', 'Riverside Properties LLC']);
  // One-time homeowners are neither new nor lost customers.
  const movers = r.trend.customerMovers.filter((c) => c.status === 'New' || c.status === 'Lost').map((c) => c.name);
  assert.ok(movers.every((n) => !/, [A-Z]\.$/.test(n)), movers.join(', '));
  assert.ok(movers.includes('Pinecrest Library'));
});

test('Bloom & Basil Cafe: register sales are not one customer, and cafe problems are found', () => {
  const r = load('bloom-basil');
  assert.equal(r.tieOut.ties, true);
  assert.ok(r.customers.walkInShare > 0.9);
  assert.notEqual(r.customers.top.name, 'Daily POS Sales');
  assert.equal(r.customers.level.label, 'Diversified');
  const bs = r.balanceSheet.items.map((i) => i.kind);
  for (const k of ['Opening Balance Equity', 'Customer credit', 'Old open invoice']) assert.ok(bs.includes(k), k);
  assert.ok(r.audit.duplicates.some((g) => /HR-2606X/.test(g.reason)));
  assert.equal(r.jobCosts.mode, 'untracked');
  assert.ok(r.unusual.txns.some((t) => /Espresso Parts Co/.test(t.detail)));
  assert.ok(r.receipts.items.some((i) => i.rule === 'Large purchase' && /Espresso/.test(i.name)));
  assert.ok(r.subs.list.some((x) => /Square for Restaurants|Toast/.test(x.vendor) && x.flags.some((f) => f.kind === 'Overlapping tool')), 'two POS systems');
  assert.ok(!r.subs.list.some((x) => x.vendor === 'Clover Dairy'), 'a dairy is not software');
  assert.deepEqual(r.vendors.prices.rows.map((x) => x.name).sort(), ['Cintas', 'Recology']);
  const y25 = r.vendors.tax.find((y) => y.year === 2025).vendors.filter((v) => v.status === 'Review').map((v) => v.vendor);
  assert.deepEqual(y25, ['Main Street Holdings'], 'only the landlord');
});

test('Riverbend September update: edits to closed months are caught', () => {
  const snap = E.analyze(E.parseTransactions(read('riverbend-transaction-detail.csv'))).closeBooks('2026-07');
  const c = E.analyze(E.parseTransactions(read('riverbend-transaction-detail-september-update.csv')), { closed: snap }).closed;
  assert.deepEqual(c.months.map((m) => m.label), ['Apr 26', 'May 26', 'Jun 26']);
  assert.equal(c.months[0].removed, 1, 'a deleted crew lunch');
  assert.match(c.months[1].added[0].memo, /gift card/, 'an edited description');
  assert.deepEqual(c.months[2].accounts, [{ account: 'Telephone', was: 318.45, now: 418.45, diff: 100 }]);
});

test('Greenway Landscape: the landscaping checks find what was planted', () => {
  const r = load('greenway');
  assert.equal(r.meta.company, 'Greenway Landscape Co.');
  assert.ok(r.tieOut.ties);
  assert.equal(r.industry, 'landscaping');
  assert.deepEqual([r.audit.open.uncategorized, r.audit.open.duplicates], [1, 1]);
  const L = r.landscape;
  // Winter: cash dips under the cushion in April, before spring money comes in.
  assert.deepEqual(L.offSeason.offMonths, [1, 2, 3, 11, 12]);
  assert.equal(L.offSeason.low.key, '2027-04');
  assert.ok(L.offSeason.needed > 0 && L.offSeason.setAside > 0);
  assert.equal(L.offSeason.locDraws.length, 3);
  // Snow loses money after the salt price jump; the other lines make money.
  assert.deepEqual(L.serviceLines.losing.map((x) => x.key), ['snow']);
  assert.ok(L.serviceLines.byClass);
  // Two contract invoices never sent, four prices frozen since 2024.
  assert.deepEqual(L.contracts.missed.map((m) => `${m.name} ${m.month}`), ['Lakeview Office Park 2026-08', 'Sunset Villas HOA 2026-07']);
  assert.deepEqual(L.contracts.stale.map((m) => m.name).sort(), ['Dr. Patel Dental', 'Hartman Residence', 'Maple Ridge HOA', 'Riverside Church']);
  // June 2026 overtime; winter labor above the usual range.
  assert.ok(L.labor.flags.some((f) => f.kind === 'Overtime spike' && f.key === '2026-06'));
  assert.ok(L.labor.flags.some((f) => f.key === '2026-01'));
  assert.ok(!L.labor.flags.some((f) => ['2026-05', '2026-07', '2026-08'].includes(f.key)));
  // The mower that keeps breaking, and equipment bought but expensed.
  assert.deepEqual(L.equipment.repeat.map((x) => [x.machine, x.count]), [['Exmark Lazer Z #3', 4]]);
  assert.deepEqual(L.equipment.capitalize.map((x) => x.amount).sort((a, b) => a - b), [3150, 12480]);
  assert.deepEqual(L.equipment.loans.sort(), ['Ally Truck Loan', 'John Deere Financial']);
  // The close checklist and the saved summary carry the landscaping items.
  const cl = E.closeChecklist(r, '2026-08', {}, []);
  assert.equal(cl.items.find((i) => i.id === 'contractbilling').auto.status, 'open');
  assert.ok(!cl.items.some((i) => i.id === 'snowbilled'), 'no snow step in August');
  assert.deepEqual(E.clientSummary(r, {}, []).landscape, { missed: 2, stale: 4 });
});
