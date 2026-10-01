// The test clients in sample-data/test-clients: the saved files match the generator, and
// the app finds what was planted in them (a contractor and a cafe, unlike the built-in sample).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const E = require('../src/engine.js');
const { riverbend, cafe, greenway, greenwayContacts, greenwayVoidedDeleted, greenwayEmployees, greenwayChaseStatement, greenwayAmexStatement, transactionDetail } = require('../scripts/make-test-clients.js');

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
  assert.equal(read('greenway-customer-contact-list.csv'), greenwayContacts(gw.b));
  assert.equal(read('greenway-voided-deleted.csv'), greenwayVoidedDeleted(gw.plants));
  assert.equal(read('greenway-employee-details.csv'), greenwayEmployees());
  assert.equal(read('greenway-chase-statement-jul-aug-2026.csv'), greenwayChaseStatement(gw.b));
  assert.equal(read('greenway-amex-statement-jul-aug-2026.csv'), greenwayAmexStatement());
});

test('Greenway Landscape: the card statements combined and checked against the books', () => {
  const statements = [['greenway-chase-statement-jul-aug-2026.csv', 'Chase'], ['greenway-amex-statement-jul-aug-2026.csv', 'Amex']].map(([f, label]) => {
    const r = E.readExport(read(f));
    assert.equal(r.kind, 'statement', f);
    return { ...r.data, label };
  });
  const r = E.analyze(E.parseTransactions(read('greenway-transaction-detail.csv')), { chart: E.parseChartOfAccounts(read('greenway-chart-of-accounts.csv')), statements });
  const c = r.cards;
  assert.deepEqual(c.cards.map((x) => x.account), ['Chase Ink (4410)']);
  assert.ok(c.total > 90000 && c.categories[0].category === 'Fuel');
  const ck = c.check;
  // Not in QuickBooks: two Chase charges never entered, and every charge on the Amex card.
  assert.equal(ck.missing.length, 11);
  assert.deepEqual(ck.missing.filter((x) => x.statement === 'Chase').map((x) => x.description), ['AMAZON MKTPL*2K4QZ', 'HARBOR FREIGHT TOOLS 512']);
  assert.equal(ck.missing.filter((x) => x.statement === 'Amex').length, 9);
  // In QuickBooks, on no statement: the WEX charge entered twice.
  assert.deepEqual(ck.extra.map((x) => [x.description, x.amount, x.date]), [['WEX Fleet Card', 612.18, '2026-07-21']]);
  assert.deepEqual(ck.people.map((p) => p.who), ['Chase', 'TOM GREENWAY', 'DAN ORTIZ']);
  assert.match(E.combinedStatementsCsv(statements).split('\n')[0], /^Card,Card member,Date,Description,Category,Amount$/);
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
  // Profit playbook: fuel stops, supply runs, vendor fees, the biggest vendors, growth and new customers.
  const pb = L.playbook;
  assert.ok(pb.fuel.stops >= 150, `fuel stops ${pb.fuel.stops}`);
  assert.ok(pb.fuel.vendors.some((v) => v.vendor === 'QuikTrip'));
  assert.ok(pb.supply.runs >= 70 && pb.supply.vendors[0].vendor === 'Home Depot');
  assert.deepEqual(pb.fees.vendors.map((v) => v.vendor).sort(), ['Rock Solid Stone Supply', 'SiteOne Landscape Supply']);
  assert.equal(pb.vendors[0].vendor, 'Rock Solid Stone Supply');
  assert.match(pb.vendors[0].advice, /discount/);
  assert.deepEqual(pb.growth.years.map((y) => y.year), [2024, 2025]);
  assert.ok(pb.growth.ttmChange > 0);
  assert.equal(pb.customers.newCount, 14);
  assert.ok(pb.customers.perCustomer > 100 && pb.customers.perCustomer < 400);
  const cost = E.playbookCost(pb, { crew: 3, wage: 20, stopMinutes: 20 });
  assert.equal(cost.fuelHours, pb.fuel.stops);
  assert.match(E.buildHtmlReport(r, {}), /Ideas to save time and money/);
  // Route density from the customer contact list: three streets of homes and a row of
  // businesses, the HOA billed to a PO box, and the church missing from the list.
  const routed = E.analyze(E.parseTransactions(read('greenway-transaction-detail.csv')), {
    chart: E.parseChartOfAccounts(read('greenway-chart-of-accounts.csv')), customers: E.parseCustomerList(read('greenway-customer-contact-list.csv')),
  }).landscape.routes;
  assert.deepEqual(routed.clusters.map((c) => `${c.street} ${c.count}`), ['Oak Ridge Dr 8', 'Willow Bend Rd 5', 'Wabash Ave 3', 'Maple Hollow Ct 3']);
  assert.deepEqual(routed.missing.map((m) => m.name), ['Maple Ridge HOA', 'Riverside Church']);
  assert.match(routed.missing[0].reason, /PO box/);
  assert.ok(routed.aloneShare > 0.3 && routed.aloneShare < 0.7);
  assert.ok(routed.fillIn.length > 0 && routed.fillIn.every((f) => f.names.every((n) => /Residence/.test(n))));
  assert.equal(r.landscape.routes, null, 'no routes without the contact list');
  // The close checklist and the saved summary carry the landscaping items.
  const cl = E.closeChecklist(r, '2026-08', {}, []);
  assert.equal(cl.items.find((i) => i.id === 'contractbilling').auto.status, 'open');
  assert.ok(!cl.items.some((i) => i.id === 'snowbilled'), 'no snow step in August');
  assert.deepEqual(E.clientSummary(r, {}, []).landscape, { missed: 2, stale: 4 });
});

