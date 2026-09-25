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
  const OPENING_CASH = 26500;

  const MONTHS = 18; // January 2025 through June 2026
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function build() {
    const rand = rng(20260101);
    const entries = [];
    let num = 1040;
    let inv = 2001;
    // Month index k: 0 = Jan 2025 ... 17 = Jun 2026.
    const ym = (k) => ({ y: 2025 + Math.floor(k / 12), m: (k % 12) + 1 });
    const d = (k, day) => { const { y, m } = ym(k); return `${String(m).padStart(2, '0')}/${String(day).padStart(2, '0')}/${y}`; };
    const d26 = (m, day) => d(11 + m, day); // month m of 2026
    const money = (a, b) => Math.round((a + rand() * (b - a)) * 100) / 100;
    const add = (e) => entries.push(e);
    const AS_OF = Date.UTC(2026, 5, 30);
    // Date `days` after month k / day, or null when it falls after the export's end.
    const after = (k, day, days) => {
      const { y, m } = ym(k);
      const t = Date.UTC(y, m - 1, day) + days * 86400000;
      if (t > AS_OF) return null;
      const x = new Date(t);
      return `${String(x.getUTCMonth() + 1).padStart(2, '0')}/${String(x.getUTCDate()).padStart(2, '0')}/${x.getUTCFullYear()}`;
    };

    // from/to: active month range. pays: days to pay in 2025 and in 2026.
    const customers = [
      { name: 'Northwind Outfitters', project: 'Spring Catalog', fee: [9800, 12500], cost: 0.28, pays: [24, 24], from: 0, to: 17, vendor: 'Lena Ortiz Illustration', raise: 1.06 },
      { name: 'Bluebird Bakery', project: 'Brand Refresh', fee: [3200, 4200], cost: 0.18, pays: [12, 12], from: 0, to: 17, vendor: 'PrintWorks Co.' },
      { name: 'Cedar Ridge Dental', project: 'Website Build', fee: [5200, 6400], cost: 0.46, pays: [22, 33], from: 4, to: 17, vendor: 'Dev Studio Partners' },
      { name: 'Oakline Realty', project: 'Listing Collateral', fee: [2600, 3400], cost: 0.9, pays: [30, 47], from: 0, to: 17, vendor: 'PrintWorks Co.' },
      { name: 'Summit Fitness', project: 'Social Retainer', fee: [2400, 2400], cost: 0.12, pays: [6, 6], from: 6, to: 17, vendor: 'Lena Ortiz Illustration' },
      { name: 'Harborview Hotel', project: 'Signage', fee: [6800, 8800], cost: 0.55, pays: [54, 54], from: 14, to: 17, vendor: 'Metro Sign Fabricators' },
      { name: 'Lakeside Brewing', project: 'Label Series', fee: [4200, 5200], cost: 0.3, pays: [20, 20], from: 0, to: 8, vendor: 'Lena Ortiz Illustration' },
    ];

    for (let k = 0; k < MONTHS; k++) {
      const { y, m } = ym(k);
      const in2026 = y === 2026;
      // Revenue and job costs per customer.
      customers.forEach((c, i) => {
        if (k < c.from || k > c.to) return;
        const fee = Math.round(money(c.fee[0], c.fee[1]) * (in2026 && c.raise ? c.raise : 1) * 100) / 100;
        const cust = `${c.name}:${c.project}`;
        add({ date: d(k, 3 + i), type: 'Invoice', num: String(inv++), name: c.name, customer: cust, memo: `${c.project} - ${MON[m - 1]} services`, pnl: 'Design Services Income', bs: AR, amount: fee });
        // Cedar Ridge disputed its March 2026 invoice and has not paid it.
        const paid = after(k, 3 + i, c.pays[in2026 ? 1 : 0] + Math.round(rand() * 6 - 3));
        if (paid && !(c.name === 'Cedar Ridge Dental' && k === 14)) {
          add({ date: paid, type: 'Payment', num: '', name: c.name, customer: cust, memo: 'Payment received', pnl: null, bs: BANK, bs2: AR, amount: fee });
        }
        const sub = Math.round(fee * c.cost * (0.85 + rand() * 0.3) * 100) / 100;
        const acct = c.vendor === 'PrintWorks Co.' || c.vendor === 'Metro Sign Fabricators' ? 'Job Materials & Printing' : 'Subcontractors';
        const billNo = `B${String(y).slice(2)}${String(m).padStart(2, '0')}-${i}`;
        add({ date: d(k, 10 + i), type: 'Bill', num: billNo, name: c.vendor, customer: cust, memo: `${c.project} production`, pnl: acct, bs: 'Accounts Payable (A/P)', amount: sub });
        // PrintWorks gets paid the week its bill arrives; everyone else on 21 or 30 days.
        const billPaid = after(k, 10 + i, c.vendor === 'Dev Studio Partners' ? 30 : c.vendor === 'PrintWorks Co.' ? 6 : 21);
        if (billPaid) add({ date: billPaid, type: 'Bill Payment (Check)', num: String(num++), name: c.vendor, customer: '', memo: `Pay ${billNo}`, pnl: null, bs: BANK, bs2: 'Accounts Payable (A/P)', amount: sub });
      });

      // Fixed overhead. A designer was hired in September 2025; the lease renewed in January 2026.
      add({ date: d(k, 1), type: 'Check', num: String(num++), name: 'Brightline Properties', customer: '', memo: 'Studio rent', pnl: 'Rent & Lease', bs: BANK, amount: in2026 ? 3200 : 3000 });
      add({ date: d(k, 15), type: 'Expense', num: '', name: 'Gusto', customer: '', memo: 'Payroll', pnl: 'Payroll Expenses:Wages', bs: BANK, amount: k >= 8 ? money(11800, 12400) : money(8900, 9300) });
      add({ date: d(k, 12), type: 'Expense', num: '', name: 'Comcast Business', customer: '', memo: 'Internet', pnl: 'Utilities', bs: BANK, amount: 129.99 });
      add({ date: d(k, 20), type: 'Expense', num: '', name: 'The Home Depot', customer: '', memo: 'Studio supplies', pnl: 'Office Supplies', bs: CARD, amount: money(40, 160) });
      add({ date: d(k, 9), type: 'Expense', num: '', name: 'Blue Door Cafe', customer: '', memo: 'Client lunch', pnl: 'Meals', bs: CARD, amount: money(45, 120) });

      // Software stack, with tools added over time: [vendor, amount, day, first month].
      const saas = [
        ['Adobe Creative Cloud', k >= 15 ? 89.99 : 79.99, 2, 0],
        ['Canva Pro', 14.99, 4, 0],
        ['Slack Technologies', k >= 8 ? 43.75 : 35.0, 5, 0],
        ['Zoom Video Communications', 15.99, 6, 0],
        ['Microsoft 365 Business', 66.0, 6, 0],
        ['Google Workspace', k >= 8 ? 72.0 : 54.0, 7, 0],
        ['Dropbox', 19.99, 8, 0],
        ['Asana', 30.49, 10, 0],
        ['Monday.com', 36.0, 11, 13],
        ['QuickBooks Online', 90.0, 14, 0],
        ['Zapier', 29.99, 16, 9],
        ['Spotify', 11.99, 21, 0],
        ['Calendly', 12.0, 22, 3],
      ];
      for (const [vendor, amt, day, first] of saas) {
        if (k < first) continue;
        add({ date: d(k, day), type: 'Expense', num: '', name: vendor, customer: '', memo: `${vendor} subscription`, pnl: 'Software & Subscriptions', bs: CARD, amount: amt });
      }
      // A second Notion workspace appeared in 2026 and is billed separately.
      add({ date: d(k, 3), type: 'Expense', num: '', name: 'Notion Labs', customer: '', memo: 'Notion Plus - workspace A', pnl: 'Software & Subscriptions', bs: CARD, amount: 20.0 });
      if (in2026) add({ date: d(k, 17), type: 'Expense', num: '', name: 'Notion Labs', customer: '', memo: 'Notion Plus - workspace B', pnl: 'Software & Subscriptions', bs: CARD, amount: 20.0 });
    }
    // Quarterly owner draws (equity, not an expense).
    [[2, 5000], [5, 6000], [8, 7000], [11, 11000], [14, 3000]].forEach(([k, amt]) => {
      add({ date: d(k, 28), type: 'Check', num: String(num++), name: 'Jordan Pike', customer: '', memo: 'Owner draw', pnl: "Owner's Draw", bs: BANK, amount: amt });
    });

    // Annual renewals.
    add({ date: d(1, 26), type: 'Expense', num: '', name: 'Squarespace', customer: '', memo: 'Squarespace Business annual plan', pnl: 'Software & Subscriptions', bs: CARD, amount: 259.0 });
    add({ date: d26(2, 26), type: 'Expense', num: '', name: 'Squarespace', customer: '', memo: 'Squarespace Business annual plan', pnl: 'Software & Subscriptions', bs: CARD, amount: 276.0 });

    // ---- Seeded issues (all in 2026) -----------------------------------------
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
    unc.forEach(([m, day, name, memo, amt]) => add({ date: d26(m, day), type: 'Expense', num: '', name, customer: '', memo, pnl: 'Uncategorized Expense', bs: name === 'Amazon' || name === 'Best Buy' ? CARD : BANK, amount: amt }));
    add({ date: d26(3, 27), type: 'Deposit', num: '', name: '', customer: '', memo: 'Mobile deposit', pnl: 'Uncategorized Income', bs: BANK, amount: 1850.0 });
    add({ date: d26(5, 29), type: 'Deposit', num: '', name: 'Stripe', customer: '', memo: 'STRIPE TRANSFER', pnl: 'Uncategorized Income', bs: BANK, amount: 642.3 });
    add({ date: d26(6, 11), type: 'Check', num: String(num++), name: 'R. Patel', customer: '', memo: 'Check - no memo', pnl: 'Ask My Accountant', bs: BANK, amount: 750.0 });

    // Duplicates: a bill keyed in twice, rent paid online on top of the check, a lunch charged twice.
    const dupOf = entries.find((e) => e.num === 'B2603-1');
    add({ ...dupOf, date: d26(3, 12) });
    add({ date: d26(4, 2), type: 'Expense', num: '', name: 'Brightline Properties', customer: '', memo: 'ONLINE PMT BRIGHTLINE PROP', pnl: 'Rent & Lease', bs: BANK, amount: 3200 });
    add({ date: d26(5, 21), type: 'Expense', num: '', name: 'Blue Door Cafe', customer: '', memo: 'Client lunch', pnl: 'Meals', bs: CARD, amount: 88.5 });
    add({ date: d26(5, 22), type: 'Expense', num: '', name: 'Blue Door Cafe', customer: '', memo: 'Client lunch', pnl: 'Meals', bs: CARD, amount: 88.5 });

    // Mismatches
    add({ date: d26(2, 14), type: 'Expense', num: '', name: 'Staples', customer: '', memo: 'Printer toner', pnl: 'Design Services Income', bs: CARD, amount: 94.12 });
    add({ date: d26(4, 20), type: 'Expense', num: '', name: 'The Home Depot', customer: '', memo: 'Shelving', pnl: 'Meals', bs: CARD, amount: 227.4 });
    add({ date: d26(5, 6), type: 'Sales Receipt', num: '1009', name: 'Walk-in client', customer: '', memo: 'Logo consult', pnl: 'Advertising & Marketing', bs: BANK, amount: 450.0 });
    add({ date: d26(3, 30), type: 'Transfer', num: '', name: '', customer: '', memo: 'Transfer to savings', pnl: 'Bank Fees', bs: BANK, amount: 2500.0 });
    add({ date: d26(6, 18), type: 'Expense', num: '', name: '', customer: '', memo: 'Card purchase', pnl: 'Office Supplies', bs: CARD, amount: 58.2 });

    // Card statement paid from checking on the 25th for the prior month's charges.
    for (let k = 1; k < MONTHS; k++) {
      const { y, m } = ym(k - 1);
      const due = entries.filter((e) => e.bs === CARD && e.date.startsWith(`${String(m).padStart(2, '0')}/`) && e.date.endsWith(`/${y}`)).reduce((t, e) => t + e.amount, 0);
      add({ date: d(k, 25), type: 'Credit Card Payment', num: '', name: 'Chase Card Services', customer: '', memo: 'Card autopay', pnl: null, bs: BANK, bs2: CARD, amount: Math.round(due * 100) / 100 });
    }

    return toCSV(entries, { [BANK]: OPENING_CASH });
  }

  // Lay entries out QuickBooks-style: one section per account, each entry
  // appearing under both of the accounts it touches.
  function toCSV(entries, openings) {
    const sections = new Map();
    const push = (acct, row) => {
      if (!sections.has(acct)) sections.set(acct, []);
      sections.get(acct).push(row);
    };
    const reversing = (t) => /credit memo|refund|vendor credit/i.test(t);
    for (const e of entries) {
      const base = { date: e.date, type: e.type, num: e.num, name: e.name, customer: e.customer, memo: e.memo };
      if (e.bs2) {
        // Customer payments raise cash and lower A/R; bill and card payments lower both sides.
        const cashSign = e.type === 'Payment' ? 1 : -1;
        push(e.bs, { ...base, split: e.bs2, amount: cashSign * e.amount });
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
      '"January 2025 - June 2026"',
      '',
      ['', 'Date', 'Transaction Type', 'Num', 'Name', 'Customer', 'Memo/Description', 'Split', 'Amount', 'Balance'].join(','),
    ];
    for (const acct of names) {
      const rows = sections.get(acct).sort((a, b) => toKey(a.date).localeCompare(toKey(b.date)));
      lines.push(q(acct));
      let bal = (openings && openings[acct]) || 0;
      if (bal) lines.push(['', 'Beginning Balance', '', '', '', '', '', '', '', fmt(bal)].join(','));
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
