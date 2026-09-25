/*
 * Builds a realistic QuickBooks Online "Transaction Detail by Account" CSV for
 * a fictional design studio, with known issues seeded in so every panel of the
 * dashboard has something to show. Deterministic: same output every run.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LedgerSample = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function rng(seed) {
    return function () {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
  }

  const BANK = 'Checking';
  const CARD = 'Chase Ink Card (4417)';
  const AR = 'Accounts Receivable (A/R)';

  function build() {
    const rand = rng(20260101);
    const entries = [];
    let num = 1040;
    let inv = 2101;
    const d = (m, day) => `${String(m).padStart(2, '0')}/${String(day).padStart(2, '0')}/2026`;
    const money = (a, b) => Math.round((a + rand() * (b - a)) * 100) / 100;
    const add = (e) => entries.push(e);

    const customers = [
      { name: 'Northwind Outfitters', project: 'Spring Catalog', fee: [9800, 12500], cost: 0.28 },
      { name: 'Bluebird Bakery', project: 'Brand Refresh', fee: [3200, 4200], cost: 0.18 },
      { name: 'Cedar Ridge Dental', project: 'Website Build', fee: [5200, 6400], cost: 0.46 },
      { name: 'Oakline Realty', project: 'Listing Collateral', fee: [2600, 3400], cost: 0.9 },
      { name: 'Summit Fitness', project: 'Social Retainer', fee: [2400, 2400], cost: 0.12 },
      { name: 'Harborview Hotel', project: 'Signage', fee: [6800, 8800], cost: 0.55 },
    ];

    for (let m = 1; m <= 6; m++) {
      // Revenue and job costs per customer.
      customers.forEach((c, i) => {
        if (c.name === 'Harborview Hotel' && m < 3) return;
        const fee = money(c.fee[0], c.fee[1]);
        const cust = `${c.name}:${c.project}`;
        add({ date: d(m, 3 + i), type: 'Invoice', num: String(inv++), name: c.name, customer: cust, memo: `${c.project} - ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'][m - 1]} services`, pnl: 'Design Services Income', bs: AR, amount: fee });
        add({ date: d(m, 18 + i), type: 'Payment', num: '', name: c.name, customer: cust, memo: 'Payment received', pnl: null, bs: BANK, bs2: AR, amount: fee });
        const sub = Math.round(fee * c.cost * (0.85 + rand() * 0.3) * 100) / 100;
        const vendor = ['Lena Ortiz Illustration', 'PrintWorks Co.', 'Dev Studio Partners', 'PrintWorks Co.', 'Lena Ortiz Illustration', 'Metro Sign Fabricators'][i];
        const acct = vendor === 'PrintWorks Co.' || vendor === 'Metro Sign Fabricators' ? 'Job Materials & Printing' : 'Subcontractors';
        add({ date: d(m, 10 + i), type: 'Bill', num: `B-${m}${i}`, name: vendor, customer: cust, memo: `${c.project} production`, pnl: acct, bs: 'Accounts Payable (A/P)', amount: sub });
      });

      // Fixed overhead.
      add({ date: d(m, 1), type: 'Check', num: String(num++), name: 'Brightline Properties', customer: '', memo: 'Studio rent', pnl: 'Rent & Lease', bs: BANK, amount: 3200 });
      add({ date: d(m, 15), type: 'Expense', num: '', name: 'Gusto', customer: '', memo: 'Payroll', pnl: 'Payroll Expenses:Wages', bs: BANK, amount: money(11800, 12400) });
      add({ date: d(m, 12), type: 'Expense', num: '', name: 'Comcast Business', customer: '', memo: 'Internet', pnl: 'Utilities', bs: BANK, amount: 129.99 });
      add({ date: d(m, 20), type: 'Expense', num: '', name: 'The Home Depot', customer: '', memo: 'Studio supplies', pnl: 'Office Supplies', bs: CARD, amount: money(40, 160) });
      add({ date: d(m, 9), type: 'Expense', num: '', name: 'Blue Door Cafe', customer: '', memo: 'Client lunch', pnl: 'Meals', bs: CARD, amount: money(45, 120) });

      // Software stack.
      const saas = [
        ['Adobe Creative Cloud', m >= 4 ? 89.99 : 79.99, 2],
        ['Canva Pro', 14.99, 4],
        ['Slack Technologies', 43.75, 5],
        ['Zoom Video Communications', 15.99, 6],
        ['Microsoft 365 Business', 66.0, 6],
        ['Google Workspace', 72.0, 7],
        ['Dropbox', 19.99, 8],
        ['Asana', 30.49, 10],
        ['Monday.com', 36.0, 11],
        ['QuickBooks Online', 90.0, 14],
        ['Zapier', 29.99, 16],
        ['Spotify', 11.99, 21],
        ['Calendly', 12.0, 22],
      ];
      for (const [vendor, amt, day] of saas) {
        add({ date: d(m, day), type: 'Expense', num: '', name: vendor, customer: '', memo: `${vendor} subscription`, pnl: 'Software & Subscriptions', bs: CARD, amount: amt });
      }
      // Two Notion workspaces billed separately every month.
      add({ date: d(m, 3), type: 'Expense', num: '', name: 'Notion Labs', customer: '', memo: 'Notion Plus - workspace A', pnl: 'Software & Subscriptions', bs: CARD, amount: 20.0 });
      add({ date: d(m, 17), type: 'Expense', num: '', name: 'Notion Labs', customer: '', memo: 'Notion Plus - workspace B', pnl: 'Software & Subscriptions', bs: CARD, amount: 20.0 });
    }
    // Annual renewal.
    add({ date: d(2, 26), type: 'Expense', num: '', name: 'Squarespace', customer: '', memo: 'Squarespace Business annual plan', pnl: 'Software & Subscriptions', bs: CARD, amount: 276.0 });

    // ---- Seeded issues ------------------------------------------------------
    // Uncategorized
    const unc = [
      [1, 22, 'Amazon', 'AMZN Mktp US*2K41', 86.44],
      [2, 7, '', 'POS DEBIT 4471 SQ *MAKERS', 212.0],
      [2, 19, 'Venmo', 'Venmo payment', 350.0],
      [3, 11, 'Amazon', 'AMZN Mktp US*7Q02', 143.9],
      [4, 2, '', 'ACH DEBIT WEB PMT 88213', 1200.0],
      [4, 24, 'Costco', 'COSTCO WHSE #0412', 318.27],
      [5, 13, 'Uber', 'UBER *TRIP', 64.18],
      [6, 5, 'Best Buy', 'BESTBUY 00012', 1499.99],
    ];
    unc.forEach(([m, day, name, memo, amt]) => add({ date: d(m, day), type: 'Expense', num: '', name, customer: '', memo, pnl: 'Uncategorized Expense', bs: name === 'Amazon' || name === 'Best Buy' ? CARD : BANK, amount: amt }));
    add({ date: d(3, 27), type: 'Deposit', num: '', name: '', customer: '', memo: 'Mobile deposit', pnl: 'Uncategorized Income', bs: BANK, amount: 1850.0 });
    add({ date: d(5, 29), type: 'Deposit', num: '', name: 'Stripe', customer: '', memo: 'STRIPE TRANSFER', pnl: 'Uncategorized Income', bs: BANK, amount: 642.3 });
    add({ date: d(6, 11), type: 'Check', num: String(num++), name: 'R. Patel', customer: '', memo: 'Check - no memo', pnl: 'Ask My Accountant', bs: BANK, amount: 750.0 });

    // Duplicates
    add({ date: d(3, 12), type: 'Bill', num: 'B-31', name: 'PrintWorks Co.', customer: 'Bluebird Bakery:Brand Refresh', memo: 'Brand Refresh production', pnl: 'Job Materials & Printing', bs: 'Accounts Payable (A/P)', amount: entries.find((e) => e.num === 'B-31').amount });
    add({ date: d(4, 2), type: 'Expense', num: '', name: 'Brightline Properties', customer: '', memo: 'ONLINE PMT BRIGHTLINE PROP', pnl: 'Rent & Lease', bs: BANK, amount: 3200 });
    add({ date: d(5, 21), type: 'Expense', num: '', name: 'Blue Door Cafe', customer: '', memo: 'Client lunch', pnl: 'Meals', bs: CARD, amount: 88.5 });
    add({ date: d(5, 22), type: 'Expense', num: '', name: 'Blue Door Cafe', customer: '', memo: 'Client lunch', pnl: 'Meals', bs: CARD, amount: 88.5 });

    // Mismatches
    add({ date: d(2, 14), type: 'Expense', num: '', name: 'Staples', customer: '', memo: 'Printer toner', pnl: 'Design Services Income', bs: CARD, amount: 94.12 });
    add({ date: d(4, 20), type: 'Expense', num: '', name: 'The Home Depot', customer: '', memo: 'Shelving', pnl: 'Meals', bs: CARD, amount: 227.4 });
    add({ date: d(5, 6), type: 'Sales Receipt', num: '1009', name: 'Walk-in client', customer: '', memo: 'Logo consult', pnl: 'Advertising & Marketing', bs: BANK, amount: 450.0 });
    add({ date: d(3, 30), type: 'Transfer', num: '', name: '', customer: '', memo: 'Transfer to savings', pnl: 'Bank Fees', bs: BANK, amount: 2500.0 });
    add({ date: d(6, 18), type: 'Expense', num: '', name: '', customer: '', memo: 'Card purchase', pnl: 'Office Supplies', bs: CARD, amount: 58.2 });

    return toCSV(entries);
  }

  // Lay entries out QuickBooks-style: one section per account, each entry
  // appearing under both of the accounts it touches.
  function toCSV(entries) {
    const sections = new Map();
    const push = (acct, row) => {
      if (!sections.has(acct)) sections.set(acct, []);
      sections.get(acct).push(row);
    };
    const reversing = (t) => /credit memo|refund|vendor credit/i.test(t);
    for (const e of entries) {
      const base = { date: e.date, type: e.type, num: e.num, name: e.name, customer: e.customer, memo: e.memo };
      if (e.type === 'Payment') {
        push(e.bs, { ...base, split: e.bs2, amount: e.amount });
        push(e.bs2, { ...base, split: e.bs, amount: -e.amount });
        continue;
      }
      if (e.type === 'Transfer') {
        push(e.bs, { ...base, split: e.pnl, amount: -e.amount });
        push(e.pnl, { ...base, split: e.bs, amount: e.amount });
        continue;
      }
      const incoming = /invoice|sales receipt|deposit/i.test(e.type);
      const sign = reversing(e.type) ? -1 : 1;
      const bsAmt = e.bs === AR || e.bs === BANK ? (incoming ? 1 : -1) * e.amount : e.amount;
      push(e.bs, { ...base, split: e.pnl, amount: sign * bsAmt });
      push(e.pnl, { ...base, split: e.bs, amount: sign * e.amount });
    }

    const order = [BANK, AR, CARD, 'Accounts Payable (A/P)', 'Design Services Income', 'Uncategorized Income'];
    const names = [...sections.keys()].sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      return a.localeCompare(b);
    });

    const q = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const fmt = (n) => n.toFixed(2);
    const toKey = (s) => { const [m, dd, y] = s.split('/'); return `${y}${m}${dd}`; };
    const lines = [
      'Harbor & Pine Design Co.',
      'Transaction Detail by Account',
      '"January - June, 2026"',
      '',
      ['', 'Date', 'Transaction Type', 'Num', 'Name', 'Customer', 'Memo/Description', 'Split', 'Amount', 'Balance'].join(','),
    ];
    for (const acct of names) {
      const rows = sections.get(acct).sort((a, b) => toKey(a.date).localeCompare(toKey(b.date)));
      lines.push(q(acct));
      let bal = 0;
      for (const r of rows) {
        bal += r.amount;
        lines.push(['', r.date, r.type, r.num, r.name, r.customer, r.memo, r.split, fmt(r.amount), fmt(bal)].map(q).join(','));
      }
      lines.push([q(`Total for ${acct}`), '', '', '', '', '', '', '', `"$${bal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}"`, ''].join(','));
    }
    lines.push('');
    lines.push('');
    lines.push('Accrual Basis Friday, July 3, 2026 09:14 AM GMT-05:00');
    return lines.join('\n');
  }

  return { build };
});
