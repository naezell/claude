/*
 * Ledger Lens analysis engine.
 * Parses a QuickBooks "Transaction Detail" CSV export and produces the
 * diagnostic audit, customer profitability and subscription analysis.
 * Pure functions, no DOM: runs in the browser (window.LedgerEngine) and in Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LedgerEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- CSV

  function parseCSV(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  // ---------------------------------------------------------------- field helpers

  const norm = (s) => String(s == null ? '' : s).trim();
  const lower = (s) => norm(s).toLowerCase();

  function parseAmount(v) {
    let s = norm(v);
    if (!s) return null;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    if (/-$/.test(s)) { neg = true; s = s.slice(0, -1); }
    s = s.replace(/[$,\s]/g, '').replace(/^[A-Z]{3}/, '');
    if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
    if (!/^\d*\.?\d+$/.test(s)) return null;
    const n = parseFloat(s);
    return Math.round((neg ? -n : n) * 100) / 100;
  }

  function parseDate(v) {
    const s = norm(v);
    let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
    if (m) {
      let y = +m[3];
      if (y < 100) y += 2000;
      const d = new Date(Date.UTC(y, +m[1] - 1, +m[2]));
      return isNaN(d) ? null : d;
    }
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return null;
  }

  const DAY = 86400000;
  const isoDate = (d) => (d ? d.toISOString().slice(0, 10) : '');

  // Header aliases seen across QuickBooks Online and Desktop exports.
  const COLUMN_ALIASES = {
    date: ['date', 'transaction date', 'txn date'],
    type: ['transaction type', 'type', 'txn type'],
    num: ['num', 'no.', 'number', 'ref no.', 'doc num', 'check no.'],
    name: ['name', 'payee', 'vendor/customer'],
    customer: ['customer', 'customer/project', 'customer:job', 'customer full name', 'customer name'],
    vendor: ['vendor', 'vendor name', 'supplier'],
    project: ['project', 'job'],
    className: ['class', 'class full name'],
    memo: ['memo/description', 'memo', 'description', 'memo/desc'],
    account: ['account', 'account full name', 'account name', 'distribution account', 'posting account'],
    split: ['split', 'split account'],
    amount: ['amount', 'amt', 'net amount'],
    debit: ['debit'],
    credit: ['credit'],
    balance: ['balance', 'running balance'],
  };

  function mapHeader(cells) {
    const map = {};
    const lc = cells.map(lower);
    for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
      for (const a of aliases) {
        const idx = lc.indexOf(a);
        if (idx !== -1) { map[key] = idx; break; }
      }
    }
    return map;
  }

  function findHeaderRow(rows) {
    for (let i = 0; i < Math.min(rows.length, 40); i++) {
      const map = mapHeader(rows[i]);
      if (map.date != null && (map.amount != null || map.debit != null || map.credit != null)) {
        return { index: i, map };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- account classification

  const RX = {
    uncategorized: /uncategori[sz]ed|ask my accountant|suspense|\bunknown\b|to be classified/i,
    balanceSheet: /receivable|payable|checking|savings|\bbank\b|undeposited|credit card|\bvisa\b|mastercard|\bamex\b|american express|\bloan\b|line of credit|equity|retained earnings|opening bal|inventory asset|fixed asset|accumulated|depreciation reserve|prepaid|liabilit|sales tax (payable|agency)|\bowner|\bdraw\b|distributions|contributions|cash on hand|petty cash|\bpaypal\b|stripe balance|clearing|transfer|x{2,}\d{2,}|\*\d{4}|\(\d{4}\)|\b\d{4}\)?$|security deposit|notes payable|payroll clearing|due (to|from)/i,
    income: /income|revenue|\bsales\b(?! tax)|fees earned|service fees|consulting fees|\bbilled\b|reimbursed|markup|discounts given|refunds given|interest earned|commissions? earned/i,
    cogs: /cost of (goods|sales|revenue|labor|services)|\bcogs\b|job (costs|materials|supplies)|subcontract|direct labor|materials/i,
  };

  const EXPENSE_TYPES = /expense|bill|check|purchase|credit card (charge|credit)|vendor credit|cash expense/i;
  const REVERSING_TYPES = /credit memo|refund|vendor credit|credit card credit/i;

  function classifyAccount(name) {
    const s = norm(name);
    if (!s) return 'blank';
    if (RX.uncategorized.test(s)) {
      if (/income/i.test(s)) return 'income';
      if (/asset|liabilit|equity/i.test(s)) return 'balance';
      return 'expense';
    }
    if (RX.cogs.test(s)) return 'cogs';
    if (RX.income.test(s) && !/payable|receivable|unearned|deferred/i.test(s)) return 'income';
    if (/\b(fees?|charges?|expenses?|interest paid)\b/i.test(s) && !/payable|receivable|accrued|prepaid/i.test(s)) return 'expense';
    if (RX.balanceSheet.test(s)) return 'balance';
    return 'expense';
  }

  const leafAccount = (s) => norm(s).split(':').pop().trim();

  // ---------------------------------------------------------------- parse

  function parseTransactions(text, opts) {
    opts = opts || {};
    const rows = parseCSV(text);
    const header = findHeaderRow(rows);
    if (!header) {
      throw new Error('No header row found. Export the report from QuickBooks as CSV with at least Date and Amount (or Debit/Credit) columns.');
    }
    const { map } = header;
    const get = (r, key) => (map[key] != null ? norm(r[map[key]]) : '');
    const meta = rows.slice(0, header.index).map((r) => r.filter(Boolean).join(' ').trim()).filter(Boolean);

    const txns = [];
    let section = '';
    let skippedTotals = 0;
    for (let i = header.index + 1; i < rows.length; i++) {
      const r = rows[i];
      const nonEmpty = r.map(norm).filter(Boolean);
      if (!nonEmpty.length) continue;
      const first = norm(r[0]);
      if (/^total\b/i.test(first) || /^total for\b/i.test(nonEmpty[0])) { skippedTotals++; continue; }
      const date = parseDate(get(r, 'date'));
      if (!date) {
        // Section header in "by Account" layouts ("Office Supplies", "Checking (1)").
        if (nonEmpty.length <= 2 && !/^(tuesday|monday|wednesday|thursday|friday|saturday|sunday),|accrual basis|cash basis|gmt/i.test(nonEmpty[0])) {
          section = nonEmpty[0];
        }
        continue;
      }
      let amount = parseAmount(get(r, 'amount'));
      const debit = parseAmount(get(r, 'debit'));
      const credit = parseAmount(get(r, 'credit'));
      const hasDC = map.debit != null || map.credit != null;
      if (amount == null && hasDC) amount = (debit || 0) - (credit || 0);
      if (amount == null) continue;

      const account = get(r, 'account') || section;
      txns.push({
        id: txns.length + 1,
        line: i + 1,
        date,
        dateStr: isoDate(date),
        type: get(r, 'type'),
        num: get(r, 'num'),
        name: get(r, 'name'),
        customer: get(r, 'customer'),
        vendor: get(r, 'vendor'),
        project: get(r, 'project'),
        className: get(r, 'className'),
        memo: get(r, 'memo'),
        account,
        split: get(r, 'split'),
        amount,
        debit: hasDC ? debit || 0 : null,
        credit: hasDC ? credit || 0 : null,
        amountFromDC: map.amount == null && hasDC,
      });
    }
    return {
      transactions: txns,
      meta: {
        reportLines: meta,
        company: meta[0] || '',
        reportTitle: meta[1] || '',
        period: meta[2] || '',
        columns: Object.keys(map),
        rowCount: txns.length,
        skippedTotals,
        grouped: map.account == null,
      },
    };
  }

  // ---------------------------------------------------------------- audit

  function counterpartyOf(t) {
    return t.name || t.vendor || t.customer || '';
  }

  const entryKey = (t) => [t.dateStr, lower(t.type), t.num, lower(counterpartyOf(t)), Math.abs(t.amount).toFixed(2)].join('|');
  const isPnlClass = (c) => c === 'income' || c === 'expense' || c === 'cogs';

  // "by Account" exports list every entry once per account it touches (bank side
  // and category side). Collapse to one row per entry, keeping true repeats: for
  // each entry key keep the rows of a single account, preferring a P&L account.
  function logicalRows(txns, accountClass) {
    const cls = (a) => (accountClass && accountClass[a]) || classifyAccount(a);
    const byKey = new Map();
    for (const t of txns) {
      const k = entryKey(t);
      if (!byKey.has(k)) byKey.set(k, new Map());
      const accts = byKey.get(k);
      if (!accts.has(t.account)) accts.set(t.account, []);
      accts.get(t.account).push(t);
    }
    const keep = new Set();
    for (const accts of byKey.values()) {
      let best = null;
      for (const [acct, rows] of accts) {
        const score = rows.length * 10 + (RX.uncategorized.test(acct) ? 6 : isPnlClass(cls(acct)) ? 5 : 0);
        if (!best || score > best.score) best = { score, rows };
      }
      best.rows.forEach((r) => keep.add(r.id));
    }
    return txns.filter((t) => keep.has(t.id));
  }

  function findUncategorized(txns) {
    return txns
      .filter((t) => RX.uncategorized.test(t.account) || RX.uncategorized.test(t.split) || (!t.account && !t.split))
      .map((t) => ({
        ...t,
        reason: !t.account && !t.split
          ? 'No account or split assigned'
          : RX.uncategorized.test(t.account) ? `Posted to "${leafAccount(t.account)}"` : `Split to "${leafAccount(t.split)}"`,
      }));
  }

  // One logical transaction per (date, type, num, counterparty, |amount|).
  // In "by Account" exports the same entry appears once per account it touches,
  // so we compare entries that land in the same account only.
  function findDuplicates(txns, windowDays) {
    windowDays = windowDays == null ? 3 : windowDays;
    const groups = [];
    const buckets = new Map();
    for (const t of txns) {
      if (!t.amount) continue;
      const cp = lower(counterpartyOf(t)) || lower(t.memo).slice(0, 24);
      const key = [lower(t.account), cp, Math.abs(t.amount).toFixed(2)].join('|');
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(t);
    }
    for (const list of buckets.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => a.date - b.date);
      let cluster = [list[0]];
      const flush = () => {
        if (cluster.length < 2) return;
        // Distinct reference numbers on the same vendor + amount usually mean
        // separate legitimate bills; only keep clusters that share or lack refs.
        const nums = cluster.map((c) => c.num).filter(Boolean);
        const distinctNums = new Set(nums);
        if (nums.length === cluster.length && distinctNums.size === cluster.length) return;
        const sameDay = cluster.every((c) => c.dateStr === cluster[0].dateStr);
        const sameNum = nums.length >= 2 && distinctNums.size < nums.length;
        groups.push({
          id: groups.length + 1,
          confidence: sameDay || sameNum ? 'High' : 'Medium',
          reason: sameNum
            ? `Same reference #${nums.find((n, i) => nums.indexOf(n) !== i)} entered ${cluster.length}×`
            : sameDay ? `Same payee, amount and date entered ${cluster.length}×` : `Same payee and amount within ${windowDays} days`,
          amount: Math.abs(cluster[0].amount),
          exposure: Math.abs(cluster[0].amount) * (cluster.length - 1),
          rows: cluster,
        });
      };
      for (let i = 1; i < list.length; i++) {
        const t = list[i];
        if ((t.date - cluster[cluster.length - 1].date) / DAY <= windowDays) cluster.push(t);
        else { flush(); cluster = [t]; }
      }
      flush();
    }
    // Recurring subscriptions are exactly-monthly and never within the window,
    // so they are not caught here by construction.
    return groups.sort((a, b) => b.exposure - a.exposure);
  }

  function findMismatches(txns, accountClass, rawTxns) {
    const cls = (a) => accountClass[a] || classifyAccount(a);
    const issues = [];
    const add = (t, kind, detail, severity) => issues.push({ ...t, kind, detail, severity });

    for (const t of txns) {
      const acct = cls(t.account);
      const split = cls(t.split);
      const pnl = acct === 'income' || acct === 'expense' || acct === 'cogs' ? acct
        : split === 'income' || split === 'expense' || split === 'cogs' ? split : null;
      const pnlName = pnl === acct ? t.account : t.split;
      if (/transfer|journal/i.test(t.type)) {
        if (/transfer/i.test(t.type) && pnl && !RX.uncategorized.test(pnlName)) {
          add(t, 'Type / account conflict', `Transfer touching P&L account "${leafAccount(pnlName)}"; transfers should move money between balance-sheet accounts only`, 'High');
        }
        continue;
      }
      if (EXPENSE_TYPES.test(t.type) && pnl === 'income' && !REVERSING_TYPES.test(t.type) && !RX.uncategorized.test(pnlName)) {
        add(t, 'Type / account conflict', `${t.type} coded to income account "${leafAccount(pnlName)}"`, 'High');
      } else if (/invoice|sales receipt/i.test(t.type) && (pnl === 'expense' || pnl === 'cogs') && !RX.uncategorized.test(pnlName)) {
        add(t, 'Type / account conflict', `${t.type} coded to expense account "${leafAccount(pnlName)}"`, 'High');
      } else if (/deposit/i.test(t.type) && (pnl === 'expense' || pnl === 'cogs') && t.amount > 0 && !RX.uncategorized.test(pnlName)) {
        add(t, 'Type / account conflict', `Deposit coded to expense account "${leafAccount(pnlName)}" (possible refund or misposted income)`, 'Medium');
      }
      if (EXPENSE_TYPES.test(t.type) && !counterpartyOf(t)) {
        add(t, 'Missing payee', `${t.type || 'Expense'} with no vendor or payee; 1099 tracking and vendor reporting will miss it`, 'Low');
      }
    }

    // Same vendor coded to different expense categories.
    const byVendor = new Map();
    for (const t of txns) {
      if (!EXPENSE_TYPES.test(t.type) || REVERSING_TYPES.test(t.type)) continue;
      const v = counterpartyOf(t);
      if (!v) continue;
      const cat = ['expense', 'cogs'].includes(cls(t.account)) ? t.account : ['expense', 'cogs'].includes(cls(t.split)) ? t.split : '';
      if (!cat || RX.uncategorized.test(cat)) continue;
      if (!byVendor.has(v)) byVendor.set(v, new Map());
      const m = byVendor.get(v);
      if (!m.has(cat)) m.set(cat, []);
      m.get(cat).push(t);
    }
    for (const [vendor, cats] of byVendor) {
      if (cats.size < 2) continue;
      const sorted = [...cats.entries()].sort((a, b) => b[1].length - a[1].length);
      const [primary, primaryRows] = sorted[0];
      const total = [...cats.values()].reduce((s, l) => s + l.length, 0);
      if (primaryRows.length / total < 0.5 || total < 3) continue;
      for (const [cat, list] of sorted.slice(1)) {
        for (const t of list) {
          add(t, 'Inconsistent coding', `${vendor} is usually coded to "${leafAccount(primary)}" (${primaryRows.length} of ${total}); this one went to "${leafAccount(cat)}"`, 'Medium');
        }
      }
    }

    // Debit / credit imbalance per journal entry, when debit & credit columns exist.
    const raw = rawTxns || txns;
    if (raw.some((t) => t.debit != null)) {
      const entries = new Map();
      for (const t of raw) {
        if (!/journal/i.test(t.type)) continue;
        const k = `${t.dateStr}|${t.num}`;
        if (!entries.has(k)) entries.set(k, []);
        entries.get(k).push(t);
      }
      for (const list of entries.values()) {
        const net = list.reduce((s, t) => s + (t.debit || 0) - (t.credit || 0), 0);
        if (Math.abs(net) > 0.009) {
          add(list[0], 'Out of balance', `Journal entry ${list[0].num || ''} debits and credits differ by ${Math.abs(net).toFixed(2)}`, 'High');
        }
      }
    }

    const rank = { High: 0, Medium: 1, Low: 2 };
    return issues.sort((a, b) => rank[a.severity] - rank[b.severity] || a.date - b.date);
  }

  // ---------------------------------------------------------------- P&L view

  // Turns raw rows into P&L postings: { t, category, cls, value } where value is
  // positive revenue for income and positive cost for expense/COGS.
  function toPostings(txns, accountClass) {
    const cls = (a) => accountClass[a] || classifyAccount(a);
    const isPnl = (c) => c === 'income' || c === 'expense' || c === 'cogs';
    const direct = [];
    const seen = new Set();
    const key = entryKey;
    for (const t of txns) {
      const c = cls(t.account);
      if (!isPnl(c)) continue;
      const sign = t.amountFromDC ? (c === 'income' ? -1 : 1) : 1;
      direct.push({ t, category: t.account, cls: c, value: sign * t.amount });
      seen.add(key(t));
    }
    const fallback = [];
    for (const t of txns) {
      const c = cls(t.account);
      if (isPnl(c)) continue;
      const sc = cls(t.split);
      if (!isPnl(sc) || seen.has(key(t))) continue;
      const mag = Math.abs(t.amount);
      fallback.push({ t, category: t.split, cls: sc, value: REVERSING_TYPES.test(t.type) ? -mag : mag });
      seen.add(key(t));
    }
    return direct.concat(fallback);
  }

  // Falls back to the Name column only on sales forms, where Name is the customer.
  function customerOf(t, cls) {
    let c = t.customer;
    if (!c && cls === 'income' && /invoice|sales receipt|credit memo|refund receipt|statement charge/i.test(t.type)) c = t.name;
    return c;
  }

  function profitability(txns, accountClass, groupBy) {
    groupBy = groupBy || 'customer';
    const postings = toPostings(txns, accountClass);
    const groups = new Map();
    let revenue = 0, cogs = 0, opex = 0, unassignedCost = 0, unassignedRevenue = 0;
    for (const p of postings) {
      const full = customerOf(p.t, p.cls);
      let label;
      if (groupBy === 'project') label = p.t.project || (full && full.includes(':') ? full : '') || (p.t.className ? `Class: ${p.t.className}` : '');
      else label = full ? full.split(':')[0].trim() : '';
      if (p.cls === 'income') revenue += p.value;
      else if (p.cls === 'cogs') cogs += p.value;
      else opex += p.value;
      if (!label) {
        if (p.cls === 'income') unassignedRevenue += p.value;
        else unassignedCost += p.value;
        continue;
      }
      if (!groups.has(label)) groups.set(label, { name: label, revenue: 0, directCost: 0, txnCount: 0 });
      const g = groups.get(label);
      g.txnCount++;
      if (p.cls === 'income') g.revenue += p.value;
      else g.directCost += p.value;
    }
    const totalRevenueAssigned = [...groups.values()].reduce((s, g) => s + g.revenue, 0);
    const list = [...groups.values()].map((g) => {
      const profit = g.revenue - g.directCost;
      // Overhead allocated pro-rata by revenue share for a fully-loaded view.
      const overhead = totalRevenueAssigned > 0 ? unassignedCost * (g.revenue / totalRevenueAssigned) : 0;
      return {
        ...g,
        revenue: round2(g.revenue),
        directCost: round2(g.directCost),
        profit: round2(profit),
        margin: g.revenue ? profit / g.revenue : null,
        overhead: round2(overhead),
        netAfterOverhead: round2(profit - overhead),
        netMargin: g.revenue ? (profit - overhead) / g.revenue : null,
      };
    }).sort((a, b) => b.revenue - a.revenue);
    return {
      groups: list,
      totals: {
        revenue: round2(revenue),
        cogs: round2(cogs),
        opex: round2(opex),
        netIncome: round2(revenue - cogs - opex),
        netMargin: revenue ? (revenue - cogs - opex) / revenue : null,
        unassignedCost: round2(unassignedCost),
        unassignedRevenue: round2(unassignedRevenue),
      },
      postings,
    };
  }

  const round2 = (n) => Math.round(n * 100) / 100;

  // ---------------------------------------------------------------- subscriptions

  const SAAS_VENDORS = [
    ['adobe', 'Design'], ['canva', 'Design'], ['figma', 'Design'], ['sketch', 'Design'],
    ['slack', 'Chat'], ['microsoft teams', 'Chat'],
    ['zoom', 'Video meetings'], ['gotomeeting', 'Video meetings'], ['webex', 'Video meetings'], ['loom', 'Video meetings'],
    ['google workspace', 'Office suite'], ['gsuite', 'Office suite'], ['g suite', 'Office suite'], ['google *gsuite', 'Office suite'],
    ['microsoft 365', 'Office suite'], ['office 365', 'Office suite'], ['msft', 'Office suite'],
    ['dropbox', 'File storage'], ['box.com', 'File storage'], ['google one', 'File storage'], ['icloud', 'File storage'], ['onedrive', 'File storage'],
    ['asana', 'Project management'], ['monday.com', 'Project management'], ['trello', 'Project management'], ['clickup', 'Project management'],
    ['basecamp', 'Project management'], ['smartsheet', 'Project management'], ['wrike', 'Project management'], ['notion', 'Project management'], ['airtable', 'Project management'],
    ['jira', 'Dev tools'], ['atlassian', 'Dev tools'], ['github', 'Dev tools'], ['gitlab', 'Dev tools'],
    ['hubspot', 'CRM'], ['salesforce', 'CRM'], ['pipedrive', 'CRM'], ['zoho', 'CRM'], ['keap', 'CRM'],
    ['mailchimp', 'Email marketing'], ['constant contact', 'Email marketing'], ['klaviyo', 'Email marketing'], ['convertkit', 'Email marketing'], ['activecampaign', 'Email marketing'],
    ['quickbooks', 'Accounting'], ['intuit', 'Accounting'], ['xero', 'Accounting'], ['freshbooks', 'Accounting'], ['bill.com', 'Accounting'],
    ['expensify', 'Accounting'], ['dext', 'Accounting'], ['hubdoc', 'Accounting'], ['gusto', 'Payroll'], ['adp', 'Payroll'], ['paychex', 'Payroll'],
    ['docusign', 'E-signature'], ['pandadoc', 'E-signature'], ['hellosign', 'E-signature'], ['dropbox sign', 'E-signature'],
    ['zapier', 'Automation'], ['make.com', 'Automation'], ['ifttt', 'Automation'],
    ['calendly', 'Scheduling'], ['acuity', 'Scheduling'],
    ['openai', 'AI tools'], ['chatgpt', 'AI tools'], ['anthropic', 'AI tools'], ['claude.ai', 'AI tools'], ['jasper', 'AI tools'], ['grammarly', 'AI tools'], ['otter.ai', 'AI tools'],
    ['aws', 'Hosting'], ['amazon web services', 'Hosting'], ['digitalocean', 'Hosting'], ['heroku', 'Hosting'], ['vercel', 'Hosting'], ['netlify', 'Hosting'],
    ['squarespace', 'Website'], ['wix', 'Website'], ['godaddy', 'Website'], ['wordpress', 'Website'], ['webflow', 'Website'], ['shopify', 'Website'],
    ['lastpass', 'Security'], ['1password', 'Security'], ['dashlane', 'Security'], ['norton', 'Security'], ['mcafee', 'Security'],
    ['ringcentral', 'Phone'], ['dialpad', 'Phone'], ['grasshopper', 'Phone'], ['openphone', 'Phone'], ['vonage', 'Phone'],
    ['linkedin', 'Sales tools'], ['semrush', 'Marketing tools'], ['ahrefs', 'Marketing tools'], ['hootsuite', 'Marketing tools'], ['buffer', 'Marketing tools'], ['later.com', 'Marketing tools'],
    ['typeform', 'Forms'], ['jotform', 'Forms'], ['surveymonkey', 'Forms'],
    ['spotify', 'Personal / entertainment'], ['netflix', 'Personal / entertainment'], ['hulu', 'Personal / entertainment'], ['apple.com/bill', 'Personal / entertainment'], ['audible', 'Personal / entertainment'],
  ];
  const NOT_SAAS_ACCOUNT = /payroll|wages|salar|rent|lease|loan|insurance|tax|contract labor|subcontract/i;
  const SAAS_ACCOUNT = /software|subscription|saas|dues|computer|internet|web ?hosting|technology|apps?\b/i;

  function saasCategory(text) {
    const s = lower(text);
    for (const [kw, cat] of SAAS_VENDORS) if (s.includes(kw)) return cat;
    return null;
  }

  const median = (arr) => {
    const a = [...arr].sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };

  function cadenceOf(days) {
    if (days >= 5 && days <= 9) return { label: 'Weekly', perYear: 52 };
    if (days >= 25 && days <= 35) return { label: 'Monthly', perYear: 12 };
    if (days >= 80 && days <= 100) return { label: 'Quarterly', perYear: 4 };
    if (days >= 340 && days <= 390) return { label: 'Annual', perYear: 1 };
    return null;
  }

  function subscriptions(txns, accountClass) {
    const postings = toPostings(txns, accountClass).filter((p) => p.cls !== 'income' && p.value > 0);
    const byVendor = new Map();
    for (const p of postings) {
      const vendor = p.t.vendor || p.t.name || p.t.memo.replace(/[#*]?\d{3,}.*$/, '').trim().slice(0, 40);
      if (!vendor) continue;
      const k = lower(vendor);
      if (!byVendor.has(k)) byVendor.set(k, { vendor, rows: [] });
      byVendor.get(k).rows.push(p);
    }

    const subs = [];
    for (const { vendor, rows } of byVendor.values()) {
      rows.sort((a, b) => a.t.date - b.t.date);
      const text = `${vendor} ${rows.map((r) => r.t.memo).join(' ')}`;
      const category = saasCategory(text);
      const inSoftwareAcct = rows.some((r) => SAAS_ACCOUNT.test(r.category));
      const amounts = rows.map((r) => r.value);
      // Group same-month charges to catch multiple seats/accounts billed separately.
      const byMonth = new Map();
      for (const r of rows) {
        const m = r.t.dateStr.slice(0, 7);
        byMonth.set(m, (byMonth.get(m) || 0) + 1);
      }
      const months = [...byMonth.keys()].sort();
      const firstOfMonth = months.map((m) => rows.find((r) => r.t.dateStr.startsWith(m)).t.date);
      const gaps = [];
      for (let i = 1; i < firstOfMonth.length; i++) gaps.push((firstOfMonth[i] - firstOfMonth[i - 1]) / DAY);
      let cadence = gaps.length ? cadenceOf(median(gaps)) : null;
      if (!cadence && rows.length === 1 && (category || inSoftwareAcct) && /annual|yearly|\/yr|per year/i.test(text)) {
        cadence = { label: 'Annual', perYear: 1 };
      }
      const recurring = !!cadence && (rows.length >= 3 || (cadence.perYear <= 4 && rows.length >= 2) || cadence.label === 'Annual');
      if (!recurring) continue;
      // Wages, rent and other large fixed costs recur too, but they are not software.
      if (rows.some((r) => NOT_SAAS_ACCOUNT.test(r.category)) && !inSoftwareAcct) continue;
      if (median(rows.map((r) => r.value)) > 5000 && !inSoftwareAcct) continue;
      if (!category && !inSoftwareAcct) {
        // Recurring but not software: keep only if amounts are steady (rent-like
        // bills are excluded because they are not in software accounts).
        continue;
      }
      const mean = amounts.reduce((s, a) => s + a, 0) / amounts.length;
      const perCharge = median(amounts);
      const multiPerMonth = [...byMonth.values()].filter((n) => n > 1).length;
      const chargesPerPeriod = cadence.label === 'Monthly' && multiPerMonth >= Math.max(2, months.length / 2)
        ? median([...byMonth.values()]) : 1;
      const annualized = round2(perCharge * chargesPerPeriod * cadence.perYear);
      const first = amounts[0];
      const last = amounts[amounts.length - 1];
      const flags = [];
      if (last > first * 1.1 && last - first >= 2) flags.push({ kind: 'Price increase', detail: `${fmtMoney(first)} → ${fmtMoney(last)} (+${Math.round((last / first - 1) * 100)}%)` });
      if (multiPerMonth) flags.push({ kind: 'Multiple charges per period', detail: `${multiPerMonth} month(s) billed more than once; check for duplicate accounts or unused seats` });
      if (category === 'Personal / entertainment') flags.push({ kind: 'Possibly personal', detail: 'Consumer service; confirm business purpose or reclassify to owner draw' });
      const lastDate = rows[rows.length - 1].t.date;
      subs.push({
        vendor,
        category: category || 'Software (other)',
        cadence: cadence.label,
        charges: rows.length,
        perCharge: round2(perCharge),
        average: round2(mean),
        annualized,
        totalPaid: round2(amounts.reduce((s, a) => s + a, 0)),
        firstDate: rows[0].t.dateStr,
        lastDate: isoDate(lastDate),
        account: leafAccount(rows[rows.length - 1].category),
        flags,
        oneChargeAnnual: round2(perCharge * cadence.perYear),
        savings: 0,
      });
    }

    // Overlapping tools in one category: everything but the most expensive is a candidate to cut.
    const byCat = new Map();
    for (const s of subs) {
      if (s.category === 'Software (other)' || s.category === 'Accounting' || s.category === 'Hosting') continue;
      if (!byCat.has(s.category)) byCat.set(s.category, []);
      byCat.get(s.category).push(s);
    }
    const overlaps = [];
    for (const [cat, list] of byCat) {
      if (list.length < 2) continue;
      list.sort((a, b) => b.annualized - a.annualized);
      const keep = list[0];
      for (const s of list.slice(1)) {
        s.flags.push({ kind: 'Overlapping tool', detail: `Same job as ${keep.vendor} (${cat})` });
        s.savings = Math.max(s.savings, s.annualized);
      }
      overlaps.push({ category: cat, tools: list.map((s) => s.vendor), annualized: round2(list.reduce((t, s) => t + s.annualized, 0)), savings: round2(list.slice(1).reduce((t, s) => t + s.annualized, 0)) });
    }
    // Price increases are flagged for renegotiation but not counted as savings.
    for (const s of subs) {
      for (const f of s.flags) {
        if (f.kind === 'Multiple charges per period' && s.savings === 0) {
          s.savings = s.oneChargeAnnual; // one redundant seat or account
        }
        if (f.kind === 'Possibly personal' && s.savings === 0) s.savings = s.annualized;
      }
    }
    subs.sort((a, b) => b.annualized - a.annualized);
    return {
      list: subs,
      overlaps,
      totalAnnual: round2(subs.reduce((t, s) => t + s.annualized, 0)),
      potentialSavings: round2(subs.reduce((t, s) => t + s.savings, 0)),
    };
  }

  // ---------------------------------------------------------------- orchestration

  function listAccounts(txns) {
    const counts = new Map();
    for (const t of txns) {
      for (const a of [t.account, t.split]) {
        if (!a || /^-split-$/i.test(a)) continue;
        counts.set(a, (counts.get(a) || 0) + 1);
      }
    }
    return [...counts.entries()].map(([name, count]) => ({ name, count, detected: classifyAccount(name) }))
      .sort((a, b) => b.count - a.count);
  }

  function analyze(parsed, opts) {
    opts = opts || {};
    const accountClass = opts.accountClass || {};
    const txns = parsed.transactions;
    const entries = logicalRows(txns, accountClass);
    const dates = txns.map((t) => t.date).sort((a, b) => a - b);
    const uncategorized = findUncategorized(entries);
    const duplicates = findDuplicates(entries, opts.duplicateWindow);
    const mismatches = findMismatches(entries, accountClass, txns);
    const profit = profitability(txns, accountClass, opts.groupBy);
    const subs = subscriptions(txns, accountClass);
    const uncategorizedTotal = round2(uncategorized.reduce((s, t) => s + Math.abs(t.amount), 0));
    const duplicateExposure = round2(duplicates.reduce((s, g) => s + g.exposure, 0));
    const flaggedIds = new Set([...uncategorized.map((t) => t.id), ...duplicates.flatMap((g) => g.rows.map((r) => r.id)), ...mismatches.map((t) => t.id)]);
    const healthScore = entries.length ? Math.max(0, Math.round(100 - (flaggedIds.size / entries.length) * 100 * 1.5)) : 100;
    return {
      meta: parsed.meta,
      period: { start: isoDate(dates[0]), end: isoDate(dates[dates.length - 1]) },
      count: txns.length,
      entryCount: entries.length,
      accounts: listAccounts(txns),
      audit: { uncategorized, uncategorizedTotal, duplicates, duplicateExposure, mismatches, flaggedCount: flaggedIds.size, healthScore },
      profit,
      subs,
    };
  }

  // ---------------------------------------------------------------- report

  function fmtMoney(n) {
    if (n == null || isNaN(n)) return '-';
    const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (n < 0 ? '-$' : '$') + s;
  }
  const fmtPct = (n) => (n == null || !isFinite(n) ? 'n/a' : `${(n * 100).toFixed(1)}%`);
  const pad = (s, n) => String(s).slice(0, n).padEnd(n);
  const padL = (s, n) => String(s).slice(0, n).padStart(n);

  function buildReport(result, opts) {
    opts = opts || {};
    const { audit, profit, subs } = result;
    const client = opts.clientName || result.meta.company || 'Client';
    const preparer = opts.preparer || '';
    const rule = '='.repeat(72);
    const thin = '-'.repeat(72);
    const L = [];
    L.push(rule);
    L.push('BOOKKEEPING REVIEW: DIAGNOSTIC AUDIT & PROFITABILITY SUMMARY');
    L.push(rule);
    L.push(`Client:        ${client}`);
    L.push(`Period:        ${result.period.start} to ${result.period.end}`);
    L.push(`Transactions:  ${result.entryCount.toLocaleString('en-US')} entries reviewed${result.entryCount !== result.count ? ` (${result.count.toLocaleString('en-US')} report lines)` : ''}`);
    L.push(`Prepared:      ${new Date().toISOString().slice(0, 10)}${preparer ? ` by ${preparer}` : ''}`);
    L.push('');
    L.push('EXECUTIVE SUMMARY');
    L.push(thin);
    L.push(`Books health score:          ${audit.healthScore}/100`);
    L.push(`Uncategorized transactions:  ${audit.uncategorized.length} (${fmtMoney(audit.uncategorizedTotal)})`);
    L.push(`Potential duplicate groups:  ${audit.duplicates.length} (${fmtMoney(audit.duplicateExposure)} at risk)`);
    L.push(`Coding / entry mismatches:   ${audit.mismatches.length}`);
    L.push(`Revenue:                     ${fmtMoney(profit.totals.revenue)}`);
    L.push(`Net income:                  ${fmtMoney(profit.totals.netIncome)} (${fmtPct(profit.totals.netMargin)} net margin)`);
    L.push(`Recurring software spend:    ${fmtMoney(subs.totalAnnual)} per year`);
    L.push(`Potential software savings:  ${fmtMoney(subs.potentialSavings)} per year`);
    L.push('');

    L.push('1. UNCATEGORIZED TRANSACTIONS');
    L.push(thin);
    if (!audit.uncategorized.length) L.push('None found.');
    else {
      L.push('These need a category before the books can be closed:');
      for (const t of audit.uncategorized.slice(0, 50)) {
        L.push(`  ${t.dateStr}  ${pad(t.type, 14)} ${pad(counterpartyOf(t) || t.memo || '(no payee)', 26)} ${padL(fmtMoney(t.amount), 12)}`);
      }
      if (audit.uncategorized.length > 50) L.push(`  ...and ${audit.uncategorized.length - 50} more.`);
    }
    L.push('');

    L.push('2. POTENTIAL DUPLICATES');
    L.push(thin);
    if (!audit.duplicates.length) L.push('None found.');
    else {
      L.push('Please confirm whether each group below was paid or billed more than once:');
      audit.duplicates.slice(0, 30).forEach((g, i) => {
        L.push(`  Group ${i + 1} [${g.confidence}]: ${g.reason}`);
        for (const t of g.rows) L.push(`     ${t.dateStr}  ${pad(t.type, 14)} ${pad(counterpartyOf(t) || '(no payee)', 24)} ${padL(fmtMoney(t.amount), 12)}  #${t.num || '-'}`);
      });
    }
    L.push('');

    L.push('3. MISMATCHED ENTRIES');
    L.push(thin);
    if (!audit.mismatches.length) L.push('None found.');
    else {
      const byKind = {};
      for (const m of audit.mismatches) (byKind[m.kind] = byKind[m.kind] || []).push(m);
      for (const [kind, list] of Object.entries(byKind)) {
        L.push(`  ${kind} (${list.length})`);
        for (const m of list.slice(0, 15)) L.push(`     ${m.dateStr}  ${padL(fmtMoney(m.amount), 12)}  ${m.detail}`);
        if (list.length > 15) L.push(`     ...and ${list.length - 15} more.`);
      }
    }
    L.push('');

    L.push(`4. PROFITABILITY BY ${opts.groupBy === 'project' ? 'PROJECT' : 'CUSTOMER'}`);
    L.push(thin);
    if (!profit.groups.length) L.push('No customer or project tags found on income transactions.');
    else {
      L.push(`  ${pad('Name', 24)} ${padL('Revenue', 12)} ${padL('Direct cost', 12)} ${padL('Gross', 7)} ${padL('Net*', 7)}`);
      for (const g of profit.groups.slice(0, 25)) {
        L.push(`  ${pad(g.name, 24)} ${padL(fmtMoney(g.revenue), 12)} ${padL(fmtMoney(g.directCost), 12)} ${padL(fmtPct(g.margin), 7)} ${padL(fmtPct(g.netMargin), 7)}`);
      }
      L.push('  * Net margin allocates untagged overhead by share of revenue.');
      const weak = profit.groups.filter((g) => g.netMargin != null && g.netMargin < 0.1 && g.revenue > 0);
      if (weak.length) {
        L.push('');
        L.push(`  Watch list: ${weak.map((g) => `${g.name} (${fmtPct(g.netMargin)})`).join(', ')}`);
        L.push('  Consider repricing, tighter scope control, or billing for reimbursable costs.');
      }
    }
    L.push('');

    L.push('5. RECURRING SOFTWARE & SUBSCRIPTIONS');
    L.push(thin);
    if (!subs.list.length) L.push('No recurring software charges detected.');
    else {
      L.push(`  ${pad('Vendor', 22)} ${pad('Cadence', 10)} ${padL('Per charge', 11)} ${padL('Per year', 11)}  Notes`);
      for (const s of subs.list) {
        L.push(`  ${pad(s.vendor, 22)} ${pad(s.cadence, 10)} ${padL(fmtMoney(s.perCharge), 11)} ${padL(fmtMoney(s.annualized), 11)}  ${s.flags.map((f) => f.kind).join('; ')}`);
      }
      if (subs.overlaps.length) {
        L.push('');
        L.push('  Overlapping tools (same job, paid twice):');
        for (const o of subs.overlaps) L.push(`   - ${o.category}: ${o.tools.join(', ')}. Consolidating could save ~${fmtMoney(o.savings)}/yr.`);
      }
    }
    L.push('');
    L.push('RECOMMENDED NEXT STEPS');
    L.push(thin);
    const steps = [];
    if (audit.uncategorized.length) steps.push(`Provide receipts or context for the ${audit.uncategorized.length} uncategorized items so they can be coded.`);
    if (audit.duplicates.length) steps.push(`Review the ${audit.duplicates.length} possible duplicate groups; we will void confirmed duplicates or request vendor refunds.`);
    if (audit.mismatches.length) steps.push(`We will correct ${audit.mismatches.length} miscoded entries and set bank rules to keep vendor coding consistent.`);
    if (subs.potentialSavings > 0) steps.push(`Review flagged subscriptions; cancelling overlaps and unused seats could save about ${fmtMoney(subs.potentialSavings)} a year.`);
    const weak = profit.groups.filter((g) => g.netMargin != null && g.netMargin < 0.1 && g.revenue > 0);
    if (weak.length) steps.push(`Discuss pricing on ${weak.length} low-margin ${opts.groupBy === 'project' ? 'project' : 'customer'}${weak.length > 1 ? 's' : ''}.`);
    if (!steps.length) steps.push('No action items. The books look clean for this period.');
    steps.forEach((s, i) => L.push(`  ${i + 1}. ${s}`));
    L.push('');
    L.push(rule);
    L.push('Figures come from the QuickBooks export provided and are for internal review.');
    L.push('Flags are indicators for follow-up, not confirmed errors.');
    L.push(rule);
    return L.join('\n');
  }

  return {
    parseCSV, parseAmount, parseDate, parseTransactions, classifyAccount,
    findUncategorized, findDuplicates, findMismatches, profitability, subscriptions,
    analyze, buildReport, logicalRows, fmtMoney, fmtPct, counterpartyOf, leafAccount,
  };
});
