const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine.js');
const S = require('../src/sample.js');

test('parseAmount handles QuickBooks number formats', () => {
  assert.equal(E.parseAmount('$1,234.56'), 1234.56);
  assert.equal(E.parseAmount('(1,234.56)'), -1234.56);
  assert.equal(E.parseAmount('-45.10'), -45.1);
  assert.equal(E.parseAmount(''), null);
  assert.equal(E.parseAmount('abc'), null);
});

test('parseCSV handles quoted commas and escaped quotes', () => {
  const rows = E.parseCSV('a,"b, c","say ""hi"""\r\n1,2,3');
  assert.deepEqual(rows, [['a', 'b, c', 'say "hi"'], ['1', '2', '3']]);
});

test('classifyAccount separates P&L from balance sheet', () => {
  assert.equal(E.classifyAccount('Checking'), 'balance');
  assert.equal(E.classifyAccount('Chase Ink Card (4417)'), 'balance');
  assert.equal(E.classifyAccount('Accounts Receivable (A/R)'), 'balance');
  assert.equal(E.classifyAccount('Design Services Income'), 'income');
  assert.equal(E.classifyAccount('Uncategorized Income'), 'income');
  assert.equal(E.classifyAccount('Uncategorized Expense'), 'expense');
  assert.equal(E.classifyAccount('Bank Fees'), 'expense');
  assert.equal(E.classifyAccount('Cost of Goods Sold'), 'cogs');
  assert.equal(E.classifyAccount('Sales Tax Payable'), 'balance');
});

test('flat export with Account and Split columns', () => {
  const csv = [
    'Acme LLC', 'Transaction Detail', 'All Dates', '',
    'Date,Transaction Type,Num,Name,Customer,Memo/Description,Account,Split,Amount',
    '01/05/2026,Invoice,100,Globex,Globex,Work,Sales,Accounts Receivable,"1,000.00"',
    '01/06/2026,Expense,,Freelancer,Globex,Sub,Contract Labor,Checking,400.00',
    '01/07/2026,Expense,,Mystery,,,Uncategorized Expense,Checking,50.00',
    '01/07/2026,Expense,,Mystery,,,Uncategorized Expense,Checking,50.00',
    'Total,,,,,,,,1500.00',
  ].join('\n');
  const r = E.analyze(E.parseTransactions(csv));
  assert.equal(r.count, 4);
  assert.equal(r.audit.uncategorized.length, 2);
  assert.equal(r.audit.duplicates.length, 1);
  assert.equal(r.audit.duplicates[0].confidence, 'High');
  const g = r.profit.groups.find((x) => x.name === 'Globex');
  assert.equal(g.revenue, 1000);
  assert.equal(g.directCost, 400);
  assert.equal(g.margin, 0.6);
});

test('debit/credit columns and journal imbalance', () => {
  const csv = [
    'Date,Transaction Type,Num,Name,Account,Debit,Credit',
    '06/30/2026,Journal Entry,JE-1,,Depreciation Expense,415.00,',
    '06/30/2026,Journal Entry,JE-1,,Accumulated Depreciation,,400.00',
  ].join('\n');
  const r = E.analyze(E.parseTransactions(csv));
  assert.ok(r.audit.mismatches.some((m) => m.kind === 'Out of balance'));
  assert.equal(r.profit.totals.opex, 415);
});

test('sample "by Account" export: every seeded issue is found once', () => {
  const r = E.analyze(E.parseTransactions(S.build()));
  assert.equal(r.count, 542);
  assert.equal(r.entryCount, 271, 'each entry appears in two account sections');
  assert.equal(r.audit.uncategorized.length, 11);
  assert.equal(r.audit.duplicates.length, 3);
  const kinds = r.audit.mismatches.map((m) => m.kind);
  assert.equal(kinds.filter((k) => k === 'Type / account conflict').length, 3);
  assert.equal(kinds.filter((k) => k === 'Inconsistent coding').length, 1);
  assert.deepEqual(r.profit.groups.map((g) => g.name).sort(), [
    'Bluebird Bakery', 'Cedar Ridge Dental', 'Harborview Hotel', 'Northwind Outfitters', 'Oakline Realty', 'Summit Fitness',
  ]);
  const oak = r.profit.groups.find((g) => g.name === 'Oakline Realty');
  assert.ok(oak.margin < 0.2, 'Oakline is the low-margin customer');
});