test('Greenway Landscape: the Fraud risk checks find one planted case each', () => {
  const opts = {
    chart: E.parseChartOfAccounts(read('greenway-chart-of-accounts.csv')), pnl: E.parseProfitAndLoss(read('greenway-profit-and-loss.csv')),
    customers: E.parseCustomerList(read('greenway-customer-contact-list.csv')),
  };
  const txns = E.parseTransactions(read('greenway-transaction-detail.csv'));
  // Both extra reports are recognized when uploaded.
  assert.equal(E.readExport(read('greenway-voided-deleted.csv')).kind, 'voided');
  assert.equal(E.readExport(read('greenway-employee-details.csv')).kind, 'employees');
  const before = E.analyze(txns, opts).fraud;
  const status = (F) => Object.fromEntries(F.checks.map((c) => [c.id, c.status]));
  assert.equal(status(before).deleted, 'needs');
  assert.equal(status(before).sharedAccounts, 'needs');
  const F = E.analyze(txns, { ...opts, voided: E.parseVoidedDeleted(read('greenway-voided-deleted.csv')), employees: E.parseEmployeeList(read('greenway-employee-details.csv')) }).fraud;
  const by = Object.fromEntries(F.checks.map((c) => [c.id, c]));
  const found = F.checks.filter((c) => c.status === 'found').map((c) => c.id).sort();
  assert.deepEqual(found, ['bigFuel', 'checkGaps', 'deleted', 'dormant', 'employeePayments', 'ghosts', 'invoiceGaps', 'jobCosts', 'justUnder', 'lookalikes', 'manualPayroll', 'materialsNoJob', 'offDays', 'refunds', 'roundDollar', 'sharedAccounts', 'vendorSpikes', 'voids'].sort());
  assert.equal(by.benford.status, 'clean');
  assert.equal(by.undeposited.status, 'clean');
  assert.equal(F.needs, 0);
  assert.equal(F.level, 'high');
  // What each one found.
  assert.equal(by.invoiceGaps.items[0].range, '#5532 to #5533');
  assert.match(by.invoiceGaps.items[0].deleted, /Deleted 06\/18\/2026 by Jenna/);
  assert.deepEqual(by.dormant.items.map((d) => d.name), ['Kingsley Residence']);
  assert.match(by.dormant.items[0].street, /Oak Ridge Dr/);
  assert.deepEqual(by.jobCosts.items.map((j) => j.job), ['Castle Rock Winery › Tasting room patio']);
  assert.deepEqual([...new Set(by.vendorSpikes.items.map((s) => s.vendor))], ['Prairie Stone & Mulch']);
  assert.deepEqual(by.materialsNoJob.items.map((x) => x.cost), [2860]);
  assert.deepEqual(by.lookalikes.items.map((p) => [p.a, p.b].sort().join(' / ')), ['Site One Landscape Supply / SiteOne Landscape Supply']);
  assert.deepEqual(by.ghosts.items.map((g) => g.vendor), ['DR Landscape Services']);
  assert.deepEqual([...new Set(by.justUnder.items.map((u) => u.vendor))], ['DR Landscape Services']);
  assert.deepEqual(by.offDays.items.map((x) => x.day).sort(), ['Independence Day', 'Memorial Day', 'Sunday', 'Sunday']);
  assert.deepEqual(by.roundDollar.items.map((x) => x.vendor), ["Casey's"]);
  assert.deepEqual(by.bigFuel.items.map((x) => x.amount).sort((a, b) => a - b), [198.75, 212.4, 236.1]);
  assert.deepEqual(by.manualPayroll.items.map((x) => x.amount).sort((a, b) => a - b), [1240, 1500]);
  assert.deepEqual(by.employeePayments.items.map((x) => [x.name, x.count, x.total]), [['Dan Ortiz', 4, 600]]);
  assert.deepEqual(by.sharedAccounts.items.map((x) => x.employees), ['Dan Ortiz, Mike Dawson']);
  assert.deepEqual(by.refunds.items.map((x) => [x.name, x.amount]), [['Bauer Residence', 1850]]);
  assert.equal(by.deleted.items.length, 4);
  // A gas receipt from a client answer: 41 gallons is more than a pickup's tank.
  const withReceipt = E.analyze(txns, { ...opts, answers: { k1: { expect: { amount: 158.4, date: '2026-08-04', payee: 'Shell' }, read: { status: 'match', total: 158.4, gallons: 41.2, date: '2026-08-04' } } } }).fraud;
  const fuel = withReceipt.checks.find((c) => c.id === 'bigFuel');
  assert.ok(fuel.items.some((x) => x.gallons === 41.2 && x.vendor === 'Shell'));
  assert.ok(fuel.columns.some((c) => c[1] === 'gallons'));
  // The other test clients aren't landscapers: no fraud tab, so no checks run.
  assert.equal(load('riverbend').fraud, undefined);
});

