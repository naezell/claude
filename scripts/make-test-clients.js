#!/usr/bin/env node
/* Builds two fictional test clients, different from the built-in sample, to try the app on:
   Riverbend Plumbing & Heating (a contractor with job costing, sales tax, payroll and a truck
   loan) and Bloom & Basil Cafe (daily sales, food suppliers, catering invoices). Each client
   gets the QuickBooks exports the app reads, with known problems planted in them; see
   sample-data/test-clients/README.md for what each one should turn up.
   Deterministic: the same files every run.  Usage: node scripts/make-test-clients.js */
'use strict';
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'sample-data', 'test-clients');

// ------------------------------------------------------------------ shared machinery

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pad2 = (n) => String(n).padStart(2, '0');
const r2 = (n) => Math.round(n * 100) / 100;

// Account types decide which side is the normal balance. QuickBooks' Transaction Detail by
// Account shows each account's rows in that account's normal sign, so an expense is positive
// in the expense section and negative in the bank section it was paid from.
const DEBIT_NORMAL = new Set(['bank', 'ar', 'asset', 'fixed', 'expense', 'cogs']);

function book(company, accounts, opts) {
  const entries = [];
  const add = (e) => entries.push(e);
  // A two-sided entry: debit one account, credit another.
  const post = (date, type, num, name, customer, memo, dr, cr, amount, extra) => add({ date, type, num, name, customer, memo, dr, cr, amount: r2(amount), ...(extra || {}) });
  return { company, accounts, entries, add, post, opts: opts || {} };
}

const q = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const mdY = (iso) => { const [y, m, d] = iso.split('-'); return `${m}/${d}/${y}`; };
const money = (n) => n.toFixed(2);

function transactionDetail(b, openings, period, withClass, footerDate) {
  const sections = new Map();
  const push = (acct, row) => {
    if (!b.accounts[acct]) throw new Error(`Unknown account ${acct}`);
    if (!sections.has(acct)) sections.set(acct, []);
    sections.get(acct).push(row);
  };
  for (const e of b.entries) {
    const base = { date: e.date, type: e.type, num: e.num || '', name: e.name || '', customer: e.customer || '', memo: e.memo || '', cls: e.cls || '' };
    const dSign = DEBIT_NORMAL.has(b.accounts[e.dr]) ? 1 : -1;
    const cSign = DEBIT_NORMAL.has(b.accounts[e.cr]) ? -1 : 1;
    push(e.dr, { ...base, split: e.cr, amount: dSign * e.amount });
    push(e.cr, { ...base, split: e.dr, amount: cSign * e.amount });
  }
  for (const a of Object.keys(openings || {})) if (!sections.has(a)) sections.set(a, []);
  const order = ['bank', 'ar', 'asset', 'fixed', 'card', 'ap', 'liab', 'loan', 'equity', 'income', 'cogs', 'expense'];
  const names = [...sections.keys()].sort((x, y) => order.indexOf(b.accounts[x]) - order.indexOf(b.accounts[y]) || x.localeCompare(y));
  const head = ['', 'Date', 'Transaction Type', 'Num', 'Name', 'Customer', ...(withClass ? ['Class'] : []), 'Memo/Description', 'Split', 'Amount', 'Balance'];
  const lines = [q(b.company), 'Transaction Detail by Account', q(period), '', head.join(',')];
  for (const acct of names) {
    const rows = sections.get(acct).sort((x, y) => x.date.localeCompare(y.date));
    lines.push(q(acct));
    let bal = (openings && openings[acct]) || 0;
    if (bal) lines.push(['', 'Beginning Balance', '', '', '', '', ...(withClass ? [''] : []), '', '', '', money(bal)].join(','));
    for (const r of rows) {
      bal = r2(bal + r.amount);
      lines.push(['', mdY(r.date), r.type, r.num, r.name, r.customer, ...(withClass ? [r.cls] : []), r.memo, r.split, money(r.amount), money(bal)].map(q).join(','));
    }
    lines.push([q(`Total for ${acct}`), '', '', '', '', '', ...(withClass ? [''] : []), '', '', q(`$${bal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`), ''].join(','));
  }
  lines.push('');
  lines.push(q(`Cash Basis ${(footerDate || new Date(Date.UTC(2026, 8, 1))).toUTCString().slice(0, 16)}`));
  return `${lines.join('\n')}\n`;
}

