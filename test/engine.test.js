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
  assert.equal(r.count, 486);
  assert.equal(r.entryCount, 243, 'each entry appears in two account sections');
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
  for (const h of ['EXECUTIVE SUMMARY', 'UNCATEGORIZED', 'POTENTIAL DUPLICATES', 'MISMATCHED ENTRIES', 'PROFITABILITY BY CUSTOMER', 'RECURRING SOFTWARE', 'RECOMMENDED NEXT STEPS']) {
    assert.ok(txt.includes(h), h);
  }
  assert.ok(txt.includes('Harbor & Pine Design Co.'));
});

test('missing header gives a clear error', () => {
  assert.throws(() => E.parseTransactions('foo,bar\n1,2'), /No header row found/);
});