test('sample subscriptions: overlaps, seats, price increase, personal', () => {
  const { subs } = E.analyze(E.parseTransactions(S.build()));
  const byVendor = Object.fromEntries(subs.list.map((s) => [s.vendor, s]));
  assert.ok(!byVendor.Gusto, 'payroll is not a subscription');
  assert.ok(!byVendor['Brightline Properties'], 'rent is not a subscription');
  assert.ok(byVendor['Adobe Creative Cloud'].flags.some((f) => f.kind === 'Price increase'));
  assert.ok(byVendor['Notion Labs'].flags.some((f) => f.kind === 'Multiple charges per period'));
  assert.ok(byVendor.Spotify.flags.some((f) => f.kind === 'Possibly personal'));
  assert.equal(byVendor.Squarespace.cadence, 'Annual');
  assert.ok(subs.overlaps.some((o) => o.category === 'Project management' && o.tools.length === 3));
  assert.ok(subs.potentialSavings > 0);
});

test('report contains every section', () => {
  const r = E.analyze(E.parseTransactions(S.build()));
  const txt = E.buildReport(r);
  for (const h of ['EXECUTIVE SUMMARY', 'UNCATEGORIZED', 'POTENTIAL DUPLICATES', 'MISMATCHED ENTRIES', 'PROFITABILITY BY CUSTOMER', 'RECURRING SOFTWARE', '13-WEEK CASH FORECAST', 'BREAK-EVEN', 'RECOMMENDED NEXT STEPS']) {
    assert.ok(txt.includes(h), h);
  }
  assert.ok(txt.includes('Harbor & Pine Design Co.'));
});

test('missing header gives a clear error', () => {
  assert.throws(() => E.parseTransactions('foo,bar\n1,2'), /No header row found/);
});

test('beginning balance rows set opening balances instead of sections', () => {
  const csv = [
    ',Date,Transaction Type,Num,Name,Split,Amount,Balance',
    'Checking',
    ',Beginning Balance,,,,,,"5,000.00"',
    ',01/05/2026,Deposit,,Globex,Sales,100.00,5100.00',
    'Total for Checking,,,,,,100.00,',
  ].join('\n');
  const p = E.parseTransactions(csv);
  assert.deepEqual(p.meta.openingBalances, { Checking: 5000 });
  assert.equal(p.transactions[0].account, 'Checking');
});

test('cash forecast: open invoices, payment speed and starting cash', () => {
  const csv = [
    'Date,Transaction Type,Num,Name,Customer,Account,Split,Amount',
    '01/05/2026,Invoice,1,Globex,Globex,Sales,Accounts Receivable,1000.00',
    '02/04/2026,Payment,,Globex,Globex,Checking,Accounts Receivable,1000.00',
    '02/05/2026,Invoice,2,Globex,Globex,Sales,Accounts Receivable,1200.00',
    '03/07/2026,Payment,,Globex,Globex,Checking,Accounts Receivable,1200.00',
    '03/05/2026,Invoice,3,Globex,Globex,Sales,Accounts Receivable,900.00',
    '01/10/2026,Invoice,9,Initech,Initech,Sales,Accounts Receivable,400.00',
    '03/20/2026,Expense,,Landlord,,Rent,Checking,-500.00',
  ].join('\n');
  const p = E.parseTransactions(csv);
  const cash = E.cashForecast(p.transactions, {}, { startingCash: 2000 });
  assert.equal(cash.asOf, '2026-03-20');
  assert.equal(cash.startingCash, 2000);
  assert.equal(cash.weeks.length, 13);
  const lag = cash.ar.customerLags.find((c) => c.name === 'Globex');
  assert.equal(lag.medianDays, 30);
  const inv3 = cash.ar.openInvoices.find((i) => i.num === '3');
  assert.equal(inv3.expectedStr, '2026-04-04', 'invoice date + 30-day history');
  const old = cash.ar.openInvoices.find((i) => i.num === '9');
  assert.equal(old.doubtful, false, '69 days old is not yet doubtful');
  assert.equal(cash.ar.total, 1300);
  const collected = cash.inflowRows.find((r) => r.label === 'Collections on open invoices').total;
  assert.equal(collected, 1300);
});