const TYPE_LABEL = {
  bank: ['Bank', 'Checking'], ar: ['Accounts receivable (A/R)', 'Accounts Receivable (A/R)'], asset: ['Other Current Assets', 'Other Current Assets'],
  fixed: ['Fixed Assets', 'Machinery & Equipment'], card: ['Credit Card', 'Credit Card'], ap: ['Accounts payable (A/P)', 'Accounts Payable (A/P)'], liab: ['Other Current Liabilities', 'Other Current Liabilities'],
  loan: ['Long Term Liabilities', 'Notes Payable'], equity: ['Equity', "Owner's Equity"], income: ['Income', 'Service/Fee Income'],
  cogs: ['Cost of Goods Sold', 'Supplies & Materials - COGS'], expense: ['Expenses', 'Other Miscellaneous Service Cost'],
};
function chartOfAccounts(b, details) {
  const lines = [q(b.company), 'Account List', '', 'Account,Type,Detail type,Description,Balance'];
  for (const [name, type] of Object.entries(b.accounts)) {
    const [t, d] = TYPE_LABEL[type];
    lines.push([name, t, (details && details[name]) || d, '', ''].map(q).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function profitAndLoss(b, period) {
  const sums = new Map();
  for (const e of b.entries) {
    for (const [acct, side] of [[e.dr, 'D'], [e.cr, 'C']]) {
      const t = b.accounts[acct];
      if (!['income', 'cogs', 'expense'].includes(t)) continue;
      const natural = (t === 'income') === (side === 'C') ? 1 : -1;
      sums.set(acct, r2((sums.get(acct) || 0) + natural * e.amount));
    }
  }
  const group = (t) => [...sums.entries()].filter(([a]) => b.accounts[a] === t).sort((x, y) => x[0].localeCompare(y[0]));
  const total = (t) => r2(group(t).reduce((s, [, v]) => s + v, 0));
  const lines = [q(b.company), 'Profit and Loss', q(period), '', ',Total', 'Income'];
  for (const [a, v] of group('income')) lines.push(`${q(`   ${a}`)},${money(v)}`);
  lines.push(`Total Income,${money(total('income'))}`, 'Cost of Goods Sold');
  for (const [a, v] of group('cogs')) lines.push(`${q(`   ${a}`)},${money(v)}`);
  lines.push(`Total Cost of Goods Sold,${money(total('cogs'))}`, `Gross Profit,${money(r2(total('income') - total('cogs')))}`, 'Expenses');
  for (const [a, v] of group('expense')) lines.push(`${q(`   ${a}`)},${money(v)}`);
  lines.push(`Total Expenses,${money(total('expense'))}`, `Net Operating Income,${money(r2(total('income') - total('cogs') - total('expense')))}`);
  lines.push(`Net Income,${money(r2(total('income') - total('cogs') - total('expense')))}`, '', '"Cash Basis"');
  return `${lines.join('\n')}\n`;
}

// QuickBooks' Expenses page exported with the Attachments column.
function expenseList(b, since, missing) {
  const lines = ['Date,Type,No.,Payee,Category,Total,Attachments'];
  for (const e of b.entries) {
    if (!/^(Expense|Check)$/.test(e.type) || e.date < since) continue;
    if (!['expense', 'cogs'].includes(b.accounts[e.dr])) continue;
    lines.push([mdY(e.date), e.type, e.num || '', e.name || '', e.dr, money(e.amount), missing(e) ? 0 : 1].map(q).join(','));
  }
  return `${lines.join('\n')}\n`;
}

// Pays each month's card charges in full on the 12th of the next month (or the export date).
function payCard(b, card, bank, payee, M) {
  for (const mo of M) {
    const key = `${mo.y}-${pad2(mo.m)}`;
    const owed = r2(b.entries.filter((e) => e.cr === card && e.date.slice(0, 7) === key).reduce((s, e) => s + e.amount, 0));
    const next = addDays(mo.d(mo.days), 12);
    if (owed > 0) b.post(next > END ? END : next, 'Credit Card Payment', '', payee, '', 'Card autopay', card, bank, owed);
  }
}

// Month helpers for a span of months starting at (y, m).
function months(y0, m0, count) {
  return Array.from({ length: count }, (_, k) => {
    const m = ((m0 - 1 + k) % 12) + 1, y = y0 + Math.floor((m0 - 1 + k) / 12);
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return { k, y, m, days, d: (day) => `${y}-${pad2(m)}-${pad2(Math.min(day, days))}` };
  });
}
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const END = '2026-08-31';
const within = (iso) => iso <= END;

// ------------------------------------------------------------------ Riverbend Plumbing & Heating

function riverbend() {
  const R = rng(20260901);
  const between = (a, z) => r2(a + R() * (z - a));
  const pick = (list) => list[Math.floor(R() * list.length)];
  const A = {
    'Business Checking': 'bank', 'Business Savings': 'bank', 'Undeposited Funds': 'asset', 'Accounts Receivable (A/R)': 'ar',
    'Capital One Spark (5521)': 'card', 'Accounts Payable (A/P)': 'ap', 'Sales Tax Payable': 'liab', 'Payroll Liabilities': 'liab',
    'Ford Credit Truck Loan': 'loan', 'Opening Balance Equity': 'equity', 'Owner Distributions': 'equity',
    'Service Income': 'income', 'Installation Income': 'income', 'Uncategorized Income': 'income',
    'Job Materials': 'cogs', 'Subcontractors': 'cogs', 'Equipment Rental': 'cogs',
    'Payroll Expenses:Wages': 'expense', 'Payroll Expenses:Taxes': 'expense', 'Shop Rent': 'expense', 'Utilities': 'expense', 'Insurance': 'expense',
    'Fuel': 'expense', 'Vehicle Repairs': 'expense', 'Software & Subscriptions': 'expense', 'Telephone': 'expense', 'Office Supplies': 'expense',
    'Meals': 'expense', 'Travel': 'expense', 'Gifts': 'expense', 'Interest Expense': 'expense', 'Bank Fees': 'expense', 'Advertising': 'expense',
    'Uncategorized Expense': 'expense', 'Ask My Accountant': 'expense',
  };
  const b = book('Riverbend Plumbing & Heating LLC', A);
  const P = b.post;
  const BANK = 'Business Checking', CARD = 'Capital One Spark (5521)', AR = 'Accounts Receivable (A/R)', AP = 'Accounts Payable (A/P)', UF = 'Undeposited Funds';
  const TAX = 0.0725; // on materials billed to customers
  let inv = 3101, chk = 2201;
  const M = months(2025, 1, 20);
  const seasonal = (m) => [1.35, 1.3, 1.05, 0.85, 0.8, 1.0, 1.15, 1.1, 0.85, 0.95, 1.15, 1.4][m - 1];

  // Residential service calls: paid on the spot into Undeposited Funds, deposited each Friday.
  // Homeowners: a large pool, so most appear once or twice, as real service customers do.
  const surnames = ['Alvarez', 'Bennett', 'Chen', 'Dubois', 'Evans', 'Fischer', 'Garcia', 'Hughes', 'Iverson', 'Jensen', 'Kaur', 'Larsen', 'Moreno', 'Nguyen', 'Okafor', 'Patel', 'Quinn', 'Rossi', 'Schmidt', 'Tanaka', 'Underwood', 'Vasquez', 'Walsh', 'Yilmaz', 'Zimmerman',
    'Abbott', 'Brooks', 'Castillo', 'Delgado', 'Ellis', 'Foster', 'Gibson', 'Harper', 'Ingram', 'Jordan', 'Keller', 'Lambert', 'Mendez', 'Novak', 'Ortiz', 'Price', 'Ramos', 'Sullivan', 'Thornton', 'Vaughn', 'Warren', 'Young', 'Barker', 'Cross', 'Doyle', 'Fleming', 'Grant', 'Holt', 'Kemp', 'Lowe', 'Marsh', 'Nash', 'Owens', 'Pearce', 'Reyes', 'Shaw', 'Tate', 'Vega', 'Webb', 'Yates'];
  const people = surnames.flatMap((sn) => ['A.', 'B.', 'C.', 'D.', 'E.', 'J.', 'K.', 'L.', 'M.', 'R.', 'S.', 'T.'].map((i) => `${sn}, ${i}`));
  for (const mo of M) {
    const calls = Math.round(36 * seasonal(mo.m) + R() * 6);
    let batch = [];
    for (let i = 0; i < calls; i++) {
      const day = 1 + Math.floor((i / calls) * mo.days);
      const date = mo.d(day);
      const who = pick(people);
      const labor = between(180, 580), parts = between(30, 300);
      const num = String(inv++);
      P(date, 'Sales Receipt', num, who, '', pick(['Water heater repair', 'Drain cleaning', 'Furnace tune-up', 'Leak repair', 'Faucet replacement', 'No-heat call']), UF, 'Service Income', labor + parts);
      P(date, 'Sales Receipt', num, who, '', 'Sales tax on parts', UF, 'Sales Tax Payable', parts * TAX);
      batch.push(r2(labor + parts + parts * TAX));
      const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
      if (dow === 5 || i === calls - 1) {
        const total = r2(batch.reduce((s, v) => s + v, 0));
        // August's last batch is still sitting in Undeposited Funds at the export date.
        if (!(mo.y === 2026 && mo.m === 8 && i === calls - 1)) P(addDays(date, 1), 'Deposit', '', '', '', 'Deposit - service calls', BANK, UF, total);
        batch = [];
      }
    }
  }
  // A March check that was entered as a payment but never included in a deposit.
  P('2026-03-19', 'Sales Receipt', String(inv++), 'Hughes, R.', '', 'Boiler inspection - paid by check', UF, 'Service Income', 385);

  // Commercial jobs: invoiced by milestone, paid on each customer's own terms.
  const jobs = [
    { cust: 'Brightwater Brewing', job: 'New Build Plumbing', from: 2, to: 11, fee: [12800, 17200], pays: 38, costShare: 0.46, vendor: 'Ferguson Supply' },
    { cust: 'Maple Grove Apartments', job: 'Boiler Replacement', from: 9, to: 13, fee: [9200, 11800], pays: 24, costShare: 0.5, vendor: 'Ferguson Supply' },
    { cust: 'Lakeshore Dental', job: 'Remodel Rough-in', from: 12, to: 19, fee: [6800, 8400], pays: 30, costShare: 0.4, vendor: 'Winsupply' },
    { cust: 'Cedar Point Elementary', job: 'Restroom Upgrade', from: 13, to: 16, fee: [7600, 8900], pays: 118, costShare: 0.44, vendor: 'Ferguson Supply' },
    { cust: 'Pinecrest Library', job: 'Boiler Upgrade', from: 15, to: 19, fee: [8800, 11200], pays: 27, costShare: 0.48, vendor: 'Ferguson Supply' },
    { cust: 'Hillside HOA', job: 'Annual Service Contract', from: 0, to: 19, fee: [1450, 1450], pays: 12, costShare: 0.08, vendor: 'Winsupply' },
  ];
  const sub = { 'Brightwater Brewing': 'Precision Electric LLC', 'Maple Grove Apartments': 'Mike Delaney Excavating', 'Lakeshore Dental': 'Precision Electric LLC', 'Cedar Point Elementary': 'Mike Delaney Excavating', 'Pinecrest Library': 'Precision Electric LLC' };
  for (const mo of M) {
    jobs.forEach((j, i) => {
      if (mo.k < j.from || mo.k > j.to) return;
      const date = mo.d(4 + i * 2);
      const fee = between(j.fee[0], j.fee[1]);
      const customer = `${j.cust}:${j.job}`;
      const num = String(inv++);
      P(date, 'Invoice', num, j.cust, customer, `${j.job} - progress billing`, AR, 'Installation Income', fee);
      const paid = addDays(date, j.pays + Math.round(R() * 6 - 3));
      if (within(paid)) {
        P(paid, 'Payment', '', j.cust, customer, 'Check received', UF, AR, fee);
        P(addDays(paid, 1), 'Deposit', '', '', '', `Deposit - ${j.cust}`, BANK, UF, fee);
      }
      const matDate = mo.d(8 + i);
      const mat = r2(fee * j.costShare * between(0.8, 1.15));
      const billNo = `F${mo.y % 100}${pad2(mo.m)}-${i}`;
      P(matDate, 'Bill', billNo, j.vendor, customer, `Materials - ${j.job}`, 'Job Materials', AP, mat);
      const billPaid = addDays(matDate, 28);
      if (within(billPaid)) P(billPaid, 'Bill Payment (Check)', String(chk++), j.vendor, '', `Pay ${billNo}`, AP, BANK, mat);
      if (sub[j.cust] && mo.k % 2 === 0) {
        const s = r2(fee * 0.18 * between(0.8, 1.2));
        P(mo.d(15 + i), 'Check', String(chk++), sub[j.cust], customer, `${j.job} - sub work`, 'Subcontractors', BANK, s);
      }
      if (j.cust === 'Brightwater Brewing' && mo.k % 3 === 1) P(mo.d(12), 'Expense', '', 'Sunbelt Rentals', customer, 'Mini excavator rental', 'Equipment Rental', CARD, between(640, 980));
    });
  }
  // Hillside's July payment was recorded twice, leaving the HOA with a credit.
  P('2026-07-19', 'Payment', '', 'Hillside HOA', 'Hillside HOA:Annual Service Contract', 'Check received (entered twice)', UF, AR, 1450);
  P('2026-07-20', 'Deposit', '', '', '', 'Deposit - Hillside HOA', BANK, UF, 1450);
  // A new job started in August: materials bought, nothing invoiced yet.
  P('2026-08-18', 'Bill', 'F2608-9', 'Ferguson Supply', 'Oak Ridge Senior Living:Water Main Replacement', 'Materials - water main', 'Job Materials', AP, 3240);

  // Truck-stock materials on the card, mostly with no job attached.
  for (const mo of M) {
    P(mo.d(6), 'Expense', '', 'The Home Depot', '', 'Truck stock - fittings', 'Job Materials', CARD, between(180, 420));
    P(mo.d(20), 'Expense', '', 'The Home Depot', '', 'Shop supplies', 'Office Supplies', CARD, between(40, 120));
    if (mo.k % 2) P(mo.d(22), 'Expense', '', 'Winsupply', '', 'PEX and valves', 'Job Materials', CARD, between(210, 560));
  }

  // Payroll: three techs and an office manager, twice a month; taxes paid monthly.
  for (const mo of M) {
    const crew = mo.k >= 8 ? 4 : 3; // a fourth tech from September 2025
    for (const day of [15, mo.days]) {
      const gross = r2(crew * between(2150, 2300) + 1650);
      P(mo.d(day), 'Payroll Check', '', 'Gusto', '', 'Payroll', 'Payroll Expenses:Wages', BANK, r2(gross * 0.82));
      P(mo.d(day), 'Journal Entry', '', 'Gusto', '', 'Payroll withholding', 'Payroll Expenses:Wages', 'Payroll Liabilities', r2(gross * 0.18));
      P(mo.d(day), 'Journal Entry', '', 'Gusto', '', 'Employer payroll taxes', 'Payroll Expenses:Taxes', 'Payroll Liabilities', r2(gross * 0.0765));
    }
  }
  // Liability payments settle the prior month (running the actual balance to zero).
  const liabByMonth = new Map();
  for (const e of b.entries) if (e.cr === 'Payroll Liabilities') liabByMonth.set(e.date.slice(0, 7), r2((liabByMonth.get(e.date.slice(0, 7)) || 0) + e.amount));
  for (const mo of M.slice(1)) {
    const prev = `${mo.k === 0 ? '' : M[mo.k - 1].y}-${pad2(M[mo.k - 1].m)}`;
    P(mo.d(12), 'Tax Payment', '', 'IRS / State EFTPS', '', 'Payroll tax deposit', 'Payroll Liabilities', BANK, liabByMonth.get(prev) || 0);
  }

  // Sales tax: quarterly returns. The Q1 2026 payment went out twice (online and by check).
  const taxByQuarter = new Map();
  for (const e of b.entries) if (e.cr === 'Sales Tax Payable') { const qk = `${e.date.slice(0, 4)}-Q${Math.ceil(+e.date.slice(5, 7) / 3)}`; taxByQuarter.set(qk, r2((taxByQuarter.get(qk) || 0) + e.amount)); }
  const due = { '2025-Q1': '2025-04-20', '2025-Q2': '2025-07-20', '2025-Q3': '2025-10-20', '2025-Q4': '2026-01-20', '2026-Q1': '2026-04-20', '2026-Q2': '2026-07-20' };
  for (const [qk, date] of Object.entries(due)) P(date, 'Sales Tax Payment', '', 'State Dept. of Revenue', '', `Sales tax ${qk}`, 'Sales Tax Payable', BANK, taxByQuarter.get(qk) || 0);
  P('2026-04-24', 'Check', String(chk++), 'State Dept. of Revenue', '', 'Sales tax 2026-Q1', 'Sales Tax Payable', BANK, taxByQuarter.get('2026-Q1') || 0);

  // Overhead.
  for (const mo of M) {
    const y26 = mo.y === 2026;
    P(mo.d(1), 'Check', String(chk++), 'Riverside Properties LLC', '', 'Shop rent', 'Shop Rent', BANK, y26 ? 2850 : 2600);
    P(mo.d(9), 'Expense', '', 'City Light & Water', '', 'Utilities', 'Utilities', BANK, between(260, 390));
    P(mo.d(11), 'Expense', '', 'Verizon Wireless', '', 'Crew phones', 'Telephone', CARD, mo.k >= 10 ? 318.45 : 284.95);
    P(mo.d(3), 'Expense', '', 'ServiceTitan', '', 'Field service software', 'Software & Subscriptions', CARD, mo.k >= 12 ? 449 : 398);
    P(mo.d(3), 'Expense', '', 'Jobber', '', 'Scheduling software', 'Software & Subscriptions', CARD, 129); // never cancelled after the switch
    P(mo.d(5), 'Expense', '', 'Intuit QuickBooks', '', 'QuickBooks Online Plus', 'Software & Subscriptions', CARD, 99);
    P(mo.d(7), 'Expense', '', 'Google Workspace', '', 'Email', 'Software & Subscriptions', CARD, 36);
    P(mo.d(8), 'Expense', '', 'Microsoft 365', '', 'Office apps', 'Software & Subscriptions', CARD, 44);
    P(mo.d(14), 'Expense', '', 'Netflix', '', 'Netflix Premium', 'Software & Subscriptions', CARD, 24.99);
    P(mo.d(10), 'Expense', '', 'Travelers Insurance', '', 'Workers comp', 'Insurance', BANK, between(610, 690));
    for (const day of [4, 12, 19, 26]) P(mo.d(day), 'Expense', '', pick(['Shell', 'Chevron', 'Speedway']), '', 'Fuel - service vans', 'Fuel', CARD, between(140, 260));
    P(mo.d(24), 'Expense', '', 'Google Ads', '', 'Local search ads', 'Advertising', CARD, between(300, 520));
    if (mo.k % 4 === 2) P(mo.d(17), 'Expense', '', 'Quick Lube Plus', '', 'Van service', 'Vehicle Repairs', CARD, between(90, 240));
    if (mo.k % 3 === 0) P(mo.d(21), 'Expense', '', pick(['Hometown Diner', 'Olive Garden', 'Pho 99']), '', 'Crew lunch', 'Meals', CARD, between(80, 190));
    // Truck loan: $1,050 a month, interest and principal.
    P(mo.d(5), 'Check', String(chk++), 'Ford Credit', '', 'Truck loan - interest', 'Interest Expense', BANK, r2(260 - mo.k * 6));
    P(mo.d(5), 'Check', String(chk - 1), 'Ford Credit', '', 'Truck loan - principal', 'Ford Credit Truck Loan', BANK, r2(790 + mo.k * 6));
    P(mo.d(28), 'Check', String(chk++), 'Dave Kowalski', '', 'Owner distribution', 'Owner Distributions', BANK, y26 ? 3000 : 2500);
  }
  // Annual items and one-offs.
  P('2025-01-15', 'Check', String(chk++), 'Travelers Insurance', '', 'General liability - annual', 'Insurance', BANK, 6840);
  P('2026-01-15', 'Check', String(chk++), 'Travelers Insurance', '', 'General liability - annual', 'Insurance', BANK, 7420);
  P('2025-12-12', 'Expense', '', 'Harry & David', '', 'Holiday gift baskets - top customers', 'Gifts', CARD, 612);
  P('2026-03-10', 'Expense', '', 'Delta Air Lines', '', 'PHCC trade show - airfare', 'Travel', CARD, 486);
  P('2026-03-11', 'Expense', '', 'Marriott Las Vegas', '', 'PHCC trade show - hotel', 'Travel', CARD, 742.6);
  P('2026-03-12', 'Expense', '', 'Carmine\'s', '', 'Dinner with supplier rep', 'Meals', CARD, 168.4);
  // Last full month spike: a transmission from a shop never used before.
  P('2026-08-09', 'Check', String(chk++), 'Transmission Pros', '', 'Van #2 transmission rebuild', 'Vehicle Repairs', BANK, 4860);
  // Savings sweep coded as an expense, and a transfer back.
  P('2026-05-29', 'Transfer', '', '', '', 'Transfer to savings', 'Bank Fees', BANK, 5000);
  P('2025-11-03', 'Transfer', '', '', '', 'Move to savings', 'Business Savings', BANK, 10000);

  // Planted bookkeeping problems.
  P('2026-06-07', 'Expense', '', '', '', 'ZELLE TO J RAMIREZ 8812', 'Uncategorized Expense', BANK, 650);
  P('2026-07-15', 'Expense', '', 'AMZN Mktp US*7Q21', '', 'AMZN Mktp US*7Q21', 'Uncategorized Expense', CARD, 138.77);
  P('2026-07-30', 'Deposit', '', '', '', 'REMOTE DEPOSIT', 'Uncategorized Income', BANK, 925);
  P('2026-08-14', 'Expense', '', 'Lowe\'s', '', 'Tools?', 'Ask My Accountant', CARD, 389.12);
  P('2026-05-11', 'Expense', '', '', '', 'CHECKCARD 0511 SQ *PIPEWORKS', 'Job Materials', CARD, 212.4);
  // A Ferguson bill entered twice (copied from the real one), and a bill paid by a separate
  // check (so it stays open).
  const orig = b.entries.find((e) => e.type === 'Bill' && e.num === 'F2606-4');
  b.add({ ...orig });
  P('2026-04-03', 'Bill', 'W-88214', 'Winsupply', '', 'Water heaters (2)', 'Job Materials', AP, 1864);
  P('2026-04-10', 'Check', String(chk++), 'Winsupply', '', 'Water heaters (2) - inv W-88214', 'Job Materials', BANK, 1864);
  // Home Depot coded to Meals once.
  P('2026-02-17', 'Expense', '', 'The Home Depot', '', 'Pipe cutter', 'Meals', CARD, 96.3);
  // Duplicate fuel charge.
  P('2026-07-12', 'Expense', '', 'Shell', '', 'Fuel - service vans', 'Fuel', CARD, 187.35);
  P('2026-07-12', 'Expense', '', 'Shell', '', 'Fuel - service vans', 'Fuel', CARD, 187.35);

  // Cards paid monthly; then an extra August payment leaves the card with a credit balance.
  payCard(b, CARD, BANK, 'Capital One', M);
  P('2026-08-24', 'Credit Card Payment', '', 'Capital One', '', 'Extra payment (online)', CARD, BANK, 3200);
  const openings = { 'Business Checking': 46400, 'Business Savings': 15000, 'Ford Credit Truck Loan': 41200 };
  return { b, openings };
}

// ------------------------------------------------------------------ Bloom & Basil Cafe

function cafe() {
  const R = rng(4471);
  const between = (a, z) => r2(a + R() * (z - a));
  const pick = (list) => list[Math.floor(R() * list.length)];
  const A = {
    'Chase Checking': 'bank', 'Accounts Receivable (A/R)': 'ar', 'Amex Business Gold': 'card', 'Accounts Payable (A/P)': 'ap',
    'Sales Tax Payable': 'liab', 'Payroll Liabilities': 'liab', 'Kitchen Equipment Loan': 'loan', 'Opening Balance Equity': 'equity', "Owner's Draw": 'equity',
    'Food Sales': 'income', 'Beverage Sales': 'income', 'Catering Income': 'income',
    'Food Costs': 'cogs', 'Coffee & Beverage Costs': 'cogs', 'Packaging': 'cogs',
    'Payroll Expenses:Wages': 'expense', 'Payroll Expenses:Taxes': 'expense', 'Rent': 'expense', 'Utilities': 'expense', 'Merchant Fees': 'expense',
    'Repairs & Maintenance': 'expense', 'Linen & Laundry': 'expense', 'Software & Subscriptions': 'expense', 'Waste Removal': 'expense',
    'Insurance': 'expense', 'Marketing': 'expense', 'Meals': 'expense', 'Travel': 'expense', 'Interest Expense': 'expense', 'Bank Fees': 'expense',
    'Uncategorized Expense': 'expense', 'Supplies': 'expense',
  };
  const b = book('Bloom & Basil Cafe', A);
  const P = b.post;
  const BANK = 'Chase Checking', CARD = 'Amex Business Gold', AR = 'Accounts Receivable (A/R)', AP = 'Accounts Payable (A/P)';
  const TAX = 0.08;
  const M = months(2025, 1, 20);
  const season = (m) => [0.78, 0.8, 0.92, 1.0, 1.08, 1.12, 1.15, 1.12, 1.05, 1.0, 0.9, 1.02][m - 1];
  let sr = 50001, inv = 7001, chk = 1401;

  // Daily card sales from the POS, closed out each night (food and drinks on separate lines).
  for (const mo of M) {
    for (let day = 1; day <= mo.days; day++) {
      const date = mo.d(day);
      const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
      if (dow === 1) continue; // closed Mondays
      const lift = (dow === 6 || dow === 0 ? 1.35 : 1) * season(mo.m) * (mo.y === 2026 ? 1.04 : 1);
      const food = r2(between(620, 840) * lift), drinks = r2(between(480, 640) * lift);
      const num = String(sr++);
      P(date, 'Sales Receipt', num, 'Daily POS Sales', '', 'Food', BANK, 'Food Sales', food, { cls: 'Counter' });
      P(date, 'Sales Receipt', num, 'Daily POS Sales', '', 'Beverages', BANK, 'Beverage Sales', drinks, { cls: 'Counter' });
      P(date, 'Sales Receipt', num, 'Daily POS Sales', '', 'Sales tax collected', BANK, 'Sales Tax Payable', r2((food + drinks) * TAX), { cls: 'Counter' });
    }
    // Card processing fees, taken monthly.
    const sales = b.entries.filter((e) => e.date.slice(0, 7) === `${mo.y}-${pad2(mo.m)}` && /Sales$/.test(e.cr)).reduce((s, e) => s + e.amount, 0);
    P(mo.d(mo.days), 'Expense', '', 'Square', '', 'Card processing fees', 'Merchant Fees', BANK, r2(sales * 0.027));
  }

  // Catering for offices, invoiced.
  const clients = [
    { name: 'Nimbus Software', pays: 18, fee: [1100, 1900], every: 1 },
    { name: 'Harborside Law Group', pays: 32, fee: [650, 980], every: 2 },
    { name: 'Summit Physical Therapy', pays: 160, fee: [780, 1040], every: 3, from: 10, to: 16 }, // stopped paying
    { name: 'Greenleaf Realty', pays: 25, fee: [520, 760], every: 2 },
  ];
  for (const mo of M) {
    clients.forEach((c, i) => {
      if (mo.k % c.every || (c.from != null && (mo.k < c.from || mo.k > c.to))) return;
      const date = mo.d(6 + i * 5);
      const amt = between(c.fee[0], c.fee[1]);
      const num = String(inv++);
      P(date, 'Invoice', num, c.name, c.name, 'Office catering', AR, 'Catering Income', amt, { cls: 'Catering' });
      const paid = addDays(date, c.pays);
      if (within(paid)) P(paid, 'Payment', '', c.name, c.name, 'ACH payment', BANK, AR, amt);
    });
  }
  // Harborside paid one invoice twice.
  P('2026-05-02', 'Payment', '', 'Harborside Law Group', 'Harborside Law Group', 'ACH payment (duplicate)', BANK, AR, 842.5);

  // Suppliers: weekly food bills, coffee every two weeks, packaging monthly.
  for (const mo of M) {
    for (const day of [2, 9, 16, 23, 30]) {
      if (day > mo.days) continue;
      const billNo = `SY${mo.y % 100}${pad2(mo.m)}${pad2(day)}`;
      const amt = r2(between(1380, 1760) * season(mo.m) * (mo.k >= 13 ? 1.09 : 1)); // prices up from Feb 2026
      P(mo.d(day), 'Bill', billNo, 'Sysco', '', 'Weekly food order', 'Food Costs', AP, amt);
      const pd = addDays(mo.d(day), 14);
      if (within(pd)) P(pd, 'Bill Payment (Check)', String(chk++), 'Sysco', '', `Pay ${billNo}`, AP, BANK, amt);
    }
    for (const day of [5, 19]) {
      const lbs = r2(between(52, 64) * season(mo.m));
      const price = mo.k >= 11 ? 15.4 : 13.25; // roaster raised prices in Dec 2025
      const billNo = `HR-${mo.y % 100}${pad2(mo.m)}${day}`;
      P(mo.d(day), 'Bill', billNo, 'Hilltop Roasters', '', `${lbs} lb espresso blend`, 'Coffee & Beverage Costs', AP, r2(lbs * price));
      const pd = addDays(mo.d(day), 10);
      if (within(pd)) P(pd, 'Bill Payment (Check)', String(chk++), 'Hilltop Roasters', '', `Pay ${billNo}`, AP, BANK, r2(lbs * price));
    }
    P(mo.d(8), 'Expense', '', 'Clover Dairy', '', 'Milk and cream', 'Coffee & Beverage Costs', CARD, between(640, 820));
    P(mo.d(12), 'Expense', '', 'WebstaurantStore', '', 'Cups, lids, boxes', 'Packaging', CARD, between(380, 560));
    for (const day of [3, 17]) P(mo.d(day), 'Expense', '', 'Farmers Market', '', 'Produce', 'Food Costs', CARD, between(140, 260));
  }

  // Payroll every other Friday; taxes deposited monthly.
  for (const mo of M) {
    for (const day of [14, 28]) {
      const gross = r2(between(6300, 7200) * season(mo.m));
      P(mo.d(day), 'Payroll Check', '', 'Gusto', '', 'Payroll', 'Payroll Expenses:Wages', BANK, r2(gross * 0.84));
      P(mo.d(day), 'Journal Entry', '', 'Gusto', '', 'Payroll withholding', 'Payroll Expenses:Wages', 'Payroll Liabilities', r2(gross * 0.16));
      P(mo.d(day), 'Journal Entry', '', 'Gusto', '', 'Employer payroll taxes', 'Payroll Expenses:Taxes', 'Payroll Liabilities', r2(gross * 0.0765));
    }
  }
  const liab = new Map();
  for (const e of b.entries) if (e.cr === 'Payroll Liabilities') liab.set(e.date.slice(0, 7), r2((liab.get(e.date.slice(0, 7)) || 0) + e.amount));
  for (const mo of M.slice(1)) P(mo.d(10), 'Tax Payment', '', 'IRS / State EFTPS', '', 'Payroll tax deposit', 'Payroll Liabilities', BANK, liab.get(`${M[mo.k - 1].y}-${pad2(M[mo.k - 1].m)}`) || 0);
  // Sales tax filed monthly.
  const tax = new Map();
  for (const e of b.entries) if (e.cr === 'Sales Tax Payable') tax.set(e.date.slice(0, 7), r2((tax.get(e.date.slice(0, 7)) || 0) + e.amount));
  for (const mo of M.slice(1)) P(mo.d(20), 'Sales Tax Payment', '', 'State Dept. of Revenue', '', 'Sales tax return', 'Sales Tax Payable', BANK, tax.get(`${M[mo.k - 1].y}-${pad2(M[mo.k - 1].m)}`) || 0);

  // Overhead.
  for (const mo of M) {
    P(mo.d(1), 'Check', String(chk++), 'Main Street Holdings', '', 'Rent', 'Rent', BANK, 5400);
    P(mo.d(9), 'Expense', '', 'PG&E', '', 'Gas and electric', 'Utilities', BANK, r2(between(880, 1150) * (mo.m >= 6 && mo.m <= 9 ? 1.2 : 1)));
    P(mo.d(15), 'Expense', '', 'Cintas', '', 'Linen and aprons', 'Linen & Laundry', CARD, mo.k >= 14 ? 204 : 186.5);
    P(mo.d(18), 'Expense', '', 'Recology', '', 'Waste and compost', 'Waste Removal', BANK, mo.k >= 12 ? 338 : 312);
    P(mo.d(2), 'Expense', '', 'Square for Restaurants', '', 'POS software', 'Software & Subscriptions', CARD, 69);
    if (mo.k >= 12) P(mo.d(2), 'Expense', '', 'Toast POS', '', 'POS software (trial became paid)', 'Software & Subscriptions', CARD, 110); // both POS systems running since Jan 2026
    P(mo.d(4), 'Expense', '', '7shifts', '', 'Staff scheduling', 'Software & Subscriptions', CARD, 76.99);
    P(mo.d(6), 'Expense', '', 'Spotify for Business', '', 'Background music', 'Software & Subscriptions', CARD, 34.99);
    P(mo.d(6), 'Expense', '', 'Canva', '', 'Menu design', 'Software & Subscriptions', CARD, 14.99);
    P(mo.d(13), 'Expense', '', 'Netflix', '', 'Netflix', 'Software & Subscriptions', CARD, 22.99);
    P(mo.d(11), 'Expense', '', 'Hiscox', '', 'Business insurance', 'Insurance', BANK, 418);
    P(mo.d(22), 'Expense', '', 'Instagram Ads', '', 'Promoted posts', 'Marketing', CARD, between(90, 220));
    P(mo.d(24), 'Expense', '', 'Costco', '', 'Cleaning and paper goods', 'Supplies', CARD, between(160, 320));
    P(mo.d(7), 'Check', String(chk++), 'Umpqua Bank', '', 'Equipment loan - interest', 'Interest Expense', BANK, r2(210 - mo.k * 5));
    P(mo.d(7), 'Check', String(chk - 1), 'Umpqua Bank', '', 'Equipment loan - principal', 'Kitchen Equipment Loan', BANK, r2(640 + mo.k * 5));
    P(mo.d(27), 'Check', String(chk++), 'Priya Raman', '', 'Owner draw', "Owner's Draw", BANK, mo.y === 2026 ? 3500 : 3000);
  }
  P('2025-02-03', 'Check', String(chk++), 'Hiscox', '', 'Liquor liability - annual', 'Insurance', BANK, 1890);
  P('2026-04-14', 'Expense', '', 'Alaska Airlines', '', 'Coffee Fest Seattle - airfare', 'Travel', CARD, 318);
  P('2026-04-15', 'Expense', '', 'Hotel Theodore', '', 'Coffee Fest Seattle - hotel', 'Travel', CARD, 524.2);
  P('2026-06-21', 'Expense', '', 'Nopa', '', 'Staff appreciation dinner', 'Meals', CARD, 412.6);
  P('2025-09-18', 'Expense', '', 'Tartine', '', 'Lunch with new roaster', 'Meals', CARD, 96.4);

  // Planted problems.
  P('2026-08-12', 'Expense', '', 'Espresso Parts Co', '', 'La Marzocco Linea replacement', 'Repairs & Maintenance', CARD, 9840); // equipment, expensed
  for (const [date, amt] of [['2026-06-03', 300], ['2026-07-08', 400], ['2026-08-05', 300]]) P(date, 'Expense', '', '', '', 'ATM WITHDRAWAL', 'Uncategorized Expense', BANK, amt);
  P('2026-07-19', 'Expense', '', 'SQ *CORNER HARDWARE', '', 'SQ *CORNER HARDWARE', 'Uncategorized Expense', CARD, 64.18);
  // A Sysco bill paid twice (check and online), and a Hilltop bill keyed in twice.
  P('2026-07-14', 'Bill', 'SY260714', 'Sysco', '', 'Special order - holiday menu', 'Food Costs', AP, 1712.4);
  P('2026-07-21', 'Bill Payment (Check)', String(chk++), 'Sysco', '', 'Pay SY260714', AP, BANK, 1712.4);
  P('2026-07-22', 'Bill Payment (Check)', '', 'Sysco', '', 'Online bill pay SY260714', AP, BANK, 1712.4);
  P('2026-06-03', 'Bill', 'HR-2606X', 'Hilltop Roasters', '', 'Decaf and cold brew blend', 'Coffee & Beverage Costs', AP, 612.5);
  P('2026-06-03', 'Bill', 'HR-2606X', 'Hilltop Roasters', '', 'Decaf and cold brew blend', 'Coffee & Beverage Costs', AP, 612.5);
  P('2026-06-13', 'Bill Payment (Check)', String(chk++), 'Hilltop Roasters', '', 'Pay HR-2606X', AP, BANK, 612.5);
  // A transfer to the owner's personal account coded to Supplies.
  P('2026-05-16', 'Transfer', '', '', '', 'Online transfer to PERSONAL CHK 2231', 'Supplies', BANK, 1500);
  // Costco coded to Catering Income once.
  P('2026-03-24', 'Expense', '', 'Costco', '', 'Paper goods', 'Catering Income', CARD, 142.3);

  payCard(b, CARD, BANK, 'American Express', M);
  // Opening Balance Equity left from setup; loan and cash opening balances.
  const openings = { 'Chase Checking': 18600, 'Kitchen Equipment Loan': 38400, 'Opening Balance Equity': 5400 };
  return { b, openings };
}


// ------------------------------------------------------------------ Greenway Landscape Co.

function greenway() {
  const R = rng(56173);
  const between = (a, z) => r2(a + R() * (z - a));
  const pick = (list) => list[Math.floor(R() * list.length)];
  const A = {
    'Operating Checking': 'bank', 'Undeposited Funds': 'asset', 'Accounts Receivable (A/R)': 'ar', 'Equipment': 'fixed', 'Accumulated Depreciation': 'fixed',
    'Chase Ink (4410)': 'card', 'Accounts Payable (A/P)': 'ap', 'Sales Tax Payable': 'liab', 'Payroll Liabilities': 'liab',
    'Line of Credit - First State Bank': 'loan', 'John Deere Financial': 'loan', 'Ally Truck Loan': 'loan', 'Owner Draws': 'equity',
    'Maintenance Contracts': 'income', 'Installation & Hardscape': 'income', 'Irrigation Services': 'income', 'Snow Removal': 'income', 'Enhancements': 'income',
    'Materials - Plants & Mulch': 'cogs', 'Materials - Hardscape': 'cogs', 'Irrigation Parts': 'cogs', 'Salt & Ice Melt': 'cogs', 'Subcontractors': 'cogs', 'Dump Fees': 'cogs',
    'Payroll Expenses:Wages': 'expense', 'Payroll Expenses:Overtime': 'expense', 'Payroll Expenses:Taxes': 'expense', 'Fuel': 'expense', 'Equipment Repairs': 'expense',
    'Vehicle Repairs': 'expense', 'Truck Leases': 'expense', 'Professional Fees': 'expense', 'Small Tools': 'expense', 'Insurance': 'expense', 'Shop Rent': 'expense', 'Utilities': 'expense', 'Telephone': 'expense',
    'Software & Subscriptions': 'expense', 'Advertising': 'expense', 'Uniforms': 'expense', 'Interest Expense': 'expense', 'Depreciation': 'expense',
    'Office Supplies': 'expense', 'Meals': 'expense', 'Bank Fees': 'expense', 'Uncategorized Expense': 'expense',
  };
  const b = book('Greenway Landscape Co.', A);
  const P = (date, type, num, name, customer, memo, dr, cr, amount, cls) => b.post(date, type, num, name, customer, memo, dr, cr, amount, cls ? { cls } : undefined);
  const BANK = 'Operating Checking', CARD = 'Chase Ink (4410)', AR = 'Accounts Receivable (A/R)', AP = 'Accounts Payable (A/P)', UF = 'Undeposited Funds', LOC = 'Line of Credit - First State Bank';
  const TAX = 0.0625; // on materials in installs
  let inv = 5101, chk = 3301;
  const M = months(2024, 1, 32);
  const inSeason = (m) => m >= 4 && m <= 11;
  const invoice = (date, cust, job, memo, acct, cls, amount, days, tax) => {
    const num = String(inv++);
    P(date, 'Invoice', num, cust, job || cust, memo, AR, acct, amount, cls);
    if (tax) P(date, 'Invoice', num, cust, job || cust, 'Sales tax on materials', AR, 'Sales Tax Payable', tax);
    const total = r2(amount + (tax || 0));
    const paid = addDays(date, days + Math.round(R() * 8 - 4));
    if (within(paid)) {
      P(paid, 'Payment', '', cust, job || cust, 'Payment received', UF, AR, total);
      P(addDays(paid, 1), 'Deposit', '', '', '', `Deposit - ${cust}`, BANK, UF, total);
    }
    return num;
  };

  // Maintenance contracts: billed on the 1st, April to November (a few commercial accounts
  // all year). Most prices go up each spring; four have not changed since 2024.
  const contracts = [
    ['Oak Hills HOA', 3680, true], ['Lakeview Office Park', 2420, true], ['Sunset Villas HOA', 2950, false], ['Maple Ridge HOA', 2180, false],
    ['Dr. Patel Dental', 640, false], ['Riverside Church', 920, false], ['Hartman Residence', 360, false], ['Cole Residence', 410, false],
    ['Prairie Bank', 960, true], ['Brookfield Apartments', 2390, false], ['Summit Medical Plaza', 2340, true], ['Greene Residence', 395, false],
    ['Walnut Creek Condos', 2160, false], ['Fischer Residence', 430, false], ['Elm Street Deli', 410, false], ['Kingsley Residence', 450, false],
    ['Heritage Senior Living', 2860, true], ['Crossroads Shopping Center', 3120, true], ['Birchwood Townhomes', 1840, false], ['Nolan Residence', 385, false],
  ];
  const frozen = new Set(['Maple Ridge HOA', 'Dr. Patel Dental', 'Riverside Church', 'Hartman Residence']);
  const missed = new Set(['2026-08|Lakeview Office Park', '2026-07|Sunset Villas HOA']);
  for (const mo of M) {
    for (const [cust, base, yearRound] of contracts) {
      if (!yearRound && !inSeason(mo.m)) continue;
      if (missed.has(`${mo.y}-${pad2(mo.m)}|${cust}`)) continue;
      const rise = frozen.has(cust) ? 1 : mo.y === 2024 ? 1 : mo.y === 2025 ? 1.04 : 1.04 * 1.05;
      const amt = r2(base * rise);
      invoice(mo.d(1), cust, '', `Grounds maintenance - ${new Date(Date.UTC(mo.y, mo.m - 1, 1)).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })}`, 'Maintenance Contracts', 'Maintenance', amt, cust === 'Brookfield Apartments' ? 55 : 24);
    }
    if (inSeason(mo.m)) {
      P(mo.d(9), 'Expense', '', 'Menards', '', 'Mulch, fertilizer, seed', 'Materials - Plants & Mulch', CARD, between(420, 900) * (mo.m === 5 ? 2.4 : 1), 'Maintenance');
      P(mo.d(18), 'Expense', '', 'County Compost Site', '', 'Green waste dump fees', 'Dump Fees', CARD, between(140, 260), 'Maintenance');
    }
  }

  // Installation and hardscape jobs: April to October, deposits and completion invoices.
  const installCustomers = ['Bauer Residence', 'Quinn Residence', 'Northgate Library', 'Alvarez Residence', 'Delgado Residence', 'Pinewood School', 'Harper Residence', 'Tanaka Residence', 'Lincoln Park District', 'Moreno Residence', 'Ellis Residence', 'Castle Rock Winery'];
  const projects = ['Paver patio', 'Retaining wall', 'Front bed renovation', 'Flagstone walkway', 'Outdoor kitchen', 'Tree and shrub planting', 'Drainage and grading'];
  for (const mo of M) {
    if (mo.m < 4 || mo.m > 10) continue;
    const n = mo.m >= 5 && mo.m <= 9 ? 4 : 2;
    for (let i = 0; i < n; i++) {
      const cust = pick(installCustomers), proj = pick(projects), job = `${cust}:${proj}`;
      const price = between(7400, 24800) * (mo.y === 2026 ? 1.06 : 1);
      const day = 3 + i * 6;
      invoice(mo.d(day), cust, job, `${proj} - deposit`, 'Installation & Hardscape', 'Install', r2(price * 0.4), 5);
      const mat = r2(price * between(0.26, 0.34));
      invoice(mo.d(day + 12), cust, job, `${proj} - completion`, 'Installation & Hardscape', 'Install', r2(price * 0.6), 18, r2(mat * TAX));
      const billNo = `RS-${mo.y % 100}${pad2(mo.m)}${i}`;
      P(mo.d(day + 2), 'Bill', billNo, 'Rock Solid Stone Supply', job, `Pavers, block and base - ${proj}`, 'Materials - Hardscape', AP, mat, 'Install');
      if (within(addDays(mo.d(day + 2), 30))) P(addDays(mo.d(day + 2), 30), 'Bill Payment (Check)', String(chk++), 'Rock Solid Stone Supply', '', `Pay ${billNo}`, AP, BANK, mat);
      if (i === 0 && mo.m % 2 === 0) P(mo.d(day + 4), 'Check', String(chk++), 'Precision Grading LLC', job, `Excavation - ${proj}`, 'Subcontractors', BANK, between(900, 2400), 'Install');
      if (i === 1) P(mo.d(day + 3), 'Expense', '', 'Sunbelt Rentals', job, 'Skid steer rental', 'Subcontractors', CARD, between(380, 720), 'Install');
    }
  }

  // Irrigation: spring start-ups in April, winterizations in October, repairs in between.
  const homes = ['Adams', 'Brennan', 'Carver', 'Dunn', 'Ewing', 'Frost', 'Gill', 'Hale', 'Irwin', 'Joyce', 'Kerr', 'Lang', 'Mercer', 'Nolan', 'Olsen', 'Pruitt', 'Reid', 'Sutter', 'Tully', 'Vance'];
  for (const mo of M) {
    const count = mo.m === 4 || mo.m === 10 ? 24 : inSeason(mo.m) ? 8 : 0;
    for (let i = 0; i < count; i++) {
      const who = `${pick(homes)} Residence`;
      const memo = mo.m === 4 ? 'Irrigation spring start-up' : mo.m === 10 ? 'Irrigation winterization (blow-out)' : 'Irrigation repair - heads and valves';
      invoice(mo.d(2 + i), who, '', memo, 'Irrigation Services', 'Irrigation', mo.m === 4 || mo.m === 10 ? between(85, 140) : between(180, 620), 15);
    }
    if (count) P(mo.d(12), 'Expense', '', 'SiteOne Landscape Supply', '', 'Irrigation heads, valves, fittings', 'Irrigation Parts', CARD, between(160, 520), 'Irrigation');
  }

  // Enhancements: spring clean-ups, mulch, fall aeration and leaf clean-ups.
  for (const mo of M) {
    const count = { 4: 18, 5: 14, 9: 10, 10: 8, 11: 16 }[mo.m] || 0;
    for (let i = 0; i < count; i++) {
      const who = `${pick(homes)} Residence`;
      const memo = { 4: 'Spring clean-up', 5: 'Mulch installation', 9: 'Core aeration and overseed', 10: 'Fall clean-up', 11: 'Leaf removal' }[mo.m];
      invoice(mo.d(3 + i), who, '', memo, 'Enhancements', 'Enhancements', between(240, 780), 12);
    }
  }

  // Snow: seasonal contracts billed monthly December to March, plus per-push invoices for
  // storms; salt and overtime make the 2025-26 winter a loss.
  const snowContracts = [['Oak Hills HOA', 2250], ['Summit Medical Plaza', 2500], ['Prairie Bank', 1150], ['Lakeview Office Park', 1900], ['Heritage Senior Living', 2400], ['Crossroads Shopping Center', 3100]];
  for (const mo of M) {
    if (inSeason(mo.m)) continue;
    const winter2526 = (mo.y === 2025 && mo.m === 12) || (mo.y === 2026 && mo.m <= 3);
    // Contract prices go up about 4% each winter.
    const seasonRise = 1.04 ** ((mo.m === 12 ? mo.y : mo.y - 1) - 2023);
    for (const [cust, amt] of snowContracts) invoice(mo.d(1), cust, '', 'Seasonal snow contract', 'Snow Removal', 'Snow', r2(amt * seasonRise), 20);
    const storms = winter2526 ? 5 : 3;
    for (let s2 = 0; s2 < storms; s2++) {
      const day = 3 + s2 * 5;
      for (const cust of ['Walnut Creek Condos', 'Brookfield Apartments', 'Elm Street Deli', 'Birchwood Townhomes', 'Sunset Villas HOA']) invoice(mo.d(day), cust, '', 'Snow plowing and salting - per push', 'Snow Removal', 'Snow', between(260, 620) * (winter2526 ? 0.85 : 1), 18);
      const salt = r2(between(1300, 1900) * (winter2526 ? 1.55 : 1));
      const saltNo = `SL-${mo.y % 100}${pad2(mo.m)}${s2}`;
      P(mo.d(day), 'Bill', saltNo, 'Midwest Salt Co.', '', 'Bulk rock salt', 'Salt & Ice Melt', AP, salt, 'Snow');
      if (within(addDays(mo.d(day), 25))) P(addDays(mo.d(day), 25), 'Bill Payment (Check)', String(chk++), 'Midwest Salt Co.', '', `Pay ${saltNo}`, AP, BANK, salt);
    }
    if (R() < 0.5) P(mo.d(20), 'Expense', '', 'Boss Snowplow Dealer', '', 'Plow blade cutting edge', 'Equipment Repairs', CARD, between(260, 640), 'Snow');
  }

  // Payroll: a year-round core of three, a seasonal crew March to November. Wages are
  // tagged to the service lines; peak weeks bring overtime, heaviest in June 2026.
  for (const mo of M) {
    const crew = ({ 3: 5, 4: 8, 10: 8, 11: 6 })[mo.m] || (inSeason(mo.m) ? 9 : 4);
    const split = inSeason(mo.m) ? [['Maintenance', 0.52], ['Install', 0.35], ['Irrigation', 0.05], ['Enhancements', 0.08]] : [['Snow', 1]];
    const otRate = mo.y === 2026 && mo.m === 6 ? 0.42 : [5, 6, 10].includes(mo.m) ? 0.14 : !inSeason(mo.m) ? 0.22 : 0.05;
    for (const day of [15, mo.days]) {
      const gross = r2(crew * between(1650, 1760) * (mo.y === 2026 ? 1.05 : 1) * (inSeason(mo.m) ? 1 : 1.1));
      for (const [cls, share] of split) {
        const w = r2(gross * share), ot = r2(w * otRate);
        P(mo.d(day), 'Payroll Check', '', 'Gusto', '', 'Payroll', 'Payroll Expenses:Wages', BANK, r2(w * 0.8), cls);
        P(mo.d(day), 'Journal Entry', '', 'Gusto', '', 'Payroll withholding', 'Payroll Expenses:Wages', 'Payroll Liabilities', r2(w * 0.2), cls);
        if (ot) P(mo.d(day), 'Payroll Check', '', 'Gusto', '', 'Overtime', 'Payroll Expenses:Overtime', BANK, ot, cls);
        P(mo.d(day), 'Journal Entry', '', 'Gusto', '', 'Employer payroll taxes', 'Payroll Expenses:Taxes', 'Payroll Liabilities', r2((w + ot) * 0.0765), cls);
      }
    }
  }
  const liab = new Map();
  for (const e of b.entries) if (e.cr === 'Payroll Liabilities') liab.set(e.date.slice(0, 7), r2((liab.get(e.date.slice(0, 7)) || 0) + e.amount));
  for (const mo of M.slice(1)) P(mo.d(12), 'Tax Payment', '', 'IRS / State EFTPS', '', 'Payroll tax deposit', 'Payroll Liabilities', BANK, liab.get(`${M[mo.k - 1].y}-${pad2(M[mo.k - 1].m)}`) || 0);
  // Sales tax: quarterly.
  const st = new Map();
  for (const e of b.entries) if (e.cr === 'Sales Tax Payable') { const qk = `${e.date.slice(0, 4)}-Q${Math.ceil(+e.date.slice(5, 7) / 3)}`; st.set(qk, r2((st.get(qk) || 0) + e.amount)); }
  for (const [qk, date] of Object.entries({ '2024-Q2': '2024-07-20', '2024-Q3': '2024-10-20', '2024-Q4': '2025-01-20', '2025-Q2': '2025-07-20', '2025-Q3': '2025-10-20', '2025-Q4': '2026-01-20', '2026-Q2': '2026-07-20' })) {
    if (st.get(qk)) P(date, 'Sales Tax Payment', '', 'State Dept. of Revenue', '', `Sales tax ${qk}`, 'Sales Tax Payable', BANK, st.get(qk));
  }

  // Equipment, vehicles and fuel.
  for (const mo of M) {
    const summer = inSeason(mo.m);
    for (const day of [5, 12, 19, 26]) P(mo.d(day), 'Expense', '', 'WEX Fleet Card', '', 'Fuel - trucks and mowers', 'Fuel', CARD, between(summer ? 520 : 210, summer ? 780 : 340) * (mo.y === 2026 ? 1.12 : 1));
    if (summer && mo.k % 2 === 0) P(mo.d(16), 'Expense', '', 'Midwest Turf Equipment', '', 'Mower blades, belts, filters', 'Equipment Repairs', CARD, between(280, 760));
    if (mo.k % 5 === 3) P(mo.d(23), 'Expense', '', 'Jiffy Truck Service', '', 'Truck service', 'Vehicle Repairs', CARD, between(180, 520));
    // Loans: John Deere (mowers) and Ally (crew truck); interest shrinking over time.
    P(mo.d(10), 'Check', String(chk++), 'John Deere Financial', '', 'Equipment loan - interest', 'Interest Expense', BANK, r2(310 - mo.k * 5));
    P(mo.d(10), 'Check', String(chk - 1), 'John Deere Financial', '', 'Equipment loan - principal', 'John Deere Financial', BANK, r2(1140 + mo.k * 5));
    P(mo.d(14), 'Check', String(chk++), 'Ally Financial', '', 'Truck loan - interest', 'Interest Expense', BANK, r2(190 - mo.k * 3));
    P(mo.d(14), 'Check', String(chk - 1), 'Ally Financial', '', 'Truck loan - principal', 'Ally Truck Loan', BANK, r2(790 + mo.k * 3));
  }
  // One mower keeps breaking down in 2026.
  for (const [date, amt, memo] of [['2026-04-22', 1180, 'Exmark Lazer Z #3 - hydrostatic pump'], ['2026-05-30', 960, 'Exmark Lazer Z #3 - deck spindle and belts'], ['2026-06-24', 1420, 'Exmark Lazer Z #3 - engine repair'], ['2026-08-05', 1260, 'Exmark Lazer Z #3 - hydraulic lines']]) P(date, 'Check', String(chk++), 'Midwest Turf Equipment', '', memo, 'Equipment Repairs', BANK, amt);
  // A trailer bought and recorded properly, and a new mower recorded as a repair.
  P('2025-03-15', 'Check', String(chk++), 'Big Tex Trailers', '', '16 ft enclosed trailer', 'Equipment', BANK, 8900);
  P('2026-04-08', 'Check', String(chk++), 'Midwest Turf Equipment', '', 'Exmark Lazer Z 60in zero-turn mower (new)', 'Equipment Repairs', BANK, 12480);
  P('2026-03-20', 'Expense', '', 'Stihl Dealer', '', 'Backpack blowers (5)', 'Small Tools', CARD, 3150);
  P('2024-12-31', 'Journal Entry', 'YE24', '', '', 'Depreciation 2024', 'Depreciation', 'Accumulated Depreciation', 14200);
  P('2025-12-31', 'Journal Entry', 'YE25', '', '', 'Depreciation 2025', 'Depreciation', 'Accumulated Depreciation', 15650);
  // The line of credit carries the spring ramp-up each year and is paid back in summer.
  for (const [draw, pay1, pay2] of [['2024-03-18', '2024-07-15', '2024-08-15'], ['2025-03-17', '2025-07-15', '2025-08-15'], ['2026-03-16', '2026-07-15', '2026-08-17']]) {
    P(draw, 'Deposit', '', 'First State Bank', '', 'Line of credit draw', BANK, LOC, 25000);
    P(pay1, 'Check', String(chk++), 'First State Bank', '', 'Line of credit payment', LOC, BANK, 12500);
    P(pay2, 'Check', String(chk++), 'First State Bank', '', 'Line of credit payment', LOC, BANK, 12500);
  }

  // Overhead.
  for (const mo of M) {
    P(mo.d(1), 'Check', String(chk++), 'Hawthorne Properties', '', 'Shop and yard rent', 'Shop Rent', BANK, mo.y === 2024 ? 4600 : 4850);
    P(mo.d(4), 'Expense', '', 'Enterprise Fleet', '', 'Crew truck leases (2)', 'Truck Leases', BANK, 1780);
    P(mo.d(15), 'Check', String(chk++), 'Keller CPA Group', '', 'Bookkeeping and tax prep', 'Professional Fees', BANK, 1150);
    P(mo.d(8), 'Expense', '', 'Ameren', '', 'Shop utilities', 'Utilities', BANK, between(210, 420));
    P(mo.d(11), 'Expense', '', 'Verizon Wireless', '', 'Crew phones', 'Telephone', CARD, inSeason(mo.m) ? 412 : 238);
    P(mo.d(3), 'Expense', '', 'LMN Software', '', 'Estimating and scheduling', 'Software & Subscriptions', CARD, 299);
    P(mo.d(5), 'Expense', '', 'Intuit QuickBooks', '', 'QuickBooks Online Plus', 'Software & Subscriptions', CARD, 99);
    P(mo.d(10), 'Expense', '', 'Acuity Insurance', '', 'Workers comp and auto', 'Insurance', BANK, inSeason(mo.m) ? between(2300, 2550) : between(900, 1050));
    if (mo.m === 3 || mo.m === 9) P(mo.d(6), 'Expense', '', 'Cintas', '', 'Crew uniforms', 'Uniforms', CARD, between(640, 980));
    if (mo.m >= 2 && mo.m <= 5) P(mo.d(20), 'Expense', '', 'Facebook Ads', '', 'Spring booking ads', 'Advertising', CARD, between(350, 700));
    P(mo.d(28), 'Check', String(chk++), 'Tom Greenway', '', 'Owner draw', 'Owner Draws', BANK, inSeason(mo.m) ? 13000 : 7500);
  }
  P('2024-01-15', 'Check', String(chk++), 'Acuity Insurance', '', 'General liability - annual', 'Insurance', BANK, 5980);
  P('2025-01-15', 'Check', String(chk++), 'Acuity Insurance', '', 'General liability - annual', 'Insurance', BANK, 6420);
  P('2026-01-15', 'Check', String(chk++), 'Acuity Insurance', '', 'General liability - annual', 'Insurance', BANK, 6890);
  // Ordinary bookkeeping slips.
  P('2026-06-09', 'Expense', '', '', '', 'POS DEBIT 0609 FARM & FLEET', 'Uncategorized Expense', CARD, 286.4);
  P('2026-07-21', 'Expense', '', 'WEX Fleet Card', '', 'Fuel - trucks and mowers', 'Fuel', CARD, 612.18);
  P('2026-07-21', 'Expense', '', 'WEX Fleet Card', '', 'Fuel - trucks and mowers', 'Fuel', CARD, 612.18);

  payCard(b, CARD, BANK, 'Chase', M);
  const openings = { 'Operating Checking': 45000, 'John Deere Financial': 68000, 'Ally Truck Loan': 41000, 'Equipment': 142000, 'Accumulated Depreciation': -48000 };
  return { b, openings };
}

// ------------------------------------------------------------------ write everything

function edited(csv) {
  // The same export a month later, after the owner "tidied up" months that were already closed.
  return csv.split('\n')
    .map((l) => (l.includes('05/20/2026') && l.includes('Shop supplies') ? l.replace(/Shop supplies/, 'Shop supplies and a gift card') : l))
    .map((l) => (l.includes('06/11/2026') && l.includes('Crew phones') ? l.replace(',318.45,', ',418.45,') : l))
    .filter((l) => !(l.includes('04/21/2026') && l.includes('Crew lunch')))
    .join('\n');
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const period = '"January 2025 - August 2026"';
  const write = (name, text) => fs.writeFileSync(path.join(OUT, name), text);

  const rb = riverbend();
  const rbCsv = transactionDetail(rb.b, rb.openings, period.replace(/"/g, ''));
  write('riverbend-transaction-detail.csv', rbCsv);
  write('riverbend-transaction-detail-september-update.csv', edited(rbCsv));
  write('riverbend-chart-of-accounts.csv', chartOfAccounts(rb.b, { 'Undeposited Funds': 'Undeposited Funds', 'Sales Tax Payable': 'Sales Tax Payable', 'Payroll Liabilities': 'Payroll Tax Payable', 'Opening Balance Equity': 'Opening Balance Equity' }));
  write('riverbend-profit-and-loss.csv', profitAndLoss(rb.b, period.replace(/"/g, '')));
  const rbMissing = new Set(['2026-03-12|Carmine\'s', '2026-03-11|Marriott Las Vegas', '2025-12-12|Harry & David']);
  write('riverbend-expenses-with-attachments.csv', expenseList(rb.b, '2025-09-01', (e) => rbMissing.has(`${e.date}|${e.name}`) || (e.dr === 'Meals' && e.date > '2026-04-01')));

  const cf = cafe();
  const cfCsv = transactionDetail(cf.b, cf.openings, period.replace(/"/g, ''), true);
  write('bloom-basil-transaction-detail.csv', cfCsv);
  write('bloom-basil-chart-of-accounts.csv', chartOfAccounts(cf.b, { 'Sales Tax Payable': 'Sales Tax Payable', 'Payroll Liabilities': 'Payroll Tax Payable', 'Opening Balance Equity': 'Opening Balance Equity' }));
  write('bloom-basil-profit-and-loss.csv', profitAndLoss(cf.b, period.replace(/"/g, '')));
  write('bloom-basil-expenses-with-attachments.csv', expenseList(cf.b, '2025-09-01', (e) => ['2026-08-12', '2026-06-21', '2026-04-15'].includes(e.date)));
  const gw = greenway();
  const gwPeriod = 'January 2024 - August 2026';
  write('greenway-transaction-detail.csv', transactionDetail(gw.b, gw.openings, gwPeriod, true));
  write('greenway-chart-of-accounts.csv', chartOfAccounts(gw.b, { 'Undeposited Funds': 'Undeposited Funds', 'Sales Tax Payable': 'Sales Tax Payable', 'Payroll Liabilities': 'Payroll Tax Payable', 'Line of Credit - First State Bank': 'Line of Credit', 'Accumulated Depreciation': 'Accumulated Depreciation' }));
  write('greenway-profit-and-loss.csv', profitAndLoss(gw.b, gwPeriod));
  write('greenway-expenses-with-attachments.csv', expenseList(gw.b, '2025-09-01', () => false));
  console.log(`Wrote test clients to ${path.relative(process.cwd(), OUT)}`);
}

if (require.main === module) main();
module.exports = { riverbend, cafe, greenway, transactionDetail };