test('free health check: how much was found, never which customers, vendors or transactions', () => {
  const rb = load('riverbend');
  const f = E.healthCheckFacts(rb);
  assert.ok(f.bookItems >= 10 && f.bookDollars > 5000, `${f.bookItems} items, ${f.bookDollars}`);
  assert.deepEqual(f.land, [], 'no landscaping section for a plumber');
  assert.ok(f.money.some((x) => x.key === 'subs'));
  const html = E.buildHealthCheck(rb, { clientName: 'Riverbend Plumbing' });
  assert.match(html, /Get the full review/);
  assert.ok(!/landscaping business/i.test(html));
  for (const secret of ['Ferguson', 'Hillside HOA', 'Transmission Pros', 'J Ramirez', 'Winsupply', 'ServiceTitan', 'Jobber', 'Cedar Point']) assert.ok(!html.includes(secret), `${secret} is in the free report`);
  const gw = load('greenway');
  const g = E.healthCheckFacts(gw);
  assert.deepEqual(g.land.map((x) => x.key).slice(0, 3), ['missed', 'stale', 'losing']);
  assert.equal(g.land.find((x) => x.key === 'missed').amount, gw.landscape.contracts.missedTotal);
  assert.ok(g.yearly > 5000);
  const gh = E.buildHealthCheck(gw, {});
  assert.match(gh, /For your landscaping business/);
  assert.match(gh, /Route density/);
  for (const secret of ['Lakeview', 'Sunset Villas', 'Maple Ridge', 'Rock Solid', 'QuikTrip', 'Exmark', 'Home Depot']) assert.ok(!gh.includes(secret), `${secret} is in the free report`);
});