test('cash forecast on sample: exact-amount matching keeps the disputed invoice open', () => {
  const r = E.analyze(E.parseTransactions(S.build()));
  const { cash } = r;
  assert.equal(cash.asOf, '2026-06-30');
  const disputed = cash.ar.openInvoices.find((i) => i.party === 'Cedar Ridge Dental' && i.dateStr === '2026-03-05');
  assert.ok(disputed && disputed.doubtful, 'March invoice is over 90 days and excluded');
  assert.equal(disputed.week, null);
  assert.equal(cash.ar.customerLags.find((c) => c.name === 'Summit Fitness').medianDays, 6);
  assert.ok(cash.ar.customerLags.find((c) => c.name === 'Harborview Hotel').medianDays > 45);
  assert.ok(cash.outflowRows.some((row) => row.label === 'Payroll'));
  assert.ok(cash.outflowRows.some((row) => row.label === 'Rent'));
  assert.ok(cash.cardBalance > 0);
  const withDoubtful = E.analyze(E.parseTransactions(S.build()), { includeDoubtful: true }).cash;
  assert.ok(withDoubtful.totals.inflow > cash.totals.inflow);
  // Balance math: each week's ending = opening + in - out.
  for (const w of cash.weeks) assert.ok(Math.abs(w.opening + w.inflow - w.outflow - w.ending) < 0.02);
});

test('break-even math and what-if scenarios', () => {
  const base = { revenue: 10000, variable: 4000, fixed: 3000 };
  const today = E.whatIf(base, {});
  assert.equal(today.cmRatio, 0.6);
  assert.equal(today.breakEvenRevenue, 5000);
  assert.equal(today.profit, 3000);
  assert.equal(today.marginOfSafety, 0.5);
  const up = E.whatIf(base, { price: 10, target: 6000 });
  assert.equal(up.revenue, 11000);
  assert.equal(up.profit, 4000);
  assert.equal(up.revenueForTarget, 14142.86); // (3000 + 6000) / (7000 / 11000)
  assert.ok(Math.abs(up.volumeCushion - 1 / 7) < 1e-9); // 1 - 6000/7000
  const broke = E.whatIf({ revenue: 100, variable: 120, fixed: 10 }, {});
  assert.equal(broke.breakEvenRevenue, null);
});

test('break-even on sample uses whole months and splits fixed from variable', () => {
  const { breakeven: be } = E.analyze(E.parseTransactions(S.build()));
  assert.equal(be.months, 6);
  assert.equal(be.monthly.length, 6);
  assert.ok(be.variableAccounts.some((a) => a.name === 'Subcontractors'));
  assert.ok(be.fixedAccounts.some((a) => a.name === 'Wages'));
  assert.ok(be.breakEvenRevenue > 0 && be.breakEvenRevenue < be.base.revenue);
});

test('open bills flagged as duplicates in the audit are marked in the forecast', () => {
  const { cash } = E.analyze(E.parseTransactions(S.build()));
  const flagged = cash.ap.openBills.filter((b) => b.possibleDuplicate);
  assert.deepEqual(flagged.map((b) => b.num), ['B-31']);
  assert.equal(cash.ap.duplicateTotal, flagged[0].open);
});
