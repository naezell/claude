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
    const openingBalances = {};
    let section = '';
    let skippedTotals = 0;
    for (let i = header.index + 1; i < rows.length; i++) {
      const r = rows[i];
      const nonEmpty = r.map(norm).filter(Boolean);
      if (!nonEmpty.length) continue;
      const first = norm(r[0]);
      if (/^total\b/i.test(first) || /^total for\b/i.test(nonEmpty[0])) { skippedTotals++; continue; }
      // "Beginning Balance" rows open each account section in QuickBooks exports.
      if (nonEmpty.some((c) => /^(beginning|opening) balance$/i.test(c))) {
        const acct = get(r, 'account') || section;
        const nums = nonEmpty.map(parseAmount).filter((n) => n != null);
        if (acct && nums.length) openingBalances[acct] = nums[nums.length - 1];
        continue;
      }
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
        openingBalances,
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

  // ---------------------------------------------------------------- cash forecast

  const CASH_ACCOUNT = /checking|savings|\bbank\b|money market|cash on hand|petty cash|undeposited/i;
  const CARD_ACCOUNT = /credit card|\bvisa\b|mastercard|\bamex\b|american express|\bcard\b/i;
  const NON_CASH_ACCOUNT = /depreciation|amortization/i;
  const partyOf = (t) => norm(t.customer || t.name || t.vendor).split(':')[0].trim();
  const vendorOf = (t) => norm(t.vendor || t.name);
  const addDays = (d, n) => new Date(d.getTime() + n * DAY);

  // Rebuilds open invoices (or bills) by applying each party's payments to its
  // oldest items first, and measures how many days each paid item took.
  function openItems(entries, isCharge, isSettle, partyFn) {
    const parties = new Map();
    const party = (k) => {
      if (!parties.has(k)) parties.set(k, { name: k, charges: [], settles: [] });
      return parties.get(k);
    };
    for (const t of entries) {
      if (isCharge(t)) {
        const k = partyFn(t);
        if (!k) continue;
        const list = party(k).charges;
        // Multi-line invoices share date + number: fold them into one item.
        const prev = t.num && list.find((c) => c.num === t.num && c.dateStr === t.dateStr);
        if (prev) { prev.amount = round2(prev.amount + Math.abs(t.amount)); prev.open = prev.amount; }
        else list.push({ party: k, num: t.num, date: t.date, dateStr: t.dateStr, amount: Math.abs(t.amount), open: Math.abs(t.amount), line: t.line });
      } else if (isSettle(t)) {
        const k = partyFn(t);
        if (k) party(k).settles.push({ date: t.date, amount: Math.abs(t.amount) });
      }
    }
    const open = [];
    const lags = new Map();
    for (const p of parties.values()) {
      p.charges.sort((a, b) => a.date - b.date);
      p.settles.sort((a, b) => a.date - b.date);
      const days = [];
      let i = 0;
      for (const s of p.settles) {
        // A payment for exactly one invoice's amount almost always pays that invoice.
        const exact = p.charges.find((c) => c.open > 0.004 && c.date <= s.date && Math.abs(c.open - s.amount) < 0.01);
        if (exact) {
          exact.open = 0;
          days.push(Math.max(0, (s.date - exact.date) / DAY));
          continue;
        }
        let left = s.amount;
        while (left > 0.004 && i < p.charges.length) {
          const c = p.charges[i];
          if (c.open <= 0.004) { i++; continue; }
          const applied = Math.min(c.open, left);
          c.open = round2(c.open - applied);
          left = round2(left - applied);
          if (c.open <= 0.004) { days.push(Math.max(0, (s.date - c.date) / DAY)); i++; }
        }
      }
      if (days.length) lags.set(p.name, { median: Math.round(median(days)), paid: days.length });
      for (const c of p.charges) if (c.open > 0.004) open.push(c);
    }
    return { open, lags };
  }

  // Groups recurring outflows (rent, payroll, software, monthly vendors) and
  // projects their next occurrences.
  function recurringOutflows(postings, asOf, horizonEnd, apLagFor) {
    const byVendor = new Map();
    for (const p of postings) {
      const v = vendorOf(p.t) || leafAccount(p.category);
      const k = lower(v);
      if (!byVendor.has(k)) byVendor.set(k, { vendor: v, rows: [] });
      byVendor.get(k).rows.push(p);
    }
    const items = [];
    const recurringVendors = new Set();
    for (const [k, { vendor, rows }] of byVendor) {
      rows.sort((a, b) => a.t.date - b.t.date);
      const months = new Map();
      for (const r of rows) {
        const m = r.t.dateStr.slice(0, 7);
        if (!months.has(m)) months.set(m, { first: r.t.date, total: 0, count: 0 });
        const mm = months.get(m);
        mm.total += r.value;
        mm.count++;
      }
      const keys = [...months.keys()].sort();
      if (keys.length < 3) continue;
      const firsts = keys.map((m) => months.get(m).first);
      const gaps = [];
      for (let i = 1; i < firsts.length; i++) gaps.push((firsts[i] - firsts[i - 1]) / DAY);
      const cadence = cadenceOf(median(gaps));
      if (!cadence || cadence.label !== 'Monthly') continue;
      // Needs to still be active: billed within the last ~45 days.
      if ((asOf - rows[rows.length - 1].t.date) / DAY > 45) continue;
      const recent = keys.slice(-3).map((m) => months.get(m).total);
      const amount = round2(median(recent));
      const day = Math.round(median(firsts.map((d) => d.getUTCDate())));
      const viaBill = rows.some((r) => /bill/i.test(r.t.type));
      const lag = viaBill ? apLagFor(vendor) : 0;
      const group = groupFor(rows[rows.length - 1].category);
      recurringVendors.add(k);
      const lastBilled = rows[rows.length - 1].t.date;
      for (let m = 1; m <= 5; m++) {
        const base = new Date(Date.UTC(lastBilled.getUTCFullYear(), lastBilled.getUTCMonth() + m, Math.min(day, 28)));
        const pay = addDays(base, lag);
        if (pay <= asOf) continue;
        if (pay > horizonEnd) break;
        items.push({ date: pay, amount, group, label: vendor, source: viaBill ? `Monthly bill, paid ~${lag} days after billing` : 'Monthly charge' });
      }
    }
    return { items, recurringVendors };
  }

  function groupFor(category) {
    const leaf = leafAccount(category);
    if (/payroll|wages|salar/i.test(category)) return 'Payroll';
    if (/rent|lease/i.test(category)) return 'Rent';
    if (SAAS_ACCOUNT.test(category)) return 'Software';
    return leaf;
  }

  function cashForecast(txns, accountClass, opts) {
    opts = opts || {};
    const weeksN = opts.weeks || 13;
    const cls = (a) => accountClass[a] || classifyAccount(a);
    const entries = logicalRows(txns, accountClass);
    if (!entries.length) return null;
    const asOf = entries.reduce((m, t) => (t.date > m ? t.date : m), entries[0].date);
    const start = addDays(asOf, 1);
    const horizonEnd = addDays(asOf, weeksN * 7);
    const weekOf = (d) => Math.max(0, Math.min(weeksN - 1, Math.floor((d - start) / DAY / 7)));

    // Starting cash: opening balances plus period activity in cash accounts.
    const opening = opts.openingBalances || {};
    const cashAccts = new Map();
    const cardAccts = new Map();
    for (const [a, v] of Object.entries(opening)) {
      if (cls(a) !== 'balance') continue;
      if (CASH_ACCOUNT.test(a)) cashAccts.set(a, v);
      else if (CARD_ACCOUNT.test(a)) cardAccts.set(a, v);
    }
    for (const t of txns) {
      if (cls(t.account) !== 'balance') continue;
      if (CASH_ACCOUNT.test(t.account)) cashAccts.set(t.account, (cashAccts.get(t.account) || 0) + t.amount);
      else if (CARD_ACCOUNT.test(t.account)) cardAccts.set(t.account, (cardAccts.get(t.account) || 0) + t.amount);
    }
    const estimatedCash = round2([...cashAccts.values()].reduce((s, v) => s + v, 0));
    const cardBalance = round2(Math.max(0, [...cardAccts.values()].reduce((s, v) => s + v, 0)));
    const startingCash = opts.startingCash != null && !isNaN(opts.startingCash) ? +opts.startingCash : estimatedCash;

    // Receivables.
    const ar = openItems(
      entries,
      (t) => /invoice|statement charge/i.test(t.type),
      (t) => /^payment$|receive payment|credit memo/i.test(t.type),
      partyOf,
    );
    const allLags = [...ar.lags.values()].map((l) => l.median);
    const defaultArLag = allLags.length ? Math.round(median(allLags)) : 30;
    const arLagFor = (c) => (ar.lags.get(c) ? ar.lags.get(c).median : defaultArLag);
    const buckets = [
      { label: 'Current (0-30)', max: 30, amount: 0, count: 0 },
      { label: '31-60 days', max: 60, amount: 0, count: 0 },
      { label: '61-90 days', max: 90, amount: 0, count: 0 },
      { label: 'Over 90 days', max: Infinity, amount: 0, count: 0 },
    ];
    const doubtfulAfter = opts.doubtfulAfter || 90;
    const openInvoices = ar.open.map((c) => {
      const age = Math.round((asOf - c.date) / DAY);
      const lag = arLagFor(c.party);
      let expected = addDays(c.date, lag);
      const overdue = expected <= asOf;
      if (overdue) expected = addDays(asOf, 10); // past its usual timing: assume a nudge collects it soon
      const doubtful = age > doubtfulAfter;
      const b = buckets.find((x) => age <= x.max);
      b.amount = round2(b.amount + c.open);
      b.count++;
      return { ...c, age, lag, lagKnown: ar.lags.has(c.party), expected, expectedStr: isoDate(expected), overdue, doubtful, week: doubtful && !opts.includeDoubtful ? null : weekOf(expected) };
    }).sort((a, b) => b.age - a.age);

    // Payables.
    const ap = openItems(
      entries,
      (t) => /^bill$/i.test(t.type),
      (t) => /bill payment|vendor credit/i.test(t.type),
      vendorOf,
    );
    const apLags = [...ap.lags.values()].map((l) => l.median);
    const defaultApLag = apLags.length ? Math.round(median(apLags)) : 30;
    const apLagFor = (v) => (ap.lags.get(v) ? ap.lags.get(v).median : defaultApLag);
    const openBills = ap.open.map((c) => {
      let due = addDays(c.date, apLagFor(c.party));
      const late = due <= asOf;
      if (late) due = addDays(asOf, 3);
      return { ...c, age: Math.round((asOf - c.date) / DAY), due, dueStr: isoDate(due), late, week: weekOf(due) };
    }).sort((a, b) => a.due - b.due);

    // Expected new billings from customers invoiced in 3 of the last 4 months.
    const postings = toPostings(txns, accountClass);
    const recentCut = addDays(asOf, -122);
    const invoicesByCustomer = new Map();
    for (const t of entries) {
      if (!/invoice/i.test(t.type) || t.date < recentCut) continue;
      const k = partyOf(t);
      if (!k) continue;
      if (!invoicesByCustomer.has(k)) invoicesByCustomer.set(k, []);
      invoicesByCustomer.get(k).push(t);
    }
    const newBillings = [];
    for (const [cust, list] of invoicesByCustomer) {
      const months = new Map();
      for (const t of list) months.set(t.dateStr.slice(0, 7), (months.get(t.dateStr.slice(0, 7)) || 0) + Math.abs(t.amount));
      if (months.size < 3) continue;
      const keys = [...months.keys()].sort();
      const amount = round2(median(keys.slice(-3).map((k) => months.get(k))));
      const last = list.reduce((m, t) => (t.date > m ? t.date : m), list[0].date);
      const day = Math.min(28, Math.round(median(list.map((t) => t.date.getUTCDate()))));
      const lag = arLagFor(cust);
      for (let m = 1; m <= 4; m++) {
        const inv = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + m, day));
        const pay = addDays(inv, lag);
        if (pay <= asOf || pay > horizonEnd) continue;
        newBillings.push({ customer: cust, invoiceDate: isoDate(inv), date: pay, amount, week: weekOf(pay) });
      }
    }

    // Receipts that never touch A/R (sales receipts, direct deposits to income).
    const directCut = addDays(asOf, -91);
    const directReceipts = postings.filter((p) => p.cls === 'income' && !/invoice|credit memo|statement charge/i.test(p.t.type) && p.t.date >= directCut);
    const directWeekly = round2(directReceipts.reduce((s, p) => s + p.value, 0) / 13);

    // Outflows.
    const cashOut = postings.filter((p) => p.cls !== 'income' && p.value > 0 && !NON_CASH_ACCOUNT.test(p.category));
    const { items: recurringItems, recurringVendors } = recurringOutflows(cashOut, asOf, horizonEnd, apLagFor);
    const otherSpend = cashOut.filter((p) => p.t.date >= directCut && !/^bill$/i.test(p.t.type) && !recurringVendors.has(lower(vendorOf(p.t) || leafAccount(p.category))));
    const otherWeekly = round2(otherSpend.reduce((s, p) => s + p.value, 0) / 13);

    // Assemble the week grid.
    const rowsIn = new Map();
    const rowsOut = new Map();
    const put = (map, key, week, amt) => {
      if (!map.has(key)) map.set(key, new Array(weeksN).fill(0));
      map.get(key)[week] = round2(map.get(key)[week] + amt);
    };
    for (const inv of openInvoices) if (inv.week != null) put(rowsIn, 'Collections on open invoices', inv.week, inv.open);
    for (const b of newBillings) put(rowsIn, 'Collections on new billings', b.week, b.amount);
    if (directWeekly > 0) for (let w = 0; w < weeksN; w++) put(rowsIn, 'Other receipts (run-rate)', w, directWeekly);
    for (const b of openBills) put(rowsOut, 'Open bills (A/P)', b.week, b.open);
    if (cardBalance > 0) put(rowsOut, 'Credit card balance', Math.min(1, weeksN - 1), cardBalance);
    for (const it of recurringItems) put(rowsOut, it.group, weekOf(it.date), it.amount);
    if (otherWeekly > 0) for (let w = 0; w < weeksN; w++) put(rowsOut, 'Other spending (run-rate)', w, otherWeekly);

    const weeks = [];
    let bal = startingCash;
    for (let w = 0; w < weeksN; w++) {
      const inflow = round2([...rowsIn.values()].reduce((s, r) => s + r[w], 0));
      const outflow = round2([...rowsOut.values()].reduce((s, r) => s + r[w], 0));
      const opening = bal;
      bal = round2(bal + inflow - outflow);
      const ws = addDays(start, w * 7);
      weeks.push({ week: w + 1, start: isoDate(ws), end: isoDate(addDays(ws, 6)), opening: round2(opening), inflow, outflow, net: round2(inflow - outflow), ending: bal });
    }
    const lowest = weeks.reduce((m, w) => (w.ending < m.ending ? w : m), weeks[0]);
    const firstNegative = weeks.find((w) => w.ending < 0) || null;
    const sortRows = (map) => [...map.entries()].map(([label, values]) => ({ label, values, total: round2(values.reduce((s, v) => s + v, 0)) }))
      .sort((a, b) => b.total - a.total);
    const doubtful = openInvoices.filter((i) => i.doubtful);

    const assumptions = [
      `Forecast starts ${isoDate(start)}, the day after the last transaction in the export.`,
      opts.startingCash != null ? 'Starting cash entered manually.' : cashAccts.size
        ? `Starting cash is the ${Object.keys(opening).some((a) => cashAccts.has(a)) ? 'opening balance plus ' : ''}activity in ${[...cashAccts.keys()].join(', ')}.`
        : 'No bank account found in the export: enter starting cash for an accurate balance.',
      `Open invoices are collected on each customer's own median days-to-pay (${defaultArLag} days when a customer has no payment history). Invoices already past that point are assumed to arrive within about 10 days.`,
      `Invoices over ${doubtfulAfter} days old are ${opts.includeDoubtful ? 'included' : 'left out as doubtful'}.`,
      'Customers billed in at least 3 of the last 4 months are assumed to keep billing at their recent monthly amount.',
      'Monthly bills and charges (rent, payroll, software, repeat vendors) are projected forward at their recent amount; other spending uses the last 13-week average.',
      cardBalance > 0 ? `The current credit card balance (${fmtMoney(cardBalance)}) is assumed paid in week 2.` : 'No outstanding credit card balance detected.',
      'Card purchases are treated as cash out on the charge date. Loan payments, owner draws and taxes only appear if they are in the export.',
    ];

    const lagRows = [...ar.lags.entries()].map(([name, l]) => ({ name, medianDays: l.median, paid: l.paid }))
      .sort((a, b) => b.medianDays - a.medianDays);

    return {
      asOf: isoDate(asOf),
      start: isoDate(start),
      startingCash: round2(startingCash),
      estimatedCash,
      cashAccounts: [...cashAccts.keys()],
      cardBalance,
      weeks,
      inflowRows: sortRows(rowsIn),
      outflowRows: sortRows(rowsOut),
      totals: {
        inflow: round2(weeks.reduce((s, w) => s + w.inflow, 0)),
        outflow: round2(weeks.reduce((s, w) => s + w.outflow, 0)),
        ending: weeks[weeks.length - 1].ending,
      },
      lowest,
      firstNegative,
      ar: {
        total: round2(openInvoices.reduce((s, i) => s + i.open, 0)),
        overdue: round2(openInvoices.filter((i) => i.overdue).reduce((s, i) => s + i.open, 0)),
        doubtfulTotal: round2(doubtful.reduce((s, i) => s + i.open, 0)),
        buckets,
        openInvoices,
        defaultLag: defaultArLag,
        customerLags: lagRows,
      },
      ap: { total: round2(openBills.reduce((s, b) => s + b.open, 0)), openBills },
      newBillings,
      recurring: recurringItems.map((i) => ({ ...i, dateStr: isoDate(i.date) })),
      assumptions,
    };
  }

  // ---------------------------------------------------------------- break-even

  // Variable costs are COGS plus any expense tagged to a customer; everything
  // else is fixed overhead. Averages are per 30.44-day month of the export span.
  function monthsCovered(first, last) {
    const endOfMonth = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 0)).getUTCDate();
    // Whole calendar months when the export runs from a month's start to a month's end.
    if (first.getUTCDate() <= 3 && last.getUTCDate() >= endOfMonth - 3) {
      return (last.getUTCFullYear() - first.getUTCFullYear()) * 12 + last.getUTCMonth() - first.getUTCMonth() + 1;
    }
    return Math.max(1, ((last - first) / DAY + 1) / 30.44);
  }

  function breakEven(txns, accountClass) {
    const postings = toPostings(txns, accountClass);
    if (!postings.length) return null;
    const all = txns.map((t) => t.date).sort((a, b) => a - b);
    const dates = [all[0], all[all.length - 1]];
    const months = monthsCovered(dates[0], dates[1]);
    const byMonth = new Map();
    const fixedByAcct = new Map();
    const varByAcct = new Map();
    let R = 0, V = 0, F = 0;
    for (const p of postings) {
      const m = p.t.dateStr.slice(0, 7);
      if (!byMonth.has(m)) byMonth.set(m, { month: m, revenue: 0, variable: 0, fixed: 0 });
      const row = byMonth.get(m);
      if (p.cls === 'income') { R += p.value; row.revenue += p.value; continue; }
      const variable = p.cls === 'cogs' || !!customerOf(p.t, p.cls);
      const acct = leafAccount(p.category) || 'Unassigned';
      if (variable) { V += p.value; row.variable += p.value; varByAcct.set(acct, (varByAcct.get(acct) || 0) + p.value); }
      else { F += p.value; row.fixed += p.value; fixedByAcct.set(acct, (fixedByAcct.get(acct) || 0) + p.value); }
    }
    const base = { revenue: round2(R / months), variable: round2(V / months), fixed: round2(F / months) };
    const toList = (m) => [...m.entries()].map(([name, v]) => ({ name, monthly: round2(v / months) })).sort((a, b) => b.monthly - a.monthly);
    return {
      months: round2(months),
      base,
      ...whatIf(base, {}),
      monthly: [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)).map((r) => ({
        month: r.month, revenue: round2(r.revenue), variable: round2(r.variable), fixed: round2(r.fixed), profit: round2(r.revenue - r.variable - r.fixed),
      })),
      fixedAccounts: toList(fixedByAcct),
      variableAccounts: toList(varByAcct),
      firstDate: isoDate(dates[0]),
      lastDate: isoDate(dates[dates.length - 1]),
    };
  }

  // Scenario math. price: % change in prices at today's volume; variable: % change
  // in variable costs; fixed: $ change in monthly fixed costs; target: monthly profit goal.
  function whatIf(base, s) {
    const price = (s.price || 0) / 100;
    const varChg = (s.variable || 0) / 100;
    const R = base.revenue * (1 + price);
    const V = base.variable * (1 + varChg);
    const F = base.fixed + (s.fixed || 0);
    const cm = R - V;
    const cmRatio = R > 0 ? cm / R : null;
    const breakEvenRevenue = cmRatio && cmRatio > 0 ? round2(F / cmRatio) : null;
    const profit = round2(R - V - F);
    const baseProfit = base.revenue - base.variable - base.fixed;
    // Share of volume that could be lost at the new price while keeping today's profit.
    const volumeCushion = price > 0 && cm > 0 ? 1 - (baseProfit + F) / cm : null;
    return {
      revenue: round2(R),
      variable: round2(V),
      fixed: round2(F),
      contribution: round2(cm),
      cmRatio,
      breakEvenRevenue,
      profit,
      profitMargin: R > 0 ? profit / R : null,
      marginOfSafety: breakEvenRevenue != null && R > 0 ? (R - breakEvenRevenue) / R : null,
      revenueForTarget: s.target != null && cmRatio && cmRatio > 0 ? round2((F + s.target) / cmRatio) : null,
      volumeCushion,
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
    const cash = cashForecast(txns, accountClass, {
      openingBalances: parsed.meta.openingBalances,
      startingCash: opts.startingCash,
      includeDoubtful: opts.includeDoubtful,
    });
    const breakeven = breakEven(txns, accountClass);
    // Open bills that the audit flags as possible duplicates should not be paid blindly.
    if (cash) {
      const dupKeys = new Set(duplicates.flatMap((g) => g.rows.map((r) => `${lower(vendorOf(r))}|${r.num}|${r.dateStr}`)));
      for (const b of cash.ap.openBills) b.possibleDuplicate = dupKeys.has(`${lower(b.party)}|${b.num}|${b.dateStr}`);
      cash.ap.duplicateTotal = round2(cash.ap.openBills.filter((b) => b.possibleDuplicate).reduce((t, b) => t + b.open, 0));
    }
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
      cash,
      breakeven,
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
    const cash = result.cash;
    if (cash) {
      const cushion = opts.cushion || 0;
      L.push('6. 13-WEEK CASH FORECAST');
      L.push(thin);
      L.push(`Starting cash:                ${fmtMoney(cash.startingCash)} (as of ${cash.asOf})`);
      L.push(`Expected in / out (13 wks):   ${fmtMoney(cash.totals.inflow)} / ${fmtMoney(cash.totals.outflow)}`);
      L.push(`Projected cash at week 13:    ${fmtMoney(cash.totals.ending)}`);
      L.push(`Lowest point:                 ${fmtMoney(cash.lowest.ending)} (week of ${cash.lowest.start})`);
      if (cash.firstNegative) L.push(`WARNING: cash runs out in the week of ${cash.firstNegative.start}.`);
      else if (cushion && cash.lowest.ending < cushion) {
        const below = cash.weeks.filter((w) => w.ending < cushion).length;
        L.push(`Cash dips below the ${fmtMoney(cushion)} cushion in ${below} of 13 weeks.`);
      } else L.push('Cash stays positive for all 13 weeks.');
      L.push('');
      L.push(`  ${pad('Week of', 12)} ${padL('Cash in', 12)} ${padL('Cash out', 12)} ${padL('Ending cash', 13)}`);
      for (const w of cash.weeks) L.push(`  ${pad(w.start, 12)} ${padL(fmtMoney(w.inflow), 12)} ${padL(fmtMoney(w.outflow), 12)} ${padL(fmtMoney(w.ending), 13)}${cushion && w.ending < cushion ? '  < cushion' : ''}`);
      L.push('');
      L.push(`  Open receivables: ${fmtMoney(cash.ar.total)}${cash.ar.doubtfulTotal ? ` (${fmtMoney(cash.ar.doubtfulTotal)} over 90 days, left out of the forecast)` : ''}`);
      const slow = cash.ar.customerLags.filter((c) => c.medianDays > 45);
      if (slow.length) L.push(`  Slow payers: ${slow.map((c) => `${c.name} (${c.medianDays} days)`).join(', ')}`);
      L.push(`  Open bills: ${fmtMoney(cash.ap.total)}${cash.ap.duplicateTotal ? ` (${fmtMoney(cash.ap.duplicateTotal)} may be duplicate entries; confirm before paying)` : ''}`);
      L.push('');
    }

    const be = result.breakeven;
    if (be) {
      L.push('7. BREAK-EVEN');
      L.push(thin);
      L.push(`Average monthly revenue:      ${fmtMoney(be.base.revenue)}`);
      L.push(`Variable costs (job costs):   ${fmtMoney(be.base.variable)} per month`);
      L.push(`Fixed costs (overhead):       ${fmtMoney(be.base.fixed)} per month`);
      L.push(`Contribution margin:          ${fmtPct(be.cmRatio)} of each sales dollar`);
      L.push(`Break-even revenue:           ${be.breakEvenRevenue != null ? `${fmtMoney(be.breakEvenRevenue)} per month` : 'n/a (costs exceed revenue per sale)'}`);
      L.push(`Margin of safety:             ${fmtPct(be.marginOfSafety)}`);
      const lift = whatIf(be.base, { price: 5 });
      L.push('');
      L.push(`  A 5% price increase at today's volume would lift monthly profit from ${fmtMoney(be.profit)} to ${fmtMoney(lift.profit)}.`);
      if (lift.volumeCushion != null && lift.volumeCushion > 0) L.push(`  You could lose ${fmtPct(lift.volumeCushion)} of work at the higher price and still match today's profit.`);
      L.push('');
    }

    L.push('RECOMMENDED NEXT STEPS');
    L.push(thin);
    const steps = [];
    if (audit.uncategorized.length) steps.push(`Provide receipts or context for the ${audit.uncategorized.length} uncategorized items so they can be coded.`);
    if (audit.duplicates.length) steps.push(`Review the ${audit.duplicates.length} possible duplicate groups; we will void confirmed duplicates or request vendor refunds.`);
    if (audit.mismatches.length) steps.push(`We will correct ${audit.mismatches.length} miscoded entries and set bank rules to keep vendor coding consistent.`);
    if (subs.potentialSavings > 0) steps.push(`Review flagged subscriptions; cancelling overlaps and unused seats could save about ${fmtMoney(subs.potentialSavings)} a year.`);
    if (cash && cash.firstNegative) steps.push(`Plan for a cash shortfall in the week of ${cash.firstNegative.start}: chase open invoices, delay discretionary spend, or line up credit now.`);
    else if (cash && opts.cushion && cash.lowest.ending < opts.cushion) steps.push(`Cash drops to ${fmtMoney(cash.lowest.ending)} in the week of ${cash.lowest.start}; speed up collections from slow payers before then.`);
    if (cash && cash.ar.doubtfulTotal) steps.push(`Follow up on ${fmtMoney(cash.ar.doubtfulTotal)} in invoices more than 90 days old.`);
    if (be && be.marginOfSafety != null && be.marginOfSafety < 0.15) steps.push(`Revenue is only ${fmtPct(be.marginOfSafety)} above break-even; review pricing and fixed costs together.`);
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
    analyze, buildReport, logicalRows, cashForecast, breakEven, whatIf, fmtMoney, fmtPct, counterpartyOf, leafAccount,
  };
});
