const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/statement-reports');

const profit = (month, labor, supplies, margin, profit) =>
  `Oak Services
Profit and Loss
${month} 2026
Accrual Basis
,Total
Income
Sales,10000
Total Income,10000
Cost of Goods Sold
Labor,${labor}
Total Cost of Goods Sold,${labor}
Gross Profit,${margin}
Expenses
Supplies,${supplies}
Total Expenses,${supplies}
Net Income,${profit}`;
const balance = (day, cash) => `Oak Services
Balance Sheet
As of ${day}
,Total
ASSETS
Bank Accounts
Checking,${cash}
Total Bank Accounts,${cash}
TOTAL ASSETS,${cash}
LIABILITIES AND EQUITY
Total Liabilities and Equity,${cash}`;

test('executive brief uses cash flow sections, gross margin and signed month-over-month changes', () => {
  const report = R.fromUploads({
    period: '2026-02', current: profit('February', 5200, 1100, 4800, 3700), prior: profit('January', 4000, 600, 6000, 5400),
    balance: balance('February 28 2026', 6000), priorBalance: balance('January 31 2026', 7000),
    cashFlow: 'Net cash provided by operating activities,1500\nNet cash used in investing activities,(2000)\nNet cash used in financing activities,-500',
  });
  assert.equal(report.profit, 3700);
  assert.ok(Math.abs(report.marginDelta + 0.12) < 1e-10);
  assert.equal(report.profitDelta, -1700);
  assert.equal(report.cashDelta, -1000);
  assert.deepEqual(report.flows.map((x) => x.amount), [1500, -2000, -500]);
  assert.deepEqual(report.anomalies.map((x) => [x.name, x.amount]), [['Labor', 1200], ['Supplies', 500]]);
  assert.equal(report.actions.length, 3);
});

test('report rejects mismatched statement dates and leaves unavailable cash movement blank', () => {
  const fields = { period: '2026-02', current: profit('February', 5200, 1100, 4800, 3700), balance: balance('February 28 2026', 6000) };
  const result = R.fromUploads(fields);
  assert.deepEqual(result.flows, []);
  assert.equal(result.cashDelta, null);
  assert.throws(() => R.fromUploads({ ...fields, balance: balance('January 31 2026', 7000) }), /month-end/);
});

test('trial balance grader applies normal signs and exclusions without exposing account names', () => {
  const trial = `Trial Balance
Account,Account Type,Debit,Credit
Bank 1001,Bank,,300
Trade Payable,Accounts Payable,80,
Accumulated Depreciation,Fixed Asset,,500
Ask My Accountant,Expenses,1500,
Total,,1580,800`;
  const report = R.cleanupScore(R.trialCsv(trial));
  assert.equal(report.odd, 2);
  assert.equal(report.tested, 2);
  assert.equal(report.holding, 1);
  assert.equal(report.holdingTotal, 1500);
  assert.equal(report.monthsBehind, null);
  assert.doesNotMatch(JSON.stringify(report), /Bank 1001|Trade Payable/);
});

test('QBO operating cash adds net income and the operating adjustments subtotal', () => {
  const col = (label, value) => [{ value: label }, { value }];
  const flows = R.qboRows({ Rows: { Row: [{ type: 'Section', group: 'OperatingActivities',
    Header: { ColData: col('OPERATING ACTIVITIES', '') },
    Rows: { Row: [{ type: 'Data', group: 'NetIncome', ColData: col('Net Income', '600') }] },
    Summary: { ColData: col('Total Adjustments to reconcile Net Income to Net Cash provided by operations:', '-110') },
  }] } });
  const brief = R.executiveBrief({ period: '2026-02', current: { totals: { netIncome: 600 } }, cashFlow: flows });
  assert.deepEqual(brief.flows, [{ label: 'Day-to-day operations', amount: 490 }]);
});
