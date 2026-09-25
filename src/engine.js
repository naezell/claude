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
    // Excel stores dates as day counts from 1899-12-30; unformatted cells arrive that way.
    if (/^\d{5}(\.\d+)?$/.test(s) && +s > 20000 && +s < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.floor(+s) * DAY);
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
  const EMPTY = Object.freeze({});

  // Reads the report period from QuickBooks header lines such as
  // "January 1 - June 30, 2026", "January - June, 2026", "January 2025 - June 2026".
  const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  function parsePeriod(lines) {
    const mon = (w) => { const i = MONTH_NAMES.findIndex((m) => m.startsWith(lower(w).slice(0, 3))); return i; };
    const M = '(jan\\w*|feb\\w*|mar\\w*|apr\\w*|may|jun\\w*|jul\\w*|aug\\w*|sep\\w*|oct\\w*|nov\\w*|dec\\w*)';
    const re = new RegExp(`^${M}\\.?\\s*(\\d{1,2})?,?\\s*(\\d{4})?\\s*[-–]\\s*${M}\\.?\\s*(\\d{1,2})?,?\\s*(\\d{4})$`, 'i');
    const single = new RegExp(`^(?:as of\\s+)?${M}\\.?\\s*(\\d{1,2})?,?\\s*(\\d{4})$`, 'i');
    for (const raw of lines || []) {
      const line = norm(raw);
      let m = line.match(re);
      if (m) {
        const y2 = +m[6];
        const y1 = m[3] ? +m[3] : y2;
        const m1 = mon(m[1]), m2 = mon(m[4]);
        const start = new Date(Date.UTC(y1, m1, m[2] ? +m[2] : 1));
        const end = m[5] ? new Date(Date.UTC(y2, m2, +m[5])) : new Date(Date.UTC(y2, m2 + 1, 0));
        if (end >= start) return { start, end };
      }
      m = line.match(single);
      if (m) {
        const y = +m[3], mm = mon(m[1]);
        if (/^as of/i.test(line)) return { start: null, end: new Date(Date.UTC(y, mm, m[2] ? +m[2] : 1)) };
        return { start: new Date(Date.UTC(y, mm, m[2] ? +m[2] : 1)), end: m[2] ? new Date(Date.UTC(y, mm, +m[2])) : new Date(Date.UTC(y, mm + 1, 0)) };
      }
    }
    return null;
  }

  // Report date range: the header's period when it plausibly covers the data, else the data's own span.
  const spanCache = typeof WeakMap === 'function' ? new WeakMap() : null;
  function dateRange(txns, meta) {
    // Only the earliest and latest dates matter: one pass, cached per file.
    let span = spanCache && spanCache.get(txns);
    if (!span) {
      let lo = Infinity, hi = -Infinity;
      for (const t of txns) { const v = t.date.getTime(); if (v < lo) lo = v; if (v > hi) hi = v; }
      span = { lo, hi };
      if (spanCache) spanCache.set(txns, span);
    }
    let first = new Date(span.lo), last = new Date(span.hi);
    const p = meta && meta.periodRange;
    if (p) {
      if (p.start && p.start <= first && (first - p.start) / DAY <= 45) first = p.start;
      if (p.end && p.end >= last && (p.end - last) / DAY <= 45) last = p.end;
    }
    return { first, last };
  }
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

  // Account names repeat on every row, so the pattern matching is cached by name.
  const classCache = new Map();
  function classifyAccount(name) {
    const key = norm(name);
    if (classCache.has(key)) return classCache.get(key);
    const c = classifyAccountUncached(key);
    if (classCache.size > 5000) classCache.clear();
    classCache.set(key, c);
    return c;
  }

  function classifyAccountUncached(name) {
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

  // ---------------------------------------------------------------- account roles & chart of accounts

  // Account roles refine the "balance" class: where cash sits, what is owed, what the owner took.
  const ROLES = typeof Symbol === 'function' ? Symbol('accountRoles') : '__accountRoles';
  const BALANCE_ROLES = ['cash', 'card', 'ar', 'ap', 'loan', 'equity', 'salestax', 'payrolltax', 'otherbalance'];

  const roleCache = new Map();
  function roleFromName(a) {
    if (roleCache.has(a)) return roleCache.get(a);
    const r = roleFromNameUncached(a);
    if (roleCache.size > 5000) roleCache.clear();
    roleCache.set(a, r);
    return r;
  }

  function roleFromNameUncached(a) {
    if (CASH_ACCOUNT.test(a)) return 'cash';
    if (CARD_ACCOUNT.test(a)) return 'card';
    if (/receivable/i.test(a)) return 'ar';
    if (/sales tax/i.test(a)) return 'salestax';
    if (/payroll (tax|liabilit)/i.test(a)) return 'payrolltax';
    if (/payable/i.test(a)) return 'ap';
    if (/\bloan\b|line of credit|notes? payable|mortgage|\bsba\b/i.test(a)) return 'loan';
    if (/equity|\bowner|\bdraw|distribution|retained|capital|contribution|opening bal/i.test(a)) return 'equity';
    return 'otherbalance';
  }

  // The class an account is treated as: manual choice, then chart of accounts, then its name.
  const classOf = (accountClass, a) => (accountClass && accountClass[a]) || classifyAccount(a);

  function roleOf(accountClass, a) {
    if (!a) return null;
    const c = classOf(accountClass, a);
    if (c !== 'balance') return c;
    const r = accountClass && accountClass[ROLES] && accountClass[ROLES].get(a);
    return r || roleFromName(a);
  }

  // QuickBooks account types (Online and Desktop spellings) to class and role.
  function typeToRole(type, detail) {
    const t = lower(type), d = lower(detail);
    if (!t) return null;
    if (/^bank/.test(t)) return { cls: 'balance', role: 'cash' };
    if (/receivable|^a\/r/.test(t)) return { cls: 'balance', role: 'ar' };
    if (/credit card/.test(t)) return { cls: 'balance', role: 'card' };
    if (/payable|^a\/p/.test(t)) return { cls: 'balance', role: 'ap' };
    if (/long.?term liab/.test(t)) return { cls: 'balance', role: 'loan' };
    if (/current liab|liabilit/.test(t)) {
      if (/sales tax/.test(d) || /sales tax/.test(t)) return { cls: 'balance', role: 'salestax' };
      if (/payroll/.test(d)) return { cls: 'balance', role: 'payrolltax' };
      if (/loan|line of credit|notes? payable/.test(d)) return { cls: 'balance', role: 'loan' };
      return { cls: 'balance', role: 'otherbalance' };
    }
    if (/equity/.test(t)) return { cls: 'balance', role: 'equity' };
    if (/asset/.test(t)) return { cls: 'balance', role: 'otherbalance' };
    if (/cost of (goods|sales)|cogs/.test(t)) return { cls: 'cogs', role: 'cogs' };
    if (/income|revenue/.test(t)) return { cls: 'income', role: 'income' };
    if (/expense/.test(t)) return { cls: 'expense', role: 'expense' };
    return null;
  }

  // Reads a QuickBooks "Account List" (Chart of Accounts) export. Returns null when the
  // text is not one, so callers can try it as a transaction report instead.
  function parseChartOfAccounts(text) {
    const rows = parseCSV(text);
    for (let i = 0; i < Math.min(rows.length, 30); i++) {
      const lc = rows[i].map(lower);
      const nameIdx = ['account', 'full name', 'account full name', 'name', 'account name'].map((h) => lc.indexOf(h)).find((x) => x !== -1);
      const typeIdx = ['type', 'account type'].map((h) => lc.indexOf(h)).find((x) => x !== -1);
      if (nameIdx == null || typeIdx == null || lc.includes('date')) continue;
      const detailIdx = ['detail type', 'detail', 'account subtype', 'subtype'].map((h) => lc.indexOf(h)).find((x) => x !== -1);
      const accounts = [];
      for (const r of rows.slice(i + 1)) {
        const name = norm(r[nameIdx]);
        const type = norm(r[typeIdx]);
        if (!name || !type || /^total\b/i.test(name)) continue;
        const mapped = typeToRole(type, detailIdx != null ? r[detailIdx] : '');
        if (mapped) accounts.push({ name, type, detail: detailIdx != null ? norm(r[detailIdx]) : '', ...mapped });
      }
      return accounts.length ? { accounts } : null;
    }
    return null;
  }

  // Builds the lookup analyze() passes around: manual overrides beat the chart of accounts,
  // which beats name-based guesses. Matches on full name, then on the last segment.
  function resolveAccounts(names, overrides, chart) {
    const out = {};
    const roles = new Map();
    const source = {};
    if (chart && chart.accounts.length) {
      const full = new Map(chart.accounts.map((a) => [lower(a.name), a]));
      const leafCount = new Map();
      for (const a of chart.accounts) leafCount.set(lower(leafAccount(a.name)), (leafCount.get(lower(leafAccount(a.name))) || 0) + 1);
      const leaf = new Map(chart.accounts.filter((a) => leafCount.get(lower(leafAccount(a.name))) === 1).map((a) => [lower(leafAccount(a.name)), a]));
      for (const n of names) {
        const hit = full.get(lower(n)) || leaf.get(lower(leafAccount(n)));
        if (!hit) continue;
        out[n] = hit.cls;
        if (hit.cls === 'balance') roles.set(n, hit.role);
        source[n] = { from: 'chart', type: hit.type };
      }
    }
    for (const [n, c] of Object.entries(overrides || {})) {
      out[n] = c;
      source[n] = { from: 'manual' };
      if (c === 'balance' && !roles.has(n)) roles.set(n, roleFromName(n));
      if (c !== 'balance') roles.delete(n);
    }
    out[ROLES] = roles;
    return { accountClass: out, source };
  }

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
        periodRange: parsePeriod(meta.slice(1, 4)),
      },
    };
  }

  // ---------------------------------------------------------------- audit

  // ---------------------------------------------------------------- payee names

  // Bank feeds name the same business many ways ("AMZN Mktp US*2K41", "Amazon.com").
  // Known brands map to one key; everything else loses bank noise before comparing.
  const PAYEE_ALIASES = [
    [/amazon web services|\baws\b/i, 'aws'], [/\bamzn\b|amazon/i, 'amazon'], [/costco/i, 'costco'], [/best ?buy/i, 'best buy'],
    [/uber\s*\*?\s*eats/i, 'uber eats'], [/\buber\b/i, 'uber'], [/\blyft\b/i, 'lyft'], [/home ?depot/i, 'home depot'], [/lowe'?s\b/i, 'lowes'],
    [/wal-?mart/i, 'walmart'], [/\btarget\b/i, 'target'], [/staples/i, 'staples'], [/office ?depot|officemax/i, 'office depot'],
    [/starbucks/i, 'starbucks'], [/adobe/i, 'adobe'], [/dropbox/i, 'dropbox'], [/zoom\.?us|zoom video/i, 'zoom'], [/\bslack\b/i, 'slack'],
    [/\bcanva\b/i, 'canva'], [/mailchimp/i, 'mailchimp'], [/intuit|quickbooks|qbooks/i, 'quickbooks'], [/g ?suite|google\s*\*?\s*(workspace|gsuite)/i, 'google workspace'],
    [/\bmsft\b|microsoft/i, 'microsoft'], [/comcast|xfinity/i, 'comcast'], [/verizon/i, 'verizon'], [/at&t|\batt\*/i, 'att'],
    [/fedex/i, 'fedex'], [/\bups\b/i, 'ups'], [/\busps\b/i, 'usps'], [/netflix/i, 'netflix'], [/spotify/i, 'spotify'],
    [/apple\.com\/bill|itunes/i, 'apple'], [/github/i, 'github'], [/\bnotion\b/i, 'notion'], [/calendly/i, 'calendly'], [/zapier/i, 'zapier'],
  ];
  const PAYEE_PREFIX = /^((pos|ach|dbt|debit|credit|card|check ?card|checkcard|purchase|recurring|preauthorized|online|web|pmt|payment|withdrawal|visa|mc|crd|ppd|ccd)\b[\s.:-]*)+/i;
  const PROCESSOR_TAG = /^(sq|tst|pp|paypal|sp|dd|pypl|in|sqsp)\s*\*\s*/i;
  const NOISE_WORDS = new Set(['pos', 'debit', 'credit', 'ach', 'web', 'pmt', 'payment', 'purchase', 'card', 'checkcard', 'recurring', 'online', 'transfer', 'withdrawal', 'deposit', 'mobile', 'check', 'no', 'memo', 'inc', 'llc', 'co', 'corp', 'ltd', 'the', 'com', 'www', 'us', 'usa', 'mktp']);

  function cleanPayee(raw) {
    let s = norm(raw);
    if (!s) return '';
    // Order matters: store numbers, then long digit runs, then bank prefixes and processor tags.
    s = s.replace(/#\s*\d+/g, ' ');
    s = s.replace(/\b\d{4,}\b/g, ' ').replace(/\s{2,}/g, ' ').trim();
    s = s.replace(PAYEE_PREFIX, '').trim();
    s = s.replace(PROCESSOR_TAG, '').trim();
    // "ADOBE *CREATIVE CLD" -> "ADOBE": the part after an asterisk is a billing descriptor.
    const star = s.indexOf('*');
    if (star > 0 && /[a-z]{3,}/i.test(s.slice(0, star))) s = s.slice(0, star);
    else if (star === 0) s = s.slice(1);
    s = s.replace(/\s\d{3,}\b/g, ' ');
    return s.replace(/\s{2,}/g, ' ').replace(/[\s.,:*#-]+$/, '').trim();
  }

  const payeeKeyCache = new Map();
  function payeeKeyOf(raw) {
    const r = norm(raw);
    if (!r) return '';
    if (payeeKeyCache.has(r)) return payeeKeyCache.get(r);
    let key = '';
    for (const [rx, k] of PAYEE_ALIASES) if (rx.test(r)) { key = k; break; }
    if (!key) {
      const words = lower(cleanPayee(r)).replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w && !NOISE_WORDS.has(w));
      key = words.join(' ');
    }
    if (payeeKeyCache.size > 20000) payeeKeyCache.clear();
    payeeKeyCache.set(r, key);
    return key;
  }

  // The business a cost went to, for grouping: the vendor or name, else a cleaned bank memo.
  function payeeOf(t) {
    const named = norm(t.vendor || t.name);
    if (named) return { key: payeeKeyOf(named), raw: named };
    const fromMemo = cleanPayee(t.memo);
    const key = payeeKeyOf(fromMemo);
    return key && /[a-z]{3,}/.test(key) ? { key, raw: fromMemo } : { key: '', raw: '' };
  }

  // Display name for a group of raw names: the one used most, tidied if it is bank shouting.
  function displayPayee(counts) {
    const [best] = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0] || [''];
    const clean = best === best.toUpperCase() && /[A-Z]{3,}/.test(best) ? cleanPayee(best).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()) : best;
    return clean || best;
  }

  function counterpartyOf(t) {
    return t.name || t.vendor || t.customer || '';
  }

  const entryKey = (t) => [t.dateStr, lower(t.type), t.num, lower(counterpartyOf(t)), Math.abs(t.amount).toFixed(2)].join('|');
  const isPnlClass = (c) => c === 'income' || c === 'expense' || c === 'cogs';

  // "by Account" exports list every entry once per account it touches (bank side
  // and category side). Collapse to one row per entry, keeping true repeats: for
  // each entry key keep the rows of a single account, preferring a P&L account.
  // Several analyses need the same derived tables; compute each once per file and account setup.
  const memoStore = typeof WeakMap === 'function' ? new WeakMap() : null;
  function memo(name, txns, accountClass, compute) {
    if (!memoStore || !txns || typeof txns !== 'object' || !accountClass || typeof accountClass !== 'object') return compute();
    let byTxns = memoStore.get(txns);
    if (!byTxns) { byTxns = new WeakMap(); memoStore.set(txns, byTxns); }
    let byClass = byTxns.get(accountClass);
    if (!byClass) { byClass = new Map(); byTxns.set(accountClass, byClass); }
    if (!byClass.has(name)) byClass.set(name, compute());
    return byClass.get(name);
  }

  const chartIds = typeof WeakMap === 'function' ? new WeakMap() : null;
  let chartSeq = 0;
  function chartId(chart) {
    if (!chart || !chartIds) return '';
    if (!chartIds.has(chart)) chartIds.set(chart, ++chartSeq);
    return chartIds.get(chart);
  }

  function logicalRows(txns, accountClass) {
    return memo('logicalRows', txns, accountClass || EMPTY, () => logicalRowsUncached(txns, accountClass));
  }

  function logicalRowsUncached(txns, accountClass) {
    const cls = (a) => classOf(accountClass, a);
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
      const cp = payeeKeyOf(counterpartyOf(t)) || payeeOf(t).key || lower(t.memo).slice(0, 24);
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
    const cls = (a) => classOf(accountClass, a);
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
    const vendorNames = new Map();
    for (const t of txns) {
      if (!EXPENSE_TYPES.test(t.type) || REVERSING_TYPES.test(t.type)) continue;
      const who = counterpartyOf(t);
      const v = payeeKeyOf(who);
      if (!v) continue;
      if (!vendorNames.has(v)) vendorNames.set(v, new Map());
      vendorNames.get(v).set(who, (vendorNames.get(v).get(who) || 0) + 1);
      const cat = ['expense', 'cogs'].includes(cls(t.account)) ? t.account : ['expense', 'cogs'].includes(cls(t.split)) ? t.split : '';
      if (!cat || RX.uncategorized.test(cat)) continue;
      if (!byVendor.has(v)) byVendor.set(v, new Map());
      const m = byVendor.get(v);
      if (!m.has(cat)) m.set(cat, []);
      m.get(cat).push(t);
    }
    for (const [key, cats] of byVendor) {
      if (cats.size < 2) continue;
      const vendor = displayPayee(vendorNames.get(key));
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
    return memo('postings', txns, accountClass || EMPTY, () => toPostingsUncached(txns, accountClass));
  }

  function toPostingsUncached(txns, accountClass) {
    const cls = (a) => classOf(accountClass, a);
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
      const who = payeeOf(p.t);
      if (!who.key) continue;
      if (!byVendor.has(who.key)) byVendor.set(who.key, { names: new Map(), rows: [] });
      const g = byVendor.get(who.key);
      g.names.set(who.raw, (g.names.get(who.raw) || 0) + 1);
      g.rows.push(p);
    }

    const subs = [];
    for (const g of byVendor.values()) {
      const vendor = displayPayee(g.names);
      const rows = g.rows;
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

  // Cleans up what-if inputs from the page; anything malformed is ignored.
  function normalizeScenario(s) {
    const out = { delay: new Map(), lost: new Set(), salesPct: 0, monthly: [], once: [], describe: [], active: false };
    for (const lv of (s && s.levers) || []) {
      const amt = Math.abs(+lv.amount || 0);
      const date = lv.date ? new Date(`${lv.date}T00:00:00Z`) : null;
      if (lv.type === 'delay' && lv.customer && +lv.days) {
        out.delay.set(lower(lv.customer), (out.delay.get(lower(lv.customer)) || 0) + +lv.days);
        out.describe.push(`${lv.customer} pays ${+lv.days} days later`);
      } else if (lv.type === 'lose' && lv.customer) {
        out.lost.add(lower(lv.customer));
        out.describe.push(`No new billing to ${lv.customer}`);
      } else if (lv.type === 'sales' && +lv.pct) {
        out.salesPct += +lv.pct;
        out.describe.push(`New sales ${+lv.pct > 0 ? 'up' : 'down'} ${Math.abs(+lv.pct)}%`);
      } else if (lv.type === 'monthly' && amt && date && !isNaN(date)) {
        out.monthly.push({ label: lv.label || 'New monthly cost', amount: amt, start: date });
        out.describe.push(`${lv.label || 'New monthly cost'} of ${fmtWhole(amt)}/month from ${lv.date}`);
      } else if ((lv.type === 'payment' || lv.type === 'receipt') && amt && date && !isNaN(date)) {
        const dir = lv.type === 'receipt' ? 'in' : 'out';
        out.once.push({ label: lv.label || (dir === 'in' ? 'One-time receipt' : 'One-time payment'), amount: amt, date, dir });
        out.describe.push(`${lv.label || (dir === 'in' ? 'One-time receipt' : 'One-time payment')} of ${fmtWhole(amt)} on ${lv.date}`);
      }
    }
    out.active = out.describe.length > 0;
    return out;
  }

  function cashForecast(txns, accountClass, opts) {
    opts = opts || {};
    const weeksN = opts.weeks || 13;
    const cls = (a) => classOf(accountClass, a);
    const entries = logicalRows(txns, accountClass);
    if (!entries.length) return null;
    const asOf = dateRange(txns, opts.meta).last;
    const start = addDays(asOf, 1);
    const horizonEnd = addDays(asOf, weeksN * 7);
    const weekOf = (d) => Math.max(0, Math.min(weeksN - 1, Math.floor((d - start) / DAY / 7)));
    const sc = normalizeScenario(opts.scenario);

    // Starting cash: opening balances plus period activity in cash accounts.
    const opening = opts.openingBalances || {};
    const cashAccts = new Map();
    const cardAccts = new Map();
    for (const [a, v] of Object.entries(opening)) {
      const role = roleOf(accountClass, a);
      if (role === 'cash') cashAccts.set(a, v);
      else if (role === 'card') cardAccts.set(a, v);
    }
    for (const t of txns) {
      const role = roleOf(accountClass, t.account);
      if (role === 'cash') cashAccts.set(t.account, (cashAccts.get(t.account) || 0) + t.amount);
      else if (role === 'card') cardAccts.set(t.account, (cardAccts.get(t.account) || 0) + t.amount);
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
      const delay = sc.delay.get(lower(c.party)) || 0;
      if (delay) expected = addDays(expected, delay);
      const doubtful = age > doubtfulAfter;
      const b = buckets.find((x) => age <= x.max);
      b.amount = round2(b.amount + c.open);
      b.count++;
      // Money expected after the last forecast week is not counted in it.
      const week = (doubtful && !opts.includeDoubtful) || expected > horizonEnd ? null : weekOf(expected);
      return { ...c, age, lag, lagKnown: ar.lags.has(c.party), expected, expectedStr: isoDate(expected), overdue, doubtful, week };
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
      if (sc.lost.has(lower(cust))) continue;
      const lag = arLagFor(cust) + (sc.delay.get(lower(cust)) || 0);
      const billed = round2(amount * (1 + sc.salesPct / 100));
      for (let m = 1; m <= 4; m++) {
        const inv = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + m, day));
        const pay = addDays(inv, lag);
        if (pay <= asOf || pay > horizonEnd) continue;
        newBillings.push({ customer: cust, invoiceDate: isoDate(inv), date: pay, amount: billed, week: weekOf(pay) });
      }
    }

    // Receipts that never touch A/R (sales receipts, direct deposits to income).
    const directCut = addDays(asOf, -91);
    const directReceipts = postings.filter((p) => p.cls === 'income' && !/invoice|credit memo|statement charge/i.test(p.t.type) && p.t.date >= directCut);
    const directWeekly = round2(directReceipts.reduce((s, p) => s + p.value, 0) / 13 * (1 + sc.salesPct / 100));

    // Outflows.
    const cashOut = postings.filter((p) => p.cls !== 'income' && p.value > 0 && !NON_CASH_ACCOUNT.test(p.category));
    const { items: recurringItems, recurringVendors } = recurringOutflows(cashOut, asOf, horizonEnd, apLagFor);
    const otherSpend = cashOut.filter((p) => p.t.date >= directCut && !/^bill$/i.test(p.t.type) && !recurringVendors.has(lower(vendorOf(p.t) || leafAccount(p.category))));
    const otherWeekly = round2(otherSpend.reduce((s, p) => s + p.value, 0) / 13);

    const rowsIn = new Map();
    const rowsOut = new Map();
    const put = (map, key, week, amt) => {
      if (!map.has(key)) map.set(key, new Array(weeksN).fill(0));
      map.get(key)[week] = round2(map.get(key)[week] + amt);
    };

    // Cash paid to balance-sheet accounts never shows as an expense: owner draws, loan
    // principal, sales and payroll tax remittances. Project the ones that repeat.
    const BS_LABEL = { equity: 'Owner draws', loan: 'Loan payments', salestax: 'Sales tax', payrolltax: 'Payroll taxes' };
    const bsGroups = new Map();
    for (const t of txns) {
      if (t.amount >= 0 || roleOf(accountClass, t.account) !== 'cash') continue;
      const role = roleOf(accountClass, t.split);
      if (!BS_LABEL[role]) continue;
      if (!bsGroups.has(t.split)) bsGroups.set(t.split, { account: t.split, role, rows: [] });
      bsGroups.get(t.split).rows.push({ date: t.date, amount: -t.amount });
    }
    const balanceOut = [];
    for (const g of bsGroups.values()) {
      const rows = g.rows.sort((a, b) => a.date - b.date);
      const gaps = [];
      for (let i = 1; i < rows.length; i++) gaps.push((rows[i].date - rows[i - 1].date) / DAY);
      if (!gaps.length) continue;
      const gap = median(gaps);
      const cadence = gap >= 12 && gap <= 17 ? { label: 'Every 2 weeks', months: 0, days: 14 }
        : gap >= 25 && gap <= 35 ? { label: 'Monthly', months: 1 }
          : gap >= 80 && gap <= 100 ? { label: 'Quarterly', months: 3 } : null;
      const enough = cadence && (cadence.months === 3 ? rows.length >= 2 : rows.length >= 3);
      const last = rows[rows.length - 1].date;
      // Still active: the last payment is no more than two periods old.
      if (!enough || (asOf - last) / DAY > gap * 2 + 7) continue;
      const amount = round2(median(rows.slice(-3).map((r) => r.amount)));
      const dates = [];
      for (let n = 1; n <= 30; n++) {
        const d = cadence.days ? addDays(last, cadence.days * n)
          : new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + cadence.months * n, Math.min(last.getUTCDate(), 28)));
        if (d > horizonEnd) break;
        if (d > asOf) dates.push(d);
      }
      const label = BS_LABEL[g.role];
      for (const d of dates) put(rowsOut, label, weekOf(d), amount);
      balanceOut.push({ label, account: g.account, cadence: cadence.label, amount, count: rows.length, lastDate: isoDate(last), next: dates.map(isoDate) });
    }

    // Assemble the week grid.
    for (const inv of openInvoices) if (inv.week != null) put(rowsIn, 'Collections on open invoices', inv.week, inv.open);
    for (const b of newBillings) put(rowsIn, 'Collections on new billings', b.week, b.amount);
    if (directWeekly > 0) for (let w = 0; w < weeksN; w++) put(rowsIn, 'Other receipts (run-rate)', w, directWeekly);
    for (const b of openBills) put(rowsOut, 'Open bills (A/P)', b.week, b.open);
    if (cardBalance > 0) put(rowsOut, 'Credit card balance', Math.min(1, weeksN - 1), cardBalance);
    for (const it of recurringItems) put(rowsOut, it.group, weekOf(it.date), it.amount);
    if (otherWeekly > 0) for (let w = 0; w < weeksN; w++) put(rowsOut, 'Other spending (run-rate)', w, otherWeekly);

    // What-if changes the bookkeeper added.
    for (const m of sc.monthly) {
      for (let n = 0; n < 12; n++) {
        const d = new Date(Date.UTC(m.start.getUTCFullYear(), m.start.getUTCMonth() + n, Math.min(28, m.start.getUTCDate())));
        if (d > horizonEnd) break;
        if (d > asOf) put(rowsOut, m.label, weekOf(d), m.amount);
      }
    }
    for (const o of sc.once) {
      if (o.date <= asOf || o.date > horizonEnd) continue;
      put(o.dir === 'in' ? rowsIn : rowsOut, o.label, weekOf(o.date), o.amount);
    }

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
      `Forecast starts ${isoDate(start)}, the day after the export's end date (${isoDate(asOf)}).`,
      opts.startingCash != null ? 'Starting cash entered manually.' : cashAccts.size
        ? `Starting cash is the ${Object.keys(opening).some((a) => cashAccts.has(a)) ? 'opening balance plus ' : ''}activity in ${[...cashAccts.keys()].join(', ')}.`
        : 'No bank account found in the export: enter starting cash for an accurate balance.',
      `Open invoices are collected on each customer's own median days-to-pay (${defaultArLag} days when a customer has no payment history). Invoices already past that point are assumed to arrive within about 10 days.`,
      `Invoices over ${doubtfulAfter} days old are ${opts.includeDoubtful ? 'included' : 'left out as doubtful'}.`,
      'Customers billed in at least 3 of the last 4 months are assumed to keep billing at their recent monthly amount.',
      'Monthly bills and charges (rent, payroll, software, repeat vendors) are projected forward at their recent amount; other spending uses the last 13-week average.',
      cardBalance > 0 ? `The current credit card balance (${fmtMoney(cardBalance)}) is assumed paid in week 2.` : 'No outstanding credit card balance detected.',
      'Card purchases are treated as cash out on the charge date.',
      balanceOut.length
        ? `Repeating payments to balance-sheet accounts are projected too: ${balanceOut.map((b) => `${b.label.toLowerCase()} (${b.cadence.toLowerCase()}, about ${fmtWhole(b.amount)})`).join(', ')}.`
        : 'No repeating owner draws, loan payments or tax remittances found in the export. Add them by hand if the client makes them.',
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
      ap: {
        total: round2(openBills.reduce((s, b) => s + b.open, 0)),
        openBills,
        defaultLag: defaultApLag,
        vendorLags: [...ap.lags.entries()].map(([name, l]) => ({ name, medianDays: l.median, paid: l.paid })).sort((a, b) => a.medianDays - b.medianDays),
      },
      newBillings,
      recurring: recurringItems.map((i) => ({ ...i, dateStr: isoDate(i.date) })),
      balanceOut,
      scenario: sc.active ? sc.describe : null,
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

  // The last 12 whole months of an export longer than a year, else null.
  function trailingYear(first, last) {
    if (monthsCovered(first, last) <= 12.5) return null;
    const endOfMonth = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 0));
    const lastFull = last.getUTCDate() >= endOfMonth.getUTCDate() - 3 ? endOfMonth : new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth(), 0));
    const start = new Date(Date.UTC(lastFull.getUTCFullYear(), lastFull.getUTCMonth() - 11, 1));
    return { start, end: lastFull };
  }

  function breakEven(txns, accountClass, meta) {
    let postings = toPostings(txns, accountClass);
    if (!postings.length) return null;
    const range = dateRange(txns, meta);
    let dates = [range.first, range.last];
    // Long exports: use the trailing 12 months so the cost structure is current.
    const ttm = trailingYear(dates[0], dates[1]);
    if (ttm) {
      postings = postings.filter((p) => p.t.date >= ttm.start && p.t.date <= ttm.end);
      dates = [ttm.start, ttm.end];
    }
    const months = ttm ? 12 : monthsCovered(dates[0], dates[1]);
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
      trailing: !!ttm,
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

  // ---------------------------------------------------------------- trends

  const monthLabel = (key) => {
    const [y, m] = key.split('-');
    return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m - 1]} ${y.slice(2)}`;
  };
  const quarterOf = (key) => { const [y, m] = key.split('-'); return `${y}-Q${Math.ceil(+m / 3)}`; };
  const pctChange = (a, b) => (a && Math.abs(a) > 0.009 ? (b - a) / Math.abs(a) : null);

  const TREND_METRICS = [
    { key: 'revenue', label: 'Revenue', kind: 'money', up: true, flow: true },
    { key: 'grossProfit', label: 'Gross profit', kind: 'money', up: true, flow: true },
    { key: 'grossMargin', label: 'Gross margin', kind: 'pct', up: true },
    { key: 'netIncome', label: 'Net income', kind: 'money', up: true, flow: true },
    { key: 'netMargin', label: 'Net margin', kind: 'pct', up: true },
    { key: 'variable', label: 'Job costs', kind: 'money', up: false, flow: true },
    { key: 'fixed', label: 'Overhead', kind: 'money', up: false, flow: true },
    { key: 'software', label: 'Software', kind: 'money', up: false, flow: true },
    { key: 'customers', label: 'Active customers', kind: 'count', up: true },
    { key: 'arEnd', label: 'Receivables', kind: 'money', up: false, balance: true },
    { key: 'dso', label: 'Days to collect (DSO)', kind: 'days', up: false, balance: true },
    { key: 'dpo', label: 'Days to pay vendors (DPO)', kind: 'days', up: true, balance: true },
    { key: 'cashEnd', label: 'Cash', kind: 'money', up: true, balance: true },
  ];

  function derive(p) {
    p.grossProfit = round2(p.revenue - p.variable);
    p.netIncome = round2(p.revenue - p.variable - p.fixed);
    p.grossMargin = p.revenue > 0 ? p.grossProfit / p.revenue : null;
    p.netMargin = p.revenue > 0 ? p.netIncome / p.revenue : null;
    return p;
  }

  function trends(txns, accountClass, opts) {
    opts = opts || {};
    const cls = (a) => classOf(accountClass, a);
    const postings = toPostings(txns, accountClass);
    if (!postings.length) return null;
    const entries = logicalRows(txns, accountClass);
    const { first, last } = dateRange(txns, opts.meta);

    const keys = [];
    for (let y = first.getUTCFullYear(), m = first.getUTCMonth(); y < last.getUTCFullYear() || (y === last.getUTCFullYear() && m <= last.getUTCMonth()); m++) {
      if (m === 12) { m = 0; y++; }
      keys.push(`${y}-${String(m + 1).padStart(2, '0')}`);
    }
    const lastEnd = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 0)).getUTCDate();
    const months = new Map(keys.map((k, i) => [k, {
      key: k, label: monthLabel(k), revenue: 0, variable: 0, fixed: 0, software: 0, bills: 0,
      partial: (i === 0 && first.getUTCDate() > 3) || (i === keys.length - 1 && last.getUTCDate() < lastEnd - 3),
      byCategory: new Map(), byFixed: new Map(), byVariable: new Map(), byCustomer: new Map(),
    }]));

    for (const p of postings) {
      const mo = months.get(p.t.dateStr.slice(0, 7));
      if (!mo) continue;
      if (p.cls === 'income') {
        mo.revenue += p.value;
        const c = customerOf(p.t, p.cls);
        if (c) { const k = c.split(':')[0].trim(); mo.byCustomer.set(k, (mo.byCustomer.get(k) || 0) + p.value); }
        continue;
      }
      const variable = p.cls === 'cogs' || !!customerOf(p.t, p.cls);
      if (variable) mo.variable += p.value; else mo.fixed += p.value;
      const cat = leafAccount(p.category) || 'Unassigned';
      mo.byCategory.set(cat, (mo.byCategory.get(cat) || 0) + p.value);
      const saasCat = saasCategory(`${vendorOf(p.t)} ${p.t.memo}`);
      if (SAAS_ACCOUNT.test(p.category) || (saasCat && saasCat !== 'Payroll' && !NOT_SAAS_ACCOUNT.test(p.category))) mo.software += p.value;
      (variable ? mo.byVariable : mo.byFixed).set(cat, ((variable ? mo.byVariable : mo.byFixed).get(cat) || 0) + p.value);
    }

    // Month-end receivables and cash.
    const sorted = [...entries].sort((a, b) => a.date - b.date);
    let ar = 0;
    let apBal = 0;
    let idx = 0;
    const opening = opts.openingBalances || {};
    const isCash = (a) => roleOf(accountClass, a) === 'cash';
    let cash = Object.entries(opening).filter(([a]) => isCash(a)).reduce((t, [, v]) => t + v, 0);
    const cashRows = txns.filter((t) => isCash(t.account)).sort((a, b) => a.date - b.date);
    const hasCash = cashRows.length > 0;
    let cIdx = 0;
    for (const k of keys) {
      const mo = months.get(k);
      while (idx < sorted.length && sorted[idx].dateStr.slice(0, 7) <= k) {
        const t = sorted[idx++];
        if (/invoice|statement charge/i.test(t.type)) ar += Math.abs(t.amount);
        else if (/^payment$|receive payment|credit memo/i.test(t.type)) ar -= Math.abs(t.amount);
        else if (/^bill$/i.test(t.type)) { apBal += Math.abs(t.amount); mo.bills += Math.abs(t.amount); }
        else if (/bill payment|vendor credit/i.test(t.type)) apBal -= Math.abs(t.amount);
      }
      while (cIdx < cashRows.length && cashRows[cIdx].dateStr.slice(0, 7) <= k) cash += cashRows[cIdx++].amount;
      mo.arEnd = round2(Math.max(0, ar));
      mo.apEnd = round2(Math.max(0, apBal));
      mo.bills = round2(mo.bills);
      mo.cashEnd = hasCash ? round2(cash) : null;
    }

    const finish = (list) => {
      list.forEach((p, i) => {
        derive(p);
        p.revenue = round2(p.revenue); p.variable = round2(p.variable); p.fixed = round2(p.fixed); p.software = round2(p.software);
        p.customers = p.byCustomer.size;
        // DSO on trailing three periods' average monthly revenue.
        const window = list.slice(Math.max(0, i - 2), i + 1);
        const monthsIn = window.reduce((t, w) => t + (w.monthCount || 1), 0);
        const rev = window.reduce((t, w) => t + w.revenue, 0) / monthsIn;
        p.dso = rev > 0 ? Math.round((p.arEnd / rev) * 30.44) : null;
        // DPO on trailing three periods' average monthly vendor bills.
        const billed = window.reduce((t, w) => t + (w.bills || 0), 0) / monthsIn;
        p.dpo = billed > 0 ? Math.round((p.apEnd / billed) * 30.44) : null;
      });
      return list;
    };
    const monthList = finish(keys.map((k) => months.get(k)));

    const quarterMap = new Map();
    for (const mo of monthList) {
      const q = quarterOf(mo.key);
      if (!quarterMap.has(q)) quarterMap.set(q, { key: q, label: `Q${q.slice(-1)} ${q.slice(2, 4)}`, revenue: 0, variable: 0, fixed: 0, software: 0, bills: 0, monthCount: 0, partial: false, byCategory: new Map(), byFixed: new Map(), byVariable: new Map(), byCustomer: new Map() });
      const qq = quarterMap.get(q);
      qq.revenue += mo.revenue; qq.variable += mo.variable; qq.fixed += mo.fixed; qq.software += mo.software; qq.bills += mo.bills;
      qq.monthCount++;
      qq.partial = qq.partial || mo.partial;
      qq.arEnd = mo.arEnd; qq.apEnd = mo.apEnd; qq.cashEnd = mo.cashEnd;
      for (const [c, v] of mo.byCategory) qq.byCategory.set(c, (qq.byCategory.get(c) || 0) + v);
      for (const [c, v] of mo.byFixed) qq.byFixed.set(c, (qq.byFixed.get(c) || 0) + v);
      for (const [c, v] of mo.byVariable) qq.byVariable.set(c, (qq.byVariable.get(c) || 0) + v);
      for (const [c, v] of mo.byCustomer) qq.byCustomer.set(c, (qq.byCustomer.get(c) || 0) + v);
    }
    const quarterList = finish([...quarterMap.values()].map((q) => ({ ...q, partial: q.partial || q.monthCount < 3 })));

    const full = monthList.filter((m) => !m.partial);
    const sum = (list, key) => list.reduce((t, m) => t + (m[key] || 0), 0);
    const windowValue = (list, metric) => {
      if (!list.length) return null;
      if (metric.balance) return list[list.length - 1][metric.key];
      if (metric.kind === 'pct') {
        const r = sum(list, 'revenue');
        if (!r) return null;
        return metric.key === 'grossMargin' ? (r - sum(list, 'variable')) / r : (r - sum(list, 'variable') - sum(list, 'fixed')) / r;
      }
      if (metric.key === 'customers') return new Set(list.flatMap((m) => [...m.byCustomer.keys()])).size;
      return sum(list, metric.key) / list.length;
    };
    const cmp = (a, b, metric) => {
      if (a == null || b == null) return null;
      return { from: a, to: b, delta: b - a, pct: metric.kind === 'pct' ? null : pctChange(a, b) };
    };
    const last3 = full.slice(-3);
    const prior3 = full.slice(-6, -3);
    const lastKey = full.length ? full[full.length - 1].key : null;
    const yearAgoKeys = last3.map((m) => `${+m.key.slice(0, 4) - 1}${m.key.slice(4)}`);
    const yearAgo = yearAgoKeys.map((k) => months.get(k)).filter((m) => m && !m.partial);
    const hasYoY = yearAgo.length === last3.length && last3.length === 3;

    const metrics = TREND_METRICS.map((metric) => {
      if (metric.key === 'cashEnd' && !hasCash) return null;
      const latest = full.length ? full[full.length - 1] : null;
      const prev = full.length > 1 ? full[full.length - 2] : null;
      return {
        ...metric,
        series: monthList.map((m) => m[metric.key]),
        latest: latest ? latest[metric.key] : null,
        latestLabel: latest ? latest.label : '',
        mom: latest && prev ? cmp(prev[metric.key], latest[metric.key], metric) : null,
        recent: prior3.length === 3 ? cmp(windowValue(prior3, metric), windowValue(last3, metric), metric) : null,
        yoy: hasYoY ? cmp(windowValue(yearAgo, metric), windowValue(last3, metric), metric) : null,
      };
    }).filter(Boolean);
    const byKey = Object.fromEntries(metrics.map((m) => [m.key, m]));

    // Movers: cost categories and customers, last 3 full months vs the 3 before.
    const catAvg = (list, field) => {
      const m = new Map();
      for (const mo of list) for (const [c, v] of mo[field || 'byCategory']) m.set(c, (m.get(c) || 0) + v / list.length);
      return m;
    };
    const typeOf = (c) => (full.some((mo) => mo.byVariable.has(c)) ? (full.some((mo) => mo.byFixed.has(c)) ? 'Mixed' : 'Job cost') : 'Overhead');
    const costMovers = [];
    if (prior3.length === 3) {
      const a = catAvg(prior3), b = catAvg(last3);
      for (const c of new Set([...a.keys(), ...b.keys()])) {
        const from = round2(a.get(c) || 0), to = round2(b.get(c) || 0);
        const delta = round2(to - from);
        if (Math.abs(delta) >= Math.max(100, 0.15 * from)) costMovers.push({ name: c, type: typeOf(c), from, to, delta, pct: pctChange(from, to) });
      }
      costMovers.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
    }
    const custTotals = (list) => {
      const m = new Map();
      for (const mo of list) for (const [c, v] of mo.byCustomer) m.set(c, (m.get(c) || 0) + v);
      return m;
    };
    const customerMovers = [];
    if (full.length >= 4) {
      const recentT = custTotals(last3);
      const priorT = custTotals(prior3);
      const before = custTotals(full.slice(0, -6));
      const everBefore = custTotals(full.slice(0, -3));
      const lastSeen = new Map();
      for (const mo of monthList) for (const c of mo.byCustomer.keys()) lastSeen.set(c, mo.key);
      for (const c of new Set([...recentT.keys(), ...everBefore.keys()])) {
        const r = recentT.get(c) || 0, p = priorT.get(c) || 0;
        let status;
        if (!before.has(c) && r > 0) status = 'New';
        else if (r === 0 && everBefore.has(c)) status = 'Lost';
        else if (r === 0) continue;
        else if (p > 0 && r / p >= 1.2) status = 'Growing';
        else if (p > 0 && r / p <= 0.8) status = 'Shrinking';
        else status = 'Steady';
        customerMovers.push({ name: c, recent: round2(r / Math.max(1, last3.length)), prior: round2(p / Math.max(1, prior3.length)), status, pct: p ? pctChange(p, r) : null, lastMonth: monthLabel(lastSeen.get(c)), lifetime: round2([...monthList].reduce((t, mo) => t + (mo.byCustomer.get(c) || 0), 0)) });
      }
      const order = { New: 0, Growing: 1, Shrinking: 2, Lost: 3, Steady: 4 };
      customerMovers.sort((x, y) => order[x.status] - order[y.status] || y.recent - x.recent);
    }

    // Plain-language findings, most important first.
    const insights = [];
    const rev = byKey.revenue;
    if (rev && rev.yoy) insights.push({ tone: rev.yoy.pct >= 0 ? 'good' : 'bad', text: `Revenue over the last 3 months averaged ${fmtWhole(rev.yoy.to)}/month, ${fmtPct(Math.abs(rev.yoy.pct))} ${rev.yoy.pct >= 0 ? 'above' : 'below'} the same months last year.` });
    else if (rev && rev.recent) insights.push({ tone: rev.recent.pct >= 0 ? 'good' : 'bad', text: `Revenue over the last 3 months averaged ${fmtWhole(rev.recent.to)}/month, ${fmtPct(Math.abs(rev.recent.pct))} ${rev.recent.pct >= 0 ? 'up' : 'down'} on the 3 months before.` });
    const nm = byKey.netMargin;
    const nmCmp = nm && (nm.yoy || nm.recent);
    if (nmCmp && Math.abs(nmCmp.delta) >= 0.02) insights.push({ tone: nmCmp.delta >= 0 ? 'good' : 'bad', text: `Net margin ${nmCmp.delta >= 0 ? 'improved' : 'slipped'} from ${fmtPct(nmCmp.from)} to ${fmtPct(nmCmp.to)} ${nm.yoy ? 'compared with a year ago' : 'over the last 3 months'}.` });
    const fx = byKey.fixed;
    const fxCmp = fx && (fx.yoy || fx.recent);
    if (fxCmp && fxCmp.pct != null && Math.abs(fxCmp.pct) >= 0.08) {
      // Name the categories behind the overhead change when a year of history exists.
      let why = '';
      if (hasYoY) {
        const a = catAvg(yearAgo, 'byFixed'), b = catAvg(last3, 'byFixed');
        const top = [...new Set([...a.keys(), ...b.keys()])].map((c) => ({ c, d: (b.get(c) || 0) - (a.get(c) || 0) }))
          .filter((x) => Math.sign(x.d) === Math.sign(fxCmp.delta) && Math.abs(x.d) >= 100).sort((x, y) => Math.abs(y.d) - Math.abs(x.d)).slice(0, 2);
        if (top.length) why = ` Biggest change${top.length > 1 ? 's' : ''}: ${top.map((x) => `${x.c} (${x.d > 0 ? '+' : '-'}${fmtWhole(Math.abs(x.d))}/month)`).join(', ')}.`;
      }
      insights.push({ tone: fxCmp.delta > 0 ? 'bad' : 'good', text: `Overhead is ${fmtWhole(fxCmp.to)}/month, ${fmtPct(Math.abs(fxCmp.pct))} ${fxCmp.delta > 0 ? 'higher' : 'lower'} than ${fx.yoy ? 'a year ago' : 'the 3 months before'}.${why}` });
    }
    const dso = byKey.dso;
    const dsoCmp = dso && (dso.yoy || dso.recent);
    if (dsoCmp && Math.abs(dsoCmp.delta) >= 5) insights.push({ tone: dsoCmp.delta > 0 ? 'bad' : 'good', text: `Customers are taking ${Math.round(dsoCmp.to)} days to pay on average, ${dsoCmp.delta > 0 ? 'up' : 'down'} from ${Math.round(dsoCmp.from)} days ${dso.yoy ? 'a year ago' : '3 months ago'}.` });
    const lost = customerMovers.filter((c) => c.status === 'Lost');
    const added = customerMovers.filter((c) => c.status === 'New');
    if (lost.length) insights.push({ tone: 'bad', text: `${lost.length === 1 ? `${lost[0].name} has` : `${lost.length} customers have`} not been billed in the last 3 months${lost.length === 1 ? ` (last invoice ${lost[0].lastMonth}, ${fmtWhole(lost[0].lifetime)} lifetime)` : ''}.` });
    if (added.length) insights.push({ tone: 'good', text: `New in the last 6 months: ${added.map((c) => `${c.name} (${fmtWhole(c.recent)}/month lately)`).join(', ')}.` });
    const sw = byKey.software;
    const swCmp = sw && (sw.yoy || sw.recent);
    if (swCmp && swCmp.pct != null && swCmp.pct >= 0.15 && swCmp.delta >= 50) insights.push({ tone: 'bad', text: `Software spend is up ${fmtPct(swCmp.pct)} ${sw.yoy ? 'year over year' : 'on the prior 3 months'}, to ${fmtWhole(swCmp.to)}/month.` });

    const strip = (list) => list.map(({ byCategory, byFixed, byVariable, byCustomer, ...rest }) => ({
      ...rest,
      categories: Object.fromEntries([...byCategory].map(([c, v]) => [c, round2(v)])),
    }));
    return {
      months: strip(monthList),
      quarters: strip(quarterList),
      metrics,
      lastFullMonth: lastKey,
      hasYoY,
      windows: {
        last3: last3.map((m) => m.label),
        prior3: prior3.map((m) => m.label),
        yearAgo: hasYoY ? yearAgo.map((m) => m.label) : [],
      },
      costMovers: costMovers.slice(0, 8),
      customerMovers,
      insights,
      customerRevenueByMonth: monthList.map((m) => ({ key: m.key, partial: m.partial, byCustomer: Object.fromEntries(m.byCustomer) })),
    };
  }

  // ---------------------------------------------------------------- customer concentration & risk

  function customerRisk(txns, accountClass, cash, trend, breakeven) {
    const prof = profitability(txns, accountClass, 'customer');
    if (!prof.groups.length) return null;
    const margins = new Map(prof.groups.map((g) => [g.name, g]));
    // Concentration uses the trailing 12 whole months when available, so long-gone
    // customers don't dilute today's picture.
    const monthsAll = trend ? trend.customerRevenueByMonth.filter((m) => !m.partial) : [];
    const window = monthsAll.length >= 12 ? monthsAll.slice(-12) : monthsAll;
    const recent = new Map();
    for (const m of window) for (const [c, v] of Object.entries(m.byCustomer)) recent.set(c, (recent.get(c) || 0) + v);
    const basis = recent.size ? recent : new Map(prof.groups.map((g) => [g.name, g.revenue]));
    const windowMonths = recent.size ? window.length : Math.max(1, breakeven ? breakeven.months : 1);
    const total = [...basis.values()].reduce((t, v) => t + Math.max(0, v), 0) || 1;

    const arBy = new Map();
    const over90By = new Map();
    if (cash) {
      for (const i of cash.ar.openInvoices) {
        arBy.set(i.party, (arBy.get(i.party) || 0) + i.open);
        if (i.age > 90) over90By.set(i.party, (over90By.get(i.party) || 0) + i.open);
      }
    }
    const lagBy = new Map(cash ? cash.ar.customerLags.map((l) => [l.name, l.medianDays]) : []);
    const moverBy = new Map(trend ? trend.customerMovers.map((c) => [c.name, c]) : []);
    const arTotal = cash ? cash.ar.total : 0;
    const baseProfit = breakeven ? breakeven.profit : null;

    const names = new Set([...basis.keys(), ...prof.groups.map((g) => g.name)]);
    const rows = [...names].map((name) => {
      const g = margins.get(name);
      const rev = Math.max(0, basis.get(name) || 0);
      const share = rev / total;
      const margin = g ? g.margin : null;
      const mover = moverBy.get(name);
      const openAR = round2(arBy.get(name) || 0);
      const over90 = round2(over90By.get(name) || 0);
      const days = lagBy.has(name) ? lagBy.get(name) : null;
      const monthlyRevenue = round2(rev / windowMonths);
      const monthlyContribution = margin != null ? round2(monthlyRevenue * margin) : null;
      const flags = [];
      if (mover && mover.status === 'Lost') flags.push({ kind: 'Lost', level: 'high', detail: `No invoices since ${mover.lastMonth}` });
      if (share >= 0.25) flags.push({ kind: 'Concentration', level: 'high', detail: `${fmtPct(share)} of revenue` });
      else if (share >= 0.15) flags.push({ kind: 'Large share', level: 'medium', detail: `${fmtPct(share)} of revenue` });
      if (over90 > 0) flags.push({ kind: 'Over 90 days', level: 'high', detail: `${fmtMoney(over90)} unpaid over 90 days` });
      if (days != null && days > 45) flags.push({ kind: 'Slow payer', level: 'medium', detail: `Pays in ${days} days on average` });
      if (mover && mover.status === 'Shrinking') flags.push({ kind: 'Shrinking', level: 'medium', detail: `Revenue ${fmtPct(mover.pct)} vs prior 3 months` });
      if (margin != null && margin < 0.2) flags.push({ kind: 'Low margin', level: 'medium', detail: `${fmtPct(margin)} gross margin` });
      return {
        name, revenue: round2(rev), lifetimeRevenue: g ? g.revenue : 0, share, margin, openAR, arShare: arTotal ? openAR / arTotal : 0, over90, days,
        status: mover ? mover.status : null, trendPct: mover ? mover.pct : null, flags,
        monthlyRevenue, monthlyContribution,
        profitIfLost: baseProfit != null && monthlyContribution != null && !(mover && mover.status === 'Lost') ? round2(baseProfit - monthlyContribution) : null,
      };
    }).filter((r) => r.revenue > 0 || r.lifetimeRevenue > 0 || r.openAR > 0)
      .sort((a, b) => b.revenue - a.revenue || b.lifetimeRevenue - a.lifetimeRevenue);

    const active = rows.filter((r) => r.revenue > 0);
    const hhi = Math.round(active.reduce((t, r) => t + (r.share * 100) ** 2, 0));
    const level = hhi >= 2500 ? { label: 'Highly concentrated', tone: 'high' } : hhi >= 1500 ? { label: 'Moderately concentrated', tone: 'medium' } : { label: 'Diversified', tone: 'good' };
    const top = active[0] || null;
    return {
      rows,
      windowLabel: recent.size ? (window.length >= 12 ? 'last 12 months' : `last ${window.length} months`) : 'the full period',
      top,
      top1Share: top ? top.share : 0,
      top3Share: active.slice(0, 3).reduce((t, r) => t + r.share, 0),
      hhi,
      level,
      activeCount: active.length,
      arTopShare: rows.reduce((m, r) => Math.max(m, r.arShare), 0),
      baseProfit,
    };
  }

  // ---------------------------------------------------------------- vendors & payables

  const LARGE_COMPANY = /\bbank\b|credit union|comcast|xfinity|verizon|at&t|t-mobile|spectrum|cox comm|amazon|costco|home depot|lowe'?s|staples|office depot|walmart|target|best buy|uber|lyft|fedex|\bups\b|usps|delta air|united air|southwest|chase|bank of america|wells fargo|american express|paypal|stripe|square|gusto|adp\b|paychex|pg&e|con ed|duke energy|national grid/i;
  const CORP_SUFFIX = /\b(inc|incorporated|corp|corporation)\b\.?/i;

  const PAYROLL_ACCOUNT = /payroll|wages|salar/i;
  const threshold1099 = (year) => (year <= 2025 ? 600 : 2000);

  // Payments to each vendor by calendar year, split by bank and card, for 1099 review.
  function tax1099(txns, accountClass, meta) {
    const cls = (a) => classOf(accountClass, a);
    const entries = logicalRows(txns, accountClass);
    const postings = toPostings(txns, accountClass);
    const byYear = new Map();
    const add = (year, who, method, amount, account) => {
      if (!who.key || amount <= 0) return;
      if (!byYear.has(year)) byYear.set(year, new Map());
      const m = byYear.get(year);
      if (!m.has(who.key)) m.set(who.key, { names: new Map(), bank: 0, card: 0, count: 0, rent: 0, accounts: new Set() });
      const v = m.get(who.key);
      v.names.set(who.raw, (v.names.get(who.raw) || 0) + 1);
      v[method] += amount;
      v.count++;
      if (account) { v.accounts.add(leafAccount(account)); if (/rent|lease/i.test(account)) v.rent += amount; }
    };
    // Bills are reported when paid, so count the bill payments.
    const billAccount = new Map();
    for (const p of postings) if (/^bill$/i.test(p.t.type)) billAccount.set(payeeKeyOf(vendorOf(p.t)), p.category);
    for (const t of entries) {
      if (!/bill payment/i.test(t.type)) continue;
      const who = payeeOf(t);
      add(t.date.getUTCFullYear(), who, /credit card/i.test(t.type) ? 'card' : 'bank', Math.abs(t.amount), billAccount.get(who.key));
    }
    // Direct payments: checks, expenses and card charges coded straight to a cost account.
    for (const p of postings) {
      if (p.cls === 'income' || p.value <= 0 || /^bill$/i.test(p.t.type)) continue;
      if (PAYROLL_ACCOUNT.test(p.category)) continue;
      const funding = isPnlClass(cls(p.t.account)) ? p.t.split : p.t.account;
      const fundRole = roleOf(accountClass, funding);
      const method = fundRole === 'card' ? 'card' : fundRole === 'cash' || cls(funding) === 'balance' ? 'bank' : null;
      if (!method) continue;
      add(p.t.date.getUTCFullYear(), payeeOf(p.t), method, p.value, p.category);
    }
    const range = dateRange(txns, meta);
    const years = [...byYear.keys()].sort();
    const out = years.map((year) => {
      const full = range.first <= new Date(Date.UTC(year, 0, 3)) && range.last >= new Date(Date.UTC(year, 11, 28));
      const limit = threshold1099(year);
      const vendors = [...byYear.get(year).values()].map((v) => {
        v.vendor = displayPayee(v.names);
        let status, note;
        const bank = round2(v.bank), card = round2(v.card);
        if (bank < limit && card >= limit) { status = 'Card only'; note = 'Card payments are reported by the card processor on 1099-K.'; }
        else if (bank < limit) { status = 'Below threshold'; note = `Under ${fmtWhole(limit)} paid by check or bank transfer.`; }
        else if (saasCategory(v.vendor) || LARGE_COMPANY.test(v.vendor)) { status = 'Likely exempt'; note = 'Large company, usually a corporation. Keep a W-9 on file.'; }
        else if (CORP_SUFFIX.test(v.vendor)) { status = 'Likely exempt'; note = 'Name suggests a corporation. Confirm on the W-9 (attorneys still get a 1099).'; }
        else { status = 'Review'; note = 'Collect a W-9 to confirm whether a 1099 is needed.'; }
        const form = bank > 0 && v.rent > bank / 2 ? '1099-MISC (rent)' : '1099-NEC';
        return { vendor: v.vendor, bank, card, total: round2(bank + card), count: v.count, accounts: [...v.accounts].slice(0, 3), status, note, form };
      // Keep vendors paid $600+ by check or transfer (to watch the new $2,000 line fill up) and large card-only vendors.
      }).filter((v) => v.bank >= 600 || v.status === 'Card only')
        .sort((a, b) => (a.status === 'Review' ? 0 : 1) - (b.status === 'Review' ? 0 : 1) || b.bank - a.bank);
      return { year, full, threshold: limit, vendors, reviewCount: vendors.filter((v) => v.status === 'Review').length };
    });
    return out;
  }

  function vendorAnalysis(txns, accountClass, cash, trend, meta) {
    const range = dateRange(txns, meta);
    const ttm = trailingYear(range.first, range.last);
    // Payroll is people, not a vendor relationship, so it stays out of vendor spend.
    const all = toPostings(txns, accountClass).filter((p) => p.cls !== 'income' && p.value > 0 && !NON_CASH_ACCOUNT.test(p.category) && !PAYROLL_ACCOUNT.test(p.category));
    const postings = ttm ? all.filter((p) => p.t.date >= ttm.start && p.t.date <= ttm.end) : all;
    if (!postings.length) return null;
    const months = ttm ? 12 : monthsCovered(range.first, range.last);
    const full = trend ? trend.months.filter((m) => !m.partial) : [];
    const last3 = new Set(full.slice(-3).map((m) => m.key));
    const prior3 = new Set(full.slice(-6, -3).map((m) => m.key));

    const vendors = new Map();
    for (const p of all) {
      const who = payeeOf(p.t);
      if (!vendors.has(who.key)) vendors.set(who.key, { key: who.key, names: new Map(), spend: 0, variable: 0, fixed: 0, charges: 0, accounts: new Map(), recent: 0, prior: 0, card: 0, bank: 0, viaBills: false });
      const v = vendors.get(who.key);
      if (who.raw) v.names.set(who.raw, (v.names.get(who.raw) || 0) + 1);
      const k = p.t.dateStr.slice(0, 7);
      if (last3.has(k)) v.recent += p.value;
      if (prior3.has(k)) v.prior += p.value;
      if (ttm && (p.t.date < ttm.start || p.t.date > ttm.end)) continue;
      v.spend += p.value;
      v.charges++;
      const variable = p.cls === 'cogs' || !!customerOf(p.t, p.cls);
      if (variable) v.variable += p.value; else v.fixed += p.value;
      const acct = leafAccount(p.category);
      v.accounts.set(acct, (v.accounts.get(acct) || 0) + p.value);
      if (/^bill$/i.test(p.t.type)) v.viaBills = true;
      else if (roleOf(accountClass, p.t.split) === 'card' || roleOf(accountClass, p.t.account) === 'card') v.card += p.value;
      else v.bank += p.value;
    }
    const total = [...vendors.values()].reduce((t, v) => t + v.spend, 0) || 1;
    const lagBy = new Map(cash ? cash.ap.vendorLags.map((l) => [payeeKeyOf(l.name), l.medianDays]) : []);
    const openBy = new Map();
    if (cash) for (const b of cash.ap.openBills) openBy.set(payeeKeyOf(b.party), (openBy.get(payeeKeyOf(b.party)) || 0) + b.open);
    const rows = [...vendors.values()].filter((v) => v.spend > 0).map((v) => {
      v.name = v.key ? displayPayee(v.names) : 'No vendor recorded';
      const topAccount = [...v.accounts.entries()].sort((a, b) => b[1] - a[1])[0];
      const days = lagBy.has(v.key) ? lagBy.get(v.key) : null;
      return {
        name: v.name,
        key: v.key,
        aliases: [...v.names.keys()].filter((n) => lower(n) !== lower(v.name)).slice(0, 4),
        spend: round2(v.spend),
        monthly: round2(v.spend / months),
        share: v.spend / total,
        type: v.variable && v.fixed ? 'Mixed' : v.variable ? 'Job cost' : 'Overhead',
        account: topAccount ? topAccount[0] : '',
        charges: v.charges,
        trendPct: prior3.size === 3 && v.prior > 0 ? pctChange(v.prior, v.recent) : null,
        isNew: prior3.size === 3 && v.prior === 0 && v.recent > 0,
        days,
        openBills: round2(openBy.get(v.key) || 0),
        paidBy: v.viaBills ? 'Bills' : v.card > v.bank ? 'Card' : 'Bank',
      };
    }).sort((a, b) => b.spend - a.spend);

    // Paying faster than 30-day terms would require ties up cash for nothing.
    const billedMonthly = new Map();
    for (const p of postings) if (/^bill$/i.test(p.t.type)) {
      const v = payeeKeyOf(vendorOf(p.t));
      billedMonthly.set(v, (billedMonthly.get(v) || 0) + p.value / months);
    }
    const earlyPay = rows.filter((r) => r.days != null && r.days <= 10 && (billedMonthly.get(r.key) || 0) >= 300).map((r) => {
      const monthlyBills = round2(billedMonthly.get(r.key));
      return { name: r.name, days: r.days, monthlyBills, cashFreed: round2(monthlyBills * (30 - r.days) / 30.44) };
    });

    // Payables aging by bill age.
    const buckets = [
      { label: 'Current (0-30)', max: 30, amount: 0, count: 0 },
      { label: '31-60 days', max: 60, amount: 0, count: 0 },
      { label: '61-90 days', max: 90, amount: 0, count: 0 },
      { label: 'Over 90 days', max: Infinity, amount: 0, count: 0 },
    ];
    if (cash) for (const b of cash.ap.openBills) {
      const bk = buckets.find((x) => b.age <= x.max);
      bk.amount = round2(bk.amount + b.open);
      bk.count++;
    }

    // Bills coming due each forecast week against the projected cash balance.
    const weekly = cash ? cash.weeks.map((w, i) => {
      const start = new Date(`${w.start}T00:00:00Z`), end = new Date(`${w.end}T00:00:00Z`);
      const open = cash.ap.openBills.filter((b) => b.week === i).reduce((t, b) => t + b.open, 0);
      const expected = cash.recurring.filter((r) => /bill/i.test(r.source) && r.date >= start && r.date <= end).reduce((t, r) => t + r.amount, 0);
      return { week: w.week, start: w.start, open: round2(open), expected: round2(expected), ending: w.ending };
    }) : [];

    const latest = full.length ? full[full.length - 1] : null;
    const yearAgo = latest ? trend.months.find((m) => m.key === `${+latest.key.slice(0, 4) - 1}${latest.key.slice(4)}`) : null;
    const insights = [];
    const top = rows.find((r) => r.name !== 'No vendor recorded');
    if (top && top.share >= 0.2) insights.push({ tone: 'bad', text: `${top.name} is ${fmtPct(top.share)} of all spending (${fmtWhole(top.monthly)}/month). A price change or delay there moves the whole P&L.` });
    if (latest && latest.dso != null && latest.dpo != null) {
      const gap = latest.dpo - latest.dso;
      const was = yearAgo && yearAgo.dso != null && yearAgo.dpo != null ? yearAgo.dpo - yearAgo.dso : null;
      insights.push({
        tone: gap >= 0 ? 'good' : 'bad',
        text: `Customers pay in about ${latest.dso} days and vendors are paid in about ${latest.dpo}. ${gap >= 0 ? `That ${gap}-day gap works in the business's favor` : `Vendors are paid ${-gap} days before customers pay, so the gap is financed from cash`}${was != null && Math.abs(was - gap) >= 5 ? `; a year ago the gap was ${was} days` : ''}.`,
      });
    }
    for (const e of earlyPay) insights.push({ tone: 'bad', text: `${e.name} is paid about ${e.days} days after billing. If they allow 30-day terms, paying on day 30 would keep roughly ${fmtWhole(e.cashFreed)} more cash on hand.` });
    const risers = rows.filter((r) => r.trendPct != null && r.trendPct >= 0.25 && r.monthly >= 200).slice(0, 2);
    for (const r of risers) insights.push({ tone: 'bad', text: `Spending with ${r.name} is up ${fmtPct(r.trendPct)} over the last 3 months.` });

    return {
      windowLabel: ttm ? 'last 12 months' : 'the full period',
      total: round2(total),
      monthlyTotal: round2(total / months),
      rows,
      vendorCount: rows.length,
      top1Share: top ? top.share : 0,
      top5Share: rows.slice(0, 5).reduce((t, r) => t + r.share, 0),
      earlyPay,
      buckets,
      weekly,
      dpo: latest ? latest.dpo : null,
      dso: latest ? latest.dso : null,
      apEnd: latest ? latest.apEnd : null,
      insights,
      tax: memo('tax1099', txns, accountClass || EMPTY, () => tax1099(txns, accountClass, meta)),
    };
  }

  // ---------------------------------------------------------------- industry benchmarks

  // NAICS codes checked against the Intuit QuickBooks benchmark service.
  const INDUSTRIES = [
    ['Professional services', [['541430', 'Graphic Design Services'], ['541810', 'Advertising Agencies'], ['541611', 'Management Consulting Services'], ['541211', 'Offices of Certified Public Accountants'], ['541110', 'Offices of Lawyers'], ['541511', 'Custom Computer Programming Services'], ['541330', 'Engineering Services'], ['541310', 'Architectural Services'], ['541921', 'Photography Studios, Portrait'], ['541940', 'Veterinary Services'], ['54', 'Professional Services (all)']]],
    ['Construction & trades', [['236118', 'Residential Remodelers'], ['238220', 'Plumbing, Heating and AC Contractors'], ['238210', 'Electrical Contractors'], ['23', 'Construction (all)']]],
    ['Property & facility services', [['561730', 'Landscaping Services'], ['561720', 'Janitorial Services'], ['531210', 'Real Estate Agents and Brokers']]],
    ['Food & hospitality', [['722511', 'Full-Service Restaurants'], ['722515', 'Coffee and Snack Shops'], ['311811', 'Retail Bakeries'], ['72', 'Food Services (all)']]],
    ['Health, wellness & care', [['621210', 'Offices of Dentists'], ['621340', 'Physical Therapists'], ['812112', 'Beauty Salons'], ['713940', 'Fitness and Recreational Sports Centers'], ['624410', 'Child Day Care Services']]],
    ['Retail, auto & transport', [['44', 'Retail Trade (all)'], ['811111', 'General Automotive Repair'], ['484110', 'Local Freight Trucking']]],
  ].map(([group, list]) => ({ group, industries: list.map(([code, name]) => ({ code, name })) }));

  const STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');

  // The company's own yearly figures to compare: trailing 12 months when available,
  // otherwise the export annualized.
  function benchmarkInputs(result) {
    const be = result.breakeven;
    if (!be) return null;
    const scale = 12;
    const revenue = round2(be.base.revenue * scale);
    const expenses = round2((be.base.variable + be.base.fixed) * scale);
    const profit = round2(revenue - expenses);
    return {
      revenue, expenses, profit,
      marginPct: revenue > 0 ? (profit / revenue) * 100 : null,
      annualized: !be.trailing && be.months < 11.5,
      months: be.months,
      periodLabel: be.trailing ? `${be.firstDate} to ${be.lastDate}` : `${be.firstDate} to ${be.lastDate}${be.months < 11.5 ? ' (annualized)' : ''}`,
    };
  }

  const BENCH_METRICS = [
    { metric: 'revenue', label: 'Yearly revenue', kind: 'money', up: true },
    { metric: 'profit', label: 'Yearly profit', kind: 'money', up: true },
    { metric: 'margin', label: 'Profit margin', kind: 'pct', up: true },
    { metric: 'expenses', label: 'Yearly expenses', kind: 'money', up: null },
  ];

  // Arguments for the connector's benchmarking_against_industry tool.
  function benchmarkRequest(inputs, metric, industry, state, companyName) {
    const req = {
      industryType: [industry.name], naicsCode: [industry.code], location_state: state,
      companyName: norm(companyName).replace(/&/g, 'and').replace(/[^\w .,'-]/g, '').replace(/\s+/g, ' ').trim() || 'Client', aggregationPeriod: 'yearly', metricType: metric,
    };
    if (metric === 'margin') { req.metricValue = 0; req.profitValue = inputs.profit; req.revenueValue = inputs.revenue; }
    else req.metricValue = inputs[metric];
    return req;
  }

  // Normalizes one tool payload. Margin values arrive in percent.
  function readBenchmark(payload, metric) {
    const p = typeof payload === 'string' ? JSON.parse(payload) : payload;
    if (!p || p.status !== 'success') throw new Error((p && (p.message || p.error)) || 'The benchmark service returned no data.');
    const pct = metric === 'margin' || p.metricFormat === 'percent';
    const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
    return {
      metric,
      company: num(p.metricValue) != null ? (pct ? p.metricValue / 100 : p.metricValue) : null,
      regional: num(p.regionalAverage) != null && p.regionalAverage !== 0 ? (pct ? p.regionalAverage / 100 : p.regionalAverage) : null,
      national: num(p.nationalAverage) != null && p.nationalAverage !== 0 ? (pct ? p.nationalAverage / 100 : p.nationalAverage) : null,
      vsRegional: num(p.vsRegionalPercent) != null ? p.vsRegionalPercent / 100 : null,
      periodRange: p.benchmarkPeriodRange || '',
      location: p.location || '',
      naicsCode: p.naicsCode || '',
      label: p.metricLabel || '',
    };
  }

  // Compares the company with peer values from any source (live or entered by hand).
  function compareBenchmarks(inputs, peers) {
    return BENCH_METRICS.map((m) => {
      const company = m.metric === 'margin' ? (inputs.marginPct != null ? inputs.marginPct / 100 : null) : inputs[m.metric];
      const peer = peers[m.metric];
      if (company == null || peer == null || !isFinite(peer)) return { ...m, company, peer: null, diff: null, read: 'n/a' };
      const diff = m.kind === 'pct' ? company - peer : peer !== 0 ? (company - peer) / Math.abs(peer) : null;
      const near = m.kind === 'pct' ? Math.abs(diff) < 0.02 : diff != null && Math.abs(diff) < 0.1;
      const read = near ? 'In line' : m.up == null ? (diff > 0 ? 'Higher' : 'Lower') : (diff > 0) === m.up ? 'Ahead' : 'Behind';
      return { ...m, company, peer, diff, read };
    });
  }

  // ---------------------------------------------------------------- multiple exports

  // Combines several parsed exports (for example two years exported separately).
  // Rows repeated in a later file, as happens when date ranges overlap, are dropped.
  function mergeParsed(list) {
    if (list.length === 1) return list[0];
    const ordered = [...list].sort((a, b) => {
      const fa = a.transactions[0], fb = b.transactions[0];
      const da = Math.min(...a.transactions.map((t) => t.date)), db = Math.min(...b.transactions.map((t) => t.date));
      return (fa && fb ? da - db : 0);
    });
    const key = (t) => [t.dateStr, lower(t.type), t.num, lower(t.name), lower(t.customer), lower(t.memo), lower(t.account), lower(t.split), t.amount.toFixed(2)].join('|');
    const seen = new Map();
    const txns = [];
    let dropped = 0;
    ordered.forEach((p, fileIdx) => {
      const counts = new Map();
      for (const t of p.transactions) {
        const k = key(t);
        const inEarlier = seen.get(k) || 0;
        const used = counts.get(k) || 0;
        counts.set(k, used + 1);
        if (used < inEarlier) { dropped++; continue; }
        txns.push({ ...t, id: txns.length + 1, file: fileIdx });
      }
      for (const [k, n] of counts) seen.set(k, Math.max(seen.get(k) || 0, n));
    });
    // Opening balances come from the earliest export that has one for each account.
    const openingBalances = {};
    for (const p of ordered) for (const [a, v] of Object.entries(p.meta.openingBalances || {})) if (!(a in openingBalances)) openingBalances[a] = v;
    const first = ordered[0].meta;
    // The combined report period runs from the earliest start to the latest end.
    const ranges = ordered.map((p) => p.meta.periodRange).filter(Boolean);
    const starts = ranges.map((r) => r.start).filter(Boolean);
    const ends = ranges.map((r) => r.end).filter(Boolean);
    const periodRange = ranges.length ? {
      start: starts.length ? new Date(Math.min(...starts)) : null,
      end: ends.length ? new Date(Math.max(...ends)) : null,
    } : null;
    return {
      transactions: txns,
      meta: {
        ...first,
        reportLines: first.reportLines,
        period: ordered.map((p) => p.meta.period).filter(Boolean).join(' + '),
        rowCount: txns.length,
        openingBalances,
        periodRange,
        files: ordered.length,
        droppedOverlap: dropped,
      },
    };
  }

  // ---------------------------------------------------------------- loan readiness

  const INTEREST_ACCOUNT = /interest/i;
  const pmt = (principal, annualRate, years) => {
    const n = Math.round(years * 12);
    if (!principal || !n) return 0;
    const r = annualRate / 12;
    return r ? (principal * r) / (1 - Math.pow(1 + r, -n)) : principal / n;
  };
  const principalFor = (payment, annualRate, years) => {
    const n = Math.round(years * 12);
    if (payment <= 0 || !n) return 0;
    const r = annualRate / 12;
    return r ? payment * (1 - Math.pow(1 + r, -n)) / r : payment * n;
  };

  // Debt service coverage: cash the business generates before interest and non-cash
  // charges, divided by what it pays on loans in a year. Lenders commonly want 1.25.
  function loanReadiness(txns, accountClass, result, opts) {
    opts = opts || {};
    const be = result.breakeven;
    if (!be) return null;
    const range = dateRange(txns, result.meta);
    const ttm = trailingYear(range.first, range.last);
    const inWindow = (d) => (ttm ? d >= ttm.start && d <= ttm.end : true);
    const scale = ttm ? 1 : 12 / Math.max(1, be.months);
    const postings = toPostings(txns, accountClass).filter((p) => inWindow(p.t.date));
    const interest = round2(postings.filter((p) => p.cls !== 'income' && INTEREST_ACCOUNT.test(p.category)).reduce((t, p) => t + p.value, 0) * scale);
    const nonCash = round2(postings.filter((p) => p.cls !== 'income' && NON_CASH_ACCOUNT.test(p.category)).reduce((t, p) => t + p.value, 0) * scale);
    let principal = 0;
    for (const t of txns) {
      if (t.amount >= 0 || !inWindow(t.date) || roleOf(accountClass, t.account) !== 'cash') continue;
      if (roleOf(accountClass, t.split) === 'loan') principal += -t.amount;
    }
    principal = round2(principal * scale);
    const netIncome = round2(be.profit * 12);
    const addBacks = +opts.addBacks || 0;
    const cashAvailable = round2(netIncome + interest + nonCash + addBacks);
    const debtService = round2(principal + interest);
    const dscr = debtService > 0 ? cashAvailable / debtService : null;
    const target = opts.target || 1.25;

    const rate = opts.rate != null ? opts.rate / 100 : 0.105;
    const years = opts.years || 10;
    const amount = +opts.amount || 0;
    const newPayment = round2(pmt(amount, rate, years));
    const proForma = debtService + newPayment * 12 > 0 ? cashAvailable / (debtService + newPayment * 12) : null;
    const room = cashAvailable / target - debtService;
    const maxLoan = room > 0 ? round2(principalFor(room / 12, rate, years)) : 0;

    // Readiness checklist from what the rest of the analysis already knows.
    const checks = [];
    const add = (label, status, detail) => checks.push({ label, status, detail });
    const today = opts.today ? new Date(opts.today) : new Date();
    const age = Math.round((today - range.last) / DAY);
    add('Financials are current', age <= 60 ? 'pass' : age <= 90 ? 'warn' : 'fail', `The export ends ${isoDate(range.last)}, ${Math.max(0, age)} days ago. Lenders expect statements within 60 to 90 days of applying.`);
    const openFlags = result.audit.open.uncategorized + result.audit.open.duplicates;
    add('Books are clean', openFlags === 0 ? 'pass' : openFlags <= 5 ? 'warn' : 'fail', openFlags ? `${result.audit.open.uncategorized} uncategorized items and ${result.audit.open.duplicates} possible duplicates are still open. Clean books make the numbers match the bank statements lenders will compare them to.` : 'No uncategorized items or open duplicates.');
    add('Profitable over the last 12 months', netIncome > 0 ? 'pass' : 'fail', `Net income ${fmtWhole(netIncome)} (${fmtPct(be.profitMargin)} margin).`);
    if (dscr != null) add(`Debt coverage of at least ${target.toFixed(2)}`, dscr >= target ? 'pass' : dscr >= 1.15 ? 'warn' : 'fail', `Current coverage is ${dscr.toFixed(2)}: ${fmtWhole(cashAvailable)} available for ${fmtWhole(debtService)} of yearly loan payments.`);
    else add('Debt coverage', cashAvailable > 0 ? 'pass' : 'fail', `No loan payments found. ${fmtWhole(cashAvailable)} a year is available to cover new debt.`);
    const rev = result.trend && result.trend.metrics.find((m) => m.key === 'revenue');
    const revCmp = rev && (rev.yoy || rev.recent);
    if (revCmp && revCmp.pct != null) add('Revenue is steady or growing', revCmp.pct >= -0.05 ? 'pass' : revCmp.pct >= -0.15 ? 'warn' : 'fail', `Recent revenue is ${revCmp.pct >= 0 ? 'up' : 'down'} ${fmtPct(Math.abs(revCmp.pct))} ${rev.yoy ? 'on a year ago' : 'on the prior 3 months'}.`);
    const cr = result.customers;
    if (cr && cr.top) add('No single customer dominates', cr.top1Share < 0.25 ? 'pass' : cr.top1Share < 0.4 ? 'warn' : 'fail', `${cr.top.name} is ${fmtPct(cr.top1Share)} of revenue. Lenders discount revenue that depends on one client.`);
    const cash = result.cash;
    if (cash) {
      const months = be.base.fixed > 0 ? cash.startingCash / be.base.fixed : null;
      if (months != null) add('Cash cushion', months >= 2 ? 'pass' : months >= 1 ? 'warn' : 'fail', `${fmtWhole(cash.startingCash)} in the bank covers ${months.toFixed(1)} months of fixed costs.`);
      if (cash.ar.doubtfulTotal) add('Receivables are collectible', 'warn', `${fmtWhole(cash.ar.doubtfulTotal)} of invoices are over 90 days old; lenders exclude these from borrowing bases.`);
    }
    const draws = txns.filter((t) => t.amount < 0 && inWindow(t.date) && roleOf(accountClass, t.account) === 'cash' && roleOf(accountClass, t.split) === 'equity').reduce((s, t) => s - t.amount, 0) * scale;
    if (draws > 0) {
      const fits = draws <= Math.max(0, netIncome);
      add('Owner draws fit within profit', fits ? 'pass' : 'warn', `The owner took ${fmtWhole(draws)} against ${fmtWhole(netIncome)} of net income.${fits ? '' : ' Draws above profit drain the cash lenders count on.'}`);
    }

    return {
      windowLabel: ttm ? `${isoDate(ttm.start)} to ${isoDate(ttm.end)}` : `${isoDate(range.first)} to ${isoDate(range.last)} (annualized)`,
      netIncome, interest, nonCash, addBacks, cashAvailable, principal, debtService, dscr, target,
      draws: round2(draws),
      proposal: { amount, rate: rate * 100, years, payment: newPayment, proForma },
      maxLoan,
      checks,
      score: checks.filter((c) => c.status === 'pass').length,
    };
  }

  // ---------------------------------------------------------------- tax set-aside & owner pay

  const ENTITY = {
    sole: { label: 'Sole proprietor or single-member LLC', rate: 30, note: 'Income tax plus self-employment tax on the profit.' },
    partnership: { label: 'Partnership or multi-member LLC', rate: 30, note: 'Each partner owes income and self-employment tax on their share.' },
    scorp: { label: 'S corporation', rate: 25, note: 'Income tax on the profit passed through; payroll taxes are paid through the owner\'s salary.' },
    ccorp: { label: 'C corporation', rate: 25, note: '21% federal corporate tax plus state tax, paid by the company.' },
  };
  const TAX_ACCOUNT = /estimated tax|federal tax|state tax|income tax|\birs\b|tax payment/i;

  // Quarterly estimated-tax due dates for a tax year (weekend and holiday shifts not applied).
  const taxDueDates = (year) => [
    { label: `Q1 ${year}`, date: new Date(Date.UTC(year, 3, 15)) },
    { label: `Q2 ${year}`, date: new Date(Date.UTC(year, 5, 15)) },
    { label: `Q3 ${year}`, date: new Date(Date.UTC(year, 8, 15)) },
    { label: `Q4 ${year}`, date: new Date(Date.UTC(year + 1, 0, 15)) },
  ];

  function taxPlan(txns, accountClass, result, opts) {
    opts = opts || {};
    const tr = result.trend;
    const be = result.breakeven;
    if (!tr || !be) return null;
    const entity = ENTITY[opts.entity] ? opts.entity : 'sole';
    const rate = (opts.rate != null && opts.rate !== '' ? +opts.rate : ENTITY[entity].rate) / 100;
    const lastMonth = tr.months[tr.months.length - 1];
    const year = +lastMonth.key.slice(0, 4);
    const ytdMonths = tr.months.filter((m) => m.key.startsWith(`${year}-`));
    const ytdProfit = round2(ytdMonths.reduce((t, m) => t + m.netIncome, 0));
    const remaining = 12 - ytdMonths.length;
    const monthlyRunRate = be.profit;
    const projectedProfit = round2(ytdProfit + monthlyRunRate * remaining);
    const setAside = round2(Math.max(0, projectedProfit) * rate);

    // Estimated payments already made from the business accounts, if coded somewhere recognizable.
    let paidAuto = 0;
    for (const t of txns) {
      if (t.amount >= 0 || t.date.getUTCFullYear() !== year || roleOf(accountClass, t.account) !== 'cash') continue;
      if (TAX_ACCOUNT.test(t.split) || TAX_ACCOUNT.test(t.memo) || /\birs\b|us treasury|franchise tax|department of revenue/i.test(t.name)) paidAuto += -t.amount;
    }
    paidAuto = round2(paidAuto);
    const paid = opts.paid != null && opts.paid !== '' ? +opts.paid : paidAuto;

    const today = opts.today ? new Date(opts.today) : new Date();
    const asOf = result.cash ? new Date(`${result.cash.asOf}T00:00:00Z`) : new Date(`${result.period.end}T00:00:00Z`);
    const dues = taxDueDates(year);
    const upcoming = dues.filter((d) => d.date > asOf);
    const owed = Math.max(0, setAside - paid);
    const perQuarter = upcoming.length ? round2(owed / upcoming.length) : 0;
    const schedule = dues.map((d) => {
      const future = d.date > asOf;
      let cashCheck = null;
      if (future && result.cash) {
        const w = result.cash.weeks.find((wk) => d.date >= new Date(`${wk.start}T00:00:00Z`) && d.date <= new Date(`${wk.end}T00:00:00Z`));
        if (w) cashCheck = { week: w.start, ending: w.ending, after: round2(w.ending - perQuarter) };
      }
      return { label: d.label, due: isoDate(d.date), status: future ? 'Upcoming' : 'Past', amount: future ? perQuarter : null, cashCheck };
    });
    const next = schedule.find((s) => s.status === 'Upcoming') || null;

    // S corporation: salary versus distributions.
    let scorp = null;
    if (entity === 'scorp') {
      const salary = +opts.salary || 0;
      const range = dateRange(txns, result.meta);
      const ttm = trailingYear(range.first, range.last);
      const draws = txns.filter((t) => t.amount < 0 && roleOf(accountClass, t.account) === 'cash' && roleOf(accountClass, t.split) === 'equity' && (!ttm || (t.date >= ttm.start && t.date <= ttm.end))).reduce((s, t) => s - t.amount, 0);
      const share = salary + draws > 0 ? salary / (salary + draws) : null;
      scorp = {
        salary, distributions: round2(draws), share,
        status: share == null ? 'n/a' : share >= 0.4 ? 'pass' : 'warn',
        detail: share == null ? 'Enter the owner\'s yearly W-2 salary to compare it with distributions.'
          : `Salary is ${fmtPct(share)} of the owner's total pay (${fmtWhole(salary)} salary, ${fmtWhole(draws)} distributions over 12 months). ${share >= 0.4 ? 'That is within the range many advisors treat as reasonable.' : 'Many advisors look for at least 40% to 60% as salary; a low salary draws IRS attention.'}`,
      };
    }

    // Safe owner pay: the most cash that can leave over the forecast without breaching the cushion,
    // after the tax payments that fall inside it.
    let ownerPay = null;
    if (result.cash) {
      const cushion = +opts.cushion || 0;
      const endDate = new Date(`${result.cash.weeks[result.cash.weeks.length - 1].end}T00:00:00Z`);
      const taxInWindow = schedule.filter((s) => s.status === 'Upcoming' && new Date(`${s.due}T00:00:00Z`) <= endDate).reduce((t, s) => t + (s.amount || 0), 0);
      // Any money taken now lowers every later week, so the limit is the lowest week.
      let minHeadroom = Infinity;
      let taxSoFar = 0;
      for (const w of result.cash.weeks) {
        const wEnd = new Date(`${w.end}T00:00:00Z`);
        taxSoFar = schedule.filter((s) => s.status === 'Upcoming' && new Date(`${s.due}T00:00:00Z`) <= wEnd).reduce((t, s) => t + (s.amount || 0), 0);
        minHeadroom = Math.min(minHeadroom, w.ending - taxSoFar - cushion);
      }
      const planned = (result.cash.balanceOut || []).filter((b) => b.label === 'Owner draws').reduce((t, b) => t + b.amount * b.next.length, 0);
      ownerPay = { available: round2(Math.max(0, minHeadroom)), shortfall: minHeadroom < 0 ? round2(-minHeadroom) : 0, taxInWindow: round2(taxInWindow), plannedDraws: round2(planned), cushion };
    }

    return {
      year, entity, entityLabel: ENTITY[entity].label, entityNote: ENTITY[entity].note, rate,
      ytdMonths: ytdMonths.length, ytdProfit, monthlyRunRate, projectedProfit, setAside, paid, paidAuto, owed: round2(owed),
      perQuarter, schedule, next, scorp, ownerPay,
      daysToNext: next ? Math.round((new Date(`${next.due}T00:00:00Z`) - today) / DAY) : null,
    };
  }

  // ---------------------------------------------------------------- tie-out to the QuickBooks P&L

  // Reads a QuickBooks "Profit and Loss" export: section totals and account lines from the
  // Total column (the last number on each row). Returns null for anything else.
  function parseProfitAndLoss(text) {
    const rows = parseCSV(text);
    const firstCells = rows.map((r) => lower(r.find((c) => norm(c)) || ''));
    if (!firstCells.includes('net income') || rows.slice(0, 12).some((r) => r.map(lower).includes('date'))) return null;
    const lastNum = (r) => { for (let i = r.length - 1; i >= 1; i--) { const n = parseAmount(r[i]); if (n != null) return n; } return null; };
    const SECTIONS = [
      [/^income$/, 'income'], [/^other income$/, 'otherIncome'], [/^cost of (goods sold|sales)$/, 'cogs'],
      [/^expenses?$/, 'expenses'], [/^other expenses?$/, 'otherExpenses'],
    ];
    const totals = {};
    const accounts = [];
    let section = null;
    const meta = [];
    for (const r of rows) {
      const cells = r.map(norm);
      const label = cells.find((c) => c) || '';
      const l = lower(label);
      const val = lastNum(r);
      if (!label) continue;
      if (val == null) {
        const sec = SECTIONS.find(([rx]) => rx.test(l));
        if (sec) { section = sec[1]; continue; }
        if (!section) meta.push(label);
        continue;
      }
      if (/^total /.test(l)) {
        const name = l.replace(/^total /, '');
        const sec = SECTIONS.find(([rx]) => rx.test(name));
        if (sec) { totals[sec[1]] = val; section = null; }
        continue;
      }
      if (l === 'gross profit') { totals.grossProfit = val; continue; }
      if (l === 'net operating income') { totals.netOperatingIncome = val; continue; }
      if (l === 'net other income') { totals.netOtherIncome = val; continue; }
      if (l === 'net income') { totals.netIncome = val; continue; }
      if (section) accounts.push({ name: label.replace(/^\s+/, ''), section, amount: val });
    }
    if (totals.netIncome == null) return null;
    return { totals, accounts, company: meta[0] || '', period: parsePeriod(meta.slice(1, 4)), basis: /cash basis/i.test(text) ? 'cash' : /accrual basis/i.test(text) ? 'accrual' : null };
  }

  // Compares Ledger Lens figures with the client's own P&L for the same dates.
  function tieOut(txns, accountClass, meta, pnl) {
    if (!pnl) return null;
    const range = dateRange(txns, meta);
    const start = pnl.period && pnl.period.start ? pnl.period.start : range.first;
    const end = pnl.period && pnl.period.end ? pnl.period.end : range.last;
    const postings = toPostings(txns, accountClass).filter((p) => p.t.date >= start && p.t.date <= end);
    const byAccount = new Map();
    let revenue = 0, cogs = 0, expenses = 0;
    for (const p of postings) {
      if (p.cls === 'income') revenue += p.value; else if (p.cls === 'cogs') cogs += p.value; else expenses += p.value;
      const k = lower(p.category);
      byAccount.set(k, (byAccount.get(k) || 0) + p.value);
    }
    const t = pnl.totals;
    const qb = {
      revenue: (t.income || 0) + (t.otherIncome || 0),
      cogs: t.cogs || 0,
      expenses: (t.expenses || 0) + (t.otherExpenses || 0),
      netIncome: t.netIncome,
    };
    const ours = { revenue: round2(revenue), cogs: round2(cogs), expenses: round2(expenses), netIncome: round2(revenue - cogs - expenses) };
    const line = (label, a, b) => ({ label, quickbooks: round2(a), ledgerLens: round2(b), diff: round2(b - a), ties: Math.abs(b - a) < 1 });
    const lines = [
      line('Income (incl. other income)', qb.revenue, ours.revenue),
      line('Cost of goods sold', qb.cogs, ours.cogs),
      line('Expenses (incl. other expenses)', qb.expenses, ours.expenses),
      line('Net income', qb.netIncome, ours.netIncome),
    ];
    // Account by account, so a difference points at where it comes from.
    const inExport = new Map();
    for (const t of txns) for (const a of [t.account, t.split]) if (a) { inExport.set(lower(a), a); inExport.set(lower(leafAccount(a)), a); }
    const seen = new Set();
    const accounts = [];
    for (const a of pnl.accounts) {
      const key = lower(a.name);
      const leafKey = lower(leafAccount(a.name));
      const match = byAccount.has(key) ? key : [...byAccount.keys()].find((k) => lower(leafAccount(k)) === leafKey);
      const oursAmt = match ? byAccount.get(match) : 0;
      if (match) seen.add(match);
      const diff = round2(oursAmt - a.amount);
      if (Math.abs(diff) >= 1) {
        const exported = inExport.get(key) || inExport.get(leafKey);
        const cls = exported ? classOf(accountClass, exported) : null;
        accounts.push({
          name: a.name, quickbooks: a.amount, ledgerLens: round2(oursAmt), diff,
          hint: !exported ? 'Not in the Transaction Detail export. Check the report filters and date range.'
            : cls === 'balance' ? 'Treated as balance sheet here. Set it to the right P&L type in Account mapping.'
              : 'Amounts differ. Look for entries outside the date range or edited after export.',
        });
      }
    }
    for (const [k, v] of byAccount) {
      if (seen.has(k) || Math.abs(v) < 1) continue;
      accounts.push({ name: postings.find((p) => lower(p.category) === k).category, quickbooks: 0, ledgerLens: round2(v), diff: round2(v), hint: 'Counted as P&L here but not on the QuickBooks P&L. It may be a balance sheet account; check Account mapping.' });
    }
    const ties = lines.every((l) => l.ties) && accounts.length === 0;
    return {
      ties, lines, accounts: accounts.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)),
      period: `${isoDate(start)} to ${isoDate(end)}`, basis: pnl.basis,
      companyMatches: !pnl.company || !meta.company || lower(pnl.company) === lower(meta.company),
    };
  }

  // ---------------------------------------------------------------- review state & client questions

  // Keys that survive re-exporting: no line numbers or ids, only what the entry is.
  const rowKey = (t) => [t.dateStr, lower(t.type), t.num, lower(counterpartyOf(t)), Math.abs(t.amount).toFixed(2), lower(leafAccount(t.account))].join('|');
  const REVIEW_STATUSES = { ok: 'Not an issue', fixed: 'Fixed in QuickBooks', asked: 'Asked the client' };
  const isCleared = (r) => !!r && (r.status === 'ok' || r.status === 'fixed');

  function applyReview(audit, reviewed) {
    let cleared = 0;
    const tag = (item, key) => {
      item.key = key;
      item.review = reviewed[key] || null;
      if (isCleared(item.review)) cleared++;
    };
    audit.uncategorized.forEach((t) => tag(t, `u|${rowKey(t)}`));
    audit.duplicates.forEach((g) => tag(g, `d|${g.rows.map(rowKey).sort().join('~')}`));
    audit.mismatches.forEach((t) => tag(t, `m|${t.kind}|${rowKey(t)}`));
    return { cleared };
  }

  // Saved settings are filed under the company name from the report header.
  function clientKey(meta) {
    return lower((meta && meta.company) || '').replace(/[^a-z0-9]+/g, ' ').trim() || null;
  }

  const niceDate = (iso) => {
    const [y, m, d] = iso.split('-');
    return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m - 1]} ${+d}, ${y}`;
  };

  // A plain-language question list for the client, built from what is still open.
  function clientQuestions(result, opts) {
    opts = opts || {};
    const inc = Object.assign({ uncategorized: true, duplicates: true, coding: true, receivables: true, w9: true }, opts.include || {});
    const open = (item) => !isCleared(item.review);
    const sections = [];
    const keys = [];
    const who = (t) => counterpartyOf(t) || (t.memo ? `"${t.memo}"` : 'no payee recorded');
    const money = (n) => fmtMoney(Math.abs(n));

    const asked = new Set();
    if (inc.uncategorized) {
      const items = result.audit.uncategorized.filter(open).sort((a, b) => a.date - b.date).map((t) => {
        asked.add(rowKey(t));
        keys.push(t.key);
        const incoming = classOf(null, t.account) === 'income' || /deposit|sales receipt/i.test(t.type);
        return incoming
          ? `${niceDate(t.dateStr)}: a deposit of ${money(t.amount)} (${who(t)}). Who paid this, and what was it for?`
          : `${niceDate(t.dateStr)}: ${money(t.amount)} to ${who(t)}${t.memo && counterpartyOf(t) ? ` (${t.memo})` : ''}. What was this for?`;
      });
      if (items.length) sections.push({ title: 'Transactions we could not categorize', items });
    }
    if (inc.duplicates) {
      const items = result.audit.duplicates.filter(open).sort((a, b) => a.rows[0].date - b.rows[0].date).map((g) => {
        keys.push(g.key);
        const r = g.rows[0];
        const dates = g.rows.map((x) => niceDate(x.dateStr)).join(' and ');
        return /bill/i.test(r.type)
          ? `Bill${r.num ? ` #${r.num}` : ''} from ${who(r)} for ${money(r.amount)} is entered ${g.rows.length} times (${dates}). Did you receive ${g.rows.length} separate bills?`
          : `${who(r)} shows ${g.rows.length} charges of ${money(r.amount)} (${dates}). Were you charged ${g.rows.length === 2 ? 'twice' : `${g.rows.length} times`}, or is one of these a duplicate entry?`;
      });
      if (items.length) sections.push({ title: 'Possible double charges', items });
    }
    if (inc.coding) {
      const items = [];
      for (const t of result.audit.mismatches.filter(open).sort((a, b) => a.date - b.date)) {
        // Already asked about as uncategorized: one question per transaction.
        if (asked.has(rowKey(t))) continue;
        let q = null;
        if (t.kind === 'Missing payee') q = `${niceDate(t.dateStr)}: ${money(t.amount)}${t.memo ? ` ("${t.memo}")` : ''}. Who was this paid to?`;
        else if (t.kind === 'Type / account conflict' && /transfer/i.test(t.type)) q = `${niceDate(t.dateStr)}: a ${money(t.amount)} transfer${t.memo ? ` ("${t.memo}")` : ''}. Was this a move to another account of yours, or a payment to someone?`;
        else if (t.kind === 'Type / account conflict') q = `${niceDate(t.dateStr)}: ${money(t.amount)} with ${who(t)}${t.memo ? ` ("${t.memo}")` : ''}. Can you tell us what this was, so we can record it correctly?`;
        if (q) { items.push(q); keys.push(t.key); }
      }
      if (items.length) sections.push({ title: 'Entries we want to confirm', items });
    }
    if (inc.receivables && result.cash) {
      const items = result.cash.ar.openInvoices.filter((i) => i.age > 90).map((i) => `Invoice${i.num ? ` #${i.num}` : ''} to ${i.party} for ${money(i.open)} from ${niceDate(i.dateStr)} is still unpaid after ${i.age} days. Do you still expect payment, or should we write it off?`);
      if (items.length) sections.push({ title: 'Old unpaid invoices', items });
    }
    if (inc.w9 && result.vendors) {
      const names = [];
      for (const y of result.vendors.tax) for (const v of y.vendors) if (v.status === 'Review' && !names.includes(v.vendor)) names.push(v.vendor);
      const years = result.vendors.tax.filter((y) => y.reviewCount).map((y) => y.year);
      if (names.length) sections.push({ title: 'W-9 forms for contractors', items: [`Please send W-9 forms for ${names.join(', ')} (paid enough in ${years.join(' or ')} to need a 1099), or tell us which ones you already have on file.`] });
    }

    const count = sections.reduce((t, x) => t + x.items.length, 0);
    const end = result.period && result.period.end ? niceDate(result.period.end) : 'the latest period';
    const L = [];
    L.push(`Hi ${opts.greeting || 'there'},`);
    L.push('');
    if (!count) {
      L.push(`We've reviewed the books through ${end} and have no questions this time. Thank you!`);
    } else {
      L.push(`We're reviewing the books through ${end} and have ${count} question${count === 1 ? '' : 's'}. Short answers are fine, and receipts help where you have them.`);
      let n = 0;
      for (const sec of sections) {
        L.push('');
        L.push(sec.title.toUpperCase());
        for (const q of sec.items) L.push(`${++n}. ${q}`);
      }
      L.push('');
      L.push('Reply whenever is convenient. Anything you are unsure about, just say so and we will look into it.');
    }
    L.push('');
    L.push('Thanks,');
    if (opts.preparer) L.push(opts.preparer);
    return { text: L.join('\n'), count, sections, keys };
  }

  // ---------------------------------------------------------------- orchestration

  function accountNames(txns) {
    const counts = new Map();
    for (const t of txns) {
      for (const a of [t.account, t.split]) {
        if (!a || /^-split-$/i.test(a)) continue;
        counts.set(a, (counts.get(a) || 0) + 1);
      }
    }
    return counts;
  }

  // `detected` is what the account is treated as without a manual choice: its chart of
  // accounts type when one was loaded, otherwise the guess from its name.
  function listAccounts(counts, chartResolved) {
    return [...counts.entries()].map(([name, count]) => {
      const chart = chartResolved.source[name] && chartResolved.source[name].from === 'chart' ? chartResolved.source[name] : null;
      const detected = chart ? chartResolved.accountClass[name] : classifyAccount(name);
      return { name, count, detected, source: chart ? 'chart' : 'name', type: chart ? chart.type : null, role: roleOf(chartResolved.accountClass, name) };
    }).sort((a, b) => b.count - a.count);
  }

  function analyze(parsed, opts) {
    opts = opts || {};
    const txns = parsed.transactions;
    // Same file, corrections and chart give the same account setup object, so every cached
    // table stays valid when only forecast, loan or tax inputs change.
    const setupKey = `${JSON.stringify(opts.accountClass || {})}|${chartId(opts.chart)}`;
    const setup = memo(`setup:${setupKey}`, txns, EMPTY, () => {
      const counts = accountNames(txns);
      return { counts, chartOnly: resolveAccounts(counts.keys(), {}, opts.chart), resolved: resolveAccounts(counts.keys(), opts.accountClass, opts.chart) };
    });
    const counts = setup.counts;
    const chartOnly = setup.chartOnly;
    const { accountClass } = setup.resolved;
    const entries = logicalRows(txns, accountClass);
    // Everything that does not depend on forecast, loan or tax inputs is computed once per setup.
    const once = (name, fn) => memo(name, txns, accountClass, fn);
    const { uncategorized, duplicates, mismatches } = once(`audit:${opts.duplicateWindow}`, () => ({
      uncategorized: findUncategorized(entries),
      duplicates: findDuplicates(entries, opts.duplicateWindow),
      mismatches: findMismatches(entries, accountClass, txns),
    }));
    const profit = once(`profit:${opts.groupBy}`, () => profitability(txns, accountClass, opts.groupBy));
    const subs = once('subs', () => subscriptions(txns, accountClass));
    const cash = cashForecast(txns, accountClass, {
      meta: parsed.meta,
      openingBalances: parsed.meta.openingBalances,
      startingCash: opts.startingCash,
      includeDoubtful: opts.includeDoubtful,
    });
    const cashScenario = opts.scenario && normalizeScenario(opts.scenario).active ? cashForecast(txns, accountClass, {
      meta: parsed.meta, openingBalances: parsed.meta.openingBalances, startingCash: opts.startingCash, includeDoubtful: opts.includeDoubtful, scenario: opts.scenario,
    }) : null;
    const breakeven = once('breakeven', () => breakEven(txns, accountClass, parsed.meta));
    // Open bills that the audit flags as possible duplicates should not be paid blindly.
    if (cash) {
      const dupKeys = new Set(duplicates.flatMap((g) => g.rows.map((r) => `${lower(vendorOf(r))}|${r.num}|${r.dateStr}`)));
      for (const b of cash.ap.openBills) b.possibleDuplicate = dupKeys.has(`${lower(b.party)}|${b.num}|${b.dateStr}`);
      cash.ap.duplicateTotal = round2(cash.ap.openBills.filter((b) => b.possibleDuplicate).reduce((t, b) => t + b.open, 0));
    }
    const trend = once('trend', () => trends(txns, accountClass, { openingBalances: parsed.meta.openingBalances, meta: parsed.meta }));
    const customers = customerRisk(txns, accountClass, cash, trend, breakeven);
    const vendors = vendorAnalysis(txns, accountClass, cash, trend, parsed.meta);
    const uncategorizedTotal = round2(uncategorized.reduce((s, t) => s + Math.abs(t.amount), 0));
    const duplicateExposure = round2(duplicates.reduce((s, g) => s + g.exposure, 0));
    // Flags the bookkeeper cleared ("not an issue" or "fixed") drop out of the counts and score.
    const reviewed = opts.reviewed || {};
    const keyed = applyReview({ uncategorized, duplicates, mismatches }, reviewed);
    const openUnc = uncategorized.filter((t) => !isCleared(t.review));
    const openDup = duplicates.filter((g) => !isCleared(g.review));
    const openMis = mismatches.filter((t) => !isCleared(t.review));
    const flaggedIds = new Set([...openUnc.map((t) => t.id), ...openDup.flatMap((g) => g.rows.map((r) => r.id)), ...openMis.map((t) => t.id)]);
    const healthScore = entries.length ? Math.max(0, Math.round(100 - (flaggedIds.size / entries.length) * 100 * 1.5)) : 100;
    const out = {
      meta: parsed.meta,
      period: (() => { const r = dateRange(txns, parsed.meta); return { start: isoDate(r.first), end: isoDate(r.last) }; })(),
      count: txns.length,
      entryCount: entries.length,
      accounts: listAccounts(counts, chartOnly),
      chart: opts.chart ? { accounts: opts.chart.accounts.length, matched: Object.values(chartOnly.source).filter((x) => x.from === 'chart').length, of: counts.size } : null,
      audit: {
        uncategorized, uncategorizedTotal, duplicates, duplicateExposure, mismatches, flaggedCount: flaggedIds.size, healthScore,
        open: { uncategorized: openUnc.length, duplicates: openDup.length, mismatches: openMis.length },
        cleared: keyed.cleared,
        uncategorizedOpenTotal: round2(openUnc.reduce((t, x) => t + Math.abs(x.amount), 0)),
        duplicateOpenExposure: round2(openDup.reduce((t, g) => t + g.exposure, 0)),
      },
      clientKey: clientKey(parsed.meta),
      profit,
      subs,
      cash,
      breakeven,
      trend,
      customers,
      vendors,
      cashScenario,
    };
    out.tieOut = tieOut(txns, accountClass, parsed.meta, opts.pnl);
    // The advisory views read the finished analysis (audit, forecast, trends, customers).
    out.loan = loanReadiness(txns, accountClass, out, opts.loan);
    const cushion = opts.cushion != null && opts.cushion !== '' && !isNaN(+opts.cushion) ? +opts.cushion : breakeven ? Math.round(breakeven.base.fixed / 1000) * 1000 : 0;
    out.tax = taxPlan(txns, accountClass, out, Object.assign({ cushion }, opts.tax));
    return out;
  }

  // ---------------------------------------------------------------- report

  function fmtMoney(n) {
    if (n == null || isNaN(n)) return '-';
    const s = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (n < 0 ? '-$' : '$') + s;
  }
  const fmtWhole = (n) => (n == null || isNaN(n) ? '-' : `${n < 0 ? '-' : ''}$${Math.round(Math.abs(n)).toLocaleString('en-US')}`);
  const fmtPct = (n) => (n == null || !isFinite(n) ? 'n/a' : `${(n * 100).toFixed(1)}%`);
  const pad = (s, n) => String(s).slice(0, n).padEnd(n);
  const padL = (s, n) => String(s).slice(0, n).padStart(n);

  // ---------------------------------------------------------------- formatted (HTML) report

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const RC = { ink: '#15201b', ink2: '#4b5751', muted: '#7f8a84', hair: '#dde2dd', accent: '#17614a', s1: '#2a78d6', s2: '#eb6834', neg: '#d03b3b', warn: '#b07800', good: '#006300', neutral: '#b9c0ba' };

  // Round axis steps: 1, 2, 2.5 or 5 times a power of ten.
  function niceTicks(lo, hi, count) {
    const span = Math.max(1e-9, hi - lo);
    const raw = span / Math.max(1, count);
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((x) => x >= raw);
    const start = Math.floor(lo / step) * step;
    const ticks = [];
    for (let v = start; v <= hi + step * 0.5; v += step) ticks.push(Math.round(v * 100) / 100);
    return ticks;
  }
  const kMoney = (n) => {
    const a = Math.abs(n);
    return `${n < 0 ? '-' : ''}$${a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k` : a.toFixed(0)}`;
  };

  // Grouped monthly bars: revenue and total costs.
  function svgMonthly(months) {
    const W = 680, H = 230, L = 52, R = 8, T = 12, B = 34;
    const max = Math.max(1, ...months.map((m) => Math.max(m.revenue, m.variable + m.fixed)));
    const ticks = niceTicks(0, max, 4);
    const top = ticks[ticks.length - 1];
    const y = (v) => T + (H - T - B) * (1 - v / top);
    const band = (W - L - R) / months.length;
    const bw = Math.min(16, band * 0.32);
    let out = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Monthly revenue and costs">`;
    for (const t of ticks) out += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="${RC.hair}" stroke-width="1"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end" font-size="10" fill="${RC.muted}">${kMoney(t)}</text>`;
    months.forEach((m, i) => {
      const cx = L + band * i + band / 2;
      const cost = m.variable + m.fixed;
      out += `<rect x="${cx - bw - 1}" y="${y(m.revenue)}" width="${bw}" height="${Math.max(0, y(0) - y(m.revenue))}" rx="2" fill="${RC.s1}"><title>${esc(m.label)} revenue ${esc(fmtWhole(m.revenue))}</title></rect>`;
      out += `<rect x="${cx + 1}" y="${y(cost)}" width="${bw}" height="${Math.max(0, y(0) - y(cost))}" rx="2" fill="${RC.s2}"><title>${esc(m.label)} costs ${esc(fmtWhole(cost))}</title></rect>`;
      if (i % Math.ceil(months.length / 12) === 0) out += `<text x="${cx}" y="${H - B + 16}" text-anchor="middle" font-size="10" fill="${RC.muted}">${esc(m.label)}</text>`;
    });
    out += `<line x1="${L}" x2="${W - R}" y1="${y(0)}" y2="${y(0)}" stroke="${RC.muted}" stroke-width="1"/></svg>`;
    return out;
  }

  // Projected weekly cash with the cushion as a reference line.
  function svgCash(cash, cushion) {
    const W = 680, H = 210, L = 52, R = 12, T = 12, B = 30;
    const pts = [{ label: 'Now', v: cash.startingCash }, ...cash.weeks.map((w) => ({ label: niceDate(w.start).replace(/, \d{4}$/, ''), v: w.ending }))];
    const lo = Math.min(0, ...pts.map((p) => p.v), cushion || 0);
    const hi = Math.max(1, ...pts.map((p) => p.v), cushion || 0);
    const ticks = niceTicks(lo, hi, 4);
    const y0 = ticks[0], y1 = ticks[ticks.length - 1];
    const y = (v) => T + (H - T - B) * (1 - (v - y0) / (y1 - y0 || 1));
    const x = (i) => L + ((W - L - R) * i) / (pts.length - 1);
    let out = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Projected cash by week">`;
    for (const t of ticks) out += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="${RC.hair}"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end" font-size="10" fill="${RC.muted}">${kMoney(t)}</text>`;
    if (cushion) out += `<line x1="${L}" x2="${W - R}" y1="${y(cushion)}" y2="${y(cushion)}" stroke="${RC.warn}" stroke-width="1.5"/><text x="${W - R}" y="${y(cushion) - 4}" text-anchor="end" font-size="10" fill="${RC.warn}">Cushion ${esc(kMoney(cushion))}</text>`;
    const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
    out += `<path d="${path} L${x(pts.length - 1)},${y(Math.max(y0, 0))} L${x(0)},${y(Math.max(y0, 0))} Z" fill="${RC.s1}" fill-opacity="0.10"/><path d="${path}" fill="none" stroke="${RC.s1}" stroke-width="2"/>`;
    pts.forEach((p, i) => {
      const below = cushion && p.v < cushion;
      out += `<circle cx="${x(i)}" cy="${y(p.v)}" r="${below ? 4 : 3}" fill="${below ? RC.neg : RC.s1}" stroke="#fff" stroke-width="1.5"><title>${esc(p.label)}: ${esc(fmtWhole(p.v))}</title></circle>`;
      if (i % 2 === 0) out += `<text x="${x(i)}" y="${H - B + 16}" text-anchor="middle" font-size="10" fill="${RC.muted}">${esc(p.label)}</text>`;
    });
    return `${out}</svg>`;
  }

  function table(headers, rows, numericFrom) {
    const nf = numericFrom == null ? 1 : numericFrom;
    return `<table><thead><tr>${headers.map((h, i) => `<th${i >= nf ? ' class="n"' : ''}>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i >= nf ? ' class="n"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }

  function buildHtmlReport(result, opts) {
    opts = opts || {};
    const full = opts.version === 'full';
    const client = opts.clientName || result.meta.company || 'Client';
    const { audit, profit } = result;
    const cash = result.cash, be = result.breakeven, tr = result.trend, cr = result.customers, vd = result.vendors, tx = result.tax, ln = result.loan, tie = result.tieOut;
    const cushion = opts.cushion != null ? +opts.cushion : be ? Math.round(be.base.fixed / 1000) * 1000 : 0;
    const today = new Date().toISOString().slice(0, 10);
    const months = tr ? tr.months.filter((m) => !m.partial).slice(-12) : [];
    const rev12 = months.reduce((t, m) => t + m.revenue, 0);
    const ni12 = months.reduce((t, m) => t + m.netIncome, 0);
    const revMetric = tr && tr.metrics.find((m) => m.key === 'revenue');
    const revCmp = revMetric && (revMetric.yoy || revMetric.recent);
    const openFlags = audit.open.uncategorized + audit.open.duplicates + audit.open.mismatches;
    const steps = nextSteps(result, opts);
    const questions = clientQuestions(result, {});
    const qItems = questions.sections.flatMap((sec) => sec.items);

    const tile = (label, value, sub, tone) => `<div class="tile ${tone || ''}"><div class="tl">${esc(label)}</div><div class="tv">${esc(value)}</div><div class="ts">${esc(sub)}</div></div>`;
    const h = [];
    h.push(`<header><div class="brand">${esc(opts.preparer || 'Financial review')}</div><h1>${esc(client)}</h1><div class="meta">${full ? 'Full financial review' : 'Financial summary'} · ${esc(result.period.start)} to ${esc(result.period.end)} · prepared ${esc(today)}</div></header>`);
    h.push('<section class="tiles">');
    h.push(tile(months.length >= 12 ? 'Revenue, last 12 months' : 'Revenue', fmtWhole(months.length ? rev12 : profit.totals.revenue), revCmp && revCmp.pct != null ? `${revCmp.pct >= 0 ? 'Up' : 'Down'} ${fmtPct(Math.abs(revCmp.pct))} ${revMetric.yoy ? 'on last year' : 'on the prior 3 months'}` : ''));
    h.push(tile('Net income', fmtWhole(months.length ? ni12 : profit.totals.netIncome), `${fmtPct(months.length ? (rev12 ? ni12 / rev12 : null) : profit.totals.netMargin)} of revenue`, (months.length ? ni12 : profit.totals.netIncome) < 0 ? 'bad' : ''));
    if (cash) h.push(tile('Cash today', fmtWhole(cash.startingCash), `Lowest in 13 weeks: ${fmtWhole(cash.lowest.ending)} (${cash.lowest.start})`, cash.lowest.ending < cushion ? 'warn' : ''));
    h.push(tile('Books', openFlags ? `${openFlags} to review` : 'Clean', tie ? (tie.ties ? 'Ties to the QuickBooks P&L' : 'Does not yet tie to the QuickBooks P&L') : `Health score ${audit.healthScore}/100`, openFlags ? 'warn' : 'good'));
    h.push('</section>');

    if (months.length >= 3) {
      h.push(`<section><h2>How the business is doing</h2><div class="legend"><span><i style="background:${RC.s1}"></i>Revenue</span><span><i style="background:${RC.s2}"></i>Costs</span></div>${svgMonthly(months)}`);
      if (tr.insights.length) h.push(`<ul class="points">${tr.insights.slice(0, full ? 8 : 4).map((i) => `<li class="${i.tone}">${esc(i.text)}</li>`).join('')}</ul>`);
      h.push('</section>');
    }
    if (cash) {
      const below = cash.weeks.filter((w) => w.ending < cushion).length;
      const line = cash.firstNegative ? `Cash is projected to run out in the week of ${cash.firstNegative.start} without action.`
        : below ? `Cash dips below the ${fmtWhole(cushion)} cushion in ${below} of the next 13 weeks, lowest at ${fmtWhole(cash.lowest.ending)} in the week of ${cash.lowest.start}.`
          : `Cash stays above the ${fmtWhole(cushion)} cushion for the next 13 weeks.`;
      h.push(`<section class="keep"><h2>Cash over the next 13 weeks</h2>${svgCash(cash, cushion)}<p>${esc(line)} Expected in: ${esc(fmtWhole(cash.totals.inflow))}. Expected out: ${esc(fmtWhole(cash.totals.outflow))}.</p></section>`);
    }
    h.push(`<section><h2>What we recommend</h2><ol class="steps">${steps.slice(0, full ? 20 : 6).map((s) => `<li>${esc(s)}</li>`).join('')}</ol></section>`);
    if (qItems.length) {
      const shown = qItems.slice(0, full ? qItems.length : 8);
      h.push(`<section><h2>What we need from you</h2><p>${qItems.length} question${qItems.length === 1 ? '' : 's'} so we can finish the books.${shown.length < qItems.length ? ` The first ${shown.length} are below; we will send the rest separately.` : ''}</p><ol class="steps">${shown.map((q) => `<li>${esc(q)}</li>`).join('')}</ol></section>`);
    }

    if (full) {
      h.push('<h2 class="part">Details</h2>');
      if (tie) h.push(`<section class="keep"><h3>Ties to QuickBooks (${esc(tie.period)})</h3>${table(['Line', 'QuickBooks', 'This review', 'Difference'], tie.lines.map((l) => [l.label, fmtMoney(l.quickbooks), fmtMoney(l.ledgerLens), l.ties ? 'Ties' : fmtMoney(l.diff)]))}</section>`);
      h.push(`<section><h3>Profitability by customer</h3>${table(['Customer', 'Revenue', 'Direct cost', 'Gross margin', 'Net margin'], profit.groups.slice(0, 20).map((g) => [g.name, fmtWhole(g.revenue), fmtWhole(g.directCost), fmtPct(g.margin), fmtPct(g.netMargin)]))}</section>`);
      if (cr) h.push(`<section><h3>Customer concentration (${esc(cr.windowLabel)})</h3><p>${esc(cr.top.name)} is ${esc(fmtPct(cr.top1Share))} of revenue; the top 3 are ${esc(fmtPct(cr.top3Share))} (${esc(cr.level.label.toLowerCase())}).</p>${table(['Customer', 'Share', 'Gross margin', 'Open A/R', 'Pays in', 'Flags'], cr.rows.slice(0, 12).map((r) => [r.name, fmtPct(r.share), fmtPct(r.margin), fmtWhole(r.openAR), r.days != null ? `${r.days}d` : '-', r.flags.map((f) => f.kind).join(', ')]))}</section>`);
      if (be) h.push(`<section class="keep"><h3>Break-even</h3>${table(['Measure', 'Per month'], [['Average revenue', fmtWhole(be.base.revenue)], ['Variable costs', fmtWhole(be.base.variable)], ['Fixed costs', fmtWhole(be.base.fixed)], ['Break-even revenue', be.breakEvenRevenue != null ? fmtWhole(be.breakEvenRevenue) : 'n/a'], ['Margin of safety', fmtPct(be.marginOfSafety)]])}</section>`);
      if (vd) {
        h.push(`<section><h3>Largest vendors (${esc(vd.windowLabel)})</h3>${table(['Vendor', 'Per month', 'Share', 'Pays in', 'Type'], vd.rows.slice(0, 10).map((r) => [r.name, fmtWhole(r.monthly), fmtPct(r.share), r.days != null ? `${r.days}d` : '-', r.type]))}</section>`);
        const yr = [...vd.tax].reverse().find((y2) => y2.full) || vd.tax[vd.tax.length - 1];
        if (yr) h.push(`<section class="keep"><h3>1099 review, ${yr.year}</h3>${table(['Vendor', 'Check / transfer', 'Form', 'Status'], yr.vendors.filter((x) => x.status !== 'Card only').map((x) => [x.vendor, fmtWhole(x.bank), x.form, x.status]))}<p class="small">A screening list; a W-9 settles each case.</p></section>`);
      }
      if (result.subs && result.subs.list.length) h.push(`<section><h3>Software and subscriptions</h3>${table(['Vendor', 'Cadence', 'Per year', 'Flags'], result.subs.list.map((x) => [x.vendor, x.cadence, fmtWhole(x.annualized), x.flags.map((f) => f.kind).join(', ')]))}</section>`);
      if (ln) h.push(`<section class="keep"><h3>Loan readiness</h3><p>Debt service coverage: <strong>${ln.dscr != null ? ln.dscr.toFixed(2) : 'no existing debt'}</strong> (${esc(fmtWhole(ln.cashAvailable))} available for ${esc(fmtWhole(ln.debtService))} of yearly loan payments). Largest new loan at ${ln.target.toFixed(2)}: ${esc(fmtWhole(ln.maxLoan))}.</p>${table(['Check', 'Status', 'Detail'], ln.checks.map((c) => [c.label, c.status === 'pass' ? 'Ready' : c.status === 'warn' ? 'Watch' : 'Fix first', c.detail]), 99)}</section>`);
      if (tx) h.push(`<section class="keep"><h3>Tax set-aside, ${tx.year}</h3><p>Projected profit ${esc(fmtWhole(tx.projectedProfit))}; set aside ${esc(fmtWhole(tx.setAside))} at ${esc(fmtPct(tx.rate))} (${esc(fmtWhole(tx.paid))} paid so far).</p>${table(['Quarter', 'Due', 'Suggested payment'], tx.schedule.filter((q) => q.status === 'Upcoming').map((q) => [q.label, q.due, fmtWhole(q.amount)]), 2)}</section>`);
      const bm = opts.benchmarks;
      if (bm && bm.rows) h.push(`<section class="keep"><h3>Industry benchmarks: ${esc(bm.industry)}${bm.state ? `, ${esc(bm.state)}` : ''}</h3>${table(['Measure', 'Client', 'Peers', 'Read'], bm.rows.map((r) => [r.label, r.company == null ? '-' : r.kind === 'pct' ? fmtPct(r.company) : fmtWhole(r.company), r.peer == null ? '-' : r.kind === 'pct' ? fmtPct(r.peer) : fmtWhole(r.peer), r.read]))}<p class="small">Peer data: ${esc(bm.source)}${bm.periodRange ? `, ${esc(bm.periodRange)}` : ''}.</p></section>`);
    }
    h.push(`<footer>Figures come from the client's QuickBooks exports. Flags are leads for review, not confirmed errors. Tax and loan figures are planning estimates, not tax, legal or lending advice.</footer>`);

    const css = `
      @page { margin: 16mm 14mm; }
      * { box-sizing: border-box; }
      body { margin: 0; background: #fff; color: ${RC.ink}; font: 13px/1.5 -apple-system, "Segoe UI", system-ui, Roboto, sans-serif; }
      main { max-width: 760px; margin: 0 auto; padding: 28px 20px 40px; }
      header { border-bottom: 3px solid ${RC.accent}; padding-bottom: 12px; margin-bottom: 18px; }
      .brand { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: ${RC.accent}; font-weight: 600; }
      h1 { margin: 4px 0 2px; font-size: 26px; line-height: 1.2; }
      .meta { color: ${RC.ink2}; font-size: 12px; }
      h2 { font-size: 16px; margin: 22px 0 8px; }
      h2.part { margin-top: 30px; padding-top: 10px; border-top: 1px solid ${RC.hair}; font-size: 13px; letter-spacing: .1em; text-transform: uppercase; color: ${RC.ink2}; }
      h3 { font-size: 14px; margin: 18px 0 6px; }
      .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; }
      .tile { border: 1px solid ${RC.hair}; border-radius: 8px; padding: 10px 12px; }
      .tile.bad { border-color: ${RC.neg}; } .tile.warn { border-color: ${RC.warn}; } .tile.good { border-color: ${RC.good}; }
      .tl { font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; color: ${RC.muted}; }
      .tv { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
      .ts { font-size: 11.5px; color: ${RC.ink2}; }
      .legend { display: flex; gap: 14px; font-size: 11.5px; color: ${RC.ink2}; margin-bottom: 4px; }
      .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
      ul.points { padding-left: 18px; margin: 8px 0 0; } ul.points li { margin: 3px 0; }
      ul.points li.bad::marker { color: ${RC.neg}; } ul.points li.good::marker { color: ${RC.good}; }
      ol.steps { padding-left: 20px; margin: 6px 0; } ol.steps li { margin: 4px 0; }
      table { width: 100%; border-collapse: collapse; font-size: 12px; margin: 4px 0 6px; }
      th { text-align: left; font-weight: 600; color: ${RC.ink2}; border-bottom: 1.5px solid ${RC.ink2}; padding: 5px 6px; font-size: 11px; }
      td { border-bottom: 1px solid ${RC.hair}; padding: 5px 6px; vertical-align: top; }
      th.n, td.n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .small { font-size: 11px; color: ${RC.muted}; }
      section.keep, svg, tr { break-inside: avoid; }
      footer { margin-top: 28px; padding-top: 10px; border-top: 1px solid ${RC.hair}; font-size: 11px; color: ${RC.muted}; }
    `;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(client)}: ${full ? 'financial review' : 'financial summary'}</title><style>${css}</style></head><body><main>${h.join('\n')}</main></body></html>`;
  }

  // Action items shared by the text and formatted reports; open (not cleared) flags only.
  function nextSteps(result, opts) {
    opts = opts || {};
    const { audit, subs, profit } = result;
    const cash = result.cash, be = result.breakeven, cr = result.customers, tr = result.trend;
    const vd = result.vendors, tx = result.tax, ln = result.loan;
    const steps = [];
    if (audit.open.uncategorized) steps.push(`Provide receipts or context for the ${audit.open.uncategorized} uncategorized items so they can be coded.`);
    if (audit.open.duplicates) steps.push(`Review the ${audit.open.duplicates} possible duplicate groups; we will void confirmed duplicates or request vendor refunds.`);
    if (audit.open.mismatches) steps.push(`We will correct ${audit.open.mismatches} miscoded entries and set bank rules to keep vendor coding consistent.`);
    if (subs.potentialSavings > 0) steps.push(`Review flagged subscriptions; cancelling overlaps and unused seats could save about ${fmtMoney(subs.potentialSavings)} a year.`);
    if (cash && cash.firstNegative) steps.push(`Plan for a cash shortfall in the week of ${cash.firstNegative.start}: chase open invoices, delay discretionary spend, or line up credit now.`);
    else if (cash && opts.cushion && cash.lowest.ending < opts.cushion) steps.push(`Cash drops to ${fmtMoney(cash.lowest.ending)} in the week of ${cash.lowest.start}; speed up collections from slow payers before then.`);
    if (cash && cash.ar.doubtfulTotal) steps.push(`Follow up on ${fmtMoney(cash.ar.doubtfulTotal)} in invoices more than 90 days old.`);
    if (be && be.marginOfSafety != null && be.marginOfSafety < 0.15) steps.push(`Revenue is only ${fmtPct(be.marginOfSafety)} above break-even; review pricing and fixed costs together.`);
    if (cr && cr.top1Share >= 0.3) steps.push(`${cr.top.name} brings in ${fmtPct(cr.top1Share)} of revenue. Protect the relationship and build a pipeline so no single client can sink the year.`);
    const lostC = tr ? tr.customerMovers.filter((c) => c.status === 'Lost') : [];
    if (lostC.length) steps.push(`Reach out to ${lostC.map((c) => c.name).join(', ')}, who ${lostC.length === 1 ? 'has' : 'have'} not been billed in 3+ months.`);
    const dsoM = tr && tr.metrics.find((m) => m.key === 'dso');
    const dsoC = dsoM && (dsoM.yoy || dsoM.recent);
    if (dsoC && dsoC.delta >= 10) steps.push(`Collections are slowing (${Math.round(dsoC.from)} to ${Math.round(dsoC.to)} days). Send invoices sooner, add reminders, or require deposits.`);
    if (vd) {
      for (const e of vd.earlyPay) steps.push(`Ask ${e.name} for 30-day terms; paying on day 30 instead of day ${e.days} keeps about ${fmtWhole(e.cashFreed)} more cash on hand.`);
      const yr = [...vd.tax].reverse().find((y) => y.full);
      if (yr && yr.reviewCount) steps.push(`Collect W-9s and prepare 1099s for ${yr.reviewCount} vendor${yr.reviewCount === 1 ? '' : 's'} paid ${fmtWhole(yr.threshold)} or more in ${yr.year}.`);
    }
    if (tx && tx.next && tx.next.amount > 0) steps.push(`Set aside about ${fmtWhole(tx.next.amount)} for the ${tx.next.label} estimated tax payment due ${tx.next.due}.`);
    if (ln && ln.checks.some((c) => c.status === 'fail')) steps.push(`Before applying for financing, fix: ${ln.checks.filter((c) => c.status === 'fail').map((c) => c.label.toLowerCase()).join('; ')}.`);
    const weak = profit.groups.filter((g) => g.netMargin != null && g.netMargin < 0.1 && g.revenue > 0);
    if (weak.length) steps.push(`Discuss pricing on ${weak.length} low-margin ${opts.groupBy === 'project' ? 'project' : 'customer'}${weak.length > 1 ? 's' : ''}.`);
    return steps;
  }

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
    if (result.tieOut) L.push(`Ties to QuickBooks P&L:      ${result.tieOut.ties ? `Yes (${result.tieOut.period})` : `No: ${result.tieOut.lines.filter((l) => !l.ties).map((l) => `${l.label} off by ${fmtMoney(l.diff)}`).concat(result.tieOut.accounts.length ? [`${result.tieOut.accounts.length} account difference(s)`] : []).join('; ')}`}`);
    L.push(`Books health score:          ${audit.healthScore}/100`);
    L.push(`Uncategorized transactions:  ${audit.open.uncategorized} (${fmtMoney(audit.uncategorizedOpenTotal)})`);
    L.push(`Potential duplicate groups:  ${audit.open.duplicates} (${fmtMoney(audit.duplicateOpenExposure)} at risk)`);
    L.push(`Coding / entry mismatches:   ${audit.open.mismatches}`);
    if (audit.cleared) L.push(`Reviewed and cleared:        ${audit.cleared} flag${audit.cleared === 1 ? '' : 's'}`);
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

    const cr = result.customers;
    if (cr && cr.rows.length) {
      L.push(`8. CUSTOMER CONCENTRATION (${cr.windowLabel})`);
      L.push(thin);
      L.push(`Largest customer:             ${cr.top.name} (${fmtPct(cr.top1Share)} of revenue)`);
      L.push(`Top 3 customers:              ${fmtPct(cr.top3Share)} of revenue`);
      L.push(`Concentration:                ${cr.level.label} (HHI ${cr.hhi.toLocaleString('en-US')})`);
      if (cr.top.profitIfLost != null && cr.baseProfit != null) {
        L.push(`If ${cr.top.name} left, average monthly profit would go from ${fmtMoney(cr.baseProfit)} to ${fmtMoney(cr.top.profitIfLost)}.`);
      }
      L.push('');
      L.push(`  ${pad('Customer', 24)} ${padL('Share', 7)} ${padL('Margin', 7)} ${padL('Open A/R', 11)} ${padL('Pays in', 8)}  Flags`);
      for (const r of cr.rows.slice(0, 12)) {
        L.push(`  ${pad(r.name, 24)} ${padL(fmtPct(r.share), 7)} ${padL(fmtPct(r.margin), 7)} ${padL(fmtMoney(r.openAR), 11)} ${padL(r.days != null ? `${r.days}d` : '-', 8)}  ${r.flags.map((f) => f.kind).join('; ')}`);
      }
      L.push('');
    }

    const tr = result.trend;
    if (tr && tr.months.length >= 3) {
      L.push('9. TRENDS');
      L.push(thin);
      if (tr.insights.length) {
        L.push('What changed:');
        for (const i of tr.insights) L.push(`  - ${i.text}`);
        L.push('');
      }
      L.push(`  ${pad('Month', 8)} ${padL('Revenue', 12)} ${padL('Net income', 12)} ${padL('Margin', 7)} ${padL('DSO', 5)} ${padL('Cash', 12)}`);
      for (const m of tr.months.slice(-12)) {
        L.push(`  ${pad(m.label, 8)} ${padL(fmtMoney(m.revenue), 12)} ${padL(fmtMoney(m.netIncome), 12)} ${padL(fmtPct(m.netMargin), 7)} ${padL(m.dso != null ? m.dso : '-', 5)} ${padL(m.cashEnd != null ? fmtMoney(m.cashEnd) : '-', 12)}${m.partial ? '  (partial)' : ''}`);
      }
      L.push('');
    }

    const vd = result.vendors;
    if (vd && vd.rows.length) {
      L.push(`10. VENDORS & PAYABLES (${vd.windowLabel}, payroll excluded)`);
      L.push(thin);
      L.push(`Vendor spending:              ${fmtMoney(vd.monthlyTotal)} per month across ${vd.vendorCount} vendors`);
      L.push(`Top 5 vendors:                ${fmtPct(vd.top5Share)} of spending`);
      if (vd.dso != null && vd.dpo != null) L.push(`Days to collect / to pay:     ${vd.dso} / ${vd.dpo}`);
      L.push('');
      L.push(`  ${pad('Vendor', 26)} ${padL('Per month', 11)} ${padL('Share', 7)} ${padL('Pays in', 8)}  Type`);
      for (const r of vd.rows.slice(0, 10)) L.push(`  ${pad(r.name, 26)} ${padL(fmtMoney(r.monthly), 11)} ${padL(fmtPct(r.share), 7)} ${padL(r.days != null ? `${r.days}d` : '-', 8)}  ${r.type}`);
      if (vd.insights.length) {
        L.push('');
        for (const i of vd.insights) L.push(`  - ${i.text}`);
      }
      const yr = [...vd.tax].reverse().find((y) => y.full) || vd.tax[vd.tax.length - 1];
      if (yr) {
        const review = yr.vendors.filter((x) => x.status === 'Review');
        L.push('');
        L.push(`  1099 review for ${yr.year}${yr.full ? '' : ' (year to date)'} (threshold ${fmtWhole(yr.threshold)} paid by check or bank transfer):`);
        if (!review.length) L.push('    No vendors need review.');
        for (const x of review) L.push(`    ${pad(x.vendor, 28)} ${padL(fmtMoney(x.bank), 12)}  ${x.form}`);
        L.push('    Confirm each with a W-9. Card payments are reported by the card processor instead.');
      }
      L.push('');
    }

    const bm = opts.benchmarks;
    if (bm && bm.rows && bm.rows.some((r) => r.peer != null)) {
      L.push('11. INDUSTRY BENCHMARKS');
      L.push(thin);
      L.push(`Industry:                     ${bm.industry}${bm.code ? ` (NAICS ${bm.code})` : ''}`);
      if (bm.state) L.push(`Region:                       ${bm.state}`);
      L.push(`Peer data:                    ${bm.source}${bm.periodRange ? `, ${bm.periodRange}` : ''}`);
      L.push(`Company figures:              ${bm.companyPeriod}`);
      L.push('');
      L.push(`  ${pad('Measure', 18)} ${padL('Company', 13)} ${padL('Peers', 13)} ${padL('Difference', 11)}  Read`);
      for (const r of bm.rows) {
        const f = (v) => (v == null ? '-' : r.kind === 'pct' ? fmtPct(v) : fmtMoney(v));
        const d = r.diff == null ? '-' : r.kind === 'pct' ? `${r.diff > 0 ? '+' : ''}${(r.diff * 100).toFixed(1)} pts` : `${r.diff > 0 ? '+' : ''}${(r.diff * 100).toFixed(0)}%`;
        L.push(`  ${pad(r.label, 18)} ${padL(f(r.company), 13)} ${padL(f(r.peer), 13)} ${padL(d, 11)}  ${r.read}`);
      }
      L.push('');
    }

    const ln = result.loan;
    if (ln) {
      L.push(`12. LOAN READINESS (${ln.windowLabel})`);
      L.push(thin);
      L.push(`Net income:                   ${fmtMoney(ln.netIncome)}`);
      L.push(`+ Interest & non-cash costs:  ${fmtMoney(ln.interest + ln.nonCash)}${ln.addBacks ? `\n+ Owner add-backs:            ${fmtMoney(ln.addBacks)}` : ''}`);
      L.push(`= Cash available for debt:    ${fmtMoney(ln.cashAvailable)} per year`);
      L.push(`Existing loan payments:       ${fmtMoney(ln.debtService)} per year`);
      L.push(`Debt service coverage:        ${ln.dscr != null ? ln.dscr.toFixed(2) : 'no existing debt'} (lenders typically want ${ln.target.toFixed(2)} or more)`);
      L.push(`${pad(`Largest new loan at ${ln.target.toFixed(2)}:`, 30)}${fmtMoney(ln.maxLoan)} (${ln.proposal.years} years at ${ln.proposal.rate.toFixed(2)}%)`);
      if (ln.proposal.amount) L.push(`${pad(`Proposed ${fmtWhole(ln.proposal.amount)} loan:`, 30)}${fmtMoney(ln.proposal.payment)}/month, coverage after: ${ln.proposal.proForma != null ? ln.proposal.proForma.toFixed(2) : 'n/a'}`);
      L.push('');
      L.push('  Lender readiness checklist:');
      for (const c of ln.checks) L.push(`   [${c.status === 'pass' ? 'OK' : c.status === 'warn' ? '!!' : 'NO'}] ${c.label}: ${c.detail}`);
      L.push('');
    }

    const tx = result.tax;
    if (tx) {
      L.push(`13. TAX SET-ASIDE & OWNER PAY (${tx.year})`);
      L.push(thin);
      L.push(`Business type:                ${tx.entityLabel}`);
      L.push(`${pad(`Profit so far (${tx.ytdMonths} months):`, 30)}${fmtMoney(tx.ytdProfit)}`);
      L.push(`Projected full-year profit:   ${fmtMoney(tx.projectedProfit)}`);
      L.push(`${pad(`Set aside at ${fmtPct(tx.rate)}:`, 30)}${fmtMoney(tx.setAside)} (${fmtMoney(tx.paid)} paid so far)`);
      for (const q of tx.schedule.filter((x) => x.status === 'Upcoming')) L.push(`  ${q.label} due ${q.due}: ${fmtMoney(q.amount)}${q.cashCheck ? ` (cash that week ${fmtMoney(q.cashCheck.ending)} before paying)` : ''}`);
      if (tx.scorp) L.push(`  S corp salary check: ${tx.scorp.detail}`);
      if (tx.ownerPay) {
        L.push('');
        L.push(tx.ownerPay.available > 0
          ? `  The owner could take up to ${fmtMoney(tx.ownerPay.available)} more over the next 13 weeks and stay above the ${fmtMoney(tx.ownerPay.cushion)} cushion after tax payments${tx.ownerPay.plannedDraws ? ` (on top of ${fmtMoney(tx.ownerPay.plannedDraws)} of draws already expected)` : ''}.`
          : `  No room for extra owner pay: after tax payments${tx.ownerPay.plannedDraws ? ` and ${fmtMoney(tx.ownerPay.plannedDraws)} of expected draws` : ''}, cash is projected ${fmtMoney(tx.ownerPay.shortfall)} short of the ${fmtMoney(tx.ownerPay.cushion)} cushion.`);
      }
      L.push('  Estimates for planning only; confirm the rate and payments with the client\'s tax preparer.');
      L.push('');
    }

    L.push('RECOMMENDED NEXT STEPS');
    L.push(thin);
    const steps = nextSteps(result, opts);
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
    analyze, buildReport, buildHtmlReport, nextSteps, parseProfitAndLoss, tieOut, payeeKeyOf, cleanPayee, payeeOf, loanReadiness, taxPlan, ENTITY, pmt, clientQuestions, clientKey, REVIEW_STATUSES, parsePeriod, parseChartOfAccounts, resolveAccounts, roleOf, logicalRows, cashForecast, breakEven, whatIf, trends, customerRisk, mergeParsed, vendorAnalysis, tax1099, benchmarkInputs, benchmarkRequest, readBenchmark, compareBenchmarks, INDUSTRIES, STATES, BENCH_METRICS, fmtMoney, fmtWhole, fmtPct, counterpartyOf, leafAccount,
  };
});
