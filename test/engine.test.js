const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/engine.js');
const S = require('../src/sample.js');
const fs = require('fs');
const path = require('path');

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
  assert.equal(r.count, 1546);
  assert.equal(r.entryCount, 773, 'each entry appears in two account sections');
  assert.equal(r.audit.uncategorized.length, 11);
  assert.equal(r.audit.duplicates.length, 3);
  const kinds = r.audit.mismatches.map((m) => m.kind);
  assert.equal(kinds.filter((k) => k === 'Type / account conflict').length, 3);
  assert.equal(kinds.filter((k) => k === 'Inconsistent coding').length, 1);
  assert.deepEqual(r.profit.groups.map((g) => g.name).sort(), [
    'Bluebird Bakery', 'Cedar Ridge Dental', 'Harborview Hotel', 'Lakeside Brewing', 'Northwind Outfitters', 'Oakline Realty', 'Pinecrest Winery', 'Summit Fitness',
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
  for (const h of ['EXECUTIVE SUMMARY', 'UNCATEGORIZED', 'POTENTIAL DUPLICATES', 'MISMATCHED ENTRIES', 'PROFITABILITY BY CUSTOMER', 'RECURRING SOFTWARE', '13-WEEK CASH FORECAST', 'BREAK-EVEN', 'CUSTOMER CONCENTRATION', 'TRENDS', 'VENDORS & PAYABLES', 'RECOMMENDED NEXT STEPS']) {
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
  assert.equal(cash.ar.openInvoices.filter((i) => i.doubtful).length, 1);
  assert.ok(disputed && disputed.doubtful, 'March invoice is over 90 days and excluded');
  assert.equal(disputed.week, null);
  assert.ok(cash.ar.customerLags.find((c) => c.name === 'Summit Fitness').medianDays <= 8, 'fast payer');
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

test('break-even on an 18-month sample uses the trailing 12 months', () => {
  const { breakeven: be } = E.analyze(E.parseTransactions(S.build()));
  assert.equal(be.trailing, true);
  assert.equal(be.months, 12);
  assert.equal(be.monthly.length, 12);
  assert.equal(be.firstDate, '2025-07-01');
  assert.ok(be.variableAccounts.some((a) => a.name === 'Subcontractors'));
  assert.ok(be.fixedAccounts.some((a) => a.name === 'Wages'));
  assert.ok(be.breakEvenRevenue > 0 && be.breakEvenRevenue < be.base.revenue);
});

test('open bills flagged as duplicates in the audit are marked in the forecast', () => {
  const { cash } = E.analyze(E.parseTransactions(S.build()));
  const flagged = cash.ap.openBills.filter((b) => b.possibleDuplicate);
  assert.deepEqual(flagged.map((b) => b.num), ['B2603-1']);
  assert.equal(cash.ap.duplicateTotal, flagged[0].open);
});

test('parsePeriod reads QuickBooks header date ranges', () => {
  const iso = (p) => p && [p.start && p.start.toISOString().slice(0, 10), p.end.toISOString().slice(0, 10)];
  assert.deepEqual(iso(E.parsePeriod(['January 1 - June 30, 2026'])), ['2026-01-01', '2026-06-30']);
  assert.deepEqual(iso(E.parsePeriod(['January - June, 2026'])), ['2026-01-01', '2026-06-30']);
  assert.deepEqual(iso(E.parsePeriod(['January 2025 - June 2026'])), ['2025-01-01', '2026-06-30']);
  assert.deepEqual(iso(E.parsePeriod(['Transaction Detail', 'June 2026'])), ['2026-06-01', '2026-06-30']);
  assert.equal(E.parsePeriod(['All Dates']), null);
});

test('trends: monthly series, year-over-year comparisons and findings', () => {
  const { trend } = E.analyze(E.parseTransactions(S.build()));
  assert.equal(trend.months.length, 18);
  assert.equal(trend.quarters.length, 6);
  assert.ok(trend.months.every((m) => !m.partial), 'header period makes first and last month whole');
  assert.equal(trend.hasYoY, true);
  assert.deepEqual(trend.windows.last3, ['Apr 26', 'May 26', 'Jun 26']);
  assert.deepEqual(trend.windows.yearAgo, ['Apr 25', 'May 25', 'Jun 25']);
  const rev = trend.metrics.find((m) => m.key === 'revenue');
  assert.ok(rev.yoy.pct > 0.15, 'revenue grew year over year');
  const wagesInsight = trend.insights.find((i) => /Overhead/.test(i.text));
  assert.ok(wagesInsight && /Wages/.test(wagesInsight.text), 'overhead finding names wages');
  assert.ok(!/Job Materials/.test(wagesInsight.text), 'job costs are not overhead');
  const sw = trend.months.map((m) => m.software);
  assert.ok(Math.max(...sw) < 1000, 'payroll is not counted as software');
  const status = Object.fromEntries(trend.customerMovers.map((c) => [c.name, c.status]));
  assert.equal(status['Lakeside Brewing'], 'Lost');
  assert.equal(status['Harborview Hotel'], 'New');
  // Quarter figures add up to their months.
  const q1 = trend.quarters[0];
  const q1Rev = trend.months.slice(0, 3).reduce((t, m) => t + m.revenue, 0);
  assert.ok(Math.abs(q1.revenue - q1Rev) < 0.05);
  // Cash at the last month end matches the bank balance.
  assert.ok(trend.months[17].cashEnd > 0);
});

test('customer concentration: shares, HHI, flags and loss impact', () => {
  const { customers: c, breakeven } = E.analyze(E.parseTransactions(S.build()));
  assert.equal(c.windowLabel, 'last 12 months');
  assert.equal(c.top.name, 'Northwind Outfitters');
  assert.ok(c.top1Share > 0.3 && c.top1Share < 0.5);
  const shares = c.rows.reduce((t, r) => t + r.share, 0);
  assert.ok(Math.abs(shares - 1) < 1e-9);
  assert.ok(c.hhi >= 1500 && c.hhi < 2500);
  assert.equal(c.level.label, 'Moderately concentrated');
  const flags = (n) => c.rows.find((r) => r.name === n).flags.map((f) => f.kind);
  assert.ok(flags('Northwind Outfitters').includes('Concentration'));
  assert.ok(flags('Cedar Ridge Dental').includes('Over 90 days'));
  assert.ok(flags('Harborview Hotel').includes('Slow payer'));
  assert.ok(flags('Oakline Realty').includes('Low margin'));
  assert.ok(flags('Lakeside Brewing').includes('Lost'));
  const top = c.rows[0];
  assert.equal(top.profitIfLost, Math.round((breakeven.profit - top.monthlyContribution) * 100) / 100);
  assert.ok(top.profitIfLost < 0, 'losing the top customer turns a profit into a loss');
  assert.equal(c.rows.find((r) => r.name === 'Lakeside Brewing').profitIfLost, null);
});

test('mergeParsed combines exports and drops overlapping rows', () => {
  const head = 'Date,Transaction Type,Num,Name,Account,Split,Amount';
  const a = E.parseTransactions([head, '01/05/2026,Expense,,Acme,Rent,Checking,100.00', '01/20/2026,Expense,,Acme,Rent,Checking,100.00', '02/05/2026,Expense,,Acme,Rent,Checking,100.00'].join('\n'));
  const b = E.parseTransactions([head, '02/05/2026,Expense,,Acme,Rent,Checking,100.00', '03/05/2026,Expense,,Acme,Rent,Checking,100.00'].join('\n'));
  const m = E.mergeParsed([b, a]);
  assert.equal(m.meta.files, 2);
  assert.equal(m.meta.droppedOverlap, 1);
  assert.deepEqual(m.transactions.map((t) => t.dateStr), ['2026-01-05', '2026-01-20', '2026-02-05', '2026-03-05']);
  // A genuine repeat inside one file is kept.
  const c = E.parseTransactions([head, '04/01/2026,Expense,,Acme,Rent,Checking,100.00', '04/01/2026,Expense,,Acme,Rent,Checking,100.00'].join('\n'));
  assert.equal(E.mergeParsed([a, c]).transactions.length, 5);
});

test('merging yearly exports gives the same analysis as one long export', () => {
  const lines = S.build().split('\n');
  const head = lines.slice(0, 5);
  const pick = (from, to, keepOpening, period) => {
    const out = head.map((l) => l.replace('January 2025 - June 2026', period));
    for (const l of lines.slice(5)) {
      const m = l.match(/^,(\d\d)\/(\d\d)\/(\d{4}),/);
      if (!m) { if (!/Beginning Balance/.test(l) || keepOpening) out.push(l); continue; }
      const k = m[3] + m[1];
      if (k >= from && k <= to) out.push(l);
    }
    return E.parseTransactions(out.join('\n'));
  };
  // December 2025 appears in both files, as happens when date ranges overlap.
  const y2025 = pick('202501', '202512', true, 'January - December, 2025');
  const y2026 = pick('202512', '202606', false, 'December 2025 - June 2026');
  const merged = E.analyze(E.mergeParsed([y2026, y2025]));
  const single = E.analyze(E.parseTransactions(S.build()));
  assert.ok(E.mergeParsed([y2026, y2025]).meta.droppedOverlap > 0);
  assert.equal(merged.count, single.count);
  assert.deepEqual(merged.period, single.period);
  assert.equal(merged.profit.totals.revenue, single.profit.totals.revenue);
  assert.equal(merged.cash.startingCash, single.cash.startingCash);
  assert.equal(merged.cash.asOf, single.cash.asOf);
  assert.equal(merged.trend.hasYoY, true);
});

test('vendors: payroll excluded, concentration, payment speed and early-pay opportunity', () => {
  const { vendors: v } = E.analyze(E.parseTransactions(S.build()));
  assert.equal(v.windowLabel, 'last 12 months');
  assert.ok(!v.rows.some((r) => r.name === 'Gusto'), 'payroll is not a vendor');
  const shares = v.rows.reduce((t, r) => t + r.share, 0);
  assert.ok(Math.abs(shares - 1) < 1e-9);
  const pw = v.rows.find((r) => r.name === 'PrintWorks Co.');
  assert.ok(pw.days <= 8 && pw.paidBy === 'Bills');
  assert.deepEqual(v.earlyPay.map((e) => e.name), ['PrintWorks Co.']);
  assert.ok(v.earlyPay[0].cashFreed > 0);
  assert.equal(v.weekly.length, 13);
  // The unpaid duplicate bill from March sits in the over-90 bucket.
  assert.ok(v.buckets[3].amount > 0 && v.buckets[3].count === 1);
  assert.ok(v.dpo > 0 && v.dso > 0);
});

test('1099 review: thresholds by year, card-only and corporations', () => {
  const { vendors: v } = E.analyze(E.parseTransactions(S.build()));
  const y25 = v.tax.find((y) => y.year === 2025);
  const y26 = v.tax.find((y) => y.year === 2026);
  assert.equal(y25.threshold, 600);
  assert.equal(y26.threshold, 2000);
  assert.equal(y25.full, true);
  assert.equal(y26.full, false);
  const st = (y, n) => (y.vendors.find((x) => x.vendor === n) || {}).status;
  assert.equal(st(y25, 'Lena Ortiz Illustration'), 'Review');
  assert.equal(y25.vendors.find((x) => x.vendor === 'Brightline Properties').form, '1099-MISC (rent)');
  assert.equal(st(y25, 'Comcast Business'), undefined, 'utilities are not payments for services');
  assert.equal(st(y25, 'Adobe Creative Cloud'), undefined, 'software is not a payment for services');
  assert.equal(st(y26, 'R. Patel'), 'Below threshold');
  assert.ok(!y25.vendors.some((x) => x.vendor === 'Gusto' || x.vendor === 'Jordan Pike'), 'payroll and owner draws are excluded');
  const t = E.tax1099(E.parseTransactions(['Date,Transaction Type,Num,Name,Account,Split,Amount', '03/01/2025,Check,1,Acme Widgets Inc.,Consulting,Checking,900.00'].join('\n')).transactions, {}, {});
  assert.equal(t[0].vendors[0].status, 'Likely exempt');
  // Goods, insurance, loan payments and transfers are left out; a service vendor is kept.
  const mixed = E.tax1099(E.parseTransactions(['Date,Transaction Type,Num,Name,Account,Split,Amount',
    '03/01/2025,Check,1,Ferguson Supply,Job Materials,Checking,5000.00',
    '03/02/2025,Check,2,Travelers,Insurance,Checking,3000.00',
    '03/03/2025,Transfer,,,Bank Fees,Checking,2500.00',
    '03/04/2025,Check,3,Ace Consulting,Professional Fees,Checking,1200.00',
    '03/05/2025,Check,4,City Light & Water Co,Repairs,Checking,900.00',
    '03/06/2025,Expense,,Pat Rivera Design,Contract Labor,Amex Card,1500.00'].join('\n')).transactions, {}, {});
  const names = mixed[0].vendors.map((x) => `${x.vendor}:${x.status}`);
  assert.deepEqual(names.sort(), ['Ace Consulting:Review', 'City Light & Water Co:Likely exempt', 'Pat Rivera Design:Card only']);
});

test('benchmarks: request arguments, payload reading and comparison', () => {
  const r = E.analyze(E.parseTransactions(S.build()));
  const inputs = E.benchmarkInputs(r);
  assert.equal(inputs.annualized, false);
  assert.ok(Math.abs(inputs.revenue - inputs.expenses - inputs.profit) < 0.02);
  const ind = { code: '541430', name: 'Graphic Design Services' };
  const req = E.benchmarkRequest(inputs, 'margin', ind, 'OR', 'Harbor & Pine Design Co.');
  assert.deepEqual(req.naicsCode, ['541430']);
  assert.equal(req.metricType, 'margin');
  assert.equal(req.profitValue, inputs.profit);
  assert.equal(req.companyName, 'Harbor and Pine Design Co.');
  assert.equal(E.benchmarkRequest(inputs, 'revenue', ind, 'OR', 'X').metricValue, inputs.revenue);
  // Shape observed from the connector (values here are made up for the test).
  const m = E.readBenchmark({ status: 'success', metricType: 'margin', metricFormat: 'percent', metricValue: 8, regionalAverage: 16, nationalAverage: null, vsRegionalPercent: -50, benchmarkPeriodRange: 'Jan 2026 - Dec 2026', naicsCode: '541430', location: 'OR' }, 'margin');
  assert.equal(m.company, 0.08);
  assert.equal(m.regional, 0.16);
  assert.equal(m.national, null);
  assert.throws(() => E.readBenchmark({ status: 'error', message: 'nope' }, 'revenue'), /nope/);
  const cmp = E.compareBenchmarks({ revenue: 120, profit: 10, expenses: 110, marginPct: 8.33 }, { revenue: 100, profit: 20, margin: 0.2, expenses: 80 });
  const by = Object.fromEntries(cmp.map((c) => [c.metric, c]));
  assert.equal(by.revenue.read, 'Ahead');
  assert.equal(by.profit.read, 'Behind');
  assert.equal(by.margin.read, 'Behind');
  assert.equal(by.expenses.read, 'Higher');
  assert.ok(E.INDUSTRIES.every((g) => g.industries.every((i) => /^\d{2,6}$/.test(i.code))));
  assert.equal(E.STATES.length, 51);
});

test('chart of accounts: parsing, exact types and roles beat name guesses', () => {
  const chart = E.parseChartOfAccounts(S.chartOfAccounts());
  assert.equal(chart.accounts.length, 23);
  assert.equal(E.parseChartOfAccounts(S.build()), null, 'a transaction report is not a chart');
  // Names that fool the guesser: a card and a bank account with no telltale words.
  const coa = E.parseChartOfAccounts(['Account,Type,Detail type', 'Mercury 4471,Bank,Checking', 'Brex,Credit Card,Credit Card', 'Studio Revenue Share,Expenses,Other', 'Pike Capital,Equity,Owner draws'].join('\n'));
  const { accountClass } = E.resolveAccounts(['Mercury 4471', 'Brex', 'Studio Revenue Share', 'Pike Capital', 'Rent'], { Rent: 'cogs' }, coa);
  assert.equal(E.roleOf(accountClass, 'Mercury 4471'), 'cash');
  assert.equal(E.roleOf(accountClass, 'Brex'), 'card');
  assert.equal(accountClass['Studio Revenue Share'], 'expense', 'chart beats the "revenue" in the name');
  assert.equal(E.roleOf(accountClass, 'Pike Capital'), 'equity');
  assert.equal(accountClass.Rent, 'cogs', 'manual choice beats everything');
  const r = E.analyze(E.parseTransactions(S.build()), { chart });
  assert.deepEqual(r.chart, { accounts: 23, matched: 22, of: 22 });
  assert.ok(r.accounts.every((a) => a.source === 'chart'));
  assert.equal(r.accounts.find((a) => a.name === 'SBA Loan').role, 'loan');
});

test('forecast projects owner draws and loan principal from their history', () => {
  const { cash } = E.analyze(E.parseTransactions(S.build()), { chart: E.parseChartOfAccounts(S.chartOfAccounts()) });
  const by = Object.fromEntries(cash.balanceOut.map((b) => [b.label, b]));
  assert.equal(by['Owner draws'].cadence, 'Quarterly');
  assert.deepEqual(by['Owner draws'].next, ['2026-09-28'], 'the missed June draw is not back-filled');
  assert.equal(by['Loan payments'].cadence, 'Monthly');
  assert.deepEqual(by['Loan payments'].next, ['2026-07-05', '2026-08-05', '2026-09-05']);
  assert.ok(cash.outflowRows.some((r) => r.label === 'Owner draws' && r.total === by['Owner draws'].amount));
  assert.ok(cash.outflowRows.some((r) => r.label === 'Interest Expense'), 'loan interest is projected as a monthly expense');
});

test('review state: keys survive re-export, cleared flags leave the counts', () => {
  const p = E.parseTransactions(S.build());
  const r = E.analyze(p);
  assert.equal(r.clientKey, 'harbor pine design co');
  const dup = r.audit.duplicates[0];
  const unc = r.audit.uncategorized[0];
  const mis = r.audit.mismatches[0];
  assert.ok(dup.key.startsWith('d|') && unc.key.startsWith('u|') && mis.key.startsWith('m|'));
  assert.ok(!/\b\d{3,}\b.*row/.test(unc.key), 'keys do not use line numbers');
  // Same data re-parsed (as next month's export would be) gives the same keys.
  const again = E.analyze(E.parseTransactions(S.build()));
  assert.equal(again.audit.duplicates[0].key, dup.key);
  const reviewed = { [dup.key]: { status: 'ok' }, [unc.key]: { status: 'fixed' }, [mis.key]: { status: 'asked' } };
  const r2 = E.analyze(p, { reviewed });
  assert.equal(r2.audit.cleared, 2);
  assert.equal(r2.audit.open.duplicates, r.audit.open.duplicates - 1);
  assert.equal(r2.audit.open.uncategorized, r.audit.open.uncategorized - 1);
  assert.equal(r2.audit.open.mismatches, r.audit.open.mismatches, '"asked" stays open');
  assert.ok(r2.audit.flaggedCount < r.audit.flaggedCount);
});

test('client questions: one per open item, no repeats, cleared items left out', () => {
  const p = E.parseTransactions(S.build());
  const r = E.analyze(p);
  const q = E.clientQuestions(r, { greeting: 'Jordan', preparer: 'The bookkeeper' });
  assert.ok(q.text.startsWith('Hi Jordan,'));
  assert.ok(q.text.trim().endsWith('The bookkeeper'));
  const numbered = q.text.split('\n').filter((l) => /^\d+\. /.test(l));
  assert.equal(numbered.length, q.count);
  // The two uncategorized entries with no payee are asked about once, not twice.
  assert.equal(numbered.filter((l) => l.includes('ACH DEBIT WEB PMT 88213')).length, 1);
  assert.equal(numbered.filter((l) => /W-9/.test(l)).length, 1);
  assert.ok(numbered.some((l) => /Cedar Ridge Dental/.test(l) && /write it off/.test(l)));
  // Clearing an item removes its question.
  const cleared = E.analyze(p, { reviewed: { [r.audit.uncategorized[0].key]: { status: 'ok' } } });
  assert.equal(E.clientQuestions(cleared).count, q.count - 1);
  // Nothing open gives a short all-clear note.
  const none = E.clientQuestions(r, { include: { uncategorized: false, duplicates: false, coding: false, receivables: false, w9: false, unusual: false, receipts: false } });
  assert.equal(none.count, 0);
  assert.ok(/no questions this time/.test(none.text));
});

test('loan readiness: coverage ratio, capacity and proposed loan', () => {
  assert.ok(Math.abs(E.pmt(100000, 0.06, 10) - 1110.21) < 0.01, 'standard amortizing payment');
  const r = E.analyze(E.parseTransactions(S.build()), { chart: E.parseChartOfAccounts(S.chartOfAccounts()), loan: { amount: 60000, rate: 10.5, years: 7, today: '2026-07-20' } });
  const l = r.loan;
  // Twelve monthly payments of $1,150 on the sample's SBA loan.
  assert.ok(Math.abs(l.debtService - 13800) < 0.05);
  assert.ok(Math.abs(l.principal + l.interest - l.debtService) < 0.02);
  assert.ok(Math.abs(l.cashAvailable - (l.netIncome + l.interest + l.nonCash)) < 0.02);
  assert.ok(Math.abs(l.dscr - l.cashAvailable / l.debtService) < 1e-9);
  // The largest loan leaves coverage exactly at the target.
  const withMax = l.cashAvailable / (l.debtService + E.pmt(l.maxLoan, 0.105, 7) * 12);
  assert.ok(Math.abs(withMax - 1.25) < 0.001);
  assert.ok(l.proposal.proForma < 1.25, 'a $60k loan is too much for this cash flow');
  const status = Object.fromEntries(l.checks.map((c) => [c.label, c.status]));
  assert.equal(status['Books are clean'], 'fail');
  assert.equal(status['Financials are current'], 'pass');
  assert.equal(status['No single customer dominates'], 'warn');
});

test('tax set-aside: projection, schedule, S corp check and safe owner pay', () => {
  const r = E.analyze(E.parseTransactions(S.build()), { tax: { today: '2026-07-20' } });
  const t = r.tax;
  assert.equal(t.year, 2026);
  assert.equal(t.ytdMonths, 6);
  assert.ok(Math.abs(t.projectedProfit - (t.ytdProfit + t.monthlyRunRate * 6)) < 0.02);
  assert.ok(Math.abs(t.setAside - t.projectedProfit * 0.3) < 0.02);
  assert.deepEqual(t.schedule.map((q) => q.due), ['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15']);
  assert.deepEqual(t.schedule.map((q) => q.status), ['Past', 'Past', 'Upcoming', 'Upcoming']);
  assert.ok(Math.abs(t.perQuarter * 2 - t.owed) < 0.02);
  assert.ok(t.next.cashCheck && t.next.cashCheck.week <= '2026-09-15');
  // Entering payments already made lowers what is left.
  const paid = E.analyze(E.parseTransactions(S.build()), { tax: { paid: 1000 } }).tax;
  assert.ok(Math.abs(paid.owed - (t.setAside - 1000)) < 0.02);
  // S corp: a small salary against large distributions is flagged.
  const sc = E.analyze(E.parseTransactions(S.build()), { tax: { entity: 'scorp', salary: 10000 } }).tax.scorp;
  assert.equal(sc.status, 'warn');
  assert.equal(sc.distributions, 21000);
  // Safe owner pay respects the cushion.
  const low = E.analyze(E.parseTransactions(S.build()), { cushion: 0 }).tax.ownerPay;
  const high = E.analyze(E.parseTransactions(S.build()), { cushion: 100000 }).tax.ownerPay;
  assert.ok(low.available > 0 && low.shortfall === 0);
  assert.ok(high.available === 0 && high.shortfall > 0);
});

test('Excel serial dates are read as dates', () => {
  assert.equal(E.parseDate('46023').toISOString().slice(0, 10), '2026-01-01');
  assert.equal(E.parseDate('45658.5').toISOString().slice(0, 10), '2025-01-01');
  assert.equal(E.parseDate('12345'), null, 'small numbers are not dates');
});

test('payee cleanup merges bank-feed names without over-merging', () => {
  const k = E.payeeKeyOf;
  assert.equal(k('AMZN Mktp US*2K41'), k('Amazon.com'));
  assert.equal(k('ADOBE *CREATIVE CLD'), k('Adobe Creative Cloud'));
  assert.equal(k('THE HOME DEPOT #4417'), k('The Home Depot'));
  assert.equal(k('TST* BLUE DOOR CAFE'), k('Blue Door Cafe'));
  assert.equal(k('PrintWorks Co.'), k('Printworks Co'));
  assert.equal(k('Uber *Trip'), 'uber');
  assert.notEqual(k('Uber Eats'), k('Uber'));
  assert.notEqual(k('Blue Door Cafe'), k('Blue Bottle Coffee'));
  assert.equal(k('Studio 54 Bar'), 'studio 54 bar', 'short numbers in real names stay');
  assert.equal(E.cleanPayee('POS DEBIT 4471 SQ *MAKERS'), 'MAKERS');
  assert.equal(E.cleanPayee('ACH DEBIT WEB PMT 88213'), '');
  assert.equal(E.payeeOf({ name: '', memo: 'POS DEBIT 4471 SQ *MAKERS' }).key, 'makers', 'the memo names the payee when Name is blank');
  assert.equal(E.payeeOf({ name: '', memo: 'Card purchase' }).key, '');
  const { vendors, subs } = E.analyze(E.parseTransactions(S.build()));
  const adobe = vendors.rows.filter((r) => r.key === 'adobe');
  assert.equal(adobe.length, 1);
  assert.equal(adobe[0].name, 'Adobe Creative Cloud', 'the most common spelling is shown');
  assert.deepEqual(adobe[0].aliases, ['ADOBE *CREATIVE CLD']);
  assert.equal(subs.list.find((x) => x.vendor === 'Adobe Creative Cloud').charges, 18, 'raw-named charges count toward the subscription');
});

test('tie-out to the QuickBooks P&L: ties when right, explains when not', () => {
  const pnl = E.parseProfitAndLoss(S.profitAndLoss());
  assert.ok(pnl && pnl.totals.netIncome != null && pnl.basis === 'accrual');
  assert.equal(E.parseProfitAndLoss(S.build()), null, 'a transaction report is not a P&L');
  assert.equal(E.parseChartOfAccounts(S.profitAndLoss()), null, 'a P&L is not a chart of accounts');
  const p = E.parseTransactions(S.build());
  const good = E.analyze(p, { pnl }).tieOut;
  assert.equal(good.ties, true);
  assert.ok(good.lines.every((l) => l.diff === 0));
  // Misclassify an expense account as balance sheet: the tie-out finds it and says why.
  const bad = E.analyze(p, { pnl, accountClass: { Meals: 'balance' } }).tieOut;
  assert.equal(bad.ties, false);
  const meals = bad.accounts.find((a) => a.name.trim() === 'Meals');
  assert.ok(meals && /balance sheet/i.test(meals.hint));
  // An account on the P&L that the export does not have.
  const extra = E.parseProfitAndLoss(S.profitAndLoss().replace('   Bank Fees,', '   Insurance,"1,200.00"\n   Bank Fees,'));
  const missing = E.analyze(p, { pnl: extra }).tieOut;
  assert.ok(missing.accounts.some((a) => a.name.trim() === 'Insurance' && /Not in the Transaction Detail/.test(a.hint)));
});

test('saved sample files match the generator', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'sample-data');
  assert.equal(fs.readFileSync(path.join(dir, 'harbor-pine-transaction-detail.csv'), 'utf8'), S.build());
  assert.equal(fs.readFileSync(path.join(dir, 'harbor-pine-chart-of-accounts.csv'), 'utf8'), S.chartOfAccounts());
  assert.equal(fs.readFileSync(path.join(dir, 'harbor-pine-profit-and-loss.csv'), 'utf8'), S.profitAndLoss());
  assert.equal(fs.readFileSync(path.join(dir, 'harbor-pine-budget-2026.csv'), 'utf8'), S.budgetOverview());
  assert.equal(fs.readFileSync(path.join(dir, 'harbor-pine-expenses-with-attachments.csv'), 'utf8'), S.expenseList());
});

test('formatted report: owner and full versions, charts, escaping', () => {
  const p = E.parseTransactions(S.build());
  const r = E.analyze(p, { pnl: E.parseProfitAndLoss(S.profitAndLoss()) });
  const owner = E.buildHtmlReport(r, { preparer: 'Test Firm', version: 'owner' });
  const full = E.buildHtmlReport(r, { preparer: 'Test Firm', version: 'full' });
  assert.ok(owner.startsWith('<!doctype html>') && owner.includes('</html>'));
  for (const s of ['How the business is doing', 'Cash over the next 13 weeks', 'What we recommend', 'What we need from you']) assert.ok(owner.includes(s), s);
  assert.equal((owner.match(/<svg /g) || []).length, 2, 'two charts');
  assert.ok(!owner.includes('Profitability by customer'), 'owner summary leaves out the details');
  for (const s of ['Ties to QuickBooks', 'Profitability by customer', 'Customer concentration', 'Break-even', '1099 review', 'Loan readiness', 'Tax set-aside']) assert.ok(full.includes(s), s);
  assert.ok(!/https?:\/\//.test(owner.replace(/https?:\/\/[^"']*w3\.org[^"']*/g, '')), 'self-contained: no external resources');
  // Names from the file are escaped.
  const evil = E.analyze(E.parseTransactions(S.build().replace(/Harbor & Pine Design Co\./, '<script>alert(1)</script>')));
  const doc = E.buildHtmlReport(evil, { version: 'full', clientName: '<img src=x onerror=alert(1)>' });
  assert.ok(!doc.includes('<script>alert') && !doc.includes('<img src=x'));
  assert.ok(doc.includes('&lt;img src=x'));
  // Action items count only open flags.
  const cleared = E.analyze(p, { reviewed: Object.fromEntries(r.audit.uncategorized.map((u) => [u.key, { status: 'ok' }])) });
  assert.ok(!E.nextSteps(cleared).some((s) => /uncategorized items/.test(s)));
});

test('what-if scenarios change the forecast and leave the baseline alone', () => {
  const p = E.parseTransactions(S.build());
  const base = E.analyze(p);
  assert.equal(base.cashScenario, null, 'no scenario, no second forecast');
  const hire = E.analyze(p, { scenario: { levers: [{ type: 'monthly', label: 'New designer', amount: 5000, date: '2026-08-01' }] } });
  assert.equal(hire.cash.totals.ending, base.cash.totals.ending, 'baseline untouched');
  const row = hire.cashScenario.outflowRows.find((r) => r.label === 'New designer');
  assert.equal(row.total, 10000, 'August and September fall inside the 13 weeks');
  assert.ok(Math.abs(hire.cashScenario.totals.ending - (base.cash.totals.ending - 10000)) < 0.02);
  // One-time money in raises every later week.
  const loan = E.analyze(p, { scenario: { levers: [{ type: 'receipt', label: 'Loan', amount: 20000, date: '2026-07-10' }] } }).cashScenario;
  assert.ok(Math.abs(loan.totals.ending - (base.cash.totals.ending + 20000)) < 0.02);
  // Losing a customer removes only their future billing; open invoices still come in.
  const lose = E.analyze(p, { scenario: { levers: [{ type: 'lose', customer: 'Northwind Outfitters' }] } }).cashScenario;
  assert.ok(!lose.newBillings.some((b) => b.customer === 'Northwind Outfitters'));
  assert.ok(lose.totals.inflow < base.cash.totals.inflow);
  // A late payer moves money later; far enough and it leaves the forecast window.
  const late = E.analyze(p, { scenario: { levers: [{ type: 'delay', customer: 'Harborview Hotel', days: 120 }] } }).cashScenario;
  assert.ok(late.ar.openInvoices.filter((i) => i.party === 'Harborview Hotel').every((i) => i.week === null));
  // Sales change scales new billing.
  const down = E.analyze(p, { scenario: { levers: [{ type: 'sales', pct: -50 }] } }).cashScenario;
  const sum = (c) => c.newBillings.reduce((t, b) => t + b.amount, 0);
  assert.ok(Math.abs(sum(down) - sum(base.cash) / 2) < 1);
  // Malformed changes are ignored.
  assert.equal(E.analyze(p, { scenario: { levers: [{ type: 'monthly', amount: 'x' }, { type: 'nope' }] } }).cashScenario, null);
});

test('budget vs actual: uploaded QuickBooks budget and one built from history', () => {
  const b = E.parseBudget(S.budgetOverview());
  assert.equal(b.year, 2026);
  assert.equal(b.months.length, 12);
  assert.equal(E.parseProfitAndLoss(S.budgetOverview()), null, 'a budget is not a P&L');
  assert.equal(E.parseBudget(S.profitAndLoss()), null, 'a P&L is not a budget');
  const p = E.parseTransactions(S.build());
  const v = E.analyze(p, { budget: b }).budget;
  assert.equal(v.source, 'upload');
  assert.equal(v.ytdMonths, 6);
  // Actual year-to-date equals the P&L postings for January to June 2026.
  const trend = E.analyze(p).trend;
  const h1 = trend.months.filter((m) => m.key >= '2026-01' && m.key <= '2026-06');
  assert.ok(Math.abs(v.totals.actualYtd.revenue - h1.reduce((t, m) => t + m.revenue, 0)) < 0.05);
  assert.ok(Math.abs(v.totals.actualYtd.netIncome - h1.reduce((t, m) => t + m.netIncome, 0)) < 0.05);
  const wages = v.rows.find((r) => r.name.includes('Wages'));
  assert.equal(wages.favorable, false, 'costs over budget are unfavorable');
  const income = v.rows.find((r) => r.name.includes('Design Services'));
  assert.equal(income.favorable, true, 'income over budget is favorable');
  assert.ok(v.rows.some((r) => r.unbudgeted && /Uncategorized/.test(r.name)));
  assert.ok(Math.abs(v.outlook.netIncome - (v.totals.actualYtd.netIncome + (v.totals.fullYear.netIncome - v.totals.budgetYtd.netIncome))) < 0.05);
  // Built from last year: same month a year earlier, grown by the rates given.
  const hist = E.analyze(p, { budgetGrowth: { revenueGrowth: 10, costGrowth: 0 } }).budget;
  assert.equal(hist.source, 'history');
  const jan25 = trend.months.find((m) => m.key === '2025-01');
  const janBudget = hist.monthly.find((m) => m.month === '2026-01');
  assert.ok(Math.abs(janBudget.budgetRevenue - jan25.revenue * 1.1) < 0.1);
});

test('unusual activity: account swings and payments out of pattern', () => {
  const p = E.parseTransactions(S.build());
  const r = E.analyze(p);
  const u = r.unusual;
  assert.equal(u.month, '2026-06');
  assert.ok(u.flux.some((f) => f.account === 'Advertising & Marketing' && f.up && f.concern));
  assert.ok(!u.flux.some((f) => /uncategorized|ask my accountant/i.test(f.account)), 'holding accounts are already on the audit list');
  const comcast = u.txns.find((t) => /Comcast/.test(t.detail));
  assert.ok(comcast && comcast.kind === 'Out of pattern', 'a one-off bill far above a steady vendor');
  assert.ok(!u.txns.some((t) => /PrintWorks/.test(t.detail)), 'a vendor with two regular bill sizes is not flagged');
  assert.ok(u.txns.some((t) => t.kind === 'New payee' && /Coastal Business Expo/.test(t.detail)));
  // Reviewing an item carries through, and the question drops out.
  const q = E.clientQuestions(r);
  assert.ok(q.sections.some((s) => s.title === 'Unusual payments'));
  const done = E.analyze(p, { reviewed: Object.fromEntries(u.txns.map((t) => [t.key, { status: 'ok' }])) });
  assert.ok(done.unusual.txns.every((t) => t.review && t.review.status === 'ok'));
  assert.ok(!E.clientQuestions(done).sections.some((s) => s.title === 'Unusual payments'));
});

test('vendor price increases: steady charges that went up, and the price rise to cover them', () => {
  const r = E.analyze(E.parseTransactions(S.build()));
  const p = r.vendors.prices;
  const by = Object.fromEntries(p.rows.map((x) => [x.name, x]));
  assert.deepEqual(Object.keys(by).sort(), ['Adobe Creative Cloud', 'Brightline Properties', 'Google Workspace', 'Slack Technologies']);
  assert.equal(by['Brightline Properties'].from, 3000);
  assert.equal(by['Brightline Properties'].to, 3200);
  assert.equal(by['Brightline Properties'].annualImpact, 2400);
  assert.equal(by['Adobe Creative Cloud'].since, '2026-04-02');
  assert.ok(!by['PrintWorks Co.'], 'amounts that vary job to job are not a price');
  assert.equal(p.annualIncrease, 2841);
  assert.ok(Math.abs(p.priceRiseToHold - p.annualIncrease / p.annualRevenue) < 1e-9);
  const text = E.buildReport(r);
  assert.ok(text.includes('Price increases from vendors'));
  assert.ok(E.buildHtmlReport(r, { version: 'full' }).includes('Vendor price increases'));
  assert.ok(E.nextSteps(r).some((s) => /price increases add/i.test(s)));
});

test('firm branding on reports: name, website, logo, and only inline images', () => {
  const r = E.analyze(E.parseTransactions(S.build()));
  const logo = 'data:image/png;base64,iVBORw0KGgo=';
  const firm = { name: '7D Business Solutions', website: 'www.7dbusinesssolutions.com', color: '#2b4c1c', color2: '#8a7126', logo };
  const doc = E.buildHtmlReport(r, { firm, preparer: 'Jordan Lee' });
  assert.ok(doc.includes('<div class="brand">7D Business Solutions</div>'));
  assert.ok(doc.includes(`<img class="logo" src="${logo}"`));
  assert.ok(doc.includes('href="https://www.7dbusinesssolutions.com"'));
  assert.ok(doc.includes('Jordan Lee, 7D Business Solutions'));
  assert.ok(doc.includes('border-bottom: 3px solid #2b4c1c'));
  // Anything but an inline image is dropped, and bad colors fall back.
  const bad = E.buildHtmlReport(r, { firm: { ...firm, logo: 'https://evil.example/x.png', color: 'red;}' } });
  assert.ok(!bad.includes('evil.example'));
  assert.ok(!bad.includes('red;}'));
  const text = E.buildReport(r, { firm, preparer: 'Jordan Lee' });
  assert.ok(text.includes('by Jordan Lee, 7D Business Solutions'));
  assert.ok(text.includes('www.7dbusinesssolutions.com'));
  const q = E.clientQuestions(r, { firm });
  assert.ok(q.text.trim().endsWith('7D Business Solutions\nwww.7dbusinesssolutions.com'));
});

test('balance sheet check: undeposited funds, opening balance equity, credits, wrong signs, old bills', () => {
  const p = E.parseTransactions(S.build());
  const r = E.analyze(p, { chart: E.parseChartOfAccounts(S.chartOfAccounts()) });
  const bs = r.balanceSheet;
  assert.ok(bs.available);
  const kinds = bs.items.map((i) => i.kind);
  assert.deepEqual(kinds.slice(0, 2).sort(), ['Opening Balance Equity', 'Undeposited Funds']);
  const uf = bs.items.find((i) => i.kind === 'Undeposited Funds');
  assert.equal(uf.amount, 2400);
  assert.match(uf.detail, /since Jun 12, 2026/);
  assert.equal(bs.items.find((i) => i.kind === 'Opening Balance Equity').amount, 2150);
  assert.ok(bs.items.some((i) => i.kind === 'Customer credit' && i.account === 'Summit Fitness' && i.amount === -2400));
  assert.ok(bs.items.some((i) => i.kind === 'Old open bill' && /B2603-1/.test(i.detail)));
  assert.ok(!kinds.includes('Wrong-sign balance'), "owner's draw runs negative by nature and is not flagged");
  assert.equal(bs.balances.find((b) => b.account === 'SBA Loan').balance, 31859.45, 'loan paid down from 48,000');
  // A wrong sign on a loan, and an export that is not grouped by account.
  const csv = ['Co', 'Transaction Detail by Account', '', ',Date,Transaction Type,Num,Name,Memo/Description,Split,Amount,Balance',
    'Equipment Loan', ',Beginning Balance,,,,,,,1000.00', ',01/05/2026,Check,101,Bank,Payment,Checking,-1500.00,-500.00', 'Total for Equipment Loan,,,,,,,-500.00',
    'Checking', ',01/05/2026,Check,101,Bank,Payment,Equipment Loan,-1500.00,-1500.00', 'Total for Checking,,,,,,,-1500.00'].join('\n');
  const loan = E.analyze(E.parseTransactions(csv)).balanceSheet;
  assert.ok(loan.items.some((i) => i.kind === 'Wrong-sign balance' && i.account === 'Equipment Loan' && i.severity === 'High'));
  const flat = E.analyze(E.parseTransactions(['Date,Transaction Type,Name,Account,Amount', '01/05/2026,Expense,Staples,Office Supplies,20.00'].join('\n'))).balanceSheet;
  assert.equal(flat.available, false);
  // Review marks carry through.
  const again = E.analyze(p, { reviewed: { [uf.key]: { status: 'fixed' } } }).balanceSheet;
  assert.equal(again.items.find((i) => i.key === uf.key).review.status, 'fixed');
  assert.equal(again.open, bs.open - 1);
});

test('closed months: edits, deletions and backdated entries are caught; uncovered months are skipped', () => {
  const csv = S.build();
  const snap = E.analyze(E.parseTransactions(csv)).closeBooks('2026-05');
  assert.equal(snap.through, '2026-05');
  assert.equal(Object.keys(snap.months).length, 17);
  assert.ok(JSON.stringify(snap).length < 40000, 'small enough to keep with the client');
  assert.equal(E.analyze(E.parseTransactions(csv), { closed: snap }).closed.changedMonths, 0);
  let lines = csv.split('\n');
  lines = lines.map((l) => (l.includes('03/20/2026') && l.includes('Studio supplies') ? l.replace(',100.19,', ',150.19,') : l));
  lines = lines.filter((l) => !(l.includes('04/09/2026') && l.includes('Client lunch')));
  const c = E.analyze(E.parseTransactions(lines.join('\n')), { closed: snap }).closed;
  assert.equal(c.changedMonths, 2);
  const mar = c.months.find((m) => m.month === '2026-03');
  assert.equal(mar.added.length, 1);
  assert.equal(mar.added[0].amount, 150.19);
  assert.deepEqual(mar.accounts, [{ account: 'Office Supplies', was: 100.19, now: 150.19, diff: 50 }]);
  const apr = c.months.find((m) => m.month === '2026-04');
  assert.equal(apr.removed, 1);
  assert.equal(apr.added.length, 0);
  // June is after the close and never compared.
  assert.ok(!c.months.some((m) => m.month === '2026-06'));
  const short = csv.split('\n').filter((l) => !/\/2025,/.test(l)).join('\n');
  const s = E.analyze(E.parseTransactions(short), { closed: snap }).closed;
  assert.equal(s.changedMonths, 0, 'a shorter export is not deleted history');
  assert.equal(s.skippedMonths, 12);
});

test('job costing gaps: untagged job costs, costs never billed, with a suggested job', () => {
  const r = E.analyze(E.parseTransactions(S.build()));
  const j = r.jobCosts;
  assert.equal(j.mode, 'tracked');
  assert.equal(j.untaggedTotal, 2100);
  assert.equal(j.items.length, 2);
  const metro = j.items.find((i) => /Metro Sign/.test(i.vendor));
  assert.equal(metro.suggestion, 'Harborview Hotel', 'this vendor only works on one job');
  assert.equal(j.items.find((i) => /PrintWorks/.test(i.vendor)).suggestion, null, 'two jobs, no guess');
  assert.ok(j.jobs.some((x) => x.kind === 'Costs, no billing' && x.name === 'Pinecrest Winery' && x.cost === 1800));
  // A business that never tags costs gets a note instead of a list.
  const csv = ['Date,Transaction Type,Name,Customer,Account,Amount', '01/05/2026,Invoice,Acme,Acme,Sales,5000.00', '01/06/2026,Bill,Supplier,,Cost of Goods Sold,2000.00'].join('\n');
  assert.equal(E.analyze(E.parseTransactions(csv)).jobCosts.mode, 'untracked');
});

test('month-end checklist: automatic steps, hand ticks, custom steps, and the client summary', () => {
  const r = E.analyze(E.parseTransactions(S.build()), { pnl: E.parseProfitAndLoss(S.profitAndLoss()) });
  const c = E.closeChecklist(r, '2026-06', { done: { feeds: '2026-07-02', uncategorized: '2026-07-03' } }, [{ id: 'c1', label: 'Reconcile PayPal' }]);
  const by = Object.fromEntries(c.items.map((i) => [i.id, i]));
  assert.equal(by.tieout.done, true, 'ties, so it ticks itself');
  assert.equal(by.balance.done, false);
  assert.match(by.balance.auto.note, /4 to fix/);
  assert.equal(by.uncategorized.done, true, 'a hand tick overrides open items');
  assert.equal(by.c1.custom, true);
  assert.ok(!by.salestax, 'no sales tax account, no sales tax step');
  assert.equal(c.done, 3);
  assert.equal(c.total, c.items.length);
  // Closing the books through the month ticks the "closed" step.
  const snap = r.closeBooks('2026-06');
  const closed = E.analyze(E.parseTransactions(S.build()), { closed: snap });
  assert.equal(E.closeChecklist(closed, '2026-06', {}).items.find((i) => i.id === 'closed').done, true);
  const s = E.clientSummary(r, { '2026-06': { done: { feeds: '2026-07-02' } } }, []);
  assert.equal(s.periodEnd, '2026-06-30');
  assert.equal(s.open.uncategorized, 11);
  assert.equal(s.open.balance, 4);
  assert.equal(s.close.month, '2026-06');
  assert.equal(s.close.done, 2);
  assert.equal(s.months12, 12);
  assert.ok(JSON.stringify(s).length < 1000, 'small enough to keep per client');
});

test('receipts: IRS categories, one-off large purchases, firm limit, attachment status', () => {
  const p = E.parseTransactions(S.build());
  const plain = E.analyze(p).receipts;
  assert.equal(plain.hasAttachmentData, false);
  assert.ok(plain.items.length > 0 && plain.items.every((i) => i.rule === 'Meals' && i.amount >= 75), 'meals of $75 or more');
  assert.ok(plain.items.every((i) => i.status === 'Unknown'));
  assert.ok(!plain.items.some((i) => /Brightline/.test(i.name)), 'rent repeats every month: no receipt each time');
  assert.ok(!plain.items.some((i) => i.type === 'Bill'), 'bills are entered from the vendor invoice');
  // The Expenses page export tells which have a receipt attached.
  const att = E.parseAttachmentList(S.expenseList());
  assert.equal(E.parseAttachmentList(S.build()), null, 'a transaction report is not an attachment list');
  const r = E.analyze(p, { attachments: att.entries });
  assert.equal(r.receipts.source, 'list');
  assert.equal(r.receipts.counts.missing, 4);
  assert.equal(r.receipts.open, 4);
  // A firm limit adds one-off purchases over it.
  assert.ok(E.analyze(p, { receiptLimit: 500 }).receipts.items.some((i) => i.rule === 'Over your limit'));
  // An Attachments column in the transaction export itself is read directly.
  const csv = ['Date,Transaction Type,Name,Account,Amount,Attachments', '03/02/2026,Expense,Marriott,Travel - Lodging,48.00,0', '03/03/2026,Expense,Delta,Travel,420.00,1', '03/04/2026,Expense,Cafe,Meals,40.00,'].join('\n');
  const col = E.analyze(E.parseTransactions(csv)).receipts;
  assert.equal(col.source, 'export');
  assert.deepEqual(col.items.map((i) => [i.name, i.rule, i.status]).sort(), [['Delta', 'Travel', 'Attached'], ['Marriott', 'Lodging', 'Missing']]);
  // Missing receipts become client questions.
  assert.ok(E.clientQuestions(r).sections.some((x) => x.title === 'Receipts we need' && x.items.length === 4));
});

test('client answers: spreadsheet out, answers back, matched by reference', () => {
  const p = E.parseTransactions(S.build());
  const att = E.parseAttachmentList(S.expenseList()).entries;
  const r = E.analyze(p, { attachments: att });
  const q = E.clientQuestions(r);
  const sheet = E.questionsSheet(q);
  const lines = sheet.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines[0], 'Ref,Topic,Date,Payee,Amount,Question,Your answer,Receipt sent? (Yes/No)');
  assert.equal(lines.length - 1, q.rows.length);
  assert.equal(new Set(q.rows.map((x) => x.ref)).size, q.rows.length, 'every reference is unique');
  assert.equal(E.clientQuestions(E.analyze(p, { attachments: att })).rows[0].ref, q.rows[0].ref, 'references are stable');
  // The client fills in two rows (one with a comma and quotes) and marks a receipt sent.
  const iUnc = 1, iRec = lines.findIndex((l) => l.includes('Receipts we need'));
  lines[iUnc] = lines[iUnc].replace(/,,$/, ',"Printer, for the ""studio""",');
  lines[iRec] = lines[iRec].replace(/,,$/, ',,Yes');
  const parsed = E.parseAnswers(lines.join('\n'));
  assert.equal(parsed.answers.length, 2);
  assert.equal(parsed.answers[0].answer, 'Printer, for the "studio"');
  assert.equal(E.parseAnswers(S.build()), null);
  const m = E.matchAnswers(r, parsed);
  assert.equal(m.matched.length, 2);
  assert.deepEqual(m.unmatched, []);
  const answers = Object.fromEntries(m.matched.map((a) => [a.key, { ...a, at: '2026-07-05' }]));
  const after = E.analyze(p, { attachments: att, answers });
  assert.equal(after.receipts.counts.sent, 1);
  assert.equal(after.receipts.open, 3);
  assert.equal(after.answers.length, 2);
  assert.equal(E.clientQuestions(after, { answers }).rows.length, q.rows.length - 2, 'answered questions are not asked again');
  // A reference from another file does not match.
  assert.deepEqual(E.matchAnswers(r, { answers: [{ ref: 'Q-ZZZZZZ', answer: 'x', receipt: false }] }).unmatched, ['Q-ZZZZZZ']);
});

test('readExport recognizes each QuickBooks report', () => {
  const read = (f) => E.readExport(fs.readFileSync(path.join(__dirname, '..', 'sample-data', f), 'utf8')).kind;
  assert.equal(read('harbor-pine-transaction-detail.csv'), 'parsed');
  assert.equal(read('harbor-pine-chart-of-accounts.csv'), 'chart');
  assert.equal(read('harbor-pine-profit-and-loss.csv'), 'pnl');
  assert.equal(read('harbor-pine-budget-2026.csv'), 'budget');
  assert.equal(read('harbor-pine-expenses-with-attachments.csv'), 'attachments');
  assert.throws(() => E.readExport('Date,Amount\n'), /no dated transactions/);
});

test('lender package: statements, ratios, payroll checks, and a report without review notes by default', () => {
  const load = (name) => {
    const dir = path.join(__dirname, '..', 'sample-data', name.startsWith('harbor') ? '' : 'test-clients');
    const read = (f) => fs.readFileSync(path.join(dir, `${name}-${f}.csv`), 'utf8');
    return E.analyze(E.parseTransactions(read('transaction-detail')), { chart: E.parseChartOfAccounts(read('chart-of-accounts')), loan: { amount: 150000, rate: 10.5, years: 10 } });
  };
  const rb = load('riverbend');
  const L = rb.lender;
  assert.deepEqual(L.statement.columns.map((c) => c.label), ['2025', '2026 (8 mo)', 'Last 12 months']);
  // The statement adds up.
  for (const c of L.statement.columns) assert.ok(Math.abs(L.statement.totals.income[c.key] - L.statement.totals.cogs[c.key] - L.statement.totals.expenses[c.key] - L.statement.totals.net[c.key]) < 1);
  assert.ok(L.ratios.current > 2 && L.ratios.current < 4, `current ${L.ratios.current}`);
  assert.equal(L.balance.longTerm[0].account, 'Ford Credit Truck Loan');
  assert.ok(Math.abs(L.payroll.taxRate - 0.0765) < 0.001);
  // Riverbend's payroll lines up; its balance sheet problems are listed.
  assert.ok(!L.issues.some((x) => /payroll/i.test(x.title)), L.issues.map((x) => x.title).join('; '));
  assert.ok(L.issues.some((x) => x.title === 'Undeposited Funds'));
  assert.ok(L.issues.some((x) => /Sales Tax Payable/.test(x.title)));
  // Harbor & Pine records wages through Gusto with no employer payroll taxes.
  const hp = load('harbor-pine');
  const pay = hp.lender.issues.find((x) => x.title === 'Wages without employer payroll taxes');
  assert.ok(pay && pay.severity === 'high');
  assert.equal(hp.lender.issues[0].severity, 'high');
  // The report: key measures, the request, statements; review notes only when asked.
  const opts = { firm: { name: '7D Business Solutions' }, request: { amount: 150000, purpose: 'Second truck', lender: 'First Community Bank' } };
  const doc = E.buildLenderReport(rb, opts);
  for (const s of ['Key measures lenders test', 'Debt service coverage', 'Coverage with the new loan', 'Income statement', 'Balance summary', 'Debt schedule', 'First Community Bank', 'without audit or review']) assert.ok(doc.includes(s), s);
  assert.ok(!doc.includes('Review notes'));
  assert.ok(E.buildLenderReport(rb, { ...opts, includeReview: true }).includes('Review notes (not for the lender)'));
  assert.equal(E.lenderRead('dscr', 1.3), 'Meets');
  assert.equal(E.lenderRead('dscr', 1.15), 'Borderline');
  assert.equal(E.lenderRead('leverage', 5), 'Below');
});

test('landscaping: industry is detected from names, and only landscapers get its checks', () => {
  assert.equal(E.detectIndustry({ company: 'Greenway Landscape Co.' }, []), 'landscaping');
  assert.equal(E.detectIndustry({ company: 'Acme LLC' }, ['Snow Removal', 'Irrigation Services', 'Rent']), 'landscaping');
  assert.equal(E.detectIndustry({ company: 'Harbor & Pine Studio' }, ['Design Income', 'Rent']), 'general');
  const r = E.analyze(E.parseTransactions(S.build()));
  assert.equal(r.industry, 'general');
  assert.equal(r.landscape, undefined);
  assert.ok(!E.closeChecklist(r, r.closableMonths[r.closableMonths.length - 1], {}, []).items.some((i) => i.id === 'fuelcard'));
  const forced = E.analyze(E.parseTransactions(S.build()), { industry: 'landscaping' });
  assert.ok(forced.landscape);
  assert.ok(E.closeChecklist(forced, forced.closableMonths[forced.closableMonths.length - 1], {}, []).items.some((i) => i.id === 'fuelcard'));
});

test('landscaping: a contract with a yearly price step is still a contract, and a gap is a missed invoice', () => {
  const rows = [];
  const months = [];
  for (let y = 2024; y <= 2026; y++) for (let m = 1; m <= 12; m++) if (y < 2026 || m <= 8) months.push([y, m]);
  for (const [y, m] of months) {
    const d = `${String(m).padStart(2, '0')}/01/${y}`;
    const price = y === 2024 ? 1000 : y === 2025 ? 1040 : 1090;
    if (!(y === 2026 && m === 7)) rows.push(['Invoice', d, 'Oak HOA', 'Grounds maintenance', 'Maintenance Contracts', price]);
    rows.push(['Invoice', d, 'Pine HOA', 'Grounds maintenance', 'Maintenance Contracts', 800]);
    rows.push(['Expense', d, 'Shell', 'Fuel', 'Fuel', 300]);
  }
  const csv = ['Leafy Lawn Care', 'Transaction Detail by Account', '', 'Date,Transaction Type,Num,Name,Memo/Description,Account,Split,Amount',
    ...rows.map(([type, d, name, memo, acct, amt]) => `${d},${type},,${name},${memo},${acct},Checking,${amt}`)].join('\n');
  const r = E.analyze(E.parseTransactions(csv), { accountClass: { 'Maintenance Contracts': 'income' } });
  assert.equal(r.industry, 'landscaping');
  const L = r.landscape;
  assert.deepEqual(L.contracts.missed.map((m) => [m.name, m.month]), [['Oak HOA', '2026-07']]);
  assert.deepEqual(L.contracts.stale.map((m) => m.name), ['Pine HOA']);
});

test('fixed assets: MACRS follows the IRS tables, with bonus, Section 179 and the mid-quarter rule', () => {
  const round = (n) => Math.round(n * 100) / 100;
  const pct = (life, q) => E.macrsRates(life, q).map((r) => Math.round(r * 10000) / 100);
  assert.deepEqual(pct(5), [20, 32, 19.2, 11.52, 11.52, 5.76]);
  assert.deepEqual(pct(7), [14.29, 24.49, 17.49, 12.49, 8.93, 8.92, 8.93, 4.46]);
  assert.deepEqual(pct(7, 4), [3.57, 27.55, 19.68, 14.06, 10.04, 8.73, 8.73, 7.64]);
  for (const life of [3, 5, 7, 10, 15, 20]) assert.ok(Math.abs(E.macrsRates(life).reduce((t, r) => t + r, 0) - 1) < 1e-9, `${life}-year adds to 100%`);
  const s = E.assetSchedule([
    { id: 'a', name: 'Mower', date: '2025-03-10', cost: 10000, category: 'equipment', taxMethod: 'macrs' },
    { id: 'b', name: 'Truck', date: '2025-06-01', cost: 40000, category: 'vehicle', taxMethod: 'bonus' },
    { id: 'c', name: 'Laptop', date: '2025-02-01', cost: 2000, category: 'computer', taxMethod: 's179' },
    { id: 'd', name: 'Shop', date: '2025-01-15', cost: 390000, category: 'building' },
    { id: 'e', name: 'Lot', date: '2025-01-15', cost: 100000, category: 'land' },
  ], { asOf: '2025-12' });
  const row = (id) => s.rows.find((r) => r.id === id);
  assert.equal(row('a').taxByYear[2025], 1429);
  assert.equal(row('a').bookByYear[2025], round(10000 / 84 * 10));
  assert.equal(row('b').taxByYear[2025], 40000, '100% bonus after January 19, 2025');
  assert.equal(row('b').taxByYear[2026], undefined);
  assert.equal(row('c').taxByYear[2025], 2000);
  assert.equal(row('d').taxByYear[2025], round(390000 / 39 * 11.5 / 12), '39-year mid-month');
  assert.equal(row('e').method, 'none');
  assert.equal(row('e').accumulated, 0);
  assert.deepEqual(s.midQuarterYears, []);
  // Most of a year's equipment bought in the fourth quarter: mid-quarter for all of that year's.
  const mq = E.assetSchedule([
    { id: 'x', name: 'Skid steer', date: '2024-11-05', cost: 60000, category: 'equipment' },
    { id: 'y', name: 'Trimmer', date: '2024-04-05', cost: 5000, category: 'equipment' },
  ], { asOf: '2024-12' });
  assert.deepEqual(mq.midQuarterYears, [2024]);
  assert.equal(mq.rows.find((r) => r.id === 'x').taxByYear[2024], 2142);
  assert.equal(mq.rows.find((r) => r.id === 'y').taxByYear[2024], 892.5);
  assert.equal(E.defaultBonus('2024-06-01'), 60);
  assert.equal(E.defaultBonus('2025-01-10'), 40);
});

test('fixed assets: disposal stops depreciation, and the journal entry imports into QuickBooks', () => {
  const s = E.assetSchedule([{ id: 'a', name: 'Van', date: '2024-01-15', cost: 30000, category: 'vehicle', bookLife: 5, salvage: 6000, disposed: '2025-07-01', salePrice: 20000 }], { asOf: '2025-12' });
  const r = s.rows[0];
  assert.equal(r.accumulated, 400 * 18, '$400 a month for January 2024 to June 2025');
  assert.equal(r.disposal.gain, 20000 - (30000 - 7200));
  assert.equal(r.taxByYear[2025], 30000 * 0.32 / 2);
  assert.equal(r.taxByYear[2026], undefined);
  const live = E.assetSchedule([{ id: 'a', name: 'Van', date: '2024-01-15', cost: 30000, category: 'vehicle', bookLife: 5, salvage: 6000 }], { asOf: '2025-12' });
  const je = E.depreciationEntry(live, '2025-03', { expense: 'Depreciation', accumulated: 'Accumulated Depreciation' });
  assert.equal(je.total, 400);
  assert.equal(je.csv, 'Journal No.,Journal Date,Account Name,Debits,Credits,Description\nDEP-202503,03/31/2025,Depreciation,400.00,,Depreciation March 2025\nDEP-202503,03/31/2025,Accumulated Depreciation,,400.00,Depreciation March 2025');
  assert.equal(E.depreciationEntry(live, '2025').total, 4800);
  const list = E.parseAssetList('Asset,Date Placed in Service,Cost,Category,Method\n2023 Ford F-250,03/15/2023,"$52,400.00",Vehicle,Section 179\nOffice desks,2024-06-01,3200,,MACRS\nBad row,,100,,');
  assert.equal(list.length, 2);
  assert.deepEqual([list[0].name, list[0].date, list[0].cost, list[0].category, list[0].taxMethod], ['2023 Ford F-250', '2023-03-15', 52400, 'vehicle', 's179']);
  assert.equal(list[1].category, 'furniture');
  assert.equal(E.parseAssetList('Date,Amount\n01/01/2025,5'), null);
});

test('customer addresses: both QuickBooks formats are read, and addresses reduce to a street', () => {
  const report = E.readExport('Acme Lawn\nCustomer Contact List\nAll Dates\n\nCustomer,Phone Numbers,Email,Full Name,Billing Address,Shipping Address\nAdams Residence,555,,,"1412 Oak Ridge Drive\nSpringfield, IL 62704",\nOak HOA,,,,"c/o Summit Mgmt, 400 S 5th St Ste 210, Springfield, IL 62701","1 Oak Hills Pkwy, Springfield, IL 62711"\n');
  assert.equal(report.kind, 'customers');
  const [adams, hoa] = report.data.customers;
  assert.deepEqual([adams.billing.street, adams.billing.city, adams.billing.zip], ['1412 Oak Ridge Drive', 'Springfield', '62704']);
  assert.equal(hoa.billing.office, true);
  assert.equal(hoa.shipping.zip, '62711');
  const exported = E.parseCustomerList('Name,Company name,Street Address,City,State,Zip,Phone\nCole Residence,,22 Oak Ridge Dr. Apt 4,Springfield,IL,62704,555');
  assert.equal(exported.customers[0].billing.zip, '62704');
  assert.equal(E.streetKey(exported.customers[0].billing.street), E.streetKey(adams.billing.street));
  assert.equal(E.streetKey('12 North Main Street'), 'n main st');
  assert.equal(E.parseCustomerList('Date,Name,Amount\n01/01/2025,Cole,5'), null);
});
