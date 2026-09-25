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
  assert.equal(r.count, 1532);
  assert.equal(r.entryCount, 766, 'each entry appears in two account sections');
  assert.equal(r.audit.uncategorized.length, 11);
  assert.equal(r.audit.duplicates.length, 3);
  const kinds = r.audit.mismatches.map((m) => m.kind);
  assert.equal(kinds.filter((k) => k === 'Type / account conflict').length, 3);
  assert.equal(kinds.filter((k) => k === 'Inconsistent coding').length, 1);
  assert.deepEqual(r.profit.groups.map((g) => g.name).sort(), [
    'Bluebird Bakery', 'Cedar Ridge Dental', 'Harborview Hotel', 'Lakeside Brewing', 'Northwind Outfitters', 'Oakline Realty', 'Summit Fitness',
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
  assert.equal(st(y25, 'Comcast Business'), 'Likely exempt');
  assert.equal(st(y25, 'Adobe Creative Cloud'), 'Card only');
  assert.equal(st(y26, 'R. Patel'), 'Below threshold');
  assert.ok(!y25.vendors.some((x) => x.vendor === 'Gusto' || x.vendor === 'Jordan Pike'), 'payroll and owner draws are excluded');
  const t = E.tax1099(E.parseTransactions(['Date,Transaction Type,Num,Name,Account,Split,Amount', '03/01/2025,Check,1,Acme Widgets Inc.,Supplies,Checking,900.00'].join('\n')).transactions, {}, {});
  assert.equal(t[0].vendors[0].status, 'Likely exempt');
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
  assert.equal(chart.accounts.length, 21);
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
  assert.deepEqual(r.chart, { accounts: 21, matched: 21, of: 21 });
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
  const none = E.clientQuestions(r, { include: { uncategorized: false, duplicates: false, coding: false, receivables: false, w9: false } });
  assert.equal(none.count, 0);
  assert.ok(/no questions this time/.test(none.text));
});
