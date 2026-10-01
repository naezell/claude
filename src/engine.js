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
    attachments: ['attachments', 'attachment', '# of attachments', 'attachment count', 'no. of attachments'],
  };
  // QuickBooks shows a count of attached files; some exports say Yes/No.
  const attachCount = (v) => {
    const s = lower(v).trim();
    if (!s || s === 'no' || s === 'false' || s === '-') return 0;
    if (/^\d+$/.test(s)) return +s;
    return s === 'yes' || s === 'true' ? 1 : 0;
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
        attachments: map.attachments != null ? attachCount(get(r, 'attachments')) : null,
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
      const acct = ['expense', 'cogs'].includes(cls(t.account)) ? t.account : ['expense', 'cogs'].includes(cls(t.split)) ? t.split : '';
      if (!acct || RX.uncategorized.test(acct)) continue;
      // Sub-accounts of one parent count as the same place: a paycheck split between
      // Payroll Expenses:Wages and Payroll Expenses:Overtime is coded consistently.
      const cat = acct.includes(':') ? acct.slice(0, acct.lastIndexOf(':')) : acct;
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
    ['servicetitan', 'Field service'], ['jobber', 'Field service'], ['housecall pro', 'Field service'], ['fieldedge', 'Field service'], ['workiz', 'Field service'],
    ['square for restaurants', 'Point of sale'], ['square pos', 'Point of sale'], ['toast pos', 'Point of sale'], ['toasttab', 'Point of sale'], ['clover pos', 'Point of sale'], ['clover network', 'Point of sale'], ['clover app', 'Point of sale'], ['lightspeed', 'Point of sale'], ['spoton', 'Point of sale'],
    ['7shifts', 'Scheduling'], ['homebase', 'Scheduling'], ['when i work', 'Scheduling'],
    ['spotify for business', 'Music licensing'], ['soundtrack your brand', 'Music licensing'],
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
      const activeMonths = new Map();
      for (const mo of monthList) for (const c of mo.byCustomer.keys()) { lastSeen.set(c, mo.key); activeMonths.set(c, (activeMonths.get(c) || 0) + 1); }
      const recent6 = new Map();
      for (const mo of full.slice(-6)) for (const c of mo.byCustomer.keys()) recent6.set(c, (recent6.get(c) || 0) + 1);
      const recent3 = new Map();
      for (const mo of last3) for (const c of mo.byCustomer.keys()) recent3.set(c, (recent3.get(c) || 0) + 1);
      // Regular before going quiet: billed in at least 3 of the 6 months up to their last invoice.
      const idx = new Map(full.map((mo, i) => [mo.key, i]));
      const regularity = (c) => {
        const end = idx.get(lastSeen.get(c));
        if (end == null) return { months: 0, avg: 0 };
        const win = full.slice(Math.max(0, end - 5), end + 1);
        return { months: win.filter((mo) => mo.byCustomer.has(c)).length, avg: win.reduce((t, mo) => t + (mo.byCustomer.get(c) || 0), 0) / 6 };
      };
      // Big enough to matter: at least 2% of a typical month's revenue.
      const typical = full.slice(-12).reduce((t, mo) => t + mo.revenue, 0) / Math.max(1, full.slice(-12).length);
      const material = typical * 0.02;
      for (const c of new Set([...recentT.keys(), ...everBefore.keys()])) {
        // One-time customers (a service call, a single job) are neither won nor lost, and
        // register sales under one name are not a customer at all.
        if (isWalkIn(c) || (activeMonths.get(c) || 0) < 2) continue;
        const r = recentT.get(c) || 0, p = priorT.get(c) || 0;
        if (r > 0 && !before.has(c) && ((recent3.get(c) || 0) < 2 && (recent6.get(c) || 0) < 3 || r / Math.max(1, last3.length) < material)) continue;
        if (r === 0) { const g = regularity(c); if (g.months < 3 || g.avg < material) continue; }
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

  // Register and counter sales recorded under one catch-all name are many customers, not one.
  const WALK_IN = /^(daily|pos|point of sale|walk[- ]?in|cash (customer|sales?)|counter|retail|store|register|sales receipts?|misc(ellaneous)?|various|general|web|online|shopify|square|toast|clover|stripe)\b.*|\b(daily|pos|register|counter|walk[- ]?in)\b.*\bsales\b|^customers?$/i;
  const isWalkIn = (name) => WALK_IN.test(String(name || '').trim());

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
      const walkIn = isWalkIn(name);
      if (walkIn) return { name, walkIn, revenue: round2(rev), lifetimeRevenue: g ? g.revenue : 0, share, margin, openAR, arShare: arTotal ? openAR / arTotal : 0, over90, days, status: null, trendPct: null, flags: [{ kind: 'Walk-in sales', level: 'low', detail: 'Counter or register sales under one name; not a single customer' }], monthlyRevenue, monthlyContribution, profitIfLost: null };
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

    // Concentration is about named customers; walk-in sales are many small buyers.
    const active = rows.filter((r) => r.revenue > 0 && !r.walkIn);
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
      walkInShare: rows.filter((r) => r.walkIn).reduce((t, r) => t + r.share, 0),
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
  // Not payments for services: goods, utilities, insurance, interest, taxes, fees, travel.
  const NON_1099_ACCOUNT = /material|inventory|supplies|packaging|food|beverage|merchandise|freight|shipping|postage|utilit|insurance|interest|bank (fee|charge|service)|merchant|service charge|fuel|telephone|phone|internet|software|subscri|\btax|licens|permit|meals|travel|depreciation|amortization|equipment rental/i;
  // Payees that never get a 1099: utilities, insurers, banks and lenders, tax agencies.
  const NO_1099_PAYEE = /insurance|assurance|\bbank\b|credit union|financial|\bcredit\b|light & water|utilit|power|energy|gas & electric|water (district|dept)|wireless|irs\b|eftps|dept\.? of revenue|department of|state of|county of|city of|recology|waste management/i;

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
      const acct = billAccount.get(who.key);
      if (acct && NON_1099_ACCOUNT.test(acct)) continue;
      add(t.date.getUTCFullYear(), who, /credit card/i.test(t.type) ? 'card' : 'bank', Math.abs(t.amount), acct);
    }
    // Direct payments: checks, expenses and card charges coded straight to a cost account.
    for (const p of postings) {
      if (p.cls === 'income' || p.value <= 0 || /^bill$/i.test(p.t.type)) continue;
      // Uncategorized payments stay in: an unexplained check to a person may well be contract work.
      if (PAYROLL_ACCOUNT.test(p.category) || NON_1099_ACCOUNT.test(p.category)) continue;
      if (/transfer|journal|deposit|payroll|tax payment|credit card payment/i.test(p.t.type)) continue;
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
        else if (NO_1099_PAYEE.test(v.vendor)) { status = 'Likely exempt'; note = 'Utilities, insurers, banks, lenders and tax agencies do not get 1099s.'; }
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

  // Vendors that charge the same amount again and again, and have raised it. A run of at least
  // three matching charges, then at least two at a new higher level that is still in force.
  function priceChanges(postings, range) {
    const series = new Map();
    for (const p of postings) {
      const who = payeeOf(p.t);
      if (!who.key || RX.uncategorized.test(p.category)) continue;
      const k = `${who.key}|${lower(leafAccount(p.category))}`;
      if (!series.has(k)) series.set(k, { key: who.key, names: new Map(), account: leafAccount(p.category), list: [] });
      const s = series.get(k);
      if (who.raw) s.names.set(who.raw, (s.names.get(who.raw) || 0) + 1);
      s.list.push(p);
    }
    const same = (a, b) => Math.abs(a - b) <= Math.max(0.5, a * 0.01);
    const out = [];
    for (const s of series.values()) {
      if (s.list.length < 5) continue;
      const list = s.list.slice().sort((a, b) => a.t.date - b.t.date);
      // Split into runs of matching amounts; a single stray charge (a one-off or a duplicate) is skipped.
      const runs = [];
      for (const p of list) {
        const cur = runs[runs.length - 1];
        if (cur && same(cur.amount, p.value)) { cur.items.push(p); continue; }
        runs.push({ amount: p.value, items: [p] });
      }
      const steady = runs.filter((r) => r.items.length >= 2);
      if (steady.length < 2) continue;
      const now = steady[steady.length - 1], was = steady[steady.length - 2];
      if (was.items.length < 3 || now !== runs[runs.length - 1] && runs[runs.length - 1].items.length > 1) continue;
      // The new price must be current: its last charge is recent for the vendor's cadence.
      const gaps = list.slice(1).map((p, i) => (p.t.date - list[i].t.date) / 864e5).filter((g) => g > 0);
      const cadence = median(gaps);
      if (!cadence || cadence > 100) continue;
      const lastDate = now.items[now.items.length - 1].t.date;
      if ((range.last - lastDate) / 864e5 > cadence * 2 + 7) continue;
      const from = round2(was.amount), to = round2(now.amount);
      if (!(to > from * 1.02 && to - from >= 2)) continue;
      const perYear = Math.max(1, Math.round(365 / cadence));
      out.push({
        name: displayPayee(s.names),
        key: s.key,
        account: s.account,
        from,
        to,
        pct: to / from - 1,
        since: now.items[0].t.dateStr,
        perYear,
        cadence: perYear >= 50 ? 'weekly' : perYear >= 11 ? 'monthly' : perYear >= 4 ? 'quarterly' : 'yearly',
        annualImpact: round2((to - from) * perYear),
      });
    }
    return out.sort((a, b) => b.annualImpact - a.annualImpact);
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
    // What the increases add up to, and the price rise that would pay for them.
    const { increases, revenue } = memo('prices', txns, accountClass || EMPTY, () => ({
      increases: priceChanges(all, range),
      revenue: toPostings(txns, accountClass).filter((p) => p.cls === 'income' && (!ttm || (p.t.date >= ttm.start && p.t.date <= ttm.end))).reduce((t, p) => t + p.value, 0),
    }));
    const annualIncrease = round2(increases.reduce((t, r) => t + r.annualImpact, 0));
    const annualRevenue = revenue * 12 / months;
    const prices = { rows: increases, annualIncrease, annualRevenue: round2(annualRevenue), priceRiseToHold: annualRevenue > 0 ? annualIncrease / annualRevenue : null };
    if (increases.length) insights.push({ tone: 'bad', text: `${increases.length} vendor${increases.length === 1 ? ' has' : 's have'} raised ${increases.length === 1 ? 'its price' : 'their prices'}, adding about ${fmtWhole(annualIncrease)} a year${prices.priceRiseToHold != null ? `. Holding profit steady would take a price rise of about ${fmtPct(prices.priceRiseToHold)} on today's sales` : ''}.` });
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
      prices,
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
  // Works out which QuickBooks report a file is and parses it: { kind, data } with kind one of
  // chart, budget, pnl, answers, attachments, voided, employees, customers or parsed (transactions). Throws with a message
  // that follows the file name ("has a header row but no dated transactions.").
  function readExport(text) {
    // A chart of accounts has Account and Type columns and no dates.
    const coa = parseChartOfAccounts(text);
    if (coa) return { kind: 'chart', data: coa };
    const bud = parseBudget(text);
    if (bud) return { kind: 'budget', data: bud };
    // A Profit and Loss report has a Net Income line and no dates.
    const pl = parseProfitAndLoss(text);
    if (pl) return { kind: 'pnl', data: pl };
    // The client's filled-in questions spreadsheet, and an expense list with attachments.
    const ans = parseAnswers(text);
    if (ans) return { kind: 'answers', data: ans };
    const att = parseAttachmentList(text);
    if (att) return { kind: 'attachments', data: att };
    const vd = parseVoidedDeleted(text);
    if (vd) return { kind: 'voided', data: vd };
    const emps = parseEmployeeList(text);
    if (emps) return { kind: 'employees', data: emps };
    const custs = parseCustomerList(text);
    if (custs) return { kind: 'customers', data: custs };
    const p = parseTransactions(text);
    if (!p.transactions.length) throw new Error('has a header row but no dated transactions.');
    return { kind: 'parsed', data: p };
  }

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

  // ---------------------------------------------------------------- lender package

  const WAGE_ACCOUNT = /wage|salar|officer comp|payroll(?!.*tax)/i;
  const PAYROLL_TAX_ACCOUNT = /payroll.*tax|employer tax|fica|futa|suta|social security|medicare/i;
  const TAX_PAYEE = /\birs\b|eftps|internal revenue|dept\.? of (revenue|labor)|department of (revenue|labor)|state tax|employment dev/i;
  const CURRENT_ASSET_NAME = /undeposited|inventory|prepaid|receivable|deposit|petty cash/i;
  const CURRENT_LIAB_NAME = /payable|accrued|deferred|liabilit|gift card|customer deposit/i;
  const LINE_OF_CREDIT = /line of credit|credit line|\bloc\b|revolv/i;

  // Everything a lender-ready package needs beyond the loan readiness figures: statements by
  // year, a balance summary, ratios lenders test, and problems to fix before the bank sees them
  // (payroll that doesn't line up with payroll taxes, balances that look wrong, and so on).
  function lenderPackage(txns, accountClass, result) {
    const ln = result.loan;
    if (!ln) return null;
    const range = dateRange(txns, result.meta);
    const ttm = trailingYear(range.first, range.last);
    const postings = toPostings(txns, accountClass);

    // Income statement: one column per calendar year in the export (the last may be partial),
    // plus the trailing twelve months when there is enough history.
    const years = [...new Set(postings.map((p) => p.t.date.getUTCFullYear()))].sort();
    const cols = years.map((y) => {
      const start = new Date(Date.UTC(y, 0, 1)), end = new Date(Date.UTC(y, 11, 31));
      const from = start < range.first ? range.first : start, to = end > range.last ? range.last : end;
      const months = Math.max(1, Math.round(monthsCovered(from, to)));
      return { key: String(y), label: months >= 12 ? String(y) : `${y} (${months} mo)`, from, to, months };
    });
    if (ttm) cols.push({ key: 'ttm', label: 'Last 12 months', from: ttm.start, to: ttm.end, months: 12 });
    const lines = new Map();
    for (const p of postings) {
      const k = `${p.cls}|${p.category}`;
      if (!lines.has(k)) lines.set(k, { cls: p.cls, name: p.category, v: {} });
      const line = lines.get(k);
      for (const c of cols) {
        if (p.t.date < c.from || p.t.date > c.to) continue;
        line.v[c.key] = (line.v[c.key] || 0) + p.value;
      }
    }
    const group = (cls) => [...lines.values()].filter((l) => l.cls === cls && cols.some((c) => Math.abs(l.v[c.key] || 0) >= 0.5)).sort((a, b) => a.name.localeCompare(b.name))
      .map((l) => ({ name: l.name, v: Object.fromEntries(cols.map((c) => [c.key, round2(l.v[c.key] || 0)])) }));
    const sum = (rows) => Object.fromEntries(cols.map((c) => [c.key, round2(rows.reduce((t, r) => t + (r.v[c.key] || 0), 0))]));
    const income = group('income'), cogs = group('cogs'), expenses = group('expense');
    const totals = { income: sum(income), cogs: sum(cogs), expenses: sum(expenses) };
    totals.gross = Object.fromEntries(cols.map((c) => [c.key, round2(totals.income[c.key] - totals.cogs[c.key])]));
    totals.net = Object.fromEntries(cols.map((c) => [c.key, round2(totals.gross[c.key] - totals.expenses[c.key])]));
    const statement = { columns: cols.map(({ key, label, months }) => ({ key, label, months })), income, cogs, expenses, totals };

    // Balance summary from the account balances at the end of the export.
    const bs = result.balanceSheet && result.balanceSheet.available ? result.balanceSheet : null;
    let balance = null, ratios = {};
    if (bs) {
      const rows = bs.balances.filter((b) => Math.abs(b.balance) >= 0.5);
      const assets = [], currentLiabs = [], longTerm = [];
      for (const b of rows) {
        if (b.role === 'cash' || b.role === 'ar') assets.push({ ...b, current: true });
        else if (b.role === 'otherbalance' && CURRENT_ASSET_NAME.test(b.account) && b.balance > 0) assets.push({ ...b, current: true });
        else if (b.role === 'ap' || b.role === 'card' || b.role === 'salestax' || b.role === 'payrolltax') currentLiabs.push(b);
        else if (b.role === 'loan') (LINE_OF_CREDIT.test(b.account) ? currentLiabs : longTerm).push(b);
        else if (b.role === 'otherbalance' && CURRENT_LIAB_NAME.test(b.account)) currentLiabs.push(b);
      }
      const total = (xs) => round2(xs.reduce((t, b) => t + b.balance, 0));
      const cash = total(assets.filter((b) => b.role === 'cash'));
      const ar = total(assets.filter((b) => b.role === 'ar'));
      const ca = total(assets), cl = total(currentLiabs), ltd = total(longTerm);
      const debt = round2(total(rows.filter((b) => b.role === 'loan')));
      balance = { asOf: bs.asOf, assets, currentLiabs, longTerm, currentAssets: ca, currentLiabilities: cl, longTermDebt: ltd, totalDebt: debt };
      ratios.current = cl > 0 ? ca / cl : null;
      ratios.quick = cl > 0 ? (cash + ar) / cl : null;
      ratios.workingCapital = round2(ca - cl);
      const ebitda = round2(ln.netIncome + ln.interest + ln.nonCash);
      ratios.ebitda = ebitda;
      ratios.leverage = debt > 0 && ebitda > 0 ? debt / ebitda : null;
    }

    // Payroll: wages against employer payroll taxes, tax payments, and what is still owed.
    const inTtm = (d) => (ttm ? d >= ttm.start && d <= ttm.end : true);
    let wages = 0, ptax = 0;
    const wageMonths = new Map();
    for (const p of postings) {
      if (p.cls !== 'expense' && p.cls !== 'cogs') continue;
      const isTax = PAYROLL_TAX_ACCOUNT.test(p.category);
      const isWage = !isTax && WAGE_ACCOUNT.test(p.category);
      if (!inTtm(p.t.date)) continue;
      if (isTax) ptax += p.value;
      if (isWage) { wages += p.value; const m = p.t.dateStr.slice(0, 7); wageMonths.set(m, (wageMonths.get(m) || 0) + p.value); }
    }
    const taxPaidMonths = new Set();
    for (const t of txns) {
      if (t.amount >= 0 || roleOf(accountClass, t.account) !== 'cash') continue;
      if (roleOf(accountClass, t.split) === 'payrolltax' || /tax payment|liability check|payroll tax/i.test(t.type) || TAX_PAYEE.test(counterpartyOf(t) || '')) taxPaidMonths.add(t.dateStr.slice(0, 7));
    }
    const nextMonth = (m) => { const [y, mo] = m.split('-').map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; };
    const lastMonth = isoDate(range.last).slice(0, 7);
    const unpaidMonths = [...wageMonths.keys()].filter((m) => m < lastMonth && !taxPaidMonths.has(m) && !taxPaidMonths.has(nextMonth(m))).sort();
    const payrollBal = bs ? bs.balances.filter((b) => b.role === 'payrolltax').reduce((t, b) => t + b.balance, 0) : null;
    const payroll = { wages: round2(wages), taxes: round2(ptax), taxRate: wages > 0 ? ptax / wages : null, unpaidMonths, liability: payrollBal == null ? null : round2(payrollBal) };

    // Things to fix before the package goes to a lender, most serious first.
    const issues = [];
    const add = (severity, title, detail) => issues.push({ severity, title, detail });
    if (result.tieOut && !result.tieOut.ties) add('high', 'Numbers do not tie to the QuickBooks P&L', 'The figures here differ from the Profit and Loss report exported from QuickBooks. Lenders will compare the two; find the difference first (Ties to QuickBooks on the audit tab).');
    if (wages > 0 && ptax <= 0) add('high', 'Wages without employer payroll taxes', `${fmtWhole(wages)} of wages but no employer payroll tax expense in ${ln.windowLabel}. Lenders check payroll against the quarterly 941 filings; if a payroll service pays the taxes, their entries are missing from the books.`);
    else if (payroll.taxRate != null && (payroll.taxRate < 0.05 || payroll.taxRate > 0.16)) add('medium', 'Payroll taxes look out of line with wages', `Employer payroll taxes are ${fmtPct(payroll.taxRate)} of wages; about 8 to 12% is usual. Check that wages and taxes are coded to the right accounts and match the payroll reports.`);
    if (unpaidMonths.length && ptax > 0) add('medium', 'Months with wages but no payroll tax payment', `No payment to the IRS or state was found in or just after ${unpaidMonths.slice(0, 6).map(monthLabel).join(', ')}${unpaidMonths.length > 6 ? ` and ${unpaidMonths.length - 6} more` : ''}. Confirm the deposits were made and recorded.`);
    if (payrollBal != null && ptax > 0) {
      // What normally goes into the liability each month (employer taxes plus withholding); a
      // month or so owed at any time is normal, since deposits follow the payroll.
      let accrued = 0;
      for (const t of txns) if (roleOf(accountClass, t.account) === 'payrolltax' && t.amount > 0 && inTtm(t.date)) accrued += t.amount;
      const monthly = accrued / 12;
      if (monthly > 0 && payrollBal > Math.max(1000, monthly * 2)) add('high', 'Payroll liabilities are building up', `${fmtWhole(payrollBal)} owed in payroll liabilities, about ${(payrollBal / monthly).toFixed(1)} months of what normally builds up. Unpaid payroll taxes stop most loans; confirm they were paid or fix the entries.`);
      else if (payrollBal < -100) add('medium', 'Payroll liabilities are negative', `${fmtWhole(payrollBal)}: more paid than recorded as owed. Usually tax payments coded to the liability without the matching payroll entries.`);
    }
    for (const it of (bs ? bs.items : []).filter((x) => !(x.review && (x.review.status === 'ok' || x.review.status === 'fixed')))) add(/undeposited|opening balance|negative|below zero/i.test(`${it.kind} ${it.detail || ''}`) ? 'medium' : 'low', it.kind === it.account ? it.kind : `${it.kind}: ${it.account}`, it.detail || fmtMoney(it.amount));
    const openFlags = result.audit.open.uncategorized + result.audit.open.duplicates + result.audit.open.mismatches;
    if (openFlags) add(openFlags > 5 ? 'high' : 'medium', 'Open bookkeeping flags', `${result.audit.open.uncategorized} uncategorized, ${result.audit.open.duplicates} possible duplicates and ${result.audit.open.mismatches} miscoded entries are still open. Clear them so the statements match the bank statements.`);
    if (result.closed && result.closed.changedMonths) add('medium', 'Closed months were changed', `${result.closed.changedEntries} entries in months already closed have changed since the close. A lender who sees two versions of the same period will ask why.`);
    if (bs) {
      const loans = bs.balances.filter((b) => b.role === 'loan' && b.balance > 1);
      if (loans.length && ln.interest <= 0) add('medium', 'Loans with no interest expense', `${loans.map((b) => b.account).join(', ')} ${loans.length === 1 ? 'has' : 'have'} a balance but no interest was recorded. Payments may be coded entirely to principal.`);
      if (!loans.length && ln.interest > 0) add('low', 'Interest with no loan on the books', `${fmtWhole(ln.interest)} of interest but no loan balance. Add the loan to the balance sheet so the debt schedule is complete.`);
      for (const b of bs.balances.filter((x) => x.role === 'cash' && x.balance < -1)) add('medium', `${b.account} is overdrawn on the books`, `${fmtMoney(b.balance)} at ${bs.asOf}. Reconcile the account before sending statements.`);
    }
    if (ln.draws > Math.max(0, ln.netIncome) && ln.draws > 0) add('medium', 'Owner draws exceed profit', `${fmtWhole(ln.draws)} taken against ${fmtWhole(ln.netIncome)} of net income. Lenders read this as cash leaving the business.`);
    const personal = result.subs ? result.subs.list.filter((x) => (x.flags || []).some((f) => /personal/i.test(f.kind || f))) : [];
    if (personal.length) add('low', 'Possible personal expenses', `${personal.map((x) => x.vendor).join(', ')} ${personal.length === 1 ? 'looks' : 'look'} personal. Reclassify ${personal.length === 1 ? 'it' : 'them'} or be ready to add ${personal.length === 1 ? 'it' : 'them'} back.`);
    const age = Math.round((Date.now() - range.last) / DAY);
    if (age > 90) add('medium', 'Statements are not current', `The books run to ${isoDate(range.last)}. Most lenders want interim statements within 60 to 90 days.`);
    const order = { high: 0, medium: 1, low: 2 };
    issues.sort((a, b) => order[a.severity] - order[b.severity]);

    return { statement, balance, ratios, payroll, issues, asOf: isoDate(range.last) };
  }

  // ---------------------------------------------------------------- landscaping

  const LANDSCAPE_RX = /landscap|lawn|mow|snow|hardscape|irrigat|turf|sprinkler|mulch|tree (care|service)|grounds maint/i;
  // Guesses the industry from the company name and account names.
  function detectIndustry(meta, accounts) {
    if (LANDSCAPE_RX.test((meta && meta.company) || '')) return 'landscaping';
    const hits = (accounts || []).filter((a) => LANDSCAPE_RX.test(a)).length;
    return hits >= 2 ? 'landscaping' : 'general';
  }

  const SERVICE_LINES = [
    { key: 'snow', label: 'Snow & ice', rx: /snow|plow|salt|ice melt|de-?ic/i },
    { key: 'irrigation', label: 'Irrigation', rx: /irrigat|sprinkler|drip|backflow/i },
    { key: 'install', label: 'Installation & hardscape', rx: /install|hardscape|design|construct|patio|paver|retaining|planting project|landscape project/i },
    { key: 'enhance', label: 'Enhancements', rx: /enhanc|clean.?up|aerat|overseed|prun|tree|leaf|fertiliz|weed control|lighting/i },
    { key: 'maintenance', label: 'Maintenance', rx: /maint|mow|lawn care|grounds|contract|mulch|plants/i },
  ];
  const lineOf = (text) => { const l = SERVICE_LINES.find((x) => x.rx.test(text || '')); return l ? l.key : null; };
  const OVERTIME_ACCOUNT = /overtime|\bot\b/i;
  const EQUIP_WORD = /mower|zero.?turn|trimmer|blower|edger|skid|loader|trailer|truck|plow|spreader|aerator|tractor|excavator|chipper|stump|utv|atv|sprayer/i;
  const EXPENSE_EQUIP_ACCOUNT = /repair|maint|tool|supplies|equipment(?! rental)|small|materials/i;
  const EQUIP_LOAN = /deere|kubota|caterpillar|\bcat\b|bobcat|toro|exmark|equipment|truck|vehicle|ally|ford credit|gm financial|financial/i;

  // ---- Profit playbook: habits that cost a landscaper time and money, measured from the books
  // (last 12 months). Crew time is valued with the assumptions the page lets the bookkeeper set.
  const GAS_STATION = /quik ?trip|\bqt\b|casey|shell|\bbp\b|exxon|mobil|chevron|citgo|marathon|speedway|sunoco|phillips 66|valero|circle k|wawa|sheetz|love'?s|pilot|flying j|racetrac|murphy|holiday|7-eleven|conoco|sinclair|kum ?& ?go|kwik|maverik|buc-?ee|thorntons|gas station|\bgas\b/i;
  const FLEET_CARD = /wex|fleetcor|fuelman|voyager|fleet card|comdata/i;
  const BULK_FUEL = /propane|fuel delivery|bulk fuel|petroleum|oil co|energy|co-?op|farm supply|fuel oil/i;
  const SUPPLY_STORE = /home depot|lowe'?s|menards|ace hardware|true value|tractor supply|harbor freight|northern tool|farm ?& ?fleet|fleet farm|do it best|orscheln|rural king|siteone|ewing|horizon distribution|john deere landscapes|hardware/i;
  const VENDOR_FEE = /freight|delivery (fee|charge)|shipping|fuel surcharge|restock|handling fee|small order fee|hazmat fee|pallet (fee|charge)/i;
  const MATERIAL_ACCOUNT = /material|plant|mulch|stone|hardscape|irrigation|parts|salt|ice melt|supplies|tools|equipment|fuel|repair|seed|fertiliz|chemical|sod|nursery/i;
  const ADVERTISING = /advertis|marketing|mailer|postcard|promotion|door hanger|yard sign|lead/i;

  function landscapePlaybook(txns, accountClass, postings, inTtm, ttm) {
    const spend = postings.filter((p) => (p.cls === 'expense' || p.cls === 'cogs') && inTtm(p.t.date) && p.value > 0);
    const vendor = (p) => counterpartyOf(p.t) || '';
    const byVendor = (list) => {
      const m = new Map();
      for (const p of list) { const v = vendor(p) || 'No vendor'; const e = m.get(v) || { vendor: v, count: 0, total: 0 }; e.count++; e.total += p.value; m.set(v, e); }
      return [...m.values()].map((e) => ({ ...e, total: round2(e.total) })).sort((a, b) => b.count - a.count);
    };
    // Fuel bought one fill-up at a time at stations (or on a fleet card), not delivered in bulk.
    const fuelStops = spend.filter((p) => /fuel|gas(oline)?\b|diesel/i.test(p.category) && !BULK_FUEL.test(vendor(p)) && (GAS_STATION.test(vendor(p)) || FLEET_CARD.test(vendor(p)) || GAS_STATION.test(p.t.memo || '')));
    const bulkFuel = spend.filter((p) => /fuel|gas(oline)?\b|diesel/i.test(p.category) && BULK_FUEL.test(vendor(p)));
    // Small purchases at hardware and supply stores: a trip each.
    const runs = spend.filter((p) => p.value < 500 && SUPPLY_STORE.test(vendor(p)) && !VENDOR_FEE.test(p.t.memo || ''));
    // Flat fees on vendor tickets.
    const fees = spend.filter((p) => VENDOR_FEE.test(p.t.memo || '') || VENDOR_FEE.test(p.category));
    // Where the materials, parts and fuel money goes, and how it is paid.
    const vendors = new Map();
    for (const p of spend) {
      if (!MATERIAL_ACCOUNT.test(p.category) || WAGE_ACCOUNT.test(p.category) || GAS_STATION.test(vendor(p)) || FLEET_CARD.test(vendor(p))) continue;
      const v = vendor(p);
      if (!v) continue;
      const e = vendors.get(v) || { vendor: v, total: 0, purchases: 0, onCard: 0, onBills: 0 };
      e.total += p.value; e.purchases++;
      if (/bill/i.test(p.t.type)) e.onBills++;
      else if (roleOf(accountClass, p.t.split) === 'card' || roleOf(accountClass, p.t.account) === 'card') e.onCard++;
      vendors.set(v, e);
    }
    const topVendors = [...vendors.values()].sort((a, b) => b.total - a.total).slice(0, 8).map((e) => ({
      ...e, total: round2(e.total),
      paidBy: e.onBills >= e.purchases / 2 ? 'Bills (account)' : e.onCard >= e.purchases / 2 ? 'Card' : 'Check or cash',
      advice: e.total >= 20000 && e.onBills < e.purchases / 2 ? 'Big enough to ask for an account with 30-day terms'
        : e.total >= 20000 ? 'Ask for a volume or early-payment discount'
        : e.purchases >= 24 ? 'Frequent small orders: buy in bulk or set up a standing order' : '',
    }));

    // Growth: revenue by calendar year, the last 12 months against the 12 before, and the
    // average yearly growth across the full years in the export.
    const revYear = new Map();
    for (const p of postings) if (p.cls === 'income') { const y = p.t.dateStr.slice(0, 4); revYear.set(y, (revYear.get(y) || 0) + p.value); }
    const monthsIn = new Map();
    for (const t of txns) { const y = t.dateStr.slice(0, 4); if (!monthsIn.has(y)) monthsIn.set(y, new Set()); monthsIn.get(y).add(t.dateStr.slice(5, 7)); }
    const fullYears = [...revYear.keys()].filter((y) => monthsIn.get(y) && monthsIn.get(y).size === 12).sort();
    const years = fullYears.map((y, i) => ({ year: +y, revenue: round2(revYear.get(y)), change: i ? revYear.get(y) / revYear.get(fullYears[i - 1]) - 1 : null }));
    let ttmRev = 0, priorRev = 0;
    if (ttm) {
      const priorStart = new Date(Date.UTC(ttm.start.getUTCFullYear() - 1, ttm.start.getUTCMonth(), ttm.start.getUTCDate()));
      for (const p of postings) if (p.cls === 'income') { if (inTtm(p.t.date)) ttmRev += p.value; else if (p.t.date >= priorStart && p.t.date < ttm.start) priorRev += p.value; }
    }
    const first = years[0], last = years[years.length - 1];
    const growth = {
      years, ttm: round2(ttmRev), prior: round2(priorRev), ttmChange: priorRev > 0 ? ttmRev / priorRev - 1 : null,
      total: years.length >= 2 ? last.revenue / first.revenue - 1 : null,
      perYear: years.length >= 2 ? (last.revenue / first.revenue) ** (1 / (last.year - first.year)) - 1 : null,
    };

    // New customers: first invoice ever in the export, counted by month over the last year,
    // against advertising spend.
    const firstSeen = new Map();
    for (const p of postings) {
      if (p.cls !== 'income' || p.value <= 0) continue;
      const who = (customerOf(p.t, 'income') || p.t.name || '').split(':')[0];
      if (!who) continue;
      if (!firstSeen.has(who) || p.t.dateStr < firstSeen.get(who)) firstSeen.set(who, p.t.dateStr);
    }
    const exportStart = txns.reduce((m, t) => (t.dateStr < m ? t.dateStr : m), '9999');
    // Customers already there in the first three months of the export may just be older ones.
    const settled = (d) => d >= addMonthsKey(exportStart.slice(0, 7), 3);
    const newOnes = [...firstSeen.entries()].filter(([, d]) => settled(d) && inTtm(new Date(`${d}T00:00:00Z`)));
    const ads = spend.filter((p) => ADVERTISING.test(p.category));
    const adSpend = round2(ads.reduce((t, p) => t + p.value, 0));
    const byMonth = new Map();
    for (const [, d] of newOnes) byMonth.set(d.slice(0, 7), (byMonth.get(d.slice(0, 7)) || 0) + 1);
    const customers = {
      newCount: newOnes.length, adSpend, perCustomer: newOnes.length && adSpend ? round2(adSpend / newOnes.length) : null,
      byMonth: [...byMonth.entries()].sort().map(([k, n]) => ({ key: k, count: n })), reliable: firstSeen.size > 0 && txns.length > 0 && settled(addMonthsKey(exportStart.slice(0, 7), 12) + '-01'),
    };

    return {
      fuel: { stops: fuelStops.length, total: round2(fuelStops.reduce((t, p) => t + p.value, 0)), bulk: round2(bulkFuel.reduce((t, p) => t + p.value, 0)), vendors: byVendor(fuelStops).slice(0, 5) },
      supply: { runs: runs.length, total: round2(runs.reduce((t, p) => t + p.value, 0)), vendors: byVendor(runs).slice(0, 5) },
      fees: { count: fees.length, total: round2(fees.reduce((t, p) => t + p.value, 0)), vendors: byVendor(fees).slice(0, 6), examples: fees.slice(0, 5).map((p) => ({ date: p.t.dateStr, vendor: vendor(p), memo: p.t.memo || p.category, amount: round2(p.value) })) },
      vendors: topVendors, growth, customers,
    };
  }
  const addMonthsKey = (key, n) => { const [y, m] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); };

  // Crew time lost to stops and runs, valued at the page's assumptions.
  function playbookCost(pb, a) {
    a = a || {};
    const crew = +a.crew || 3, wage = +a.wage || 22, stopMin = +a.stopMinutes || 20, runMin = +a.runMinutes || 45;
    const fuelHours = pb.fuel.stops * crew * stopMin / 60;
    const runHours = pb.supply.runs * crew * runMin / 60;
    return { crew, wage, stopMin, runMin, fuelHours: Math.round(fuelHours), fuelCost: round2(fuelHours * wage), runHours: Math.round(runHours), runCost: round2(runHours * wage) };
  }

  // Mark's tips with nothing to measure in the books.
  const PLAYBOOK_TIPS = {
    lawn: [
      'Sell to several homes on the same street or in the same neighborhood to cut loading and unloading time.',
      'Offer current clients a discount when a neighbor signs up.',
      'Run three-person crews: one on the rider, two push mowing and trimming.',
      'Plan lawn routes to turn right wherever possible: less waiting to turn and fewer lights.',
      'Switch small equipment to ethanol-free fuel mixed in-house at 50 to 1 instead of buying premix; engines stay cleaner and last longer.',
      'If you don\'t fertilize, partner with a company that does and trade referrals.',
    ],
    landscape: [
      'Keep spare tools at the shop so a broken one doesn\'t mean a trip to the supply store.',
      'Stock as much inventory and daily-use material as you can safely store.',
      'Meet with vendors to negotiate account terms, and ask about exclusive seller rights for your area.',
      'Offer to demo vendors\' new tools and machines, and look for time-saving equipment you can get at dealer cost.',
      'After signing a project, mail the whole neighborhood.',
      'Offer homeowners a future discount for referrals.',
    ],
  };

  // ---- Route density: how close together the recurring customers are, from the QuickBooks
  // Customer Contact List (or a customer list export) with addresses.
  const STREET_WORDS = { street: 'st', avenue: 'ave', av: 'ave', road: 'rd', drive: 'dr', lane: 'ln', court: 'ct', circle: 'cir', boulevard: 'blvd', place: 'pl', parkway: 'pkwy', terrace: 'ter', trail: 'trl', highway: 'hwy', square: 'sq', north: 'n', south: 's', east: 'e', west: 'w' };
  const OFFICE_ADDRESS = /\bp\.?\s?o\.?\s?box\b|\bsuite\b|\bste\.?\s|\bfloor\b|\bc\/o\b/i;

  // Splits "1412 Oak Ridge Dr, Springfield, IL 62704" (or the same on several lines) into parts.
  function splitAddress(s) {
    const text = norm(String(s || '').replace(/\r/g, '').replace(/\n/g, ', '));
    if (!text) return null;
    const zip = (text.match(/\b(\d{5})(?:-\d{4})?\s*(?:,?\s*(?:usa|us|united states))?\s*$/i) || [])[1] || '';
    const parts = text.split(',').map((x) => x.trim()).filter(Boolean);
    const streetPart = parts.find((p) => /^\d+[a-z]?\s+\S/i.test(p)) || '';
    const cityIdx = parts.length >= 2 ? parts.length - (zip && /^[A-Z]{2}\s+\d{5}/i.test(parts[parts.length - 1]) ? 2 : 1) : -1;
    const city = cityIdx >= 0 && parts[cityIdx] !== streetPart ? parts[cityIdx].replace(/\s+[A-Z]{2}(\s+\d{5}.*)?$/, '') : '';
    return { text, street: streetPart, city, zip, office: OFFICE_ADDRESS.test(text) };
  }
  // "1412 Oak Ridge Drive Apt 3" → "oak ridge dr": the street without the house number or unit.
  function streetKey(street) {
    return lower(street).replace(/^\d+[a-z]?\s+/, '').replace(/\s*(#|apt\.?|unit|ste\.?|suite|lot)\s*\S+$/, '').replace(/[.,]/g, '')
      .split(/\s+/).map((w) => STREET_WORDS[w] || w).join(' ').trim();
  }
  const titleStreet = (k) => k.split(' ').map((w) => (w.length <= 2 && /^[nsew]$/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');

  // Reads a customer list with addresses: the Customer Contact List report, or the customer list
  // exported from Sales > Customers. Returns { customers: [{ name, billing, shipping }] } or null.
  function parseCustomerList(text) {
    const rows = parseCSV(text);
    for (let i = 0; i < Math.min(rows.length, 20); i++) {
      const lc = rows[i].map(lower);
      const col = (rx) => { const j = lc.findIndex((h) => rx.test(h)); return j === -1 ? null : j; };
      const name = col(/^(customer|customer name|name|display name|customer full name)$/);
      if (name == null || col(/^(amount|split|debit|credit|account|transaction type|date)$/) != null) continue;
      const bill = col(/^(billing address|bill to|bill address|address)$/), ship = col(/^(shipping address|ship to|ship address|service address|job site)$/);
      const part = (kind, what) => col(new RegExp(`^${kind ? `${kind}\\s*` : ''}(${what})$`));
      const pieces = (kind) => ({ street: part(kind, 'street|street address|address 1|address line 1|address'), city: part(kind, 'city'), state: part(kind, 'state|province|region'), zip: part(kind, 'zip|zip code|postal code') });
      const bp = pieces('billing'), sp = pieces('shipping'), plain = pieces('');
      const fromPieces = (r, p) => (p.street != null ? [r[p.street], r[p.city], [r[p.state], r[p.zip]].filter(Boolean).join(' ')].filter((x) => norm(x)).join(', ') : '');
      if (bill == null && ship == null && bp.street == null && sp.street == null && plain.street == null) continue;
      const customers = [];
      for (const r of rows.slice(i + 1)) {
        const n = norm(r[name]);
        if (!n || /^total/i.test(n)) continue;
        const billing = splitAddress(bill != null ? r[bill] : fromPieces(r, bp.street != null ? bp : plain));
        const shipping = splitAddress(ship != null ? r[ship] : fromPieces(r, sp));
        customers.push({ name: n, billing, shipping });
      }
      return customers.length ? { customers } : null;
    }
    return null;
  }

  // Groups the recurring customers (billed in three or more months of the last year) by street.
  function routeDensity(list, postings, inTtm) {
    const cust = new Map();
    for (const p of postings) {
      if (p.cls !== 'income' || p.value <= 0 || !inTtm(p.t.date)) continue;
      const who = (customerOf(p.t, 'income') || p.t.name || '').split(':')[0].trim();
      if (!who) continue;
      const e = cust.get(who) || { name: who, revenue: 0, months: new Set() };
      e.revenue += p.value; e.months.add(p.t.dateStr.slice(0, 7));
      cust.set(who, e);
    }
    const route = [...cust.values()].filter((c) => c.months.size >= 3);
    const byName = new Map(list.customers.map((c) => [lower(c.name), c]));
    const find = (n) => byName.get(lower(n)) || list.customers.find((c) => lower(c.name).split(':')[0].trim() === lower(n));
    const missing = [], placed = [];
    for (const c of route) {
      const rec = find(c.name);
      const pick = rec && ((rec.shipping && rec.shipping.street && !rec.shipping.office && rec.shipping) || (rec.billing && rec.billing.street && !rec.billing.office && rec.billing));
      if (!rec) missing.push({ name: c.name, revenue: round2(c.revenue), reason: 'Not in the customer list' });
      else if (!pick) missing.push({ name: c.name, revenue: round2(c.revenue), reason: rec.billing && rec.billing.office ? 'Only a billing office or PO box, no site address' : 'No address' });
      else placed.push({ ...c, street: streetKey(pick.street), zip: pick.zip, city: pick.city });
    }
    const streets = new Map();
    for (const c of placed) {
      const k = `${c.street}|${c.zip || lower(c.city)}`;
      const e = streets.get(k) || { street: titleStreet(c.street), zip: c.zip, city: c.city, count: 0, revenue: 0, names: [] };
      e.count++; e.revenue += c.revenue; e.names.push(c.name);
      streets.set(k, e);
    }
    const streetList = [...streets.values()].map((s) => ({ ...s, revenue: round2(s.revenue) })).sort((a, b) => b.count - a.count || b.revenue - a.revenue);
    const zips = new Map();
    for (const s of streetList) {
      const k = s.zip || s.city || 'Unknown';
      const e = zips.get(k) || { zip: k, count: 0, revenue: 0, streets: 0, alone: 0 };
      e.count += s.count; e.revenue += s.revenue; e.streets++; if (s.count === 1) e.alone++;
      zips.set(k, e);
    }
    const zipList = [...zips.values()].map((z) => ({ ...z, revenue: round2(z.revenue) })).sort((a, b) => b.count - a.count);
    const busy = new Set(zipList.filter((z) => z.count >= 5).map((z) => z.zip));
    const alone = streetList.filter((s) => s.count === 1);
    return {
      routeCount: route.length, placed: placed.length, missing: missing.sort((a, b) => b.revenue - a.revenue),
      clusters: streetList.filter((s) => s.count >= 3), streets: streetList, zips: zipList,
      alone: alone.length, aloneShare: placed.length ? alone.length / placed.length : null,
      // Homes (smaller yearly amounts) alone on a street in a busy area: where a neighbor
      // discount or door hangers would fill in the route.
      fillIn: streetList.filter((s) => s.count <= 2 && s.revenue / s.count < 10000 && busy.has(s.zip || s.city)).sort((a, b) => (zips.get(b.zip || b.city).count - zips.get(a.zip || a.city).count)).slice(0, 12),
    };
  }

  function landscapeAnalysis(txns, accountClass, result, opts) {
    opts = opts || {};
    const range = dateRange(txns, result.meta);
    const ttm = trailingYear(range.first, range.last);
    const postings = toPostings(txns, accountClass);
    const inTtm = (d) => (ttm ? d >= ttm.start && d <= ttm.end : true);
    const mk = (d) => d.toISOString().slice(0, 7);
    const lastFull = (() => { const e = ttm ? ttm.end : range.last; return mk(e); })();
    const monthName = (m) => new Date(Date.UTC(2020, m - 1, 1)).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    const addMonth = (key, n) => { const [y, m] = key.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return mk(d); };

    // ---- 1. Off-season cash: history of monthly cash flow (before line-of-credit draws and
    // repayments, and transfers between the business's own accounts) by calendar month.
    const flows = new Map(), revByMonth = new Map();
    for (const t of txns) {
      if (roleOf(accountClass, t.account) !== 'cash') continue;
      const sr = roleOf(accountClass, t.split);
      if (sr === 'cash') continue;
      if (sr === 'loan' && LINE_OF_CREDIT.test(t.split || '')) continue;
      const k = t.dateStr.slice(0, 7);
      flows.set(k, (flows.get(k) || 0) + t.amount);
    }
    for (const p of postings) if (p.cls === 'income') revByMonth.set(p.t.dateStr.slice(0, 7), (revByMonth.get(p.t.dateStr.slice(0, 7)) || 0) + p.value);
    const fullKeys = [...new Set([...flows.keys(), ...revByMonth.keys()])].filter((k) => k <= lastFull).sort();
    let offSeason = null;
    if (fullKeys.length >= 12) {
      const recent = fullKeys.slice(-24);
      const profile = Array.from({ length: 12 }, (_, i) => {
        const ks = recent.filter((k) => +k.slice(5) === i + 1);
        const avg = (m) => (ks.length ? ks.reduce((t, k) => t + (m.get(k) || 0), 0) / ks.length : 0);
        return { m: i + 1, label: monthName(i + 1), revenue: round2(avg(revByMonth)), flow: round2(avg(flows)), years: ks.length };
      });
      const avgRev = profile.reduce((t, p) => t + p.revenue, 0) / 12;
      const offMonths = profile.filter((p) => p.revenue < avgRev * 0.6).map((p) => p.m);
      const cash = result.balanceSheet && result.balanceSheet.available ? round2(result.balanceSheet.balances.filter((b) => b.role === 'cash').reduce((t, b) => t + b.balance, 0)) : result.cash ? result.cash.startingCash : 0;
      const projection = [];
      let run = cash, low = { cash, key: lastFull };
      for (let i = 1; i <= 12; i++) {
        const key = addMonth(lastFull, i);
        const p = profile[+key.slice(5) - 1];
        run = round2(run + p.flow);
        projection.push({ key, label: `${p.label} ${key.slice(2, 4)}`, flow: p.flow, cash: run, off: offMonths.includes(p.m) });
        if (run < low.cash) low = { cash: run, key, label: `${p.label} ${key.slice(0, 4)}` };
      }
      const be = result.breakeven;
      const cushion = opts.cushion != null && !isNaN(+opts.cushion) && opts.cushion !== '' ? +opts.cushion : be ? Math.round(be.base.fixed / 1000) * 1000 : 0;
      const offBurn = offMonths.length ? -profile.filter((p) => offMonths.includes(p.m)).reduce((t, p) => t + p.flow, 0) / offMonths.length : 0;
      const firstOff = projection.findIndex((x) => x.off);
      const peakLeft = firstOff > 0 ? projection.slice(0, firstOff).filter((x) => !x.off).length : 0;
      const needed = round2(Math.max(0, cushion - low.cash));
      const locDraws = txns.filter((t) => roleOf(accountClass, t.account) === 'cash' && t.amount > 0 && roleOf(accountClass, t.split) === 'loan' && LINE_OF_CREDIT.test(t.split || '')).map((t) => ({ date: t.dateStr, amount: round2(t.amount) }));
      const ramp = profile.filter((p, i) => !offMonths.includes(p.m) && offMonths.includes(profile[(i + 11) % 12].m) && p.flow < 0);
      offSeason = {
        profile, offMonths, cash, asOf: lastFull, projection, low, cushion, needed,
        runway: offBurn > 0 ? cash / offBurn : null, offBurn: round2(offBurn),
        setAside: peakLeft ? round2(needed / peakLeft) : null, peakLeft, locDraws,
        ramp: ramp.map((p) => ({ label: p.label, flow: p.flow })), years: Math.min(2, Math.floor(fullKeys.length / 12)),
      };
    }

    // ---- 2. Service lines: revenue and direct costs by line, from the class when the export
    // has one, else from the account name. Costs with no line are shared overhead.
    const lines = new Map();
    const line = (key) => { if (!lines.has(key)) lines.set(key, { key, revenue: 0, labor: 0, materials: 0, other: 0, prior: 0, months: new Map() }); return lines.get(key); };
    let overhead = 0, revenue = 0;
    const priorStart = ttm ? new Date(Date.UTC(ttm.start.getUTCFullYear() - 1, ttm.start.getUTCMonth(), 1)) : null;
    for (const p of postings) {
      const key = lineOf(p.t.className) || (p.cls === 'income' ? lineOf(p.category) : (p.cls === 'cogs' || p.cls === 'expense') && !WAGE_ACCOUNT.test(p.category) && !PAYROLL_TAX_ACCOUNT.test(p.category) && !OVERTIME_ACCOUNT.test(p.category) ? lineOf(p.category) : null);
      if (priorStart && p.cls === 'income' && p.t.date >= priorStart && p.t.date < ttm.start) { if (key) line(key).prior += p.value; continue; }
      if (!inTtm(p.t.date)) continue;
      if (p.cls === 'income') {
        revenue += p.value;
        const l = line(key || 'other');
        l.revenue += p.value;
        const mm = p.t.dateStr.slice(0, 7); l.months.set(mm, (l.months.get(mm) || 0) + p.value);
        continue;
      }
      if (!key) { overhead += p.value; continue; }
      const l = line(key);
      if (WAGE_ACCOUNT.test(p.category) || PAYROLL_TAX_ACCOUNT.test(p.category) || OVERTIME_ACCOUNT.test(p.category)) l.labor += p.value;
      else if (p.cls === 'cogs') l.materials += p.value;
      else l.other += p.value;
    }
    const known = [...lines.values()].filter((l) => l.key !== 'other' && l.revenue > 0);
    let serviceLines = null;
    if (known.length >= 2) {
      const rows = [...lines.values()].filter((l) => l.revenue > 0 || l.labor + l.materials + l.other > 0).map((l) => {
        const def = SERVICE_LINES.find((x) => x.key === l.key);
        const direct = l.labor + l.materials + l.other;
        const share = revenue ? l.revenue / revenue : 0;
        const net = l.revenue - direct - overhead * share;
        return {
          key: l.key, label: def ? def.label : 'Other income', revenue: round2(l.revenue), labor: round2(l.labor), materials: round2(l.materials), other: round2(l.other),
          direct: round2(direct), gross: round2(l.revenue - direct), grossMargin: l.revenue ? (l.revenue - direct) / l.revenue : null,
          overhead: round2(overhead * share), net: round2(net), netMargin: l.revenue ? net / l.revenue : null, share,
          prior: round2(l.prior), change: l.prior > 0 ? (l.revenue - l.prior) / l.prior : null,
          activeMonths: [...l.months.entries()].filter(([, v]) => v > 0).map(([k]) => +k.slice(5)).sort((a, b) => a - b),
        };
      }).sort((a, b) => b.revenue - a.revenue);
      const losing = rows.filter((r) => r.revenue > 0 && r.net < 0);
      serviceLines = { rows, overhead: round2(overhead), revenue: round2(revenue), window: ttm ? `${isoDate(ttm.start)} to ${isoDate(ttm.end)}` : `${isoDate(range.first)} to ${isoDate(range.last)}`, losing, byClass: txns.some((t) => lineOf(t.className)) };
    }

    // ---- 3. Contract billing: customers billed a steady amount most months. Flags months a
    // contract customer was expected but not billed, and prices unchanged for a year or more.
    const inv = new Map();
    for (const p of postings) {
      if (p.cls !== 'income' || !/invoice|sales receipt/i.test(p.t.type) || p.value <= 0) continue;
      const who = customerOf(p.t, 'income') || p.t.name;
      if (!who) continue;
      const cust = who.split(':')[0];
      const k = `${cust}|${lineOf(p.t.className) || lineOf(p.category) || 'other'}`;
      if (!inv.has(k)) inv.set(k, { name: cust, line: k.split('|')[1], rows: [] });
      inv.get(k).rows.push({ key: p.t.dateStr.slice(0, 7), date: p.t.dateStr, amount: p.value });
    }
    const customers = [], missed = [], stale = [];
    const windowStart = addMonth(lastFull, -11);
    for (const c of inv.values()) {
      const byMonth = new Map();
      for (const r of c.rows) byMonth.set(r.key, round2((byMonth.get(r.key) || 0) + r.amount));
      const recentMonths = [...byMonth.keys()].filter((k) => k >= windowStart && k <= lastFull).sort();
      if (recentMonths.length < 4) continue;
      // Steady: the amount repeats from one bill to the next, allowing a yearly price change.
      const amts = recentMonths.map((k) => byMonth.get(k));
      const changes = amts.slice(1).filter((a, i) => Math.abs(a - amts[i]) > amts[i] * 0.03).length;
      if (changes > (amts.length >= 6 ? Math.max(1, Math.floor(amts.length / 5)) : 0)) continue;
      const current = byMonth.get(recentMonths[recentMonths.length - 1]);
      // When the price last changed: walk back while the monthly amount stays the same.
      const all = [...byMonth.keys()].sort();
      let since = all[all.length - 1];
      for (let i = all.length - 1; i >= 0; i--) { if (Math.abs(byMonth.get(all[i]) - current) <= current * 0.005) since = all[i]; else break; }
      const perYear = recentMonths.length;
      const line2 = SERVICE_LINES.find((x) => x.key === c.line);
      customers.push({ name: c.name, line: line2 ? line2.label : 'Other', amount: current, perYear, since });
      // Missed: the last three full months, where the customer was billed a year earlier or
      // on both sides of the gap. A customer billed in none of the three has stopped, not been
      // missed (the Fraud risk tab lists them as regular customers who stopped being billed).
      const stopped = [0, 1, 2].every((i) => !byMonth.has(addMonth(lastFull, -i)));
      for (let i = 0; i < 3 && !stopped; i++) {
        const key = addMonth(lastFull, -i);
        if (byMonth.has(key)) continue;
        const lastYear = byMonth.has(addMonth(key, -12));
        const gap = byMonth.has(addMonth(key, -1)) && byMonth.has(addMonth(key, 1));
        if (lastYear || gap) missed.push({ name: c.name, line: line2 ? line2.label : 'Other', month: key, amount: current });
      }
      const monthsSince = (() => { const [y1, m1] = since.split('-').map(Number), [y2, m2] = lastFull.split('-').map(Number); return (y2 - y1) * 12 + (m2 - m1); })();
      if (monthsSince >= 12) stale.push({ name: c.name, line: line2 ? line2.label : 'Other', amount: current, since, months: monthsSince, perYear, yearly: round2(current * perYear * 0.05) });
    }
    missed.sort((a, b) => b.month.localeCompare(a.month) || b.amount - a.amount);
    stale.sort((a, b) => b.yearly - a.yearly);
    const contracts = customers.length ? { customers: customers.sort((a, b) => b.amount * b.perYear - a.amount * a.perYear), missed, stale, missedTotal: round2(missed.reduce((t, x) => t + x.amount, 0)), staleYearly: round2(stale.reduce((t, x) => t + x.yearly, 0)) } : null;

    // ---- 4. Labor through the season.
    const labor = new Map(), ot = new Map(), wages = new Map();
    for (const p of postings) {
      if (p.cls !== 'expense' && p.cls !== 'cogs') continue;
      const k = p.t.dateStr.slice(0, 7);
      if (k > lastFull) continue;
      const isOt = OVERTIME_ACCOUNT.test(p.category), isTax = PAYROLL_TAX_ACCOUNT.test(p.category), isWage = !isTax && (WAGE_ACCOUNT.test(p.category) || isOt);
      if (!isOt && !isTax && !isWage) continue;
      labor.set(k, (labor.get(k) || 0) + p.value);
      if (isOt) ot.set(k, (ot.get(k) || 0) + p.value);
      if (isWage) wages.set(k, (wages.get(k) || 0) + p.value);
    }
    let laborSeason = null;
    const lKeys = [...labor.keys()].sort().slice(-24);
    if (lKeys.length >= 6) {
      const band = { low: 0.3, high: 0.45 };
      const monthsL = lKeys.map((k) => {
        const rev = revByMonth.get(k) || 0, cost = labor.get(k) || 0, o = ot.get(k) || 0, w = wages.get(k) || 0;
        return { key: k, label: `${monthName(+k.slice(5))} ${k.slice(2, 4)}`, revenue: round2(rev), labor: round2(cost), ratio: rev > 0 ? cost / rev : null, overtime: round2(o), otShare: w > 0 ? o / w : null };
      });
      const otVals = monthsL.map((m) => m.overtime).filter((v) => v > 0).sort((a, b) => a - b);
      const otMed = otVals.length ? otVals[Math.floor(otVals.length / 2)] : 0;
      const flags = [];
      for (const m of monthsL.slice(-12)) {
        if (m.revenue > 0 && m.labor > m.revenue) flags.push({ key: m.key, kind: 'Labor above revenue', text: `${m.label}: crews cost ${fmtWhole(m.labor)} against ${fmtWhole(m.revenue)} of revenue.` });
        else if (m.ratio != null && m.ratio > band.high) flags.push({ key: m.key, kind: 'Labor high', text: `${m.label}: labor was ${fmtPct(m.ratio)} of revenue.` });
        if (m.overtime > 0 && otMed > 0 && m.overtime > otMed * 1.8 && m.otShare > 0.15) flags.push({ key: m.key, kind: 'Overtime spike', text: `${m.label}: ${fmtWhole(m.overtime)} of overtime, ${fmtPct(m.otShare)} of wages.` });
      }
      const ttmMonths = monthsL.slice(-12);
      const tRev = ttmMonths.reduce((t, m) => t + m.revenue, 0), tLab = ttmMonths.reduce((t, m) => t + m.labor, 0), tOt = ttmMonths.reduce((t, m) => t + m.overtime, 0);
      laborSeason = { months: monthsL, band, flags, ratio: tRev ? tLab / tRev : null, overtime: round2(tOt), hasOvertime: ot.size > 0 };
    }

    // ---- 5. Equipment and fuel.
    const eq = { fuel: 0, repairs: 0, vehicle: 0, rental: 0, depreciation: 0 };
    const eqPrior = { fuel: 0, revenue: 0 };
    for (const p of postings) {
      if (p.cls !== 'expense' && p.cls !== 'cogs') continue;
      const c = p.category;
      const kind = /fuel|gas(oline)?\b|diesel/i.test(c) ? 'fuel' : NON_CASH_ACCOUNT.test(c) ? 'depreciation' : /rental|lease/i.test(c) ? 'rental' : /vehicle|truck|auto/i.test(c) && /repair|maint/i.test(c) ? 'vehicle' : /repair|maint/i.test(c) ? 'repairs' : null;
      if (!kind) continue;
      if (inTtm(p.t.date)) eq[kind] += p.value;
      else if (priorStart && p.t.date >= priorStart && kind === 'fuel') eqPrior.fuel += p.value;
    }
    if (priorStart) for (const p of postings) if (p.cls === 'income' && p.t.date >= priorStart && p.t.date < ttm.start) eqPrior.revenue += p.value;
    let loanPay = 0;
    const loanNames = new Set();
    for (const t of txns) {
      if (t.amount >= 0 || !inTtm(t.date) || roleOf(accountClass, t.account) !== 'cash') continue;
      const sr = roleOf(accountClass, t.split);
      if (sr === 'loan' && !LINE_OF_CREDIT.test(t.split || '') && EQUIP_LOAN.test(t.split || '')) { loanPay += -t.amount; loanNames.add(t.split); }
      else if (sr === 'expense' && INTEREST_ACCOUNT.test(t.split || '') && EQUIP_LOAN.test(counterpartyOf(t) || '')) loanPay += -t.amount;
    }
    // Repeat repairs on one machine: grouped by the machine named in the memo, else vendor.
    const repairs = new Map();
    const capitalize = [];
    for (const p of postings) {
      if ((p.cls !== 'expense' && p.cls !== 'cogs') || !inTtm(p.t.date)) continue;
      const memo = p.t.memo || '';
      if (p.value >= 2500 && EXPENSE_EQUIP_ACCOUNT.test(p.category) && !/rental|fuel|wage|payroll/i.test(p.category) && (EQUIP_WORD.test(memo) || EQUIP_WORD.test(p.t.name || '')) && !/repair|service|rebuild|replace|parts?\b/i.test(memo.replace(/\(new\)/i, ''))) {
        capitalize.push({ date: p.t.dateStr, vendor: counterpartyOf(p.t) || '', memo, account: p.category, amount: round2(p.value) });
      }
      if (!/repair|maint/i.test(p.category) || /vehicle|truck|auto/i.test(p.category)) continue;
      const m = memo.match(/^(.*?#\s?\d+)/) || memo.match(/^([^-]{4,40}?)\s-\s/);
      const machine = m ? m[1].trim() : null;
      if (!machine || !EQUIP_WORD.test(`${machine} ${memo}`) && !/#/.test(machine)) continue;
      if (!repairs.has(machine)) repairs.set(machine, { machine, count: 0, total: 0, first: p.t.dateStr, last: p.t.dateStr });
      const r = repairs.get(machine);
      r.count++; r.total += p.value; if (p.t.dateStr < r.first) r.first = p.t.dateStr; if (p.t.dateStr > r.last) r.last = p.t.dateStr;
    }
    const repeat = [...repairs.values()].filter((r) => r.count >= 3 && r.total >= 2500).map((r) => ({ ...r, total: round2(r.total) })).sort((a, b) => b.total - a.total);
    const eqRev = revenue || (result.profit && result.profit.totals.revenue) || 0;
    const equipment = {
      fuel: round2(eq.fuel), repairs: round2(eq.repairs), vehicle: round2(eq.vehicle), rental: round2(eq.rental), depreciation: round2(eq.depreciation), loanPayments: round2(loanPay), loans: [...loanNames],
      total: round2(eq.fuel + eq.repairs + eq.vehicle + eq.rental + eq.depreciation + loanPay), revenue: round2(eqRev),
      perDollar: eqRev ? (eq.fuel + eq.repairs + eq.vehicle + eq.rental + eq.depreciation + loanPay) / eqRev : null,
      fuelShare: eqRev ? eq.fuel / eqRev : null, fuelSharePrior: eqPrior.revenue ? eqPrior.fuel / eqPrior.revenue : null,
      repeat, capitalize,
    };

    const playbook = landscapePlaybook(txns, accountClass, postings, inTtm, ttm);
    const routes = opts.customers && opts.customers.customers ? routeDensity(opts.customers, postings, inTtm) : null;
    return { offSeason, serviceLines, contracts, labor: laborSeason, equipment, playbook, routes, asOf: lastFull };
  }

  // ---------------------------------------------------------------- fixed assets & depreciation

  // Asset categories: book life (straight-line, years) and the IRS recovery period (MACRS GDS).
  // Real property uses straight-line mid-month; software is amortized over 36 months.
  const ASSET_CATEGORIES = [
    { key: 'equipment', label: 'Machinery and equipment', book: 7, tax: 7 },
    { key: 'vehicle', label: 'Cars, vans and light trucks', book: 5, tax: 5 },
    { key: 'trailer', label: 'Trailers and heavy trucks', book: 7, tax: 5 },
    { key: 'computer', label: 'Computers and office tech', book: 3, tax: 5 },
    { key: 'furniture', label: 'Furniture and fixtures', book: 7, tax: 7 },
    { key: 'landimp', label: 'Land improvements (paving, fences, irrigation)', book: 15, tax: 15 },
    { key: 'qip', label: 'Interior improvements to a building', book: 15, tax: 15 },
    { key: 'building', label: 'Commercial building', book: 39, tax: 39, real: true },
    { key: 'rental', label: 'Residential rental building', book: 27.5, tax: 27.5, real: true },
    { key: 'software', label: 'Off-the-shelf software', book: 3, tax: 3, software: true },
    { key: 'land', label: 'Land (not depreciated)', book: 0, tax: 0 },
  ];
  const categoryOf = (key) => ASSET_CATEGORIES.find((c) => c.key === key) || ASSET_CATEGORIES[0];
  const TAX_METHODS = { macrs: 'MACRS', bonus: 'MACRS with bonus depreciation', s179: 'Section 179 (all in year one)', sl: 'Straight-line (tax)' };

  // Bonus depreciation allowed for property placed in service on a date: 100% through 2022,
  // then 80/60/40 stepping down, and 100% again for property acquired after January 19, 2025.
  // A default only: the tax preparer confirms the election.
  function defaultBonus(dateStr) {
    const d = String(dateStr || '');
    if (d < '2023-01-01') return 100;
    if (d < '2024-01-01') return 80;
    if (d < '2025-01-01') return 60;
    if (d < '2025-01-20') return 40;
    return 100;
  }

  // MACRS percentages by year for personal property: 200% declining balance switching to
  // straight-line (150% for 15 and 20 years), with the first year cut to half a year, or to the
  // quarter placed in service under the mid-quarter convention (quarter 1-4). Rounded as the
  // IRS tables are, with the last year taking the remainder.
  // The published IRS percentages (Pub. 946, tables A-1 to A-5) where the IRS rounded some
  // straight-line years up and others down; other cases are computed the same way.
  const MACRS_TABLES = {
    '3|0': [33.33, 44.45, 14.81, 7.41],
    '5|0': [20, 32, 19.2, 11.52, 11.52, 5.76],
    '7|0': [14.29, 24.49, 17.49, 12.49, 8.93, 8.92, 8.93, 4.46],
    '10|0': [10, 18, 14.4, 11.52, 9.22, 7.37, 6.55, 6.55, 6.56, 6.55, 3.28],
    '15|0': [5, 9.5, 8.55, 7.7, 6.93, 6.23, 5.9, 5.9, 5.91, 5.9, 5.91, 5.9, 5.91, 5.9, 5.91, 2.95],
    '20|0': [3.75, 7.219, 6.677, 6.177, 5.713, 5.285, 4.888, 4.522, 4.462, 4.461, 4.462, 4.461, 4.462, 4.461, 4.462, 4.461, 4.462, 4.461, 4.462, 4.461, 2.231],
    '3|1': [58.33, 27.78, 12.35, 1.54], '3|2': [41.67, 38.89, 14.14, 5.3], '3|3': [25, 50, 16.67, 8.33], '3|4': [8.33, 61.11, 20.37, 10.19],
    '5|1': [35, 26, 15.6, 11.01, 11.01, 1.38], '5|2': [25, 30, 18, 11.37, 11.37, 4.26], '5|3': [15, 34, 20.4, 12.24, 11.3, 7.06], '5|4': [5, 38, 22.8, 13.68, 10.94, 9.58],
    '7|1': [25, 21.43, 15.31, 10.93, 8.75, 8.74, 8.75, 1.09], '7|2': [17.85, 23.47, 16.76, 11.97, 8.87, 8.87, 8.87, 3.33],
    '7|3': [10.71, 25.51, 18.22, 13.02, 9.3, 8.85, 8.86, 5.53], '7|4': [3.57, 27.55, 19.68, 14.06, 10.04, 8.73, 8.73, 7.64],
  };
  const macrsCache = new Map();
  function macrsRates(life, quarter) {
    const key = `${life}|${quarter || 0}`;
    if (MACRS_TABLES[key]) return MACRS_TABLES[key].map((r) => r / 100);
    if (macrsCache.has(key)) return macrsCache.get(key);
    const rate = (life >= 15 ? 1.5 : 2) / life;
    const first = quarter ? (12 - (quarter * 3 - 1.5)) / 12 : 0.5;
    const digits = life >= 20 ? 3 : 2;
    const out = [];
    let basis = 1, used = 0;
    for (let y = 1; basis > 1e-9 && y <= life + 1; y++) {
      const frac = y === 1 ? first : 1;
      const remaining = life - used;
      const db = basis * rate * frac;
      const sl = remaining > 0 ? basis * Math.min(1, frac / remaining) : basis;
      const dep = y === life + 1 ? basis : Math.min(basis, Math.max(db, sl));
      out.push(dep);
      basis -= dep;
      used += frac;
    }
    const f = 10 ** (digits + 2);
    const rounded = out.map((r) => Math.round(r * f) / f);
    rounded[rounded.length - 1] = Math.round((1 - rounded.slice(0, -1).reduce((t, r) => t + r, 0)) * f) / f;
    macrsCache.set(key, rounded);
    return rounded;
  }

  const ym = (d) => (d ? `${d.slice(0, 7)}` : '');
  const monthsBetween = (a, b) => { const [y1, m1] = a.split('-').map(Number), [y2, m2] = b.split('-').map(Number); return (y2 - y1) * 12 + (m2 - m1); };
  const addMonths = (key, n) => { const [y, m] = key.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };

  // One asset's book depreciation by month (straight-line from the month placed in service,
  // stopping the month before disposal), and tax depreciation by calendar year.
  function depreciateAsset(a, midQuarterYears) {
    const cat = categoryOf(a.category);
    const cost = Math.max(0, +a.cost || 0);
    const start = ym(a.date);
    const salvage = Math.min(cost, Math.max(0, +a.salvage || 0));
    const bookLife = a.bookLife != null && a.bookLife !== '' ? +a.bookLife : cat.book;
    const disposed = a.disposed ? ym(a.disposed) : null;
    const book = {};
    const notes = [];
    if (cat.key !== 'land' && bookLife > 0 && start) {
      const months = Math.round(bookLife * 12);
      const per = (cost - salvage) / months;
      let left = cost - salvage;
      for (let i = 0; i < months && left > 0.004; i++) {
        const k = addMonths(start, i);
        if (disposed && k >= disposed) break;
        const amt = i === months - 1 ? left : Math.min(left, per);
        book[k] = amt;
        left -= amt;
      }
    }
    const tax = {};
    let method = a.taxMethod || 'macrs';
    const year = +String(a.date || '').slice(0, 4);
    const s179 = method === 's179' ? cost : Math.min(cost, Math.max(0, +a.s179 || 0));
    let basis = cost - s179;
    let bonus = 0;
    if (cat.key === 'land' || !year) method = 'none';
    else if (!cat.real && method === 'bonus') {
      const pct = a.bonusPct != null && a.bonusPct !== '' ? Math.min(100, Math.max(0, +a.bonusPct)) : defaultBonus(a.date);
      bonus = basis * pct / 100;
      basis -= bonus;
    }
    if (method !== 'none' && year) {
      if (s179 || bonus) tax[year] = s179 + bonus;
      const add = (y, amt) => { if (amt > 0.004) tax[y] = (tax[y] || 0) + amt; };
      if (basis > 0.004) {
        if (cat.real) {
          const m = +a.date.slice(5, 7);
          const firstFrac = (12 - m + 0.5) / 12;
          const perYear = basis / cat.tax;
          let left = basis;
          for (let y = year, i = 0; left > 0.004; y++, i++) { const amt = Math.min(left, i === 0 ? perYear * firstFrac : perYear); add(y, amt); left -= amt; }
        } else if (cat.software || method === 'sl') {
          const life = cat.software ? 3 : cat.tax;
          const perYear = basis / life;
          let left = basis;
          // Software: 36 months from the month placed in service; straight-line tax: half-year.
          const firstFrac = cat.software ? (13 - +a.date.slice(5, 7)) / 12 : 0.5;
          for (let y = year, i = 0; left > 0.004; y++, i++) { const amt = Math.min(left, i === 0 ? perYear * firstFrac : perYear); add(y, amt); left -= amt; }
        } else {
          const q = midQuarterYears && midQuarterYears.has(year) ? Math.ceil(+a.date.slice(5, 7) / 3) : 0;
          macrsRates(cat.tax, q).forEach((r, i) => add(year + i, basis * r));
        }
      }
      // Sold or scrapped: half of that year's normal deduction (half-year convention), none after.
      if (a.disposed) {
        const dy = +a.disposed.slice(0, 4);
        for (const y of Object.keys(tax).map(Number)) {
          if (y > dy) delete tax[y];
          else if (y === dy && y > year && !cat.real) tax[y] /= 2;
        }
      }
    }
    if (cat.key === 'vehicle' && method !== 'none') notes.push('Passenger cars and small trucks under 6,000 lbs have yearly limits on depreciation; the tax preparer applies them.');
    if (method === 'bonus' && cat.real) notes.push('Buildings do not qualify for bonus depreciation; regular depreciation is used.');
    return { book, tax, s179, bonus, bookLife, salvage, method };
  }

  // The asset register as of a month: each asset's book and tax figures, yearly totals, and
  // whether the mid-quarter rule applies (over 40% of a year's equipment placed in service in
  // October to December).
  function assetSchedule(assets, opts) {
    opts = opts || {};
    const list = (assets || []).filter((a) => a && a.date && +a.cost > 0);
    const asOf = opts.asOf || new Date().toISOString().slice(0, 7);
    const byYear = new Map();
    for (const a of list) {
      const cat = categoryOf(a.category);
      if (cat.real || cat.key === 'land' || cat.software || a.taxMethod === 's179' || a.taxMethod === 'sl') continue;
      const y = +a.date.slice(0, 4);
      const basis = Math.max(0, +a.cost - Math.min(+a.cost, +a.s179 || 0));
      if (!byYear.has(y)) byYear.set(y, { total: 0, q4: 0 });
      const e = byYear.get(y);
      e.total += basis;
      if (+a.date.slice(5, 7) >= 10) e.q4 += basis;
    }
    const midQuarterYears = new Set([...byYear.entries()].filter(([, e]) => e.total > 0 && e.q4 / e.total > 0.4).map(([y]) => y));
    const years = new Set();
    const rows = list.map((a) => {
      const d = depreciateAsset(a, midQuarterYears);
      const bookByYear = {};
      let accumulated = 0;
      for (const [k, v] of Object.entries(d.book)) {
        const y = +k.slice(0, 4);
        bookByYear[y] = (bookByYear[y] || 0) + v;
        years.add(y);
        if (k <= asOf) accumulated += v;
      }
      for (const y of Object.keys(d.tax)) years.add(+y);
      const asOfYear = +asOf.slice(0, 4);
      const taxTo = Object.entries(d.tax).filter(([y]) => +y <= asOfYear).reduce((t, [, v]) => t + v, 0);
      const cost = +a.cost;
      const nbv = cost - accumulated;
      const disposal = a.disposed ? { date: a.disposed, price: +a.salePrice || 0, gain: round2((+a.salePrice || 0) - nbv) } : null;
      return {
        id: a.id, name: a.name, category: categoryOf(a.category).key, categoryLabel: categoryOf(a.category).label, date: a.date, cost: round2(cost),
        method: d.method, methodLabel: TAX_METHODS[d.method] || 'Not depreciated', bookLife: d.bookLife, salvage: round2(d.salvage),
        bookMonthly: d.book, bookByYear: Object.fromEntries(Object.entries(bookByYear).map(([y, v]) => [y, round2(v)])),
        taxByYear: Object.fromEntries(Object.entries(d.tax).map(([y, v]) => [y, round2(v)])),
        accumulated: round2(accumulated), nbv: round2(nbv), taxTaken: round2(taxTo), taxLeft: d.method === 'none' || a.disposed ? 0 : round2(Math.max(0, cost - taxTo)),
        s179: round2(d.s179), bonus: round2(d.bonus), midQuarter: midQuarterYears.has(+a.date.slice(0, 4)) && d.method !== 'none' && !categoryOf(a.category).real,
        disposal, notes: [],
      };
    });
    const yearList = [...years].sort((a, b) => a - b);
    const totals = yearList.map((y) => ({
      year: y,
      book: round2(rows.reduce((t, r) => t + (r.bookByYear[y] || 0), 0)),
      tax: round2(rows.reduce((t, r) => t + (r.taxByYear[y] || 0), 0)),
    }));
    const monthBook = (key) => round2(rows.reduce((t, r) => t + (r.bookMonthly[key] || 0), 0));
    return {
      rows: rows.sort((a, b) => a.date.localeCompare(b.date) || String(a.name).localeCompare(String(b.name))), asOf, years: totals, midQuarterYears: [...midQuarterYears],
      cost: round2(rows.reduce((t, r) => t + (r.disposal ? 0 : r.cost), 0)), accumulated: round2(rows.reduce((t, r) => t + (r.disposal ? 0 : r.accumulated), 0)),
      nbv: round2(rows.reduce((t, r) => t + (r.disposal ? 0 : r.nbv), 0)), monthBook,
    };
  }

  // The depreciation journal entry for a period (a month 'YYYY-MM' or a year 'YYYY'), as lines
  // and as a CSV QuickBooks Online can import (Journal No., Journal Date, Account Name, Debits,
  // Credits, Description).
  function depreciationEntry(schedule, period, accounts) {
    accounts = accounts || {};
    const expense = accounts.expense || 'Depreciation Expense';
    const accum = accounts.accumulated || 'Accumulated Depreciation';
    const isYear = /^\d{4}$/.test(period);
    const inPeriod = (k) => (isYear ? k.startsWith(`${period}-`) : k === period);
    const lines = [];
    let total = 0;
    for (const r of schedule.rows) {
      const amt = round2(Object.entries(r.bookMonthly).filter(([k]) => inPeriod(k)).reduce((t, [, v]) => t + v, 0));
      if (amt > 0) { lines.push({ name: r.name, amount: amt }); total += amt; }
    }
    total = round2(total);
    const last = isYear ? `${period}-12-31` : isoDate(new Date(Date.UTC(+period.slice(0, 4), +period.slice(5, 7), 0)));
    const label = isYear ? period : new Date(`${period}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const no = `DEP-${period.replace('-', '')}`;
    const q = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const [y, m, d] = last.split('-');
    const date = `${m}/${d}/${y}`;
    const rowsCsv = [['Journal No.', 'Journal Date', 'Account Name', 'Debits', 'Credits', 'Description']];
    if (total > 0) {
      rowsCsv.push([no, date, expense, total.toFixed(2), '', `Depreciation ${label}`]);
      rowsCsv.push([no, date, accum, '', total.toFixed(2), `Depreciation ${label}`]);
    }
    return { period, label, date: last, number: no, expense, accumulated: accum, total, lines, csv: rowsCsv.map((r) => r.map(q).join(',')).join('\n') };
  }

  // Reads an asset list (CSV) with flexible column names.
  function parseAssetList(text) {
    const rows = parseCSV(text);
    for (let i = 0; i < Math.min(rows.length, 20); i++) {
      const lc = rows[i].map(lower);
      const col = (rx) => { const j = lc.findIndex((h) => rx.test(h)); return j === -1 ? null : j; };
      const name = col(/^(asset|asset name|name|description|item|asset description)$/);
      const date = col(/placed in service|in service|purchase date|date acquired|acquired|^date$|service date/);
      const cost = col(/^(cost|amount|basis|cost basis|purchase price|price|original cost)$/);
      if (name == null || date == null || cost == null) continue;
      const cat = col(/category|class|type/), life = col(/life|years/), salvage = col(/salvage|residual/);
      const method = col(/method/), s179 = col(/179/), bonus = col(/bonus/), disposed = col(/disposed|sold|retired/), price = col(/sale price|sold for|proceeds/);
      const out = [];
      for (const r of rows.slice(i + 1)) {
        const d = parseDate(r[date]);
        const c = parseAmount(r[cost]);
        if (!d || c == null || c <= 0 || !norm(r[name])) continue;
        const m = method != null ? lower(r[method]) : '';
        const dd = disposed != null ? parseDate(r[disposed]) : null;
        out.push({
          id: `a${out.length}-${Math.random().toString(36).slice(2, 8)}`, name: norm(r[name]), date: isoDate(d), cost: c,
          category: guessAssetCategory(`${cat != null ? r[cat] : ''} ${r[name]}`),
          bookLife: life != null && parseAmount(r[life]) ? parseAmount(r[life]) : '', salvage: salvage != null ? parseAmount(r[salvage]) || '' : '',
          taxMethod: /179/.test(m) || (s179 != null && parseAmount(r[s179]) >= c) ? 's179' : /bonus/.test(m) || (bonus != null && parseAmount(r[bonus])) ? 'bonus' : /straight|sl\b/.test(m) ? 'sl' : 'macrs',
          s179: s179 != null && parseAmount(r[s179]) && parseAmount(r[s179]) < c ? parseAmount(r[s179]) : '', bonusPct: bonus != null && parseAmount(r[bonus]) ? parseAmount(r[bonus]) : '',
          disposed: dd ? isoDate(dd) : '', salePrice: price != null ? parseAmount(r[price]) || '' : '',
        });
      }
      return out.length ? out : null;
    }
    return null;
  }

  function guessAssetCategory(text) {
    const t = lower(text);
    if (/\bland\b(?! ?improv)/.test(t) && !/landscap/.test(t)) return 'land';
    if (/software|license/.test(t)) return 'software';
    if (/rental (house|property|building)|residential|apartment|duplex/.test(t)) return 'rental';
    if (/building|warehouse|office building|\bshop building/.test(t)) return 'building';
    if (/leasehold|interior|improvement to|build.?out|renovat/.test(t)) return 'qip';
    if (/paving|parking lot|fence|fencing|landscap|sidewalk|land improv/.test(t)) return 'landimp';
    if (/trailer|dump truck|box truck|semi|heavy truck/.test(t)) return 'trailer';
    if (/\bcar\b|\bvan\b|pickup|truck|vehicle|f-?150|f-?250|silverado|ram \d|tacoma|sierra|suv/.test(t)) return 'vehicle';
    if (/computer|laptop|macbook|server|printer|copier|monitor|ipad|tablet|phone system|pos system/.test(t)) return 'computer';
    if (/furniture|desk|chair|shelving|cabinet|fixture|table/.test(t)) return 'furniture';
    return 'equipment';
  }

  const FIXED_ASSET_NAME = /equipment|machinery|vehicle|truck|trailer|furniture|fixture|computer|building|leasehold|improvement|fixed asset|\btools?\b|property|land\b/i;
  const ASSET_WORD = new RegExp(`${EQUIP_WORD.source}|laptop|computer|server|printer|copier|desk|furniture|\\bvan\\b|vehicle|forklift|compressor|generator|welder|oven|freezer|refrigerat|espresso|machine|hvac|furnace|roof`, 'i');
  const ASSET_EXPENSE_ACCOUNT = /repair|maint|tool|supplies|equipment(?! rental)|small|office|furniture|computer/i;

  // Fixed-asset facts from the books: purchases recorded to fixed-asset accounts, equipment-like
  // purchases of $2,500 or more that went to expense accounts, depreciation recorded per year,
  // and the account names to use in the journal entry.
  function fixedAssetFacts(txns, accountClass) {
    const postings = toPostings(txns, accountClass);
    const candidates = [];
    const seen = new Set();
    for (const t of txns) {
      if (classOf(accountClass, t.account) !== 'balance' || !FIXED_ASSET_NAME.test(t.account) || /accum|depreciation|amortiz|loan|payable|financial|credit/i.test(t.account)) continue;
      if (!(t.amount > 0) || /journal/i.test(t.type) && NON_CASH_ACCOUNT.test(t.split || '')) continue;
      const key = `${t.dateStr}|${round2(t.amount)}|${t.account}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ key, date: t.dateStr, vendor: counterpartyOf(t) || '', memo: t.memo || '', account: t.account, amount: round2(t.amount), expensed: false, category: guessAssetCategory(`${t.account} ${t.memo || ''}`) });
    }
    for (const p of postings) {
      if (p.cls !== 'expense' && p.cls !== 'cogs') continue;
      const memo = p.t.memo || '';
      if (p.value < 2500 || !ASSET_EXPENSE_ACCOUNT.test(p.category) || /rental|fuel|wage|payroll|rent\b/i.test(p.category)) continue;
      if (!(ASSET_WORD.test(memo) || ASSET_WORD.test(p.t.name || '')) || /repair|service|rebuild|replace|parts?\b/i.test(memo.replace(/\(new\)/i, ''))) continue;
      const key = `${p.t.dateStr}|${round2(p.value)}|${p.category}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ key, date: p.t.dateStr, vendor: counterpartyOf(p.t) || '', memo, account: p.category, amount: round2(p.value), expensed: true, category: guessAssetCategory(`${memo} ${p.t.name || ''}`) });
    }
    const recorded = {}, recordedMonths = {};
    const expCount = new Map();
    for (const p of postings) {
      if ((p.cls !== 'expense' && p.cls !== 'cogs') || !/depreciation/i.test(p.category)) continue;
      const y = p.t.dateStr.slice(0, 4), k = p.t.dateStr.slice(0, 7);
      recorded[y] = round2((recorded[y] || 0) + p.value);
      recordedMonths[k] = round2((recordedMonths[k] || 0) + p.value);
      expCount.set(p.category, (expCount.get(p.category) || 0) + 1);
    }
    const accumName = [...new Set(txns.map((t) => t.account))].find((a) => /accum.*deprec/i.test(a || ''));
    const expenseName = [...expCount.entries()].sort((a, b) => b[1] - a[1]).map(([a]) => a)[0];
    return {
      candidates: candidates.sort((a, b) => b.date.localeCompare(a.date)), recorded, recordedMonths,
      accounts: { expense: expenseName || 'Depreciation Expense', accumulated: accumName || 'Accumulated Depreciation' },
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
    if (/budget/i.test(rows.slice(0, 6).map((r) => r.join(' ')).join(' '))) return null;
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

  // ---------------------------------------------------------------- budget vs actual

  const MONTH_RX = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*[-/ ]?\s*'?(\d{2}|\d{4})$/i;
  const monthKeyOf = (label) => {
    const m = norm(label).match(MONTH_RX);
    if (!m) return null;
    const mi = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(lower(m[1]).slice(0, 3));
    const y = m[2].length === 2 ? 2000 + +m[2] : +m[2];
    return `${y}-${String(mi + 1).padStart(2, '0')}`;
  };

  // Reads a QuickBooks "Budget Overview" export: one column per month, one row per account.
  function parseBudget(text) {
    const rows = parseCSV(text);
    const head = rows.slice(0, 6).map((r) => r.filter(Boolean).join(' ')).join(' ');
    if (!/budget/i.test(head)) return null;
    let headerIdx = -1, cols = [];
    for (let i = 0; i < Math.min(rows.length, 15); i++) {
      const found = rows[i].map((c, j) => ({ j, key: monthKeyOf(c) })).filter((x) => x.key);
      if (found.length >= 3) { headerIdx = i; cols = found; break; }
    }
    if (headerIdx < 0) return null;
    const SECTIONS = [[/^income$/, 'income'], [/^other income$/, 'income'], [/^cost of (goods sold|sales)$/, 'cogs'], [/^expenses?$/, 'expense'], [/^other expenses?$/, 'expense']];
    const accounts = [];
    let section = null;
    for (const r of rows.slice(headerIdx + 1)) {
      const label = norm(r.find((c) => norm(c)) || '');
      const l = lower(label);
      if (!label) continue;
      const nums = cols.map((c) => parseAmount(r[c.j]));
      const any = nums.some((n) => n != null);
      if (!any) { const sec = SECTIONS.find(([rx]) => rx.test(l)); if (sec) section = sec[1]; continue; }
      if (/^total |^gross profit$|^net (operating |other )?income$/.test(l)) continue;
      const values = {};
      cols.forEach((c, k) => { values[c.key] = nums[k] || 0; });
      accounts.push({ name: label, section, values });
    }
    if (!accounts.length) return null;
    const months = cols.map((c) => c.key);
    return { source: 'upload', months, accounts, year: +months[0].slice(0, 4) };
  }

  // A budget for the latest year from the same months a year earlier, grown by the given rates.
  function budgetFromHistory(txns, accountClass, meta, opts) {
    opts = opts || {};
    const rg = (+opts.revenueGrowth || 0) / 100, cg = (+opts.costGrowth || 0) / 100;
    const range = dateRange(txns, meta);
    const year = range.last.getUTCFullYear();
    const byAcct = new Map();
    const monthsSeen = new Set();
    for (const p of toPostings(txns, accountClass)) {
      const key = p.t.dateStr.slice(0, 7);
      monthsSeen.add(key);
      if (!byAcct.has(p.category)) byAcct.set(p.category, { cls: p.cls, byMonth: new Map() });
      const a = byAcct.get(p.category);
      a.byMonth.set(key, (a.byMonth.get(key) || 0) + p.value);
    }
    const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
    const priorYear = months.map((m) => `${year - 1}${m.slice(4)}`);
    const hasPrior = priorYear.filter((m) => monthsSeen.has(m)).length >= 6;
    const accounts = [];
    for (const [name, a] of byAcct) {
      const growth = a.cls === 'income' ? rg : cg;
      // Same month last year keeps seasonality; without a year of history, use the average month.
      const values = {};
      const all = [...a.byMonth.values()];
      const avg = all.reduce((t, v) => t + v, 0) / Math.max(1, monthsSeen.size);
      months.forEach((m, i) => {
        const base = hasPrior ? (a.byMonth.get(priorYear[i]) || 0) : avg;
        values[m] = round2(base * (1 + growth));
      });
      if (Object.values(values).some((v) => Math.abs(v) >= 0.5)) accounts.push({ name, section: a.cls, values });
    }
    return { source: 'history', months, accounts, year, revenueGrowth: rg * 100, costGrowth: cg * 100, basis: hasPrior ? `${year - 1} actuals by month` : 'average month of the export' };
  }

  function budgetVsActual(txns, accountClass, meta, budget) {
    if (!budget || !budget.accounts.length) return null;
    const range = dateRange(txns, meta);
    const lastEnd = new Date(Date.UTC(range.last.getUTCFullYear(), range.last.getUTCMonth() + 1, 0)).getUTCDate();
    const lastFull = range.last.getUTCDate() >= lastEnd - 3 ? isoDate(range.last).slice(0, 7) : isoDate(new Date(Date.UTC(range.last.getUTCFullYear(), range.last.getUTCMonth(), 0))).slice(0, 7);
    const ytd = budget.months.filter((m) => m <= lastFull && m >= isoDate(range.first).slice(0, 7));
    const actual = new Map();
    for (const p of toPostings(txns, accountClass)) {
      const m = p.t.dateStr.slice(0, 7);
      if (!ytd.includes(m)) continue;
      const k = lower(p.category);
      if (!actual.has(k)) actual.set(k, { name: p.category, cls: p.cls, byMonth: new Map() });
      const a = actual.get(k);
      a.byMonth.set(m, (a.byMonth.get(m) || 0) + p.value);
    }
    const findActual = (name) => actual.get(lower(name)) || [...actual.values()].find((a) => lower(leafAccount(a.name)) === lower(leafAccount(name)));
    const used = new Set();
    const rows = budget.accounts.map((b) => {
      const a = findActual(b.name);
      if (a) used.add(a);
      const cls = b.section || (a ? a.cls : classOf(accountClass, b.name));
      const budgetYtd = round2(ytd.reduce((t, m) => t + (b.values[m] || 0), 0));
      const actualYtd = round2(a ? ytd.reduce((t, m) => t + (a.byMonth.get(m) || 0), 0) : 0);
      const fullYear = round2(budget.months.reduce((t, m) => t + (b.values[m] || 0), 0));
      return { name: b.name, cls, budgetYtd, actualYtd, fullYear };
    });
    for (const a of actual.values()) {
      if (used.has(a)) continue;
      const actualYtd = round2(ytd.reduce((t, m) => t + (a.byMonth.get(m) || 0), 0));
      if (Math.abs(actualYtd) >= 1) rows.push({ name: a.name, cls: a.cls, budgetYtd: 0, actualYtd, fullYear: 0, unbudgeted: true });
    }
    for (const r of rows) {
      r.variance = round2(r.actualYtd - r.budgetYtd);
      r.pct = r.budgetYtd ? r.variance / Math.abs(r.budgetYtd) : null;
      // Income above budget is good; costs above budget are not.
      r.favorable = r.cls === 'income' ? r.variance >= 0 : r.variance <= 0;
      r.flag = Math.abs(r.variance) >= 500 && (r.pct == null || Math.abs(r.pct) >= 0.1);
    }
    const sumBy = (cls, key) => round2(rows.filter((r) => (cls === 'cost' ? r.cls !== 'income' : r.cls === cls)).reduce((t, r) => t + r[key], 0));
    const totals = {};
    for (const key of ['budgetYtd', 'actualYtd', 'fullYear']) {
      totals[key] = { revenue: sumBy('income', key), costs: sumBy('cost', key) };
      totals[key].netIncome = round2(totals[key].revenue - totals[key].costs);
    }
    // Where the year lands if the rest of it goes to budget.
    const remaining = budget.months.filter((m) => !ytd.includes(m));
    const restBudget = (cls) => round2(budget.accounts.filter((b) => (cls === 'cost' ? (b.section || classOf(accountClass, b.name)) !== 'income' : (b.section || classOf(accountClass, b.name)) === 'income')).reduce((t, b) => t + remaining.reduce((s2, m) => s2 + (b.values[m] || 0), 0), 0));
    const outlook = { revenue: round2(totals.actualYtd.revenue + restBudget('income')), costs: round2(totals.actualYtd.costs + restBudget('cost')) };
    outlook.netIncome = round2(outlook.revenue - outlook.costs);
    const monthly = budget.months.map((m) => {
      const b = { revenue: 0, costs: 0 }, a = { revenue: 0, costs: 0 };
      for (const bb of budget.accounts) { const c = (bb.section || classOf(accountClass, bb.name)) === 'income' ? 'revenue' : 'costs'; b[c] += bb.values[m] || 0; }
      const done = ytd.includes(m);
      if (done) for (const aa of actual.values()) { const c = aa.cls === 'income' ? 'revenue' : 'costs'; a[c] += aa.byMonth.get(m) || 0; }
      return { month: m, label: `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m.slice(5) - 1]} ${m.slice(2, 4)}`, budgetRevenue: round2(b.revenue), budgetNet: round2(b.revenue - b.costs), actualRevenue: done ? round2(a.revenue) : null, actualNet: done ? round2(a.revenue - a.costs) : null };
    });
    return {
      year: budget.year, source: budget.source, basis: budget.basis || null, revenueGrowth: budget.revenueGrowth, costGrowth: budget.costGrowth,
      ytdMonths: ytd.length, ytdLabel: ytd.length ? `${monthLabel(ytd[0])} to ${monthLabel(ytd[ytd.length - 1])}` : 'no months yet',
      totals, outlook, monthly,
      rows: rows.sort((a, b) => Math.abs(b.variance) - Math.abs(a.variance)),
    };
  }

  // ---------------------------------------------------------------- unusual activity

  // Month-end variance review: accounts that swung away from their usual month, and single
  // payments far outside a vendor's pattern (or large first payments to a new payee).
  function unusualActivityUncached(txns, accountClass, meta, trend) {
    if (!trend) return null;
    const full = trend.months.filter((m) => !m.partial);
    if (full.length < 4) return null;
    const month = full[full.length - 1].key;
    const prior = full.slice(-7, -1).map((m) => m.key);
    const postings = toPostings(txns, accountClass);
    const byAcct = new Map();
    for (const p of postings) {
      const k = p.t.dateStr.slice(0, 7);
      if (k !== month && !prior.includes(k)) continue;
      if (!byAcct.has(p.category)) byAcct.set(p.category, { cls: p.cls, byMonth: new Map() });
      const a = byAcct.get(p.category);
      a.byMonth.set(k, (a.byMonth.get(k) || 0) + p.value);
    }
    const flux = [];
    for (const [account, a] of byAcct) {
      // Holding accounts are already on the uncategorized list.
      if (RX.uncategorized.test(account)) continue;
      const now = round2(a.byMonth.get(month) || 0);
      const typical = round2(median(prior.map((k) => a.byMonth.get(k) || 0)));
      const diff = round2(now - typical);
      const big = Math.abs(diff) >= Math.max(250, Math.abs(typical) * 0.5);
      if (!big) continue;
      const up = diff > 0;
      const why = typical === 0 ? `No activity in a typical month; ${fmtWhole(now)} this month.`
        : now === 0 ? `Usually ${fmtWhole(typical)} a month; nothing this month.`
          : `${fmtWhole(now)} against a typical ${fmtWhole(typical)} (${up ? '+' : ''}${Math.round((diff / Math.abs(typical)) * 100)}%).`;
      flux.push({ key: `x|flux|${lower(account)}|${month}`, account, cls: a.cls, month, now, typical, diff, up, detail: why, concern: a.cls === 'income' ? !up : up });
    }
    flux.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));

    // Single payments: compare with the same payee's history before the recent window.
    const recentStart = full[Math.max(0, full.length - 3)].key;
    const byPayee = new Map();
    for (const p of postings) {
      if (p.cls === 'income' || p.value <= 0 || RX.uncategorized.test(p.category)) continue;
      const who = payeeOf(p.t);
      if (!who.key) continue;
      if (!byPayee.has(who.key)) byPayee.set(who.key, []);
      byPayee.get(who.key).push(p);
    }
    const txnFlags = [];
    for (const list of byPayee.values()) {
      const before = [], recent = [];
      for (const p of list) (p.t.dateStr.slice(0, 7) < recentStart ? before : recent).push(p);
      if (!recent.length) continue;
      // Past the payee's usual amount and past anything they have billed before, so vendors
      // with two regular sizes of bill (a retainer and a job) don't trip it.
      const usual = before.length >= 4 ? median(before.map((x) => x.value)) : 0;
      const most = before.reduce((m, x) => Math.max(m, x.value), 0);
      for (const p of recent) {
        const name = counterpartyOf(p.t) || payeeOf(p.t).raw;
        if (before.length >= 4) {
          if (p.value >= 500 && p.value >= usual * 3 && p.value >= most * 1.5) txnFlags.push({ t: p.t, kind: 'Out of pattern', detail: `${fmtWhole(p.value)} to ${name}, about ${Math.round(p.value / usual)} times their usual ${fmtWhole(usual)}.` });
        } else if (!before.length && p.value >= 1000 && list.length <= 2) {
          txnFlags.push({ t: p.t, kind: 'New payee', detail: `${fmtWhole(p.value)} to ${name}, a payee not paid before this period.` });
        }
      }
    }
    const txnsOut = txnFlags.map((f) => ({ ...f.t, kind: f.kind, detail: f.detail, key: `x|txn|${rowKey(f.t)}` })).sort((a, b) => b.date - a.date);
    return { month, monthLabel: monthLabel(month), priorLabel: `${monthLabel(prior[0])} to ${monthLabel(prior[prior.length - 1])}`, flux, txns: txnsOut };
  }

  // The checks depend only on the file and account setup; review status is laid on per run.
  function unusualActivity(txns, accountClass, meta, trend, reviewed) {
    const raw = memo('unusual', txns, accountClass || EMPTY, () => unusualActivityUncached(txns, accountClass, meta, trend));
    if (!raw) return null;
    const tag = (item) => ({ ...item, review: (reviewed && reviewed[item.key]) || null });
    return { ...raw, flux: raw.flux.map(tag), txns: raw.txns.map(tag) };
  }

  // ---------------------------------------------------------------- balance sheet check

  // Accounts that normally run negative, so a negative balance there is not a warning sign.
  const CONTRA_BALANCE = /draw|distribution|dividend|accumulated|depreciation|amortization|retained earnings|allowance|discount|contra|personal/i;
  const SIGN_HINT = {
    cash: 'shows an overdraft. If the bank statement is not overdrawn, deposits are missing or payments were entered twice.',
    card: 'has a credit balance: the card was overpaid, or a payment or refund was entered twice.',
    ar: 'is negative overall: customer payments were recorded without their invoices.',
    ap: 'is negative overall: bills were paid without the bill being entered, or vendor credits were never applied.',
    loan: 'is below zero: more has been paid than was borrowed. Usually interest was recorded as principal, or the loan was never set up with its opening balance.',
    salestax: 'is negative: more sales tax was paid than collected. A payment may be recorded twice, or tax on sales is not being tracked.',
    payrolltax: 'is negative: more was paid than withheld. A payroll tax payment may be recorded twice.',
    equity: 'has an unusual negative balance. Check for entries posted here by mistake.',
    otherbalance: 'has a negative balance, which an asset or liability account should not have. Check for entries posted here by mistake.',
  };

  // Balance sheet problems that sit unnoticed for months: money never deposited, Opening
  // Balance Equity left over from setup, accounts with the wrong sign, customer credits and
  // vendor debits, and bills or invoices left open long after they were likely settled.
  // Needs a "by Account" export, where each account's section carries its running balance.
  function balanceSheetCheckUncached(txns, accountClass, meta, cash) {
    if (!meta || !meta.grouped) return { available: false, reason: 'The export is not grouped by account, so account balances cannot be worked out. Use Transaction Detail by Account.' };
    const range = dateRange(txns, meta);
    const asOf = isoDate(range.last);
    const accts = new Map();
    const acct = (a) => {
      if (!accts.has(a)) accts.set(a, { name: a, balance: 0, opening: 0, rows: [] });
      return accts.get(a);
    };
    for (const [a, v] of Object.entries(meta.openingBalances || {})) {
      if (classOf(accountClass, a) !== 'balance') continue;
      const x = acct(a); x.balance += v; x.opening = v;
    }
    const parties = { ar: new Map(), ap: new Map() };
    for (const t of txns) {
      if (!t.account || classOf(accountClass, t.account) !== 'balance') continue;
      const x = acct(t.account);
      x.balance += t.amount;
      x.rows.push(t);
      const role = roleOf(accountClass, t.account);
      if (role === 'ar' || role === 'ap') {
        const who = counterpartyOf(t) || '';
        const k = payeeKeyOf(who);
        if (!k) continue;
        const m = parties[role];
        if (!m.has(k)) m.set(k, { name: who, total: 0, last: t.dateStr });
        const p = m.get(k);
        p.total += t.amount;
        if (t.dateStr > p.last) p.last = t.dateStr;
      }
    }
    const items = [];
    const push = (it) => items.push(it);
    const balances = [];
    for (const x of accts.values()) {
      const balance = round2(x.balance);
      const role = roleOf(accountClass, x.name);
      balances.push({ account: x.name, role, balance });
      if (Math.abs(balance) < 1) continue;
      if (/undeposited/i.test(x.name)) {
        if (balance <= 0) continue;
        // How long money has been waiting: since the running balance was last at zero.
        let run = x.opening, since = null;
        for (const t of x.rows.slice().sort((a, b) => a.date - b.date)) {
          const before = run;
          run += t.amount;
          if (Math.abs(before) < 0.01 && run > 0.01) since = t.dateStr;
          if (Math.abs(run) < 0.01) since = null;
        }
        const days = since ? Math.round((range.last - new Date(`${since}T00:00:00Z`)) / DAY) : null;
        push({ kind: 'Undeposited Funds', severity: days != null && days <= 7 ? 'Low' : 'High', account: x.name, amount: balance, key: `b|undeposited|${lower(x.name)}|${Math.round(balance)}`,
          detail: `${fmtMoney(balance)} is waiting in ${x.name}${since ? ` since ${niceDate(since)} (${days} days)` : ''}. Customer payments were recorded but never grouped into a bank deposit, or the deposit was entered separately, which counts the income twice.`,
          fix: 'Match each payment to its bank deposit (Bank Deposit screen), or remove payments that were deposited another way.' });
        continue;
      }
      if (/opening bal/i.test(x.name)) {
        push({ kind: 'Opening Balance Equity', severity: 'High', account: x.name, amount: balance, key: `b|obe|${lower(x.name)}|${Math.round(balance)}`,
          detail: `${x.name} holds ${fmtMoney(balance)}. It should be zero once the books are set up; lenders and auditors read a balance here as unfinished bookkeeping.`,
          fix: 'Find what was posted here (usually opening balances of bank, card or loan accounts) and move it to Owner\'s Equity or Retained Earnings, or correct the opening balance.' });
        continue;
      }
      if (balance < 0 && !CONTRA_BALANCE.test(x.name) && !RX.uncategorized.test(x.name)) {
        push({ kind: 'Wrong-sign balance', severity: role === 'ar' || role === 'ap' || role === 'loan' ? 'High' : 'Medium', account: x.name, amount: balance, key: `b|sign|${lower(x.name)}`,
          detail: `${x.name} (${fmtMoney(balance)}) ${SIGN_HINT[role] || SIGN_HINT.otherbalance}`,
          fix: 'Open the account register, sort by amount and look for entries that do not belong.' });
      }
    }
    for (const p of parties.ar.values()) {
      if (p.total > -1) continue;
      push({ kind: 'Customer credit', severity: 'Medium', account: p.name, amount: round2(p.total), key: `b|custcredit|${lower(p.name)}`,
        detail: `${p.name} shows a ${fmtMoney(-p.total)} credit in receivables: a payment not applied to its invoice, or received twice.`,
        fix: 'Apply the payment to the open invoice, refund it, or delete the duplicate payment.' });
    }
    for (const p of parties.ap.values()) {
      if (p.total > -1) continue;
      push({ kind: 'Vendor debit', severity: 'Medium', account: p.name, amount: round2(p.total), key: `b|vendordebit|${lower(p.name)}`,
        detail: `${p.name} shows a ${fmtMoney(-p.total)} debit in payables: a bill paid twice, a payment without its bill, or a vendor credit not used.`,
        fix: 'Apply the payment or credit to its bill, or ask the vendor for a refund.' });
    }
    if (cash) {
      for (const b of cash.ap.openBills.filter((x) => x.age > 90)) {
        push({ kind: 'Old open bill', severity: 'Medium', account: b.party, amount: b.open, key: `b|oldbill|${lower(b.party)}|${b.num}|${b.dateStr}`,
          detail: `Bill${b.num ? ` #${b.num}` : ''} from ${b.party} for ${fmtMoney(b.open)} has been open ${b.age} days${b.possibleDuplicate ? ' and looks like a duplicate' : ''}. If it was paid by check or card as a separate expense, the bill is still open and the cost is counted twice.`,
          fix: 'Link the payment to the bill (Pay Bills), or delete the bill if it was entered twice.' });
      }
      for (const i of cash.ar.openInvoices.filter((x) => x.age > 120)) {
        push({ kind: 'Old open invoice', severity: 'Low', account: i.party, amount: i.open, key: `b|oldinv|${lower(i.party)}|${i.num}|${i.dateStr}`,
          detail: `Invoice${i.num ? ` #${i.num}` : ''} to ${i.party} for ${fmtMoney(i.open)} has been open ${i.age} days. If the customer paid and the money was recorded as a deposit to income, revenue is counted twice.`,
          fix: 'Receive the payment against the invoice, or write it off if it will not be paid.' });
      }
    }
    const rank = { High: 0, Medium: 1, Low: 2 };
    items.sort((a, b) => rank[a.severity] - rank[b.severity] || Math.abs(b.amount) - Math.abs(a.amount));
    balances.sort((a, b) => BALANCE_ROLES.indexOf(a.role) - BALANCE_ROLES.indexOf(b.role) || a.account.localeCompare(b.account));
    return { available: true, asOf, balances, items };
  }

  function withReview(raw, lists, reviewed) {
    if (!raw) return raw;
    const tag = (item) => ({ ...item, review: (reviewed && reviewed[item.key]) || null });
    const out = { ...raw };
    for (const k of lists) if (Array.isArray(raw[k])) out[k] = raw[k].map(tag);
    return out;
  }

  function balanceSheetCheck(txns, accountClass, meta, cash, reviewed) {
    // Open bills and invoices depend on the forecast inputs; the rest only on the file.
    const raw = balanceSheetCheckUncached(txns, accountClass, meta, cash);
    const out = withReview(raw, ['items'], reviewed);
    if (out.items) out.open = out.items.filter((x) => !isCleared(x.review)).length;
    return out;
  }

  // ---------------------------------------------------------------- closed months

  // A short fingerprint of an entry: what it is and where it was coded.
  const fnv = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
  };
  const entryPrint = (t) => fnv(`${rowKey(t)}|${lower(leafAccount(t.split || ''))}|${lower(t.memo || '')}`);

  // What each month looked like when the bookkeeper closed it: entry count, totals by
  // account and a fingerprint per entry. Small enough to keep with the client's settings.
  function periodSnapshot(txns, accountClass, through) {
    const months = {};
    for (const t of logicalRows(txns, accountClass)) {
      const k = t.dateStr.slice(0, 7);
      if (k > through) continue;
      const m = months[k] || (months[k] = { count: 0, accounts: {}, prints: [] });
      m.count++;
      const a = leafAccount(t.account) || '(no account)';
      m.accounts[a] = round2((m.accounts[a] || 0) + t.amount);
      m.prints.push(entryPrint(t));
    }
    for (const m of Object.values(months)) m.prints = m.prints.sort().join(',');
    return { version: 1, through, takenAt: new Date().toISOString(), months };
  }

  // Months the export covers from their first to their last day.
  function fullMonths(txns, meta) {
    const r = dateRange(txns, meta);
    const first = r.first.getUTCDate() === 1 ? isoDate(r.first).slice(0, 7) : isoDate(new Date(Date.UTC(r.first.getUTCFullYear(), r.first.getUTCMonth() + 1, 1))).slice(0, 7);
    const lastDay = new Date(Date.UTC(r.last.getUTCFullYear(), r.last.getUTCMonth() + 1, 0)).getUTCDate();
    const last = r.last.getUTCDate() === lastDay ? isoDate(r.last).slice(0, 7) : isoDate(new Date(Date.UTC(r.last.getUTCFullYear(), r.last.getUTCMonth() - 1, 1))).slice(0, 7);
    const out = [];
    for (let d = new Date(`${first}-01T00:00:00Z`); isoDate(d).slice(0, 7) <= last; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) out.push(isoDate(d).slice(0, 7));
    return out;
  }

  // Compares the closed months with the same months in this export: entries added, changed
  // or removed, and which account totals moved. Months the export does not fully cover are
  // skipped, so a shorter export never reads as deleted history.
  function closedPeriodChanges(txns, accountClass, meta, snapshot) {
    if (!snapshot || !snapshot.months || !snapshot.through) return null;
    const covered = new Set(fullMonths(txns, meta));
    const now = periodSnapshot(txns, accountClass, snapshot.through);
    const entries = logicalRows(txns, accountClass);
    const months = [];
    const keys = [...new Set([...Object.keys(snapshot.months), ...Object.keys(now.months)])].filter((k) => k <= snapshot.through && covered.has(k)).sort();
    for (const k of keys) {
      const was = snapshot.months[k] || { count: 0, accounts: {}, prints: '' };
      const cur = now.months[k] || { count: 0, accounts: {}, prints: '' };
      if (was.prints === cur.prints) continue;
      const left = new Map();
      for (const p of (was.prints ? was.prints.split(',') : [])) left.set(p, (left.get(p) || 0) + 1);
      const added = [];
      for (const t of entries) {
        if (t.dateStr.slice(0, 7) !== k) continue;
        const p = entryPrint(t);
        if (left.get(p)) left.set(p, left.get(p) - 1);
        else added.push({ dateStr: t.dateStr, date: t.date, type: t.type, num: t.num, name: counterpartyOf(t) || '', memo: t.memo || '', account: leafAccount(t.account), split: leafAccount(t.split || ''), amount: t.amount, line: t.line });
      }
      const removed = [...left.values()].reduce((s, n) => s + n, 0);
      const accounts = [];
      for (const a of new Set([...Object.keys(was.accounts), ...Object.keys(cur.accounts)])) {
        const w = was.accounts[a] || 0, c = cur.accounts[a] || 0;
        if (Math.abs(c - w) >= 0.01) accounts.push({ account: a, was: round2(w), now: round2(c), diff: round2(c - w) });
      }
      accounts.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));
      months.push({ month: k, label: monthLabel(k), added: added.sort((a, b) => a.date - b.date), removed, accounts });
    }
    const skipped = Object.keys(snapshot.months).filter((k) => !covered.has(k)).length;
    return {
      through: snapshot.through,
      throughLabel: monthLabel(snapshot.through),
      takenAt: snapshot.takenAt,
      months,
      changedMonths: months.length,
      changedEntries: months.reduce((s, m) => s + Math.max(m.added.length, m.removed), 0),
      skippedMonths: skipped,
    };
  }

  // ---------------------------------------------------------------- job costing gaps

  // Job costs that never reached a job make every job look more profitable than it is.
  // Finds job-type costs with no customer or project, jobs with costs but no billing, and
  // jobs billed with no costs, when the business otherwise tracks costs by job.
  function jobCostGapsUncached(txns, accountClass, profit) {
    const postings = profit.postings;
    let cogs = 0, tagged = 0;
    const byVendorJob = new Map();
    const untagged = [];
    for (const p of postings) {
      if (p.cls !== 'cogs' || p.value <= 0) continue;
      cogs += p.value;
      const job = customerOf(p.t, p.cls);
      const vendor = payeeOf(p.t);
      if (job) {
        tagged += p.value;
        if (vendor.key) {
          if (!byVendorJob.has(vendor.key)) byVendorJob.set(vendor.key, new Map());
          const m = byVendorJob.get(vendor.key);
          const top = job.split(':')[0].trim();
          m.set(top, (m.get(top) || 0) + p.value);
        }
      } else if (!RX.uncategorized.test(p.category)) {
        untagged.push(p);
      }
    }
    if (cogs <= 0) return { mode: 'none', reason: 'No cost of goods sold or job cost accounts were found.' };
    const taggedShare = tagged / cogs;
    if (taggedShare < 0.2) {
      return { mode: 'untracked', cogs: round2(cogs), taggedShare,
        reason: `Only ${fmtPct(taggedShare)} of job costs carry a customer or project, so customer profit here is revenue minus overhead share only. Tagging bills and expenses with the customer makes it real.` };
    }
    // A vendor whose tagged costs nearly all go to one job suggests where an untagged one belongs.
    const suggest = (vendorKey) => {
      const m = byVendorJob.get(vendorKey);
      if (!m) return null;
      const total = [...m.values()].reduce((s, v) => s + v, 0);
      const [name, v] = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
      return v / total >= 0.8 ? name : null;
    };
    const items = untagged.sort((a, b) => b.value - a.value).map((p) => {
      const vendor = payeeOf(p.t);
      const guess = vendor.key ? suggest(vendor.key) : null;
      return {
        ...p.t, kind: 'No job', cost: round2(p.value), account: leafAccount(p.category), vendor: counterpartyOf(p.t) || vendor.raw || '',
        suggestion: guess, key: `j|untagged|${rowKey(p.t)}`,
        detail: `${fmtMoney(p.value)} on ${leafAccount(p.category)} with no customer or project${guess ? `; other costs from ${counterpartyOf(p.t) || 'this vendor'} go to ${guess}` : ''}.`,
      };
    });
    const untaggedTotal = round2(untagged.reduce((s, p) => s + p.value, 0));
    const jobs = [];
    const revenueWithCosts = profit.groups.filter((g) => g.directCost > 0).reduce((s, g) => s + g.revenue, 0);
    const revenueAll = profit.groups.reduce((s, g) => s + g.revenue, 0) || 1;
    for (const g of profit.groups) {
      if (g.revenue <= 0.5 && g.directCost >= 250) {
        jobs.push({ kind: 'Costs, no billing', name: g.name, revenue: g.revenue, cost: g.directCost, key: `j|unbilled|${lower(g.name)}`,
          detail: `${g.name} has ${fmtMoney(g.directCost)} of costs and nothing billed. Either the work has not been invoiced yet, or the costs are tagged to the wrong customer.` });
      } else if (g.directCost <= 0.5 && g.revenue >= 2500 && revenueWithCosts / revenueAll >= 0.7) {
        jobs.push({ kind: 'Billing, no costs', name: g.name, revenue: g.revenue, cost: 0, key: `j|nocost|${lower(g.name)}`,
          detail: `${g.name} was billed ${fmtMoney(g.revenue)} with no costs recorded, unlike most customers. If there were subcontractor or material costs, they are sitting on another job or on no job.` });
      }
    }
    return { mode: 'tracked', cogs: round2(cogs), taggedShare, untaggedTotal, untaggedShare: untaggedTotal / cogs, items, jobs };
  }

  function jobCostGaps(txns, accountClass, profit, reviewed, groupBy) {
    const raw = memo(`jobgaps:${groupBy || 'customer'}`, txns, accountClass || EMPTY, () => jobCostGapsUncached(txns, accountClass, profit));
    const out = withReview(raw, ['items', 'jobs'], reviewed);
    if (out.items) out.open = [...out.items, ...out.jobs].filter((x) => !isCleared(x.review)).length;
    return out;
  }

  // ---------------------------------------------------------------- month-end close

  // The standard monthly close. Steps with `auto` read their status from the analysis;
  // the rest are ticked by hand.
  const CLOSE_STEPS = [
    { id: 'feeds', label: 'Bank and card feeds reviewed and categorized in QuickBooks' },
    { id: 'reconcile', label: 'Bank accounts reconciled to the statements' },
    { id: 'cards', label: 'Credit cards and loans reconciled to the statements' },
    { id: 'uncategorized', label: 'Uncategorized transactions coded', auto: true },
    { id: 'duplicates', label: 'Possible duplicates resolved', auto: true },
    { id: 'coding', label: 'Miscoded entries corrected', auto: true },
    { id: 'balance', label: 'Balance sheet check cleared', auto: true },
    { id: 'unusual', label: 'Unusual activity reviewed', auto: true },
    { id: 'jobs', label: 'Job costs assigned to jobs', auto: true },
    { id: 'contractbilling', label: 'Every maintenance and snow contract billed for the month', auto: true, industry: 'landscaping' },
    { id: 'snowbilled', label: 'Snow pushes and salting billed for every storm', industry: 'landscaping', months: [11, 12, 1, 2, 3, 4] },
    { id: 'fuelcard', label: 'Fuel card statement matched and fuel coded', industry: 'landscaping' },
    { id: 'equiploans', label: 'Equipment and truck loan statements matched, interest split from principal', industry: 'landscaping' },
    { id: 'equipbuys', label: 'Equipment bought over $2,500 recorded as a fixed asset', auto: true, industry: 'landscaping' },
    { id: 'crew', label: 'Seasonal crew hires and layoffs recorded in payroll', industry: 'landscaping', months: [3, 4, 5, 10, 11, 12] },
    { id: 'receipts', label: 'Receipts collected for meals, travel and large purchases', auto: true },
    { id: 'depreciation', label: 'Depreciation posted from the fixed asset register', auto: true },
    { id: 'payroll', label: 'Payroll recorded and payroll liabilities checked' },
    { id: 'salestax', label: 'Sales tax reviewed and filed' },
    { id: 'tieout', label: 'Numbers tie to the QuickBooks Profit and Loss', auto: true },
    { id: 'questions', label: 'Client questions sent' },
    { id: 'report', label: 'Client report sent' },
    { id: 'closed', label: 'Month closed in Ledger Lens', auto: true },
  ];

  function autoStatus(result, id, month) {
    const open = (list) => (list || []).filter((x) => !isCleared(x.review)).length;
    const count = (n, what) => (n ? { status: 'open', note: `${n} ${what}` } : { status: 'clear', note: 'Nothing open' });
    const a = result.audit;
    switch (id) {
      case 'uncategorized': return count(a.open.uncategorized, 'still open');
      case 'duplicates': return count(a.open.duplicates, 'still open');
      case 'coding': return count(a.open.mismatches, 'still open');
      case 'balance':
        if (!result.balanceSheet || !result.balanceSheet.available) return { status: 'na', note: 'Needs a Transaction Detail by Account export' };
        return count(result.balanceSheet.open, 'to fix');
      case 'unusual':
        if (!result.unusual) return { status: 'na', note: 'Needs four or more full months' };
        return count(open([...result.unusual.flux, ...result.unusual.txns]), 'to look at');
      case 'jobs':
        if (!result.jobCosts || result.jobCosts.mode !== 'tracked') return { status: 'na', note: 'Job costs are not tracked by customer' };
        return count(result.jobCosts.open, 'to fix');
      case 'receipts':
        if (!result.receipts || !result.receipts.items.length) return { status: 'na', note: 'No expenses need a receipt' };
        return count(result.receipts.open, 'still needed');
      case 'contractbilling': {
        const c = result.landscape && result.landscape.contracts;
        if (!c) return { status: 'na', note: 'No regular contract billing found' };
        const miss = c.missed.filter((x) => x.month === month);
        return miss.length ? { status: 'open', note: `${miss.length} contract${miss.length === 1 ? '' : 's'} not billed` } : { status: 'clear', note: 'All contracts billed' };
      }
      case 'equipbuys': {
        const e = result.landscape && result.landscape.equipment;
        if (!e) return { status: 'na', note: '' };
        const n = e.capitalize.filter((x) => x.date.slice(0, 7) === month).length;
        return n ? { status: 'open', note: `${n} purchase${n === 1 ? '' : 's'} expensed` } : { status: 'clear', note: 'None expensed' };
      }
      case 'depreciation': {
        const fa = result.fixedAssets;
        if (!fa || !fa.schedule || !fa.schedule.rows.length) return { status: 'na', note: 'No fixed asset register yet' };
        const due = round2(fa.schedule.rows.reduce((t, r) => t + (r.bookMonthly[month] || 0), 0));
        const posted = fa.recordedMonths[month] || 0;
        if (due <= 0) return { status: 'clear', note: 'Nothing due this month' };
        // Clients who book depreciation once a year, at December.
        const months = Object.keys(fa.recordedMonths);
        const yearly = months.length > 0 && months.every((k) => k.endsWith('-12'));
        if (yearly && !month.endsWith('-12')) return { status: 'clear', note: 'Booked once a year, in December' };
        if (yearly) {
          const yearDue = round2(fa.schedule.rows.reduce((t, r) => t + (r.bookByYear[month.slice(0, 4)] || 0), 0));
          return Math.abs(posted - yearDue) <= 1 ? { status: 'clear', note: `${fmtMoney(posted)} for the year` } : { status: 'open', note: `${fmtMoney(yearDue)} due for the year, ${fmtMoney(posted)} posted` };
        }
        return Math.abs(posted - due) <= 1 ? { status: 'clear', note: `${fmtMoney(posted)} posted` } : { status: 'open', note: `${fmtMoney(due)} due, ${fmtMoney(posted)} posted` };
      }
      case 'tieout':
        if (!result.tieOut) return { status: 'open', note: 'Add the P&L export to check' };
        return result.tieOut.ties ? { status: 'clear', note: `Ties for ${result.tieOut.period}` } : { status: 'open', note: 'Differences found' };
      case 'closed': {
        const c = result.closed;
        if (!c || c.through < month) return { status: 'open', note: c ? `Closed through ${monthLabel(c.through)}` : 'Not closed yet' };
        if (c.changedMonths) return { status: 'open', note: `${c.changedEntries} change(s) since closing` };
        return { status: 'clear', note: `Closed through ${monthLabel(c.through)}` };
      }
      default: return null;
    }
  }

  // The checklist for one month: the standard steps (minus ones that do not apply), the
  // client's own extra steps, and what is done. An automatic step counts as done while the
  // analysis shows it clear; any step can also be ticked by hand.
  function closeChecklist(result, month, state, custom) {
    const done = (state && state.done) || {};
    const hasSalesTax = result.balanceSheet && result.balanceSheet.balances && result.balanceSheet.balances.some((b) => b.role === 'salestax');
    const items = [];
    for (const s of CLOSE_STEPS) {
      if (s.id === 'salestax' && !hasSalesTax && !done.salestax) continue;
      if (s.industry && s.industry !== result.industry && !done[s.id]) continue;
      if (s.months && !s.months.includes(+String(month).slice(5)) && !done[s.id]) continue;
      const auto = s.auto ? autoStatus(result, s.id, month) : null;
      if (auto && auto.status === 'na') continue;
      const doneAt = done[s.id] || null;
      items.push({ id: s.id, label: s.label, auto, doneAt, done: !!doneAt || (auto && auto.status === 'clear') });
    }
    for (const c of custom || []) {
      if (!c || !c.id || !c.label) continue;
      const doneAt = done[c.id] || null;
      items.push({ id: c.id, label: c.label, custom: true, auto: null, doneAt, done: !!doneAt });
    }
    const n = items.filter((i) => i.done).length;
    return { month, label: monthLabel(month), items, done: n, total: items.length, complete: n === items.length, notes: (state && state.notes) || '' };
  }

  // A short summary saved with each client, for the all-clients dashboard.
  function clientSummary(result, checklistState, custom) {
    const open = (list) => (list || []).filter((x) => !isCleared(x.review)).length;
    const a = result.audit;
    const months = result.closableMonths || [];
    const month = months[months.length - 1] || null;
    const cl = month ? closeChecklist(result, month, checklistState && checklistState[month], custom) : null;
    const tr = result.trend;
    const last12 = tr ? tr.months.filter((m) => !m.partial).slice(-12) : [];
    const counts = {
      uncategorized: a.open.uncategorized,
      duplicates: a.open.duplicates,
      mismatches: a.open.mismatches,
      balance: result.balanceSheet && result.balanceSheet.available ? result.balanceSheet.open : 0,
      unusual: result.unusual ? open([...result.unusual.flux, ...result.unusual.txns]) : 0,
      jobs: result.jobCosts && result.jobCosts.mode === 'tracked' ? result.jobCosts.open : 0,
      receipts: result.receipts ? result.receipts.open : 0,
      answers: open(result.answers),
    };
    return {
      periodStart: result.period.start,
      periodEnd: result.period.end,
      health: a.healthScore,
      open: counts,
      openTotal: Object.values(counts).reduce((s, n) => s + n, 0),
      closedThrough: result.closed ? result.closed.through : null,
      closedChanges: result.closed ? result.closed.changedEntries : 0,
      ties: result.tieOut ? result.tieOut.ties : null,
      cash: result.cash ? result.cash.startingCash : null,
      lowestCash: result.cash ? result.cash.lowest.ending : null,
      lowestWeek: result.cash ? result.cash.lowest.start : null,
      revenue12: last12.length ? round2(last12.reduce((s, m) => s + m.revenue, 0)) : result.profit.totals.revenue,
      netIncome12: last12.length ? round2(last12.reduce((s, m) => s + m.netIncome, 0)) : result.profit.totals.netIncome,
      months12: last12.length,
      close: cl ? { month: cl.month, done: cl.done, total: cl.total } : null,
      industry: result.industry || 'general',
      landscape: result.landscape && result.landscape.contracts ? { missed: result.landscape.contracts.missed.length, stale: result.landscape.contracts.stale.length } : null,
    };
  }

  // ---------------------------------------------------------------- receipts

  // A list export with an Attachments column but no accounts (QuickBooks' Expenses page),
  // used only to tell which transactions have a receipt attached.
  function parseAttachmentList(text) {
    const rows = parseCSV(text);
    for (let i = 0; i < Math.min(rows.length, 30); i++) {
      const lc = rows[i].map(lower);
      const col = (names) => names.map((n) => lc.indexOf(n)).find((x) => x !== -1);
      const att = col(['attachments', 'attachment', '# of attachments', 'attachment count', 'no. of attachments']);
      const date = col(['date', 'transaction date', 'txn date']);
      const total = col(['total', 'amount', 'total amount']);
      if (att == null || date == null || total == null) continue;
      if (col(['split', 'account', 'account full name', 'distribution account']) != null) return null;
      const payee = col(['payee', 'name', 'vendor']);
      const entries = [];
      for (const r of rows.slice(i + 1)) {
        const d = parseDate(r[date]);
        const amt = parseAmount(r[total]);
        if (!d || amt == null) continue;
        entries.push({ dateStr: isoDate(d), amount: Math.abs(amt), payee: payee != null ? norm(r[payee]) : '', count: attachCount(r[att]) });
      }
      return entries.length ? { entries } : null;
    }
    return null;
  }

  // Which expenses need a receipt, by rule, first match wins:
  // lodging and gifts at any amount, meals and travel at $75 or more (IRS rules for
  // substantiation), any purchase of $2,500 or more, and anything over the firm's own limit.
  const RECEIPT_RULES = [
    { rule: 'Lodging', rx: /lodging|hotel|motel|airbnb|\binn\b/i, min: 0, why: 'Lodging needs a receipt at any amount.' },
    { rule: 'Gift', rx: /\bgifts?\b/i, min: 0, why: 'Business gifts need a receipt and the recipient\'s name.' },
    { rule: 'Meals', rx: /meal|entertain|dining|restaurant|\bcafe\b/i, min: 75, why: 'Meals and entertainment of $75 or more need a receipt, who attended and the business purpose.' },
    { rule: 'Travel', rx: /travel|airfare|airline|flight|\buber\b|\blyft\b|taxi|parking|car rental|rental car|mileage/i, min: 75, why: 'Travel costs of $75 or more need a receipt.' },
  ];
  const NO_RECEIPT = /payroll|wages|salar|bank (fee|charge|service)|service charge|interest|depreciation|amortization|merchant fee|finance charge/i;

  function receiptCheckUncached(txns, accountClass, meta, opts) {
    const limit = +opts.limit > 0 ? +opts.limit : 0;
    const range = dateRange(txns, meta);
    const since = isoDate(new Date(range.last.getTime() - 365 * DAY));
    const index = new Map();
    for (const e of opts.attachments || []) {
      const k = `${e.dateStr}|${e.amount.toFixed(2)}`;
      index.set(k, Math.max(index.get(k) || 0, e.count));
    }
    const hasColumn = txns.some((t) => t.attachments != null);
    // Repeating payments of the same amount (rent, retainers) are covered by the agreement,
    // not a receipt each month, so the amount rules skip them.
    const postings = toPostings(txns, accountClass);
    const repeats = new Map();
    for (const p of postings) {
      if (p.cls === 'income' || p.value <= 0) continue;
      const k = `${payeeOf(p.t).key}|${Math.round(p.value)}`;
      repeats.set(k, (repeats.get(k) || 0) + 1);
    }
    const items = [];
    for (const p of postings) {
      if (p.cls === 'income' || p.value <= 0 || p.t.dateStr < since) continue;
      if (RX.uncategorized.test(p.category) || NO_RECEIPT.test(p.category) || REVERSING_TYPES.test(p.t.type)) continue;
      if (/journal|transfer|deposit|payment$/i.test(p.t.type) && !/bill payment/i.test(p.t.type)) continue;
      const text = `${p.category} ${p.t.memo || ''} ${counterpartyOf(p.t)}`;
      let hit = RECEIPT_RULES.find((r) => r.rx.test(text) && p.value >= r.min);
      // Bills are entered from the vendor's own invoice; the amount rules cover purchases
      // paid directly by check, card or bank.
      const oneOff = !/^bill$/i.test(p.t.type) && (repeats.get(`${payeeOf(p.t).key}|${Math.round(p.value)}`) || 0) < 3;
      if (!hit && oneOff && p.value >= 2500) hit = { rule: 'Large purchase', why: 'Keep the invoice for purchases of $2,500 or more, and check whether it should be recorded as equipment rather than an expense.' };
      if (!hit && oneOff && limit && p.value >= limit) hit = { rule: 'Over your limit', why: `Your firm keeps receipts for expenses of ${fmtWhole(limit)} or more.` };
      if (!hit) continue;
      const fromList = index.get(`${p.t.dateStr}|${p.value.toFixed(2)}`);
      const count = p.t.attachments != null ? p.t.attachments : fromList != null ? fromList : null;
      items.push({ ...p.t, amount: round2(p.value), account: leafAccount(p.category), rule: hit.rule, why: hit.why, attachments: count, key: `r|${rowKey(p.t)}` });
    }
    items.sort((a, b) => b.date - a.date);
    return { hasAttachmentData: hasColumn || index.size > 0, source: hasColumn ? 'export' : index.size ? 'list' : null, since, limit, items };
  }

  function receiptCheck(txns, accountClass, meta, opts, reviewed, answers) {
    opts = opts || {};
    const raw = memo(`receipts:${opts.limit || 0}:${opts.attachments ? opts.attachments.length : 0}`, txns, accountClass || EMPTY,
      () => receiptCheckUncached(txns, accountClass, meta, opts));
    const items = raw.items.map((r) => {
      const a = answers && answers[r.key];
      const status = r.attachments > 0 ? 'Attached' : a && a.receipt ? 'Client sent' : r.attachments === 0 ? 'Missing' : 'Unknown';
      return { ...r, status, review: (reviewed && reviewed[r.key]) || null };
    });
    const count = (st) => items.filter((x) => x.status === st).length;
    // A receipt the client says they sent is no longer owed by them; it shows as sent until attached.
    const needed = items.filter((x) => x.status !== 'Attached' && x.status !== 'Client sent' && !isCleared(x.review));
    return { ...raw, items, counts: { attached: count('Attached'), missing: count('Missing'), unknown: count('Unknown'), sent: count('Client sent') }, open: needed.length };
  }

  // ---------------------------------------------------------------- client answers

  // The questions as a spreadsheet the client fills in: one row per question, with a
  // reference that maps each answer back. CSV opens in Excel, Numbers and Google Sheets.
  const ANSWER_HEADERS = ['Ref', 'Topic', 'Date', 'Payee', 'Amount', 'Question', 'Your answer', 'Receipt sent? (Yes/No)'];
  function questionsSheet(q) {
    const cell = (v) => {
      const s = v == null ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [ANSWER_HEADERS.join(',')];
    for (const r of q.rows) lines.push([r.ref, r.section, r.date, r.payee, r.amount != null ? r.amount.toFixed(2) : '', r.question, '', ''].map(cell).join(','));
    return `﻿${lines.join('\r\n')}\r\n`;
  }

  // Reads a returned questions spreadsheet: rows with a reference and an answer or a
  // receipt marked as sent. Returns null for anything else.
  function parseAnswers(text) {
    const rows = parseCSV(String(text || '').replace(/^﻿/, ''));
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const lc = rows[i].map((c) => lower(c).trim());
      const ref = lc.indexOf('ref');
      const ans = lc.findIndex((c) => c.startsWith('your answer') || c === 'answer');
      if (ref === -1 || ans === -1) continue;
      const rec = lc.findIndex((c) => c.startsWith('receipt sent'));
      const out = [];
      for (const r of rows.slice(i + 1)) {
        const id = norm(r[ref]).toUpperCase();
        if (!/^Q-[0-9A-Z]{1,8}$/.test(id)) continue;
        const answer = norm(r[ans]);
        const receipt = rec !== -1 && /^(y|yes|sent|true|x|✓)$/i.test(norm(r[rec]));
        if (answer || receipt) out.push({ ref: id, answer, receipt });
      }
      return { answers: out };
    }
    return null;
  }

  // Matches returned answers to the current questions by reference.
  function matchAnswers(result, parsed) {
    const q = clientQuestions(result, { include: { uncategorized: true, duplicates: true, coding: true, receivables: true, w9: true, unusual: true, receipts: true } });
    const byRef = new Map(q.rows.map((r) => [r.ref, r]));
    const matched = [], unmatched = [];
    for (const a of (parsed && parsed.answers) || []) {
      const row = byRef.get(a.ref);
      if (row) matched.push({ key: row.key, ref: a.ref, topic: row.section, question: row.question, answer: a.answer, receipt: a.receipt });
      else unmatched.push(a.ref);
    }
    return { matched, unmatched };
  }

  // Saved answers, with the review status of the item each one is about.
  function answersView(answers, reviewed) {
    return Object.entries(answers || {}).map(([key, a]) => ({ key, ...a, review: (reviewed && reviewed[key]) || null }))
      .sort((x, y) => String(y.at || '').localeCompare(String(x.at || '')));
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
  // The reference printed next to each question in the client spreadsheet; it maps a
  // returned answer back to its question.
  const questionRef = (key) => `Q-${fnv(key).slice(0, 6).toUpperCase()}`;

  function clientQuestions(result, opts) {
    opts = opts || {};
    const inc = Object.assign({ uncategorized: true, duplicates: true, coding: true, receivables: true, w9: true, unusual: true, receipts: true }, opts.include || {});
    const answered = opts.answers || {};
    const open = (item) => !isCleared(item.review) && !answered[item.key];
    const sections = [];
    const keys = [];
    const rows = [];
    const who = (t) => counterpartyOf(t) || (t.memo ? `"${t.memo}"` : 'no payee recorded');
    const money = (n) => fmtMoney(Math.abs(n));
    // One question: its text for the letter, and a row for the spreadsheet. `markable` keys
    // belong to audit flags that "Mark as asked" can update.
    const section = (title) => ({ title, items: [] });
    const ask = (sec, key, text, t, markable) => {
      sec.items.push(text);
      if (markable) keys.push(key);
      rows.push({ key, ref: questionRef(key), section: sec.title, date: t && t.dateStr ? t.dateStr : '', payee: t ? counterpartyOf(t) || t.memo || '' : '', amount: t && t.amount != null ? Math.abs(t.amount) : null, question: text });
    };
    const done = (sec) => { if (sec.items.length) sections.push(sec); };

    const asked = new Set();
    if (inc.uncategorized) {
      const sec = section('Transactions we could not categorize');
      for (const t of result.audit.uncategorized.filter(open).sort((a, b) => a.date - b.date)) {
        asked.add(rowKey(t));
        const incoming = classOf(null, t.account) === 'income' || /deposit|sales receipt/i.test(t.type);
        ask(sec, t.key, incoming
          ? `${niceDate(t.dateStr)}: a deposit of ${money(t.amount)} (${who(t)}). Who paid this, and what was it for?`
          : `${niceDate(t.dateStr)}: ${money(t.amount)} to ${who(t)}${t.memo && counterpartyOf(t) ? ` (${t.memo})` : ''}. What was this for?`, t, true);
      }
      done(sec);
    }
    if (inc.duplicates) {
      const sec = section('Possible double charges');
      for (const g of result.audit.duplicates.filter(open).sort((a, b) => a.rows[0].date - b.rows[0].date)) {
        const r = g.rows[0];
        const dates = g.rows.map((x) => niceDate(x.dateStr)).join(' and ');
        ask(sec, g.key, /bill/i.test(r.type)
          ? `Bill${r.num ? ` #${r.num}` : ''} from ${who(r)} for ${money(r.amount)} is entered ${g.rows.length} times (${dates}). Did you receive ${g.rows.length} separate bills?`
          : `${who(r)} shows ${g.rows.length} charges of ${money(r.amount)} (${dates}). Were you charged ${g.rows.length === 2 ? 'twice' : `${g.rows.length} times`}, or is one of these a duplicate entry?`, r, true);
      }
      done(sec);
    }
    if (inc.coding) {
      const sec = section('Entries we want to confirm');
      for (const t of result.audit.mismatches.filter(open).sort((a, b) => a.date - b.date)) {
        // Already asked about as uncategorized: one question per transaction.
        if (asked.has(rowKey(t))) continue;
        let q = null;
        if (t.kind === 'Missing payee') q = `${niceDate(t.dateStr)}: ${money(t.amount)}${t.memo ? ` ("${t.memo}")` : ''}. Who was this paid to?`;
        else if (t.kind === 'Type / account conflict' && /transfer/i.test(t.type)) q = `${niceDate(t.dateStr)}: a ${money(t.amount)} transfer${t.memo ? ` ("${t.memo}")` : ''}. Was this a move to another account of yours, or a payment to someone?`;
        else if (t.kind === 'Type / account conflict') q = `${niceDate(t.dateStr)}: ${money(t.amount)} with ${who(t)}${t.memo ? ` ("${t.memo}")` : ''}. Can you tell us what this was, so we can record it correctly?`;
        if (q) ask(sec, t.key, q, t, true);
      }
      done(sec);
    }
    if (inc.unusual && result.unusual) {
      const sec = section('Unusual payments');
      for (const t of result.unusual.txns.filter(open).filter((x) => !asked.has(rowKey(x))).sort((a, b) => a.date - b.date)) {
        asked.add(rowKey(t));
        ask(sec, t.key, t.kind === 'New payee'
          ? `${niceDate(t.dateStr)}: ${money(t.amount)} to ${who(t)}, a payee we have not seen before. What was this for?`
          : `${niceDate(t.dateStr)}: ${money(t.amount)} to ${who(t)}, well above what you usually pay them. Is this amount right, and what did it cover?`, t, true);
      }
      done(sec);
    }
    if (inc.receipts && result.receipts) {
      const sec = section('Receipts we need');
      for (const r of result.receipts.items.filter((x) => x.status !== 'Attached' && open(x))) {
        ask(sec, r.key, `${niceDate(r.dateStr)}: ${money(r.amount)} to ${who(r)}${r.memo && counterpartyOf(r) ? ` (${r.memo})` : ''}. Please send the receipt${r.rule === 'Meals' ? ', and note who attended and the business purpose' : r.rule === 'Gift' ? ' and who the gift was for' : ''}.`, r, true);
      }
      done(sec);
    }
    if (inc.receivables && result.cash) {
      const sec = section('Old unpaid invoices');
      for (const i of result.cash.ar.openInvoices.filter((x) => x.age > 90)) {
        const key = `q|ar|${lower(i.party)}|${i.num}|${i.dateStr}`;
        if (answered[key]) continue;
        sec.items.push(`Invoice${i.num ? ` #${i.num}` : ''} to ${i.party} for ${money(i.open)} from ${niceDate(i.dateStr)} is still unpaid after ${i.age} days. Do you still expect payment, or should we write it off?`);
        rows.push({ key, ref: questionRef(key), section: sec.title, date: i.dateStr, payee: i.party, amount: i.open, question: sec.items[sec.items.length - 1] });
      }
      done(sec);
    }
    if (inc.w9 && result.vendors) {
      const names = [];
      for (const y of result.vendors.tax) for (const v of y.vendors) if (v.status === 'Review' && !names.includes(v.vendor)) names.push(v.vendor);
      const years = result.vendors.tax.filter((y) => y.reviewCount).map((y) => y.year);
      const key = `q|w9|${years.join('-')}`;
      if (names.length && !answered[key]) {
        const text = `Please send W-9 forms for ${names.join(', ')} (paid enough in ${years.join(' or ')} to need a 1099), or tell us which ones you already have on file.`;
        sections.push({ title: 'W-9 forms for contractors', items: [text] });
        rows.push({ key, ref: questionRef(key), section: 'W-9 forms for contractors', date: '', payee: names.join(', '), amount: null, question: text });
      }
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
    const sig = signature(opts);
    if (sig) L.push(sig);
    const site = firmOf(opts).website;
    if (site) L.push(site);
    return { text: L.join('\n'), count, sections, keys, rows };
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
    out.unusual = unusualActivity(txns, accountClass, parsed.meta, trend, opts.reviewed);
    out.balanceSheet = balanceSheetCheck(txns, accountClass, parsed.meta, cash, opts.reviewed);
    out.jobCosts = jobCostGaps(txns, accountClass, profit, opts.reviewed, opts.groupBy);
    out.closed = closedPeriodChanges(txns, accountClass, parsed.meta, opts.closed);
    out.receipts = receiptCheck(txns, accountClass, parsed.meta, { limit: opts.receiptLimit, attachments: opts.attachments }, opts.reviewed, opts.answers);
    out.answers = answersView(opts.answers, opts.reviewed);
    out.closableMonths = once('fullMonths', () => fullMonths(txns, parsed.meta));
    // Takes a snapshot for "close the books through" a month; kept with the client's settings.
    out.closeBooks = (through) => periodSnapshot(txns, accountClass, through);
    // Budget: an uploaded QuickBooks budget, else one built from last year's actuals.
    const budget = opts.budget || (opts.budgetFromHistory !== false ? budgetFromHistory(txns, accountClass, parsed.meta, opts.budgetGrowth) : null);
    out.budget = budgetVsActual(txns, accountClass, parsed.meta, budget);
    // The advisory views read the finished analysis (audit, forecast, trends, customers).
    out.loan = loanReadiness(txns, accountClass, out, opts.loan);
    const cushion = opts.cushion != null && opts.cushion !== '' && !isNaN(+opts.cushion) ? +opts.cushion : breakeven ? Math.round(breakeven.base.fixed / 1000) * 1000 : 0;
    out.tax = taxPlan(txns, accountClass, out, Object.assign({ cushion }, opts.tax));
    out.lender = lenderPackage(txns, accountClass, out);
    // Industry: what the bookkeeper chose for this client, else a guess from the names.
    out.detectedIndustry = detectIndustry(parsed.meta, out.accounts ? out.accounts.map((a) => a.name || a.account || a) : []);
    out.industry = opts.industry || out.detectedIndustry;
    if (out.industry === 'landscaping') out.landscape = landscapeAnalysis(txns, accountClass, out, { cushion: opts.cushion, customers: opts.customers });
    // Fraud risk checks: a landscaping tab for now (crews, fuel cards, cash jobs).
    if (out.industry === 'landscaping') out.fraud = fraudChecks(txns, accountClass, out, { voided: opts.voided, employees: opts.employees, routes: out.landscape && out.landscape.routes, receiptLimit: opts.receiptLimit });
    // Fixed assets: what the books show, and the saved register's schedule through the last full month.
    out.fixedAssets = fixedAssetFacts(txns, accountClass);
    if (out.balanceSheet && out.balanceSheet.available) {
      const fa = out.balanceSheet.balances.filter((b) => (FIXED_ASSET_NAME.test(b.account) || /accum.*deprec/i.test(b.account)) && !/loan|payable|financial|credit/i.test(b.account));
      out.fixedAssets.bookCost = round2(fa.filter((b) => !/accum|depreciation/i.test(b.account)).reduce((t, b) => t + b.balance, 0));
      out.fixedAssets.bookAccumulated = round2(-fa.filter((b) => /accum|depreciation/i.test(b.account)).reduce((t, b) => t + b.balance, 0));
    }
    if (opts.assets && opts.assets.length) {
      const last = out.closableMonths && out.closableMonths.length ? out.closableMonths[out.closableMonths.length - 1] : isoDate(dateRange(txns, parsed.meta).last).slice(0, 7);
      const sched = assetSchedule(opts.assets, { asOf: last });
      delete sched.monthBook;
      out.fixedAssets.schedule = sched;
    }
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

  // The preparing firm's name, website, colors and logo for report headers. Only an inline
  // image is accepted as a logo so a report never loads anything from elsewhere.
  const LOGO_RX = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
  const HEX_RX = /^#[0-9a-f]{6}$/i;
  function firmOf(opts) {
    const f = (opts && opts.firm) || {};
    const website = String(f.website || '').trim();
    return {
      name: String(f.name || '').trim(),
      website,
      href: website ? (/^https?:\/\//i.test(website) ? website : `https://${website}`) : '',
      logo: LOGO_RX.test(f.logo || '') ? f.logo : '',
      color: HEX_RX.test(f.color || '') ? f.color : RC.accent,
      color2: HEX_RX.test(f.color2 || '') ? f.color2 : RC.ink2,
    };
  }
  // "Jordan Lee, 7D Business Solutions", or whichever half is known.
  const signature = (opts) => {
    const firm = firmOf(opts);
    const who = String((opts && opts.preparer) || '').trim();
    if (!who) return firm.name;
    return firm.name && !lower(who).includes(lower(firm.name)) ? `${who}, ${firm.name}` : who;
  };

  // Styles shared by the client report and the lender package: plain, printable, the firm's
  // colors on the header.
  function reportCss(firm) {
    return `
      @page { margin: 16mm 14mm; }
      * { box-sizing: border-box; }
      body { margin: 0; background: #fff; color: ${RC.ink}; font: 13px/1.5 -apple-system, "Segoe UI", system-ui, Roboto, sans-serif; }
      main { max-width: 760px; margin: 0 auto; padding: 28px 20px 40px; }
      header { border-bottom: 3px solid ${firm.color}; padding-bottom: 12px; margin-bottom: 18px; display: flex; align-items: center; gap: 16px; }
      .head-text { flex: 1; min-width: 0; }
      .logo { width: 84px; height: auto; flex: none; }
      .brand { font-size: 11px; letter-spacing: .12em; text-transform: uppercase; color: ${firm.color}; font-weight: 600; }
      .firm { margin-top: 28px; font-size: 12px; font-weight: 600; color: ${firm.color}; }
      .firm a { color: ${firm.color2}; text-decoration: none; }
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
      footer { margin-top: 10px; padding-top: 10px; border-top: 1px solid ${RC.hair}; font-size: 11px; color: ${RC.muted}; }
    `;
  }

  // ---------------------------------------------------------------- fraud risk

  // US holidays most crews take off (fixed dates, Memorial Day, Labor Day, Thanksgiving).
  function usHoliday(iso) {
    const [y, m, d] = String(iso).split('-').map(Number);
    if (!y) return '';
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (m === 1 && d === 1) return "New Year's Day";
    if (m === 7 && d === 4) return 'Independence Day';
    if (m === 12 && d === 25) return 'Christmas';
    if (m === 5 && dow === 1 && d > 24) return 'Memorial Day';
    if (m === 9 && dow === 1 && d <= 7) return 'Labor Day';
    if (m === 11 && dow === 4 && d >= 22 && d <= 28) return 'Thanksgiving';
    return '';
  }

  // The Voided/Deleted Transactions report (QuickBooks Desktop) or the Audit Log (Online):
  // rows with an Action, Event or State column saying a transaction was voided or deleted.
  function parseVoidedDeleted(text) {
    const rows = parseCSV(text);
    for (let i = 0; i < Math.min(rows.length, 20); i++) {
      const lc = rows[i].map(lower);
      const col = (rx) => { const j = lc.findIndex((h) => rx.test(h)); return j === -1 ? null : j; };
      const action = col(/^(action|event|state|history)$/);
      if (action == null) continue;
      const date = col(/^(date|transaction date|txn date)$/), type = col(/^(type|transaction type)$/), num = col(/^(num|no\.?|number|ref no\.?)$/);
      const name = col(/^(name|customer|vendor|payee)$/), amount = col(/^(amount|total)$/), who = col(/(modified by|^user$|changed by)/), when = col(/(entered|last modified|date changed|changed)/);
      const out = [];
      for (const r of rows.slice(i + 1)) {
        const act = norm(r[action]);
        if (!/delet|void/i.test(act)) continue;
        const kind = /delet/i.test(act) ? 'Deleted' : 'Voided';
        const t = norm(type != null ? r[type] : '') || ((act.match(/(invoice|sales receipt|payment|deposit|check|bill payment|bill|expense|credit memo|refund|journal entry|estimate)/i) || [])[1] || '');
        const n = norm(num != null ? r[num] : '') || ((act.match(/no\.?\s*(\S+)/i) || [])[1] || '');
        const d = parseDate(date != null ? r[date] : '');
        out.push({ action: kind, type: t ? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() : '', num: n, name: name != null ? norm(r[name]) : '', amount: amount != null ? Math.abs(parseAmount(r[amount]) || 0) : 0, date: d ? isoDate(d) : '', by: who != null ? norm(r[who]) : '', when: when != null ? norm(r[when]) : '' });
      }
      return out.length ? { entries: out } : null;
    }
    return null;
  }

  // An employee list from payroll (Employee Details or a payroll provider's export) with the
  // direct deposit bank details, usually masked to the last four digits.
  function parseEmployeeList(text) {
    const rows = parseCSV(text);
    for (let i = 0; i < Math.min(rows.length, 20); i++) {
      const lc = rows[i].map(lower);
      const col = (rx) => { const j = lc.findIndex((h) => rx.test(h)); return j === -1 ? null : j; };
      const name = col(/^(employee|employee name|name|full name)$/);
      const routing = col(/routing/), account = col(/(bank )?account( number| no\.?)?$|^account$|deposit account/);
      if (name == null || (routing == null && account == null) || (lc[name] !== 'employee' && lc[name] !== 'employee name' && routing == null)) continue;
      const address = col(/^(address|home address|street)$/);
      const out = [];
      for (const r of rows.slice(i + 1)) {
        const n = norm(r[name]);
        if (!n || /^total/i.test(n)) continue;
        const digits = (v) => String(v || '').replace(/[^0-9]/g, '');
        out.push({ name: n, routing: routing != null ? digits(r[routing]) : '', account: account != null ? digits(r[account]).slice(-4) : '', address: address != null ? norm(r[address]) : '' });
      }
      return out.length ? { employees: out } : null;
    }
    return null;
  }

  const PAYROLL_PROVIDER = /gusto|adp|paychex|intuit|quickbooks payroll|payroll|paylocity|rippling|square payroll|onpay|patriot/i;
  const vendorKey = (s) => lower(s).replace(/[^a-z0-9 ]/g, ' ').replace(/\b(llc|inc|co|corp|corporation|company|the|ltd)\b/g, ' ').replace(/\s+/g, '');
  function similarity(a, b) {
    if (a === b) return 1;
    const m = a.length, n = b.length;
    if (!m || !n) return 0;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return 1 - prev[n] / Math.max(m, n);
  }

  const PURCHASE_ACCOUNT = /suppl|material|tool|fuel|gas\b|gasoline|diesel|meal|repair|maint|parts|travel|auto|vehicle|equipment rental|plants|mulch|landscap|job/i;
  const NOT_PURCHASE = /interest|loan|rent|lease|insurance|bank|fee|payroll|wage|tax|owner|depreciation|subscription|software|utilit/i;
  const FRAUD_WEIGHT = { high: 15, medium: 8, low: 3 };

  // Fraud risk checks: patterns worth a closer look, never proof. Each check says found, clean,
  // needs another report, or does not apply, with the items behind it.
  function fraudChecks(txns, accountClass, result, opts) {
    opts = opts || {};
    const range = dateRange(txns, result.meta);
    const ttm = trailingYear(range.first, range.last);
    const inTtm = (d) => (ttm ? d >= ttm.start && d <= ttm.end : true);
    const postings = toPostings(txns, accountClass);
    const spend = postings.filter((p) => (p.cls === 'expense' || p.cls === 'cogs') && p.value > 0);
    const spendTtm = spend.filter((p) => inTtm(p.t.date));
    const who = (t) => counterpartyOf(t) || '';
    const months = result.closableMonths || [];
    const last3 = months.slice(-3);
    const checks = [];
    const add = (c) => checks.push({ items: [], columns: [], amount: null, ...c, status: c.status || (c.items && c.items.length ? 'found' : 'clean') });
    const money = (k, label) => [label, k, 'money'];

    // ---- Missing revenue
    const numbered = (rx) => {
      const seen = new Map();
      for (const t of txns) if (rx.test(t.type || '') && /^\d{1,9}$/.test(t.num || '') && !seen.has(+t.num)) seen.set(+t.num, t.dateStr);
      return [...seen.entries()].sort((a, b) => a[0] - b[0]);
    };
    const gapsOf = (list) => {
      const gaps = [];
      for (let i = 1; i < list.length; i++) {
        const d = list[i][0] - list[i - 1][0];
        if (d > 1 && d <= 50) gaps.push({ from: list[i - 1][0] + 1, to: list[i][0] - 1, count: d - 1, after: list[i - 1][1] });
      }
      return gaps;
    };
    const deleted = opts.voided ? opts.voided.entries : null;
    const delNums = new Map((deleted || []).filter((x) => x.num).map((x) => [String(x.num), x]));
    const invList = numbered(/^invoice$/i);
    const invGaps = invList.length >= 10 ? gapsOf(invList) : null;
    add({
      id: 'invoiceGaps', group: 'revenue', severity: 'high', title: 'Skipped invoice numbers',
      status: invGaps ? undefined : 'na',
      summary: invGaps ? (invGaps.length ? `${invGaps.reduce((t, g) => t + g.count, 0)} invoice number${invGaps.reduce((t, g) => t + g.count, 0) === 1 ? '' : 's'} missing from the sequence. Each one is an invoice that was deleted or never recorded; ask what happened to it.` : `Invoice numbers ${invList[0][0]} to ${invList[invList.length - 1][0]} run without gaps.`) : 'Invoices in this export are not numbered in sequence.',
      columns: [['Missing numbers', 'range'], ['After an invoice dated', 'after'], ['In the deleted report', 'deleted']],
      items: (invGaps || []).map((g) => ({ range: g.count === 1 ? `#${g.from}` : `#${g.from} to #${g.to}`, after: g.after, count: g.count, deleted: Array.from({ length: g.count }, (_, k) => delNums.get(String(g.from + k))).filter(Boolean).map((x) => `${x.action}${x.when ? ` ${x.when.split(' ')[0]}` : ''}${x.by ? ` by ${x.by}` : ''}`).join('; ') || (deleted ? 'Not listed' : '') })),
    });
    const chkList = numbered(/^(check|bill payment \(check\)|bill payment)$/i);
    const chkGaps = chkList.length >= 10 ? gapsOf(chkList) : null;
    add({
      id: 'checkGaps', group: 'revenue', severity: 'low', title: 'Skipped check numbers',
      status: chkGaps ? undefined : 'na',
      summary: chkGaps ? (chkGaps.length ? `${chkGaps.reduce((t, g) => t + g.count, 0)} check number${chkGaps.reduce((t, g) => t + g.count, 0) === 1 ? '' : 's'} missing. Voided or spoiled checks are normal, but each should be accounted for.` : 'Check numbers run without gaps.') : 'Checks in this export are not numbered in sequence.',
      columns: [['Missing numbers', 'range'], ['After a check dated', 'after']],
      items: (chkGaps || []).map((g) => ({ range: g.count === 1 ? `#${g.from}` : `#${g.from} to #${g.to}`, after: g.after })),
    });
    // Voided invoices, credit memos and discounts given after the fact.
    const voids = new Map(), credits = [];
    for (const t of txns) {
      if (/void/i.test(t.memo || '') && Math.abs(t.amount) < 0.005 && /invoice|sales receipt|payment|deposit/i.test(t.type)) voids.set(`${t.type}|${t.num}|${t.dateStr}`, { date: t.dateStr, type: t.type, num: t.num, name: t.name || t.customer, amount: 0, kind: 'Voided' });
    }
    for (const p of postings) {
      if (p.cls !== 'income' || p.value >= 0) continue;
      if (/credit memo|refund/i.test(p.t.type) || /discount/i.test(p.category) || /discount/i.test(p.t.memo || '')) credits.push({ date: p.t.dateStr, type: p.t.type, num: p.t.num, name: (customerOf(p.t, 'income') || p.t.name || '').split(':')[0], amount: round2(-p.value), kind: /credit memo/i.test(p.t.type) ? 'Credit memo' : /refund/i.test(p.t.type) ? 'Refund' : 'Discount' });
    }
    const creditItems = [...voids.values(), ...credits.filter((c) => c.amount >= 50)].sort((a, b) => b.date.localeCompare(a.date));
    add({
      id: 'voids', group: 'revenue', severity: 'medium', title: 'Voided invoices, credits and discounts',
      summary: creditItems.length ? `${voids.size} voided and ${credits.length} credit or discount entr${credits.length === 1 ? 'y' : 'ies'} (${fmtWhole(credits.reduce((t, c) => t + c.amount, 0))}). Check each has a reason, such as a complaint or a return, and who approved it.` : 'No voided invoices, credit memos or discounts.',
      amount: round2(credits.reduce((t, c) => t + c.amount, 0)),
      columns: [['Date', 'date'], ['What', 'kind'], ['Customer', 'name'], ['No.', 'num'], money('amount', 'Amount')], items: creditItems,
    });
    const delItems = (deleted || []).filter((x) => /invoice|sales receipt|payment|deposit|credit memo|refund/i.test(x.type) || !x.type);
    add({
      id: 'deleted', group: 'revenue', severity: 'high', title: 'Deleted or voided sales and payments',
      status: deleted ? undefined : 'needs',
      summary: !deleted ? 'Needs the Voided/Deleted Transactions report (QuickBooks Desktop: Reports → Accountant & Taxes) or the Audit Log export (QuickBooks Online: Settings → Audit log). Upload it with Add export.'
        : delItems.length ? `${delItems.length} sales or customer payment${delItems.length === 1 ? ' was' : 's were'} deleted or voided (${fmtWhole(delItems.reduce((t, x) => t + x.amount, 0))}). A deleted payment is the classic sign of cash kept off the books.` : 'No sales or customer payments were deleted or voided.',
      amount: deleted ? round2(delItems.reduce((t, x) => t + x.amount, 0)) : null,
      columns: [['Date', 'date'], ['What', 'action'], ['Type', 'type'], ['No.', 'num'], ['Name', 'name'], money('amount', 'Amount'), ['By', 'by']], items: delItems,
    });
    const refunds = txns.filter((t) => /refund/i.test(t.type) && roleOf(accountClass, t.account) === 'cash' && t.amount < 0 && inTtm(t.date)).map((t) => ({ date: t.dateStr, name: t.name || t.customer, amount: round2(-t.amount), how: /check/i.test(t.type) || t.num ? 'Check' : 'Bank' }));
    add({
      id: 'refunds', group: 'revenue', severity: 'medium', title: 'Customer refunds paid out',
      summary: refunds.length ? `${refunds.length} refund${refunds.length === 1 ? '' : 's'} paid to customers in the last 12 months (${fmtWhole(refunds.reduce((t, r) => t + r.amount, 0))}). Confirm each customer asked for it and received it.` : 'No refunds paid to customers in the last 12 months.',
      amount: round2(refunds.reduce((t, r) => t + r.amount, 0)), columns: [['Date', 'date'], ['Customer', 'name'], ['Paid by', 'how'], money('amount', 'Amount')], items: refunds,
    });
    // Dormant high-value customers: billed most months, and in the same months last year, but
    // not at all in the last three.
    const byCust = new Map();
    for (const p of postings) {
      if (p.cls !== 'income' || p.value <= 0) continue;
      const c = (customerOf(p.t, 'income') || p.t.name || '').split(':')[0].trim();
      if (!c) continue;
      const e = byCust.get(c) || new Map();
      const k = p.t.dateStr.slice(0, 7);
      e.set(k, (e.get(k) || 0) + p.value);
      byCust.set(c, e);
    }
    const yearAgo = last3.map((k) => addMonthsKey(k, -12));
    const streetOf = new Map();
    if (opts.routes) for (const s of opts.routes.streets) for (const n of s.names) streetOf.set(n, s);
    const dormant = [];
    if (last3.length === 3) {
      for (const [c, m] of byCust) {
        const before = [...m.keys()].filter((k) => k < last3[0]);
        // Regular: billed in at least half of the year before. One-off projects for a repeat
        // customer are not a relationship that stopped.
        const yearBefore = before.filter((k) => k >= addMonthsKey(last3[0], -12));
        if (yearBefore.length < 6 || last3.some((k) => m.has(k)) || yearAgo.filter((k) => m.has(k)).length < 2) continue;
        const lastBilled = before.sort().pop();
        const monthly = [...m.values()].reduce((t, v) => t + v, 0) / m.size;
        const st = streetOf.get(c);
        dormant.push({ name: c, lastBilled: monthLabel(lastBilled), monthly: round2(monthly), yearly: round2(monthly * Math.min(12, before.length)), street: st ? `${st.street}${st.count > 1 ? ` (${st.count - 1} other customer${st.count === 2 ? '' : 's'} still there)` : ''}` : '' });
      }
    }
    dormant.sort((a, b) => b.yearly - a.yearly);
    add({
      id: 'dormant', group: 'revenue', severity: 'high', title: 'Regular customers who stopped being billed',
      status: last3.length === 3 ? undefined : 'na',
      summary: dormant.length ? `${dormant.length} long-time customer${dormant.length === 1 ? '' : 's'} billed most months, and in these same months last year, had no invoices in the last three months (about ${fmtWhole(dormant.reduce((t, d) => t + d.yearly, 0))} a year). Confirm they left; if crews still go there, they may be served on the side.` : 'Every regular customer billed this time last year is still being billed.',
      amount: round2(dormant.reduce((t, d) => t + d.yearly, 0)),
      columns: [['Customer', 'name'], ['Last billed', 'lastBilled'], money('monthly', 'Usual month'), money('yearly', 'Per year'), ['Street', 'street']], items: dormant,
    });
    const und = result.balanceSheet && result.balanceSheet.available ? result.balanceSheet.items.filter((x) => /undeposited/i.test(x.kind) && !isCleared(x.review)) : [];
    add({
      id: 'undeposited', group: 'revenue', severity: 'medium', title: 'Customer payments not deposited',
      status: result.balanceSheet && result.balanceSheet.available ? undefined : 'na',
      summary: und.length ? und.map((x) => x.detail).join(' ') : 'Payments recorded as received have all reached the bank.',
      amount: und.length ? round2(und.reduce((t, x) => t + Math.abs(x.amount), 0)) : null,
      columns: [['Account', 'account'], money('amount', 'Amount')], items: und.map((x) => ({ account: x.account, amount: round2(Math.abs(x.amount)) })),
    });

    // ---- Purchasing and materials
    const jobs = new Map();
    for (const p of postings) {
      const job = p.t.customer && p.t.customer.includes(':') ? p.t.customer : '';
      if (!job) continue;
      const j = jobs.get(job) || { job, revenue: 0, materials: 0 };
      if (p.cls === 'income') j.revenue += p.value; else if (p.cls === 'cogs') j.materials += p.value;
      jobs.set(job, j);
    }
    const jobRows = [...jobs.values()].filter((j) => j.materials > 0).map((j) => ({ job: j.job.replace(':', ' › '), revenue: round2(j.revenue), materials: round2(j.materials), ratio: j.revenue > 0 ? j.materials / j.revenue : null }));
    const badJobs = jobRows.filter((j) => j.materials >= 1000 && (j.ratio == null || j.ratio >= 0.6)).sort((a, b) => b.materials - b.revenue - (a.materials - a.revenue));
    add({
      id: 'jobCosts', group: 'purchasing', severity: 'medium', title: 'Jobs where materials outran the price',
      status: jobRows.length >= 3 ? undefined : 'na',
      summary: jobRows.length < 3 ? 'Costs are not tracked by customer and job, so materials cannot be compared with what each job brought in.'
        : badJobs.length ? `${badJobs.length} job${badJobs.length === 1 ? '' : 's'} where materials were 60% or more of the price, or billed nothing at all. Materials bought for one job and used elsewhere, or never used, show up here.` : 'Materials stayed well under the price on every job.',
      amount: round2(badJobs.reduce((t, j) => t + Math.max(0, j.materials - j.revenue * 0.35), 0)),
      columns: [['Job', 'job'], money('revenue', 'Billed'), money('materials', 'Materials'), ['Materials / billed', 'ratio', 'pct']], items: badJobs,
      chart: jobRows.sort((a, b) => b.materials - a.materials).slice(0, 15),
    });
    const vendMonths = new Map();
    for (const p of spend) {
      if (WAGE_ACCOUNT.test(p.category) || PAYROLL_TAX_ACCOUNT.test(p.category)) continue;
      const v = who(p.t);
      if (!v || PAYROLL_PROVIDER.test(v)) continue;
      const m = vendMonths.get(v) || new Map();
      const k = p.t.dateStr.slice(0, 7);
      m.set(k, (m.get(k) || 0) + p.value);
      vendMonths.set(v, m);
    }
    const spikes = [];
    for (const [v, m] of vendMonths) {
      const prior = [...m.entries()].filter(([k]) => last3.length && k < last3[0]).map(([, x]) => x).sort((a, b) => a - b);
      if (prior.length < 6) continue;
      const med = prior[Math.floor(prior.length / 2)];
      for (const k of last3) {
        const x = m.get(k) || 0;
        if (x >= 2000 && x >= med * 3 && x - med >= 1500) spikes.push({ vendor: v, month: monthLabel(k), spent: round2(x), usual: round2(med), times: x / med });
      }
    }
    spikes.sort((a, b) => b.spent - b.usual - (a.spent - a.usual));
    add({
      id: 'vendorSpikes', group: 'purchasing', severity: 'medium', title: 'Sudden jumps in spending with a vendor',
      status: last3.length === 3 ? undefined : 'na',
      summary: spikes.length ? `${spikes.length} month${spikes.length === 1 ? '' : 's'} where spending with an established vendor ran three times its usual level or more. Check the jobs it went to, and that the goods arrived.` : 'Spending with each regular vendor stayed in its normal range over the last three months.',
      amount: round2(spikes.reduce((t, s) => t + s.spent - s.usual, 0)),
      columns: [['Vendor', 'vendor'], ['Month', 'month'], money('spent', 'Spent'), money('usual', 'Usual month'), ['Times usual', 'times', 'times']], items: spikes,
    });
    const jc = result.jobCosts;
    // Vendors whose materials are usually put on a job. Stock bought in bulk for many jobs (salt,
    // mulch by the truckload) is never tagged, so only untagged buys from the others stand out.
    const tagRate = new Map();
    for (const p of spend) {
      if (p.cls !== 'cogs') continue;
      const v = who(p.t);
      const e = tagRate.get(v) || { tagged: 0, all: 0 };
      e.all += p.value; if (p.t.customer) e.tagged += p.value;
      tagRate.set(v, e);
    }
    const usuallyTagged = (v) => { const e = tagRate.get(v); return e && e.tagged / e.all >= 0.5; };
    const noJob = jc && jc.mode === 'tracked' ? jc.items.filter((x) => !isCleared(x.review) && x.cost >= 100 && (!ttm || x.dateStr >= isoDate(ttm.start)) && usuallyTagged(x.vendor)).map((x) => ({ date: x.dateStr, vendor: x.vendor, cost: x.cost })) : [];
    add({
      id: 'materialsNoJob', group: 'purchasing', severity: 'medium', title: 'Materials bought with no job',
      status: jc && jc.mode === 'tracked' ? undefined : 'na',
      summary: jc && jc.mode === 'tracked' ? (noJob.length ? `${noJob.length} purchase${noJob.length === 1 ? '' : 's'} (${fmtWhole(noJob.reduce((t, x) => t + x.cost, 0))}) from vendors whose materials usually go on a job, with no job this time. Purchases with no job are the easiest to divert.` : 'Materials from job vendors are assigned to jobs. Bulk stock (salt, mulch by the load) is left out.') : 'Jobs are not tracked consistently enough to check.',
      amount: jc && jc.mode === 'tracked' ? round2(noJob.reduce((t, x) => t + x.cost, 0)) : null,
      columns: [['Date', 'date'], ['Vendor', 'vendor'], money('cost', 'Amount')], items: noJob,
    });
    // Look-alike vendor names.
    const vNames = [...vendMonths.keys()];
    const totals = new Map(vNames.map((v) => [v, [...vendMonths.get(v).values()].reduce((t, x) => t + x, 0)]));
    const pairs = [];
    for (let i = 0; i < vNames.length; i++) {
      for (let j = i + 1; j < vNames.length; j++) {
        const a = vendorKey(vNames[i]), b = vendorKey(vNames[j]);
        if (a.length < 5 || b.length < 5 || Math.abs(a.length - b.length) > 3) continue;
        if (a === b || (Math.min(a.length, b.length) >= 6 && similarity(a, b) >= 0.88)) pairs.push({ a: vNames[i], b: vNames[j], totalA: round2(totals.get(vNames[i])), totalB: round2(totals.get(vNames[j])) });
      }
    }
    add({
      id: 'lookalikes', group: 'purchasing', severity: 'medium', title: 'Look-alike vendor names',
      summary: pairs.length ? `${pairs.length} pair${pairs.length === 1 ? '' : 's'} of vendors with nearly the same name. Often a duplicate entry, but a copycat vendor is a common way to send payments to the wrong place.` : 'No two vendors have confusingly similar names.',
      columns: [['Vendor', 'a'], money('totalA', 'Paid'), ['Look-alike', 'b'], money('totalB', 'Paid')], items: pairs,
    });
    // New vendors paid only by check or transfer, with few payments.
    const employees = new Set();
    if (opts.employees) for (const e of opts.employees.employees) employees.add(lower(e.name));
    for (const t of txns) if (/paycheck|payroll check/i.test(t.type) && t.name && !PAYROLL_PROVIDER.test(t.name)) employees.add(lower(t.name));
    const firstSeen = new Map(), payments = new Map();
    for (const p of spend) {
      const v = who(p.t);
      if (!v || WAGE_ACCOUNT.test(p.category) || OVERTIME_ACCOUNT.test(p.category) || PAYROLL_TAX_ACCOUNT.test(p.category)) continue;
      if (!firstSeen.has(v) || p.t.dateStr < firstSeen.get(v)) firstSeen.set(v, p.t.dateStr);
      const e = payments.get(v) || [];
      e.push(p);
      payments.set(v, e);
    }
    const settledFrom = addMonthsKey(range.first ? isoDate(range.first).slice(0, 7) : '2000-01', 6);
    const limits = [2500, 5000, ...(opts.receiptLimit > 0 ? [opts.receiptLimit] : [])];
    const justUnder = (x) => limits.some((L) => x >= L * 0.95 && x < L);
    const ghosts = [];
    for (const [v, list] of payments) {
      const first = firstSeen.get(v);
      if (first.slice(0, 7) < settledFrom || !inTtm(new Date(`${first}T00:00:00Z`)) || list.length > 6 || PAYROLL_PROVIDER.test(v) || employees.has(lower(v))) continue;
      const byBank = list.every((p) => roleOf(accountClass, p.t.split) === 'cash' || /check|bill payment/i.test(p.t.type));
      const total = list.reduce((t, p) => t + p.value, 0);
      if (!byBank || total < 1500) continue;
      const reasons = [];
      if (list.filter((p) => p.value % 50 === 0).length >= Math.ceil(list.length / 2)) reasons.push('round amounts');
      if (list.some((p) => justUnder(p.value))) reasons.push('just under a limit');
      if (employees.has(lower(v)) || [...employees].some((e) => e.split(' ').pop().length > 3 && lower(v).includes(e.split(' ').pop()))) reasons.push('name matches an employee');
      if (list.length < 2 && !reasons.includes('name matches an employee')) continue;
      if (!reasons.length && total < 5000) continue;
      ghosts.push({ vendor: v, first, count: list.length, total: round2(total), reasons: reasons.join(', ') || 'new, paid by check only' });
    }
    ghosts.sort((a, b) => b.total - a.total);
    add({
      id: 'ghosts', group: 'purchasing', severity: 'high', title: 'New vendors paid only by check',
      summary: ghosts.length ? `${ghosts.length} vendor${ghosts.length === 1 ? '' : 's'} first paid this year, only by check or transfer, with few payments. Confirm each is a real business: a W-9, an address that is not an employee's, and work you can point to.` : 'No new vendors with that pattern.',
      amount: round2(ghosts.reduce((t, g) => t + g.total, 0)),
      columns: [['Vendor', 'vendor'], ['First paid', 'first'], ['Payments', 'count', 'num'], money('total', 'Total'), ['Why', 'reasons']], items: ghosts,
    });
    // A bill that is about the same every month (insurance, a lease) is not being split.
    const steady = (v) => {
      const list = (payments.get(v) || []).map((p) => p.value).sort((a, b) => a - b);
      if (list.length < 6) return false;
      const med = list[Math.floor(list.length / 2)];
      return list.filter((x) => Math.abs(x - med) <= med * 0.1).length / list.length >= 0.7;
    };
    const under = spendTtm.filter((p) => justUnder(p.value) && !PAYROLL_PROVIDER.test(who(p.t)) && !WAGE_ACCOUNT.test(p.category) && !PAYROLL_TAX_ACCOUNT.test(p.category) && !NOT_PURCHASE.test(p.category) && !steady(who(p.t))).map((p) => ({ date: p.t.dateStr, vendor: who(p.t), amount: round2(p.value), limit: fmtWhole(limits.filter((L) => p.value >= L * 0.95 && p.value < L)[0]) }));
    // Splitting leaves a cluster just below the limit and nothing just above it; a vendor whose
    // bills simply vary lands on both sides.
    const justOver = (x) => limits.some((L) => x >= L && x < L * 1.05);
    const underVendors = new Map();
    for (const u of under) underVendors.set(u.vendor, (underVendors.get(u.vendor) || 0) + 1);
    const overVendors = new Set(spendTtm.filter((p) => justOver(p.value)).map((p) => who(p.t)));
    const underFlag = under.filter((u) => underVendors.get(u.vendor) >= 3 && !overVendors.has(u.vendor));
    add({
      id: 'justUnder', group: 'purchasing', severity: 'medium', title: 'Payments just under a limit',
      summary: underFlag.length ? `${underFlag.length} payments just below ${limits.map(fmtWhole).join(' or ')} to the same vendor${new Set(underFlag.map((u) => u.vendor)).size === 1 ? '' : 's'}. Amounts kept under a receipt or approval limit can be split purchases.` : `No vendor was paid three or more times just under ${limits.map(fmtWhole).join(' or ')}.`,
      amount: round2(underFlag.reduce((t, u) => t + u.amount, 0)),
      columns: [['Date', 'date'], ['Vendor', 'vendor'], money('amount', 'Amount'), ['Just under', 'limit']], items: underFlag,
    });

    // ---- Fuel and cards
    const shop = (p) => GAS_STATION.test(who(p.t)) || FLEET_CARD.test(who(p.t)) || SUPPLY_STORE.test(who(p.t)) || /fuel|gas(oline)?\b|diesel/i.test(p.category);
    const offDays = [];
    let saturdays = 0;
    for (const p of spendTtm) {
      if (!shop(p)) continue;
      const dow = p.t.date.getUTCDay();
      const hol = usHoliday(p.t.dateStr);
      if (dow === 6 && !hol) saturdays++;
      if (dow === 0 || hol) offDays.push({ date: p.t.dateStr, day: hol || 'Sunday', vendor: who(p.t), amount: round2(p.value) });
    }
    add({
      id: 'offDays', group: 'cards', severity: 'medium', title: 'Fuel and hardware bought on Sundays and holidays',
      summary: offDays.length ? `${offDays.length} fuel or hardware purchase${offDays.length === 1 ? '' : 's'} on Sundays or holidays in the last 12 months, when crews are usually off${saturdays ? ` (and ${saturdays} on Saturdays, normal if crews work them)` : ''}. Ask who made them and for which job. QuickBooks does not record the time of day, so late-night purchases can't be checked.` : `No fuel or hardware purchases on Sundays or holidays.${saturdays ? ` ${saturdays} on Saturdays.` : ''}`,
      amount: round2(offDays.reduce((t, x) => t + x.amount, 0)),
      columns: [['Date', 'date'], ['Day', 'day'], ['Vendor', 'vendor'], money('amount', 'Amount')], items: offDays.sort((a, b) => b.date.localeCompare(a.date)),
    });
    const byVendAmounts = new Map();
    for (const p of spendTtm) {
      // Card and cash purchases only: a check paying a dealer's repair invoice is often round.
      if (p.value < 20 || p.value > 1000 || /check|bill/i.test(p.t.type) || !(shop(p) || PURCHASE_ACCOUNT.test(p.category)) || NOT_PURCHASE.test(p.category)) continue;
      const v = who(p.t);
      if (!v) continue;
      const e = byVendAmounts.get(v) || [];
      e.push(p.value);
      byVendAmounts.set(v, e);
    }
    let roundAll = 0, countAll = 0;
    const roundVendors = [];
    for (const [v, list] of byVendAmounts) {
      const same = Math.max(...[...new Set(list)].map((x) => list.filter((y) => y === x).length));
      if (list.length >= 3 && same / list.length >= 0.7) continue; // fixed bills: rent, leases, subscriptions
      const r = list.filter((x) => Math.abs(x % 10) < 0.005);
      roundAll += r.length; countAll += list.length;
      // Card charges almost always carry cents, so three or more exact tens from one vendor stand
      // out even among many ordinary charges.
      if (r.length >= 3 && r.length / list.length >= 0.1) roundVendors.push({ vendor: v, round: r.length, of: list.length, total: round2(r.reduce((t, x) => t + x, 0)) });
    }
    roundVendors.sort((a, b) => b.total - a.total);
    add({
      id: 'roundDollar', group: 'cards', severity: 'medium', title: 'Round-dollar charges',
      summary: roundVendors.length ? `${roundVendors.length} vendor${roundVendors.length === 1 ? '' : 's'} with several charges in exact round amounts ($80.00, $100.00). Real fuel and supply purchases rarely land on whole tens; round amounts often point to made-up receipts or filling personal tanks.` : `Round amounts are ${countAll ? fmtPct(roundAll / countAll) : 'none'} of variable charges, which is normal.`,
      amount: round2(roundVendors.reduce((t, x) => t + x.total, 0)),
      columns: [['Vendor', 'vendor'], ['Round charges', 'round', 'num'], ['Of', 'of', 'num'], money('total', 'Round total')], items: roundVendors,
    });
    // Over $150 and well over the usual fill-up here: diesel trucks and mowers run bigger bills.
    const fills = spendTtm.filter((p) => GAS_STATION.test(who(p.t)) && !FLEET_CARD.test(who(p.t))).map((p) => p.value).sort((a, b) => a - b);
    const fuelCap = Math.max(150, fills.length ? fills[Math.floor(fills.length / 2)] * 2.5 : 0);
    const bigFuel = spendTtm.filter((p) => GAS_STATION.test(who(p.t)) && !FLEET_CARD.test(who(p.t)) && p.value > fuelCap).map((p) => ({ date: p.t.dateStr, vendor: who(p.t), amount: round2(p.value) }));
    add({
      id: 'bigFuel', group: 'cards', severity: 'medium', title: 'Fill-ups bigger than a truck tank',
      summary: bigFuel.length ? `${bigFuel.length} single gas station charge${bigFuel.length === 1 ? '' : 's'} over ${fmtWhole(fuelCap)}, more than a pickup's tank holds and well over the usual fill-up. Could be cans for equipment, or fuel for personal vehicles.` : `No single gas station charge over ${fmtWhole(fuelCap)}.`,
      amount: round2(bigFuel.reduce((t, x) => t + x.amount, 0)), columns: [['Date', 'date'], ['Station', 'vendor'], money('amount', 'Amount')], items: bigFuel,
    });
    // First digits of expense amounts against the pattern real spending follows (Benford).
    // One of each amount per vendor, so a monthly bill repeated twelve times counts once.
    const seenAmt = new Set();
    const firsts = spend.filter((p) => p.value >= 10 && !WAGE_ACCOUNT.test(p.category) && !PAYROLL_TAX_ACCOUNT.test(p.category) && !seenAmt.has(`${who(p.t)}|${p.value}`) && seenAmt.add(`${who(p.t)}|${p.value}`)).map((p) => +String(Math.floor(p.value)).charAt(0)).filter((d) => d >= 1);
    let benford = null;
    if (firsts.length >= 300) {
      const digits = Array.from({ length: 9 }, (_, i) => ({ digit: i + 1, expected: Math.log10(1 + 1 / (i + 1)), actual: firsts.filter((d) => d === i + 1).length / firsts.length }));
      const mad = digits.reduce((t, d) => t + Math.abs(d.actual - d.expected), 0) / 9;
      benford = { digits, mad, n: firsts.length };
    }
    add({
      id: 'benford', group: 'cards', severity: 'low', title: 'Unusual number patterns',
      status: benford ? (benford.mad > 0.04 ? 'found' : 'clean') : 'na',
      summary: !benford ? 'Needs at least 300 expenses to test.' : benford.mad > 0.04 ? `The first digits of ${benford.n} expense amounts stray from the natural pattern (more 1s than 9s) that real spending follows. Not proof of anything: it can come from a few large repeat purchases. Worth a look if other checks also found something.` : `The first digits of ${benford.n} expense amounts follow the natural pattern real spending shows.`,
      columns: [['First digit', 'digit', 'num'], ['Expected', 'expected', 'pct'], ['Actual', 'actual', 'pct']], items: benford && benford.mad > 0.04 ? benford.digits : [], chart: benford ? benford.digits : null,
    });

    // ---- Payroll
    const wages = postings.filter((p) => (p.cls === 'expense' || p.cls === 'cogs') && (WAGE_ACCOUNT.test(p.category) || OVERTIME_ACCOUNT.test(p.category) || /bonus/i.test(p.category)) && !PAYROLL_TAX_ACCOUNT.test(p.category) && inTtm(p.t.date));
    const perDay = new Map();
    for (const p of wages) perDay.set(p.t.dateStr, (perDay.get(p.t.dateStr) || 0) + 1);
    const runDays = new Set([...perDay.entries()].filter(([, n]) => n >= 3).map(([d]) => d));
    for (const p of wages) if (PAYROLL_PROVIDER.test(who(p.t) || p.t.name || '')) runDays.add(p.t.dateStr);
    const manual = wages.filter((p) => !runDays.has(p.t.dateStr) || /bonus/i.test(p.category) || /bonus|manual|adjust/i.test(p.t.memo || '')).map((p) => ({ date: p.t.dateStr, type: p.t.type, name: who(p.t) || p.t.name || '', memo: p.t.memo || '', amount: round2(p.value) }));
    add({
      id: 'manualPayroll', group: 'payroll', severity: 'high', title: 'Payroll outside the regular runs',
      status: wages.length ? undefined : 'na',
      summary: !wages.length ? 'No payroll in the books.' : manual.length ? `${manual.length} wage or bonus entr${manual.length === 1 ? 'y' : 'ies'} outside the regular payroll dates (${fmtWhole(manual.reduce((t, x) => t + x.amount, 0))}): manual checks, journal entries or bonuses. Each needs an approval from the owner.` : 'All wages were paid on the regular payroll dates.',
      amount: round2(manual.reduce((t, x) => t + x.amount, 0)),
      columns: [['Date', 'date'], ['Type', 'type'], ['Name', 'name'], ['Memo', 'memo'], money('amount', 'Amount')], items: manual,
    });
    const empPays = [];
    if (employees.size) {
      const m = new Map();
      for (const t of txns) {
        if (!inTtm(t.date) || roleOf(accountClass, t.account) !== 'cash' || t.amount >= 0 || /paycheck|payroll|liabilit/i.test(t.type) || /payroll|wage/i.test(t.split || '')) continue;
        const n = lower(t.name || '');
        if (!employees.has(n)) continue;
        const e = m.get(t.name) || { name: t.name, count: 0, total: 0, last: '' };
        e.count++; e.total += -t.amount; if (t.dateStr > e.last) e.last = t.dateStr;
        m.set(t.name, e);
      }
      for (const e of m.values()) empPays.push({ ...e, total: round2(e.total) });
    }
    add({
      id: 'employeePayments', group: 'payroll', severity: 'high', title: 'Payments to employees outside payroll',
      status: employees.size ? undefined : 'needs',
      summary: !employees.size ? 'Needs employee names: upload the payroll Employee Details report (or the payroll provider\'s employee list) with Add export.'
        : empPays.length ? `${empPays.length} employee${empPays.length === 1 ? '' : 's'} paid by check or transfer outside payroll (${fmtWhole(empPays.reduce((t, e) => t + e.total, 0))}). Reimbursements need receipts; anything else should go through payroll.` : 'No employee was paid outside payroll.',
      amount: round2(empPays.reduce((t, e) => t + e.total, 0)),
      columns: [['Employee', 'name'], ['Payments', 'count', 'num'], money('total', 'Total'), ['Last', 'last']], items: empPays,
    });
    const shared = [];
    if (opts.employees) {
      const g = new Map();
      for (const e of opts.employees.employees) {
        if (!e.account) continue;
        const k = `${e.routing}|${e.account}`;
        g.set(k, [...(g.get(k) || []), e.name]);
      }
      for (const [k, names] of g) if (names.length > 1) shared.push({ account: `Routing ${k.split('|')[0] ? `…${k.split('|')[0].slice(-4)}` : '?'}, account …${k.split('|')[1]}`, employees: names.join(', ') });
    }
    add({
      id: 'sharedAccounts', group: 'payroll', severity: 'high', title: 'Employees paid into the same bank account',
      status: opts.employees ? undefined : 'needs',
      summary: !opts.employees ? 'Needs the employee list with direct deposit details (masked account numbers are fine): the payroll Employee Details report, or your payroll provider\'s employee export.'
        : shared.length ? `${shared.length} bank account${shared.length === 1 ? ' receives' : 's receive'} pay for more than one employee. Family members can share an account, but this is also how a made-up employee gets paid.` : 'Every employee is paid into a different bank account.',
      columns: [['Bank account', 'account'], ['Employees', 'employees']], items: shared,
    });

    const found = checks.filter((c) => c.status === 'found');
    const score = Math.min(100, found.reduce((t, c) => t + FRAUD_WEIGHT[c.severity], 0));
    return {
      checks, score, level: score >= 40 ? 'high' : score >= 15 ? 'moderate' : 'low',
      found: found.length, clean: checks.filter((c) => c.status === 'clean').length, needs: checks.filter((c) => c.status === 'needs').length,
      amount: round2(found.reduce((t, c) => t + (c.amount || 0), 0)), window: ttm ? `${isoDate(ttm.start)} to ${isoDate(ttm.end)}` : '',
    };
  }

  // ---------------------------------------------------------------- free health check

  // A short teaser report: how many problems and how many dollars, never which transactions,
  // customers or vendors. The full review has the details and the fixes.
  function healthCheckFacts(result) {
    const a = result.audit;
    const cleared = (x) => isCleared(x && x.review);
    const sum = (list, f) => round2(list.reduce((t, x) => t + Math.abs(f(x) || 0), 0));
    const books = [];
    const add = (list, key, count, amount, title, why) => { if (count > 0) list.push({ key, count, amount: amount != null ? round2(amount) : null, title, why }); };
    add(books, 'uncategorized', a.open.uncategorized, a.uncategorizedOpenTotal, 'Uncategorized transactions', 'Money in or out with no account, so it is missing from the profit and loss and from tax deductions.');
    add(books, 'duplicates', a.open.duplicates, a.duplicateOpenExposure, 'Possible duplicate charges', 'The same charge or bill entered twice, overstating expenses or paying a vendor twice.');
    add(books, 'miscoded', a.open.mismatches, null, 'Entries coded to the wrong place', 'Transactions whose account, payee or amount does not fit the pattern of the books.');
    const bs = result.balanceSheet && result.balanceSheet.available ? result.balanceSheet.items.filter((x) => !cleared(x)) : [];
    add(books, 'balance', bs.length, sum(bs, (x) => x.amount), 'Balance sheet problems', 'Accounts with balances that should not be there, such as undeposited payments, overpaid cards or old open invoices.');
    const rc = result.receipts ? result.receipts.items.filter((x) => x.status === 'Missing' && !cleared(x)) : [];
    add(books, 'receipts', rc.length, sum(rc, (x) => x.amount), 'Receipts missing', 'Expenses the IRS expects a receipt for, such as meals, travel and large purchases.');
    const un = result.unusual ? [...result.unusual.flux, ...result.unusual.txns].filter((x) => !cleared(x)) : [];
    add(books, 'unusual', un.length, null, 'Unusual activity to confirm', 'New payees, one-off amounts and accounts that jumped from the usual pattern.');

    const money = [];
    const vp = result.vendors && result.vendors.prices;
    if (vp && vp.rows.length) add(money, 'prices', vp.rows.length, vp.annualIncrease, 'Vendor price increases', 'Suppliers and services that raised their prices, a cost per year worth reviewing.');
    const subs = result.subs ? result.subs.list.filter((x) => (x.flags || []).some((f) => /overlapping/i.test(f.kind || f))) : [];
    if (subs.length) add(money, 'subs', subs.length, sum(subs, (x) => x.annualized), 'Overlapping software subscriptions', 'Paying for more than one tool that does the same job, per year.');

    const land = [];
    const L = result.landscape;
    if (L) {
      if (L.contracts) {
        add(land, 'missed', L.contracts.missed.length, L.contracts.missedTotal, 'Contract invoices not sent', 'Customers billed every month who were not billed in a recent month.');
        add(land, 'stale', L.contracts.stale.length, L.contracts.staleYearly, 'Contract prices not raised in a year or more', 'Extra income per year from a 5% increase on these contracts.');
      }
      if (L.serviceLines && L.serviceLines.losing.length) add(land, 'losing', L.serviceLines.losing.length, sum(L.serviceLines.losing, (x) => x.net), 'Service lines losing money', 'Loss over the last 12 months after each line\'s share of overhead.');
      const pb = L.playbook;
      if (pb) {
        const c = playbookCost(pb);
        if (pb.fuel.stops >= 12) add(land, 'fuel', pb.fuel.stops, c.fuelCost, 'Crew fuel stops at gas stations', `About ${c.fuelHours} crew hours a year in wages, most of which fuel kept at the shop saves.`);
        if (pb.supply.runs >= 12) add(land, 'supply', pb.supply.runs, c.runCost, 'Trips to hardware and supply stores', `About ${c.runHours} crew hours a year in wages; stocking common items saves the trips.`);
        if (pb.fees.total >= 100) add(land, 'fees', pb.fees.count, pb.fees.total, 'Vendor delivery and restocking fees', 'Flat per-ticket charges that regular vendors often waive.');
      }
      if (L.equipment && L.equipment.capitalize.length) add(land, 'equipment', L.equipment.capitalize.length, sum(L.equipment.capitalize, (x) => x.amount), 'Equipment recorded as an expense', 'Machines that belong on the balance sheet and may qualify for depreciation or Section 179.');
      if (L.offSeason && L.offSeason.low.cash < L.offSeason.cushion) land.push({ key: 'winter', count: null, amount: round2(L.offSeason.needed), title: 'Winter cash shortfall', why: `Cash is on track to fall below a safe cushion in ${L.offSeason.low.label}. A plan for the slow months covers it.` });
    }

    const cash = result.cash;
    const be = result.breakeven;
    const cushion = be ? Math.round(be.base.fixed / 1000) * 1000 : 0;
    const cashLine = cash ? (cash.firstNegative ? `Cash is projected to run out in the week of ${niceDate(cash.firstNegative.start)} without action.`
      : cash.lowest.ending < cushion ? `Cash is projected to dip below one month of expenses in the week of ${niceDate(cash.lowest.start)}.`
        : 'Cash looks steady for the next 13 weeks.') : '';
    const bookItems = books.reduce((t, x) => t + x.count, 0);
    const bookDollars = round2(books.reduce((t, x) => t + (x.amount || 0), 0));
    const yearly = round2([...money, ...land].filter((x) => ['prices', 'subs', 'stale', 'fuel', 'supply', 'fees'].includes(x.key)).reduce((t, x) => t + (x.amount || 0), 0));
    return {
      health: a.healthScore, ties: result.tieOut ? result.tieOut.ties : null, books, money, land, cashLine,
      bookItems, bookDollars, yearly, landscaper: !!L, period: result.period,
    };
  }

  function buildHealthCheck(result, opts) {
    opts = opts || {};
    const firm = firmOf(opts);
    const client = opts.clientName || result.meta.company || 'Your business';
    const f = healthCheckFacts(result);
    const today = new Date().toISOString().slice(0, 10);
    const by = signature(opts);
    const tile = (label, value, sub, tone) => `<div class="tile ${tone || ''}"><div class="tl">${esc(label)}</div><div class="tv">${esc(value)}</div><div class="ts">${esc(sub)}</div></div>`;
    const rows = (list) => `<table><thead><tr><th>What we found</th><th class="n">How many</th><th class="n">Amount</th></tr></thead><tbody>${list.map((x) => `<tr><td><strong>${esc(x.title)}</strong><br><span class="small">${esc(x.why)}</span></td><td class="n">${x.count == null ? '' : esc(String(x.count))}</td><td class="n">${x.amount ? esc(fmtWhole(x.amount)) : ''}</td></tr>`).join('')}</tbody></table>`;
    const h = [];
    h.push(`<header><div class="head-text"><div class="brand">${esc(firm.name || opts.preparer || 'Books health check')}</div><h1>${esc(client)}</h1><div class="meta">Free books health check · ${esc(f.period.start)} to ${esc(f.period.end)} · prepared ${esc(today)}${firm.name ? (opts.preparer ? ` by ${esc(opts.preparer)}` : '') : by ? ` by ${esc(by)}` : ''}</div></div>${firm.logo ? `<img class="logo" src="${esc(firm.logo)}" alt="${esc(firm.name || 'Logo')}">` : ''}</header>`);
    const headline = f.bookItems
      ? `We found ${f.bookItems} item${f.bookItems === 1 ? '' : 's'} to fix in your books${f.bookDollars ? `, involving ${fmtWhole(f.bookDollars)}` : ''}.`
      : 'Your books look clean. Nice work.';
    h.push(`<section><p class="lead">${esc(headline)}${f.yearly ? ` We also found ideas worth about ${esc(fmtWhole(f.yearly))} a year.` : ''}</p></section>`);
    h.push('<section class="tiles">');
    h.push(tile('Books health score', `${f.health}/100`, f.health >= 85 ? (f.bookItems ? 'Mostly in good shape' : 'In good shape') : f.health >= 65 ? 'Needs some cleanup' : 'Needs attention', f.health >= 85 ? 'good' : f.health >= 65 ? 'warn' : 'bad'));
    h.push(tile('Items to fix', String(f.bookItems), f.bookDollars ? `Involving ${fmtWhole(f.bookDollars)}` : 'Nothing open', f.bookItems ? 'warn' : 'good'));
    if (f.ties != null) h.push(tile('Matches QuickBooks', f.ties ? 'Yes' : 'Not yet', f.ties ? 'Ties to the Profit and Loss' : 'Totals differ from the Profit and Loss', f.ties ? 'good' : 'bad'));
    if (f.yearly) h.push(tile('Savings and income ideas', fmtWhole(f.yearly), 'Per year', ''));
    h.push('</section>');
    if (f.books.length) h.push(`<section class="keep"><h2>In your books</h2>${rows(f.books)}</section>`);
    if (f.land.length) h.push(`<section class="keep"><h2>For your landscaping business</h2>${rows(f.land)}</section>`);
    if (f.money.length) h.push(`<section class="keep"><h2>Costs worth a look</h2>${rows(f.money)}</section>`);
    if (f.cashLine) h.push(`<section class="keep"><h2>Cash</h2><p>${esc(f.cashLine)}</p></section>`);
    const covers = [
      'Every item above listed by date, vendor and amount, with how to fix it',
      'Your 13-week cash forecast and what to do about low weeks',
      'Profit by customer, job and service, and where margins are slipping',
      'Vendor, subscription and price-increase review',
      ...(f.landscaper ? ['Which contract customers to bill and re-price, and by how much', 'Your winter cash plan: what to set aside each busy month', 'Route density: which streets to fill in with neighbor discounts', 'Your profit playbook: fuel, supply runs, vendor terms and crew time'] : []),
      'Fixed asset and depreciation schedule, tax set-aside and loan readiness',
      'A month-end close so the books stay clean',
    ];
    h.push(`<section class="keep cta"><h2>Get the full review</h2><p>This check shows how much we found, not where. The full review shows each item and how to fix it, plus:</p><ul class="check">${covers.map((c) => `<li>${esc(c)}</li>`).join('')}</ul><p><strong>To get it, contact ${esc(by || firm.name || 'us')}${firm.website ? ` at <a href="${esc(firm.href)}">${esc(firm.website)}</a>` : ''}.</strong></p></section>`);
    if (firm.name || firm.website) h.push(`<div class="firm">${esc(by || firm.name)}${firm.website ? ` · <a href="${esc(firm.href)}">${esc(firm.website)}</a>` : ''}</div>`);
    h.push('<footer>Figures come from your QuickBooks exports, reviewed privately; your files are not uploaded anywhere. Items are leads for review, not confirmed errors. Savings figures are estimates.</footer>');
    const css = `${reportCss(firm)}
      .lead { font-size: 17px; font-weight: 600; margin: 4px 0 14px; }
      .cta { margin-top: 24px; padding: 14px 16px; border: 2px solid ${firm.color}; border-radius: 10px; }
      .cta h2 { margin-top: 0; color: ${firm.color}; }
      ul.check { padding-left: 20px; margin: 6px 0 10px; } ul.check li { margin: 3px 0; }`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(client)}: books health check</title><style>${css}</style></head><body><main>${h.join('\n')}</main></body></html>`;
  }

  function buildHtmlReport(result, opts) {
    opts = opts || {};
    const firm = firmOf(opts);
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
    const by = signature(opts);
    h.push(`<header><div class="head-text"><div class="brand">${esc(firm.name || opts.preparer || 'Financial review')}</div><h1>${esc(client)}</h1><div class="meta">${full ? 'Full financial review' : 'Financial summary'} · ${esc(result.period.start)} to ${esc(result.period.end)} · prepared ${esc(today)}${firm.name ? (opts.preparer ? ` by ${esc(opts.preparer)}` : '') : by ? ` by ${esc(by)}` : ''}</div></div>${firm.logo ? `<img class="logo" src="${esc(firm.logo)}" alt="${esc(firm.name || 'Logo')}">` : ''}</header>`);
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
    // Landscapers: the profit playbook's measured items, valued at the default crew assumptions.
    const pb = result.landscape && result.landscape.playbook;
    if (pb) {
      const c = playbookCost(pb);
      const ideas = [];
      if (pb.fuel.stops >= 12) ideas.push(`${pb.fuel.stops} fuel stops at gas stations in the last 12 months cost about ${c.fuelHours} crew hours (${fmtWhole(c.fuelCost)} in wages). Fuel kept at the shop, or the crew lead filling up before or after the shift, saves most of that.`);
      if (pb.supply.runs >= 12) ideas.push(`${pb.supply.runs} small trips to hardware and supply stores cost about ${c.runHours} crew hours (${fmtWhole(c.runCost)}). Stocking spare tools and daily-use items, bought in bulk, saves the trips.`);
      if (pb.fees.total >= 100) ideas.push(`${fmtWhole(pb.fees.total)} went to delivery, freight and restocking fees. Ask regular vendors to drop per-ticket charges.`);
      const big = pb.vendors.find((v) => v.advice && v.total >= 20000);
      if (big) ideas.push(`${fmtWhole(big.total)} was spent with ${big.vendor} in the last 12 months: ${big.advice.toLowerCase()}.`);
      if (pb.customers.newCount && pb.customers.perCustomer) ideas.push(`${pb.customers.newCount} new customers came in, about ${fmtWhole(pb.customers.perCustomer)} of advertising each. Mailing the neighborhood after each signed project, and referral discounts, bring in more at a lower cost.`);
      if (ideas.length) h.push(`<section><h2>Ideas to save time and money</h2><ul class="points">${ideas.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></section>`);
    }
    if (qItems.length) {
      const shown = qItems.slice(0, full ? qItems.length : 8);
      h.push(`<section><h2>What we need from you</h2><p>${qItems.length} question${qItems.length === 1 ? '' : 's'} so we can finish the books.${shown.length < qItems.length ? ` The first ${shown.length} are below; we will send the rest separately.` : ''}</p><ol class="steps">${shown.map((q) => `<li>${esc(q)}</li>`).join('')}</ol></section>`);
    }

    if (full) {
      h.push('<h2 class="part">Details</h2>');
      if (tie) h.push(`<section class="keep"><h3>Ties to QuickBooks (${esc(tie.period)})</h3>${table(['Line', 'QuickBooks', 'This review', 'Difference'], tie.lines.map((l) => [l.label, fmtMoney(l.quickbooks), fmtMoney(l.ledgerLens), l.ties ? 'Ties' : fmtMoney(l.diff)]))}</section>`);
      const bsc = result.balanceSheet;
      if (bsc && bsc.available && bsc.items.length) h.push(`<section class="keep"><h3>Balance sheet check (as of ${esc(bsc.asOf)})</h3>${table(['Issue', 'Account', 'Amount', 'Status'], bsc.items.map((x) => [x.kind, x.account, fmtMoney(x.amount), x.review ? REVIEW_STATUSES[x.review.status] || 'Open' : 'Open']))}</section>`);
      const cls = result.closed;
      if (cls && cls.changedMonths) h.push(`<section class="keep"><h3>Changes to closed months</h3><p>Books were closed through ${esc(monthLabel(cls.through))} on ${esc(String(cls.takenAt).slice(0, 10))}. Since then:</p>${table(['Month', 'New or edited', 'Removed or edited', 'Accounts that moved'], cls.months.map((m) => [m.label, String(m.added.length), String(m.removed), m.accounts.slice(0, 4).map((a) => `${a.account} ${a.diff > 0 ? '+' : ''}${fmtMoney(a.diff)}`).join('; ')]))}</section>`);
      const jcs = result.jobCosts;
      if (jcs && jcs.mode === 'tracked' && (jcs.items.length || jcs.jobs.length)) h.push(`<section class="keep"><h3>Job costing gaps</h3><p>${esc(fmtPct(jcs.taggedShare))} of job costs are assigned to a customer; ${esc(fmtMoney(jcs.untaggedTotal))} is not.</p>${table(['Issue', 'Vendor / job', 'Date', 'Amount'], [...jcs.items.map((x) => ['No job', x.vendor, x.dateStr, fmtMoney(x.cost)]), ...jcs.jobs.map((x) => [x.kind, x.name, '', fmtMoney(x.kind === 'Billing, no costs' ? x.revenue : x.cost)])])}</section>`);
      h.push(`<section><h3>Profitability by customer</h3>${table(['Customer', 'Revenue', 'Direct cost', 'Gross margin', 'Net margin'], profit.groups.slice(0, 20).map((g) => [g.name, fmtWhole(g.revenue), fmtWhole(g.directCost), fmtPct(g.margin), fmtPct(g.netMargin)]))}</section>`);
      if (cr) h.push(`<section><h3>Customer concentration (${esc(cr.windowLabel)})</h3><p>${esc(cr.top.name)} is ${esc(fmtPct(cr.top1Share))} of revenue; the top 3 are ${esc(fmtPct(cr.top3Share))} (${esc(cr.level.label.toLowerCase())}).</p>${table(['Customer', 'Share', 'Gross margin', 'Open A/R', 'Pays in', 'Flags'], cr.rows.slice(0, 12).map((r) => [r.name, fmtPct(r.share), fmtPct(r.margin), fmtWhole(r.openAR), r.days != null ? `${r.days}d` : '-', r.flags.map((f) => f.kind).join(', ')]))}</section>`);
      const bv = result.budget;
      if (bv && bv.ytdMonths) h.push(`<section class="keep"><h3>Budget vs actual, ${esc(bv.ytdLabel)}</h3>${table(['', 'Budget', 'Actual', 'Difference'], [['Revenue', 'revenue'], ['Costs', 'costs'], ['Net income', 'netIncome']].map(([l, k]) => [l, fmtWhole(bv.totals.budgetYtd[k]), fmtWhole(bv.totals.actualYtd[k]), fmtWhole(bv.totals.actualYtd[k] - bv.totals.budgetYtd[k])]))}${table(['Account', 'Budget', 'Actual', 'Difference'], bv.rows.filter((r) => r.flag).slice(0, 10).map((r) => [r.name, fmtWhole(r.budgetYtd), fmtWhole(r.actualYtd), fmtWhole(r.variance)]))}</section>`);
      if (be) h.push(`<section class="keep"><h3>Break-even</h3>${table(['Measure', 'Per month'], [['Average revenue', fmtWhole(be.base.revenue)], ['Variable costs', fmtWhole(be.base.variable)], ['Fixed costs', fmtWhole(be.base.fixed)], ['Break-even revenue', be.breakEvenRevenue != null ? fmtWhole(be.breakEvenRevenue) : 'n/a'], ['Margin of safety', fmtPct(be.marginOfSafety)]])}</section>`);
      if (vd) {
        h.push(`<section><h3>Largest vendors (${esc(vd.windowLabel)})</h3>${table(['Vendor', 'Per month', 'Share', 'Pays in', 'Type'], vd.rows.slice(0, 10).map((r) => [r.name, fmtWhole(r.monthly), fmtPct(r.share), r.days != null ? `${r.days}d` : '-', r.type]))}</section>`);
        const pr = vd.prices;
        if (pr.rows.length) h.push(`<section class="keep"><h3>Vendor price increases</h3>${table(['Vendor', 'Was', 'Now', 'Since', 'Per year'], pr.rows.map((r) => [r.name, fmtMoney(r.from), fmtMoney(r.to), niceDate(r.since), fmtWhole(r.annualImpact)]))}${pr.priceRiseToHold != null ? `<p class="small">Together about ${esc(fmtWhole(pr.annualIncrease))} a year; covering it without losing profit takes a price rise of about ${esc(fmtPct(pr.priceRiseToHold))}.</p>` : ''}</section>`);
        const yr = [...vd.tax].reverse().find((y2) => y2.full) || vd.tax[vd.tax.length - 1];
        if (yr) h.push(`<section class="keep"><h3>1099 review, ${yr.year}</h3>${table(['Vendor', 'Check / transfer', 'Form', 'Status'], yr.vendors.filter((x) => x.status !== 'Card only').map((x) => [x.vendor, fmtWhole(x.bank), x.form, x.status]))}<p class="small">A screening list; a W-9 settles each case.</p></section>`);
      }
      if (result.subs && result.subs.list.length) h.push(`<section><h3>Software and subscriptions</h3>${table(['Vendor', 'Cadence', 'Per year', 'Flags'], result.subs.list.map((x) => [x.vendor, x.cadence, fmtWhole(x.annualized), x.flags.map((f) => f.kind).join(', ')]))}</section>`);
      if (ln) h.push(`<section class="keep"><h3>Loan readiness</h3><p>Debt service coverage: <strong>${ln.dscr != null ? ln.dscr.toFixed(2) : 'no existing debt'}</strong> (${esc(fmtWhole(ln.cashAvailable))} available for ${esc(fmtWhole(ln.debtService))} of yearly loan payments). Largest new loan at ${ln.target.toFixed(2)}: ${esc(fmtWhole(ln.maxLoan))}.</p>${table(['Check', 'Status', 'Detail'], ln.checks.map((c) => [c.label, c.status === 'pass' ? 'Ready' : c.status === 'warn' ? 'Watch' : 'Fix first', c.detail]), 99)}</section>`);
      if (tx) h.push(`<section class="keep"><h3>Tax set-aside, ${tx.year}</h3><p>Projected profit ${esc(fmtWhole(tx.projectedProfit))}; set aside ${esc(fmtWhole(tx.setAside))} at ${esc(fmtPct(tx.rate))} (${esc(fmtWhole(tx.paid))} paid so far).</p>${table(['Quarter', 'Due', 'Suggested payment'], tx.schedule.filter((q) => q.status === 'Upcoming').map((q) => [q.label, q.due, fmtWhole(q.amount)]), 2)}</section>`);
      const bm = opts.benchmarks;
      if (bm && bm.rows) h.push(`<section class="keep"><h3>Industry benchmarks: ${esc(bm.industry)}${bm.state ? `, ${esc(bm.state)}` : ''}</h3>${table(['Measure', 'Client', 'Peers', 'Read'], bm.rows.map((r) => [r.label, r.company == null ? '-' : r.kind === 'pct' ? fmtPct(r.company) : fmtWhole(r.company), r.peer == null ? '-' : r.kind === 'pct' ? fmtPct(r.peer) : fmtWhole(r.peer), r.read]))}<p class="small">Peer data: ${esc(bm.source)}${bm.periodRange ? `, ${esc(bm.periodRange)}` : ''}.</p></section>`);
    }
    if (firm.name || firm.website) h.push(`<div class="firm">${esc(by || firm.name)}${firm.website ? ` · <a href="${esc(firm.href)}">${esc(firm.website)}</a>` : ''}</div>`);
    h.push(`<footer>Figures come from the client's QuickBooks exports. Flags are leads for review, not confirmed errors. Tax and loan figures are planning estimates, not tax, legal or lending advice.</footer>`);

    const css = reportCss(firm);
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(client)}: ${full ? 'financial review' : 'financial summary'}</title><style>${css}</style></head><body><main>${h.join('\n')}</main></body></html>`;
  }

  // How a ratio reads against what lenders usually look for.
  const LENDER_TESTS = {
    dscr: { label: 'Debt service coverage', target: 1.25, better: 'higher', note: 'Cash available for debt payments ÷ yearly loan payments. SBA and most banks look for 1.25 or more.' },
    proForma: { label: 'Coverage with the new loan', target: 1.25, better: 'higher', note: 'The same test including the requested loan’s payments.' },
    current: { label: 'Current ratio', target: 1.2, better: 'higher', note: 'Current assets ÷ current liabilities. 1.2 or more is usually expected.' },
    quick: { label: 'Quick ratio', target: 1.0, better: 'higher', note: 'Cash and receivables ÷ current liabilities.' },
    leverage: { label: 'Debt to EBITDA', target: 3.0, better: 'lower', note: 'Total debt ÷ earnings before interest, taxes, depreciation and amortization. Under 3 is comfortable for most lenders.' },
  };
  function lenderRead(key, value) {
    const t = LENDER_TESTS[key];
    if (value == null || !isFinite(value)) return 'n/a';
    const ok = t.better === 'higher' ? value >= t.target : value <= t.target;
    const close = t.better === 'higher' ? value >= t.target * 0.9 : value <= t.target * 1.25;
    return ok ? 'Meets' : close ? 'Borderline' : 'Below';
  }

  // The lender-ready package: statements, ratios and a debt schedule laid out the way a bank's
  // underwriter reads them. Review notes (problems to fix first) are only included when asked,
  // for the bookkeeper's own copy; the version for the bank leaves them out.
  function buildLenderReport(result, opts) {
    opts = opts || {};
    const L = result.lender, ln = result.loan;
    if (!L || !ln) return '';
    const firm = firmOf(opts);
    const client = opts.clientName || result.meta.company || 'Client';
    const req = opts.request || {};
    const today = new Date().toISOString().slice(0, 10);
    const by = signature(opts);
    const cols = L.statement.columns;
    const h = [];
    const pill = (read) => `<span class="read ${read === 'Meets' ? 'ok' : read === 'Borderline' ? 'mid' : read === 'Below' ? 'bad' : ''}">${esc(read)}</span>`;
    const ratio = (v, digits) => (v == null || !isFinite(v) ? 'n/a' : `${v.toFixed(digits == null ? 2 : digits)}x`);

    h.push(`<header><div class="head-text"><div class="brand">${esc(firm.name || opts.preparer || 'Financial package')}</div><h1>${esc(client)}</h1><div class="meta">Lender-ready financial package · books through ${esc(L.asOf)} · prepared ${esc(today)}${by ? ` by ${esc(by)}` : ''}</div></div>${firm.logo ? `<img class="logo" src="${esc(firm.logo)}" alt="${esc(firm.name || 'Logo')}">` : ''}</header>`);

    // The request.
    const amount = +req.amount || ln.proposal.amount || 0;
    if (amount || req.purpose || req.lender) {
      h.push(`<section class="keep request"><h2>Loan request</h2>${table(['', ''], [
        amount ? ['Amount requested', fmtWhole(amount)] : null,
        req.purpose ? ['Purpose', req.purpose] : null,
        req.lender ? ['Lender', req.lender] : null,
        amount ? ['Assumed terms', `${ln.proposal.rate.toFixed(2)}% over ${ln.proposal.years} years, about ${fmtWhole(ln.proposal.payment)} a month`] : null,
      ].filter(Boolean), 2)}</section>`);
    }

    // Key measures.
    const measures = [
      ['dscr', ln.dscr, ln.dscr == null ? 'No existing loan payments found' : `${fmtWhole(ln.cashAvailable)} available ÷ ${fmtWhole(ln.debtService)} of payments`],
      amount ? ['proForma', ln.proposal.proForma, `Adds ${fmtWhole(ln.proposal.payment * 12)} a year of payments`] : null,
      ['current', L.ratios.current, L.balance ? `${fmtWhole(L.balance.currentAssets)} ÷ ${fmtWhole(L.balance.currentLiabilities)}` : 'Needs the Transaction Detail by Account export'],
      ['quick', L.ratios.quick, ''],
      ['leverage', L.ratios.leverage, L.balance ? `${fmtWhole(L.balance.totalDebt)} of debt ÷ ${fmtWhole(L.ratios.ebitda)} EBITDA` : ''],
    ].filter(Boolean);
    h.push('<section class="keep"><h2>Key measures lenders test</h2><table><thead><tr><th>Measure</th><th class="n">Result</th><th class="n">Looks for</th><th>Read</th><th>How it is worked out</th></tr></thead><tbody>');
    for (const [key, v, how] of measures) {
      const t = LENDER_TESTS[key];
      h.push(`<tr><td>${esc(t.label)}</td><td class="n">${esc(ratio(v))}</td><td class="n">${t.better === 'higher' ? '≥' : '≤'} ${esc(t.target.toFixed(2))}</td><td>${pill(lenderRead(key, v))}</td><td class="small">${esc(how || t.note)}</td></tr>`);
    }
    h.push('</tbody></table>');
    const ttmKey = cols.some((c) => c.key === 'ttm') ? 'ttm' : cols[cols.length - 1].key;
    const rev = L.statement.totals.income[ttmKey], net = L.statement.totals.net[ttmKey];
    h.push(`<p class="small">${ttmKey === 'ttm' ? 'Last 12 months' : esc(cols[cols.length - 1].label)}: revenue ${esc(fmtWhole(rev))}, net income ${esc(fmtWhole(net))} (${esc(fmtPct(rev ? net / rev : null))} of revenue)${L.balance ? `, working capital ${esc(fmtWhole(L.ratios.workingCapital))}` : ''}. Largest supportable new loan at 1.25 coverage and these terms: about ${esc(fmtWhole(ln.maxLoan))}.</p></section>`);

    // Review notes: only in the bookkeeper's copy.
    if (opts.includeReview && L.issues.length) {
      h.push(`<section class="review"><h2>Review notes (not for the lender)</h2><p class="small">Problems to fix or be ready to explain before sending. Remove this page, or download the lender copy, before it goes out.</p><ol class="steps">${L.issues.map((x) => `<li><strong>${esc(x.title)}</strong> <span class="sev ${x.severity}">${esc(x.severity)}</span><br>${esc(x.detail)}</li>`).join('')}</ol></section>`);
    }

    // Income statement.
    const money = (v) => (Math.abs(v || 0) < 0.5 ? '-' : fmtWhole(v));
    const row = (label, v, cls) => `<tr${cls ? ` class="${cls}"` : ''}><td>${esc(label)}</td>${cols.map((c) => `<td class="n">${money(v[c.key])}</td>`).join('')}</tr>`;
    const head = `<tr><th></th>${cols.map((c) => `<th class="n">${esc(c.label)}</th>`).join('')}</tr>`;
    const st = L.statement;
    const pl = [];
    pl.push(`<tr class="sub"><td colspan="${cols.length + 1}">Income</td></tr>`, ...st.income.map((r) => row(r.name, r.v)), row('Total income', st.totals.income, 'tot'));
    if (st.cogs.length) pl.push(`<tr class="sub"><td colspan="${cols.length + 1}">Cost of goods sold</td></tr>`, ...st.cogs.map((r) => row(r.name, r.v)), row('Total cost of goods sold', st.totals.cogs, 'tot'), row('Gross profit', st.totals.gross, 'tot'));
    pl.push(`<tr class="sub"><td colspan="${cols.length + 1}">Expenses</td></tr>`, ...st.expenses.map((r) => row(r.name, r.v)), row('Total expenses', st.totals.expenses, 'tot'), row('Net income', st.totals.net, 'grand'));
    h.push(`<section><h2>Income statement</h2><table class="stmt"><thead>${head}</thead><tbody>${pl.join('')}</tbody></table><p class="small">Cash basis as recorded in the books; partial years show the months covered.</p></section>`);

    // Cash available for debt service.
    h.push(`<section class="keep"><h2>Cash available for debt service (${esc(ln.windowLabel)})</h2>${table(['', 'Amount'], [
      ['Net income', fmtWhole(ln.netIncome)],
      ['Add back: interest', fmtWhole(ln.interest)],
      ['Add back: depreciation and amortization', fmtWhole(ln.nonCash)],
      ln.addBacks ? ['Add back: other (owner items, one-time costs)', fmtWhole(ln.addBacks)] : null,
      ['Cash available for debt service', fmtWhole(ln.cashAvailable)],
      ['Existing loan payments (principal and interest)', fmtWhole(ln.debtService)],
      ['Debt service coverage', ln.dscr == null ? 'No existing payments' : ratio(ln.dscr)],
    ].filter(Boolean))}</section>`);

    // Balance summary.
    if (L.balance) {
      const b = L.balance;
      const lines = (xs) => xs.map((x) => [x.account, fmtWhole(x.balance)]);
      h.push(`<section class="keep"><h2>Balance summary as of ${esc(b.asOf)}</h2>${table(['Current assets', ''], [...lines(b.assets), ['Total current assets', fmtWhole(b.currentAssets)]])}${table(['Current liabilities', ''], [...lines(b.currentLiabs), ['Total current liabilities', fmtWhole(b.currentLiabilities)]])}${b.longTerm.length ? table(['Long-term debt', ''], [...lines(b.longTerm), ['Total long-term debt', fmtWhole(b.longTermDebt)]]) : ''}<p class="small">From the account balances in the books; fixed assets and equity are not shown. Confirm against the QuickBooks Balance Sheet report for the same date.</p></section>`);
      const loans = [...b.currentLiabs.filter((x) => x.role === 'loan'), ...b.longTerm];
      h.push(`<section class="keep"><h2>Debt schedule</h2>${table(['Lender / account', 'Balance', 'Yearly payments found'], [
        ...loans.map((x) => [x.account, fmtWhole(x.balance), '']),
        ['Total existing debt', fmtWhole(b.totalDebt), fmtWhole(ln.debtService)],
        amount ? ['Requested loan', fmtWhole(amount), fmtWhole(ln.proposal.payment * 12)] : null,
      ].filter(Boolean))}<p class="small">Yearly payments are the principal and interest paid over ${esc(ln.windowLabel)}. Add each loan’s rate, maturity and collateral from the loan statements.</p></section>`);
    }

    // Monthly trend.
    const months = result.trend ? result.trend.months.filter((m) => !m.partial).slice(-12) : [];
    if (months.length >= 3) h.push(`<section class="keep"><h2>Month by month</h2>${table(['Month', 'Revenue', 'Gross profit', 'Net income'], months.map((m) => [m.label, fmtWhole(m.revenue), fmtWhole(m.grossProfit), fmtWhole(m.netIncome)]))}</section>`);

    // Receivables, payables, concentration.
    const cash = result.cash;
    if (cash && cash.ar.buckets) h.push(`<section class="keep"><h2>Receivables aging</h2>${table(['Age', 'Invoices', 'Amount'], [...cash.ar.buckets.map((x) => [x.label, String(x.count), fmtWhole(x.amount)]), ['Total', '', fmtWhole(cash.ar.total)]])}</section>`);
    const vb = result.vendors && result.vendors.buckets;
    if (vb) h.push(`<section class="keep"><h2>Payables aging</h2>${table(['Age', 'Bills', 'Amount'], vb.map((x) => [x.label, String(x.count != null ? x.count : ''), fmtWhole(x.amount)]))}</section>`);
    const cr = result.customers;
    if (cr && cr.rows.length) h.push(`<section class="keep"><h2>Largest customers (${esc(cr.windowLabel)})</h2>${table(['Customer', 'Revenue', 'Share'], cr.rows.slice(0, 5).map((r) => [r.name, fmtWhole(r.revenue), fmtPct(r.share)]))}<p class="small">The top customer is ${esc(fmtPct(cr.top1Share))} of revenue; the top three ${esc(fmtPct(cr.top3Share))}.</p></section>`);

    // What else the lender will ask for.
    h.push(`<section class="keep"><h2>Documents to include</h2><ul class="check"><li>Business tax returns, last 3 years</li><li>Personal tax returns for each owner of 20% or more, last 3 years</li><li>Interim statements for this year (this package)</li><li>Business bank statements, last 3 to 6 months</li><li>Personal financial statement for each owner (SBA Form 413 for SBA loans)</li><li>Debt schedule with rates, maturities and collateral</li><li>Receivables and payables aging (above; full detail from QuickBooks if asked)</li><li>Business licenses, articles of organization, and any leases</li></ul></section>`);

    if (firm.name || firm.website) h.push(`<div class="firm">${esc(by || firm.name)}${firm.website ? ` · <a href="${esc(firm.href)}">${esc(firm.website)}</a>` : ''}</div>`);
    h.push(`<footer>Prepared from the company’s accounting records${firm.name ? ` by ${esc(firm.name)}` : ''}, without audit or review. Figures are as recorded in the books through ${esc(L.asOf)}; ratios are calculated from those figures and are not a lending decision.</footer>`);
    const css = `${reportCss(firm)}
      .read { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; background: ${RC.hair}; }
      .read.ok { background: #e3f3e3; color: #1f6b1f; } .read.mid { background: #fdf3dc; color: #8a5a00; } .read.bad { background: #fbeaea; color: #b02a2a; }
      table.stmt tr.sub td { font-weight: 600; padding-top: 10px; border-bottom: 1px solid ${RC.ink2}; }
      table.stmt tr.tot td { font-weight: 600; } table.stmt tr.grand td { font-weight: 700; border-top: 1.5px solid ${RC.ink}; border-bottom: 3px double ${RC.ink}; }
      section.review { border: 2px solid #b02a2a; border-radius: 8px; padding: 4px 14px 10px; margin-top: 16px; }
      .sev { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; padding: 0 6px; border-radius: 8px; background: ${RC.hair}; }
      .sev.high { background: #fbeaea; color: #b02a2a; } .sev.medium { background: #fdf3dc; color: #8a5a00; }
      ul.check { padding-left: 20px; } ul.check li { margin: 3px 0; }
      .request td:first-child { width: 34%; color: ${RC.ink2}; }
    `;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(client)}: lender package</title><style>${css}</style></head><body><main>${h.join('\n')}</main></body></html>`;
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
    const openOf = (list) => (list || []).filter((x) => !isCleared(x.review));
    const cl = result.closed;
    if (cl && cl.changedMonths) steps.push(`${cl.changedEntries} entr${cl.changedEntries === 1 ? 'y' : 'ies'} in months already closed (${cl.months.map((m) => m.label).join(', ')}) changed after they were reported. We will review each change before accepting it.`);
    const bsItems = result.balanceSheet && result.balanceSheet.available ? openOf(result.balanceSheet.items) : [];
    const uf = bsItems.find((x) => x.kind === 'Undeposited Funds');
    if (uf) steps.push(`Clear ${fmtMoney(uf.amount)} sitting in Undeposited Funds by matching each payment to its bank deposit.`);
    const obe = bsItems.find((x) => x.kind === 'Opening Balance Equity');
    if (obe) steps.push(`Move the ${fmtMoney(obe.amount)} in Opening Balance Equity to the right equity account so the balance sheet is lender-ready.`);
    const otherBs = bsItems.filter((x) => x !== uf && x !== obe);
    if (otherBs.length) steps.push(`Fix ${otherBs.length} other balance sheet item${otherBs.length === 1 ? '' : 's'} (${[...new Set(otherBs.map((x) => x.kind.toLowerCase()))].join(', ')}).`);
    const rc = result.receipts;
    if (rc && rc.open) steps.push(`Send the ${rc.open} missing receipt${rc.open === 1 ? '' : 's'} (meals, travel and large purchases); the IRS expects them for these expenses.`);
    const jc = result.jobCosts;
    if (jc && jc.mode === 'tracked') {
      const untagged = openOf(jc.items);
      if (untagged.length) steps.push(`Assign ${fmtMoney(untagged.reduce((t, x) => t + x.cost, 0))} of job costs (${untagged.length} entr${untagged.length === 1 ? 'y' : 'ies'}) to their jobs so job profit is accurate.`);
      for (const j of openOf(jc.jobs).filter((x) => x.kind === 'Costs, no billing')) steps.push(`${j.name} has ${fmtMoney(j.cost)} of costs and nothing billed yet. Invoice the work, or move the costs to the right customer.`);
    }
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
      const pr = vd.prices;
      if (pr.rows.length && pr.annualIncrease >= 500) steps.push(`Vendor price increases add about ${fmtWhole(pr.annualIncrease)} a year (largest: ${pr.rows[0].name}). Renegotiate or shop around, and check that your own prices keep pace${pr.priceRiseToHold != null ? ` (about ${fmtPct(pr.priceRiseToHold)} covers it)` : ''}.`);
      for (const e of vd.earlyPay) steps.push(`Ask ${e.name} for 30-day terms; paying on day 30 instead of day ${e.days} keeps about ${fmtWhole(e.cashFreed)} more cash on hand.`);
      const yr = [...vd.tax].reverse().find((y) => y.full);
      if (yr && yr.reviewCount) steps.push(`Collect W-9s and prepare 1099s for ${yr.reviewCount} vendor${yr.reviewCount === 1 ? '' : 's'} paid ${fmtWhole(yr.threshold)} or more in ${yr.year}.`);
    }
    if (tx && tx.next && tx.next.amount > 0) steps.push(`Set aside about ${fmtWhole(tx.next.amount)} for the ${tx.next.label} estimated tax payment due ${tx.next.due}.`);
    if (ln && ln.checks.some((c) => c.status === 'fail')) steps.push(`Before applying for financing, get these lender checks to pass: ${ln.checks.filter((c) => c.status === 'fail').map((c) => `"${c.label}"`).join(', ')} (see Tax & lending).`);
    const weak = profit.groups.filter((g) => g.netMargin != null && g.netMargin < 0.1 && g.revenue > 0);
    if (weak.length) steps.push(`Discuss pricing on ${weak.length} low-margin ${opts.groupBy === 'project' ? 'project' : 'customer'}${weak.length > 1 ? 's' : ''}.`);
    return steps;
  }

  function buildReport(result, opts) {
    opts = opts || {};
    const { audit, profit, subs } = result;
    const client = opts.clientName || result.meta.company || 'Client';
    const preparer = signature(opts);
    const firm = firmOf(opts);
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
    if (firm.website) L.push(`               ${firm.website}`);
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
      if (vd.prices.rows.length) {
        L.push('');
        L.push('  Price increases from vendors that charge a steady amount:');
        for (const r of vd.prices.rows) L.push(`    ${pad(r.name, 26)} ${padL(fmtMoney(r.from), 11)} -> ${padL(fmtMoney(r.to), 11)}  since ${niceDate(r.since)}  ${padL(fmtWhole(r.annualImpact), 8)}/yr`);
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

    const bv = result.budget;
    if (bv && bv.ytdMonths) {
      L.push(`14. BUDGET VS ACTUAL (${bv.year}, ${bv.ytdLabel})`);
      L.push(thin);
      L.push(`Budget:                       ${bv.source === 'upload' ? 'QuickBooks budget' : `built from ${bv.basis}`}`);
      L.push(`  ${pad('', 18)} ${padL('Budget', 13)} ${padL('Actual', 13)} ${padL('Difference', 13)}`);
      for (const [label, k] of [['Revenue', 'revenue'], ['Costs', 'costs'], ['Net income', 'netIncome']]) L.push(`  ${pad(label, 18)} ${padL(fmtMoney(bv.totals.budgetYtd[k]), 13)} ${padL(fmtMoney(bv.totals.actualYtd[k]), 13)} ${padL(fmtMoney(bv.totals.actualYtd[k] - bv.totals.budgetYtd[k]), 13)}`);
      L.push(`  On track for ${fmtMoney(bv.outlook.netIncome)} of net income for the year (budget ${fmtMoney(bv.totals.fullYear.netIncome)}).`);
      const flagged = bv.rows.filter((r) => r.flag).slice(0, 8);
      if (flagged.length) {
        L.push('  Largest differences:');
        for (const r of flagged) L.push(`   - ${r.name}: ${fmtMoney(r.variance)} ${r.favorable ? '(favorable)' : '(over budget)'}${r.unbudgeted ? ', not in the budget' : ''}`);
      }
      L.push('');
    }

    const bsc = result.balanceSheet;
    const cls = result.closed;
    if ((bsc && bsc.available && bsc.items.length) || (cls && cls.changedMonths)) {
      L.push(`15. BALANCE SHEET & CLOSED MONTHS${bsc && bsc.available ? ` (as of ${bsc.asOf})` : ''}`);
      L.push(thin);
      if (bsc && bsc.available) {
        if (!bsc.items.length) L.push('  No balance sheet problems found.');
        for (const x of bsc.items) L.push(`  [${x.severity}] ${x.kind}: ${x.detail}${x.review ? ` (${REVIEW_STATUSES[x.review.status] || 'reviewed'})` : ''}`);
      }
      if (cls) {
        L.push(`  Books closed through ${monthLabel(cls.through)} on ${String(cls.takenAt).slice(0, 10)}: ${cls.changedMonths ? `${cls.changedEntries} change(s) since then.` : 'no changes since.'}`);
        for (const m of cls.months) L.push(`   - ${m.label}: ${m.added.length} new or edited, ${m.removed} removed or edited${m.accounts.length ? `; ${m.accounts.slice(0, 4).map((a) => `${a.account} ${a.diff > 0 ? '+' : ''}${fmtMoney(a.diff)}`).join(', ')}` : ''}`);
      }
      L.push('');
    }
    const jcs = result.jobCosts;
    if (jcs && jcs.mode === 'tracked' && (jcs.items.length || jcs.jobs.length)) {
      L.push('16. JOB COSTING GAPS');
      L.push(thin);
      L.push(`  ${fmtPct(jcs.taggedShare)} of job costs are assigned to a customer; ${fmtMoney(jcs.untaggedTotal)} is on no job.`);
      for (const x of jcs.items.slice(0, 15)) L.push(`   - ${x.dateStr}  ${pad(x.vendor || 'No payee', 26)} ${padL(fmtMoney(x.cost), 11)}  ${x.account}${x.suggestion ? ` (likely ${x.suggestion})` : ''}`);
      for (const x of jcs.jobs) L.push(`   - ${x.detail}`);
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
    parseCSV, parseAmount, parseDate, parseTransactions, readExport, classifyAccount,
    findUncategorized, findDuplicates, findMismatches, profitability, subscriptions,
    analyze, detectIndustry, landscapeAnalysis, SERVICE_LINES, playbookCost, PLAYBOOK_TIPS, parseCustomerList, splitAddress, streetKey, routeDensity, assetSchedule, depreciationEntry, parseAssetList, guessAssetCategory, macrsRates, defaultBonus, ASSET_CATEGORIES, TAX_METHODS, buildReport, buildHtmlReport, buildHealthCheck, healthCheckFacts, fraudChecks, usHoliday, parseVoidedDeleted, parseEmployeeList, buildLenderReport, lenderPackage, LENDER_TESTS, lenderRead, unusualActivity, balanceSheetCheck, periodSnapshot, closedPeriodChanges, jobCostGaps, closeChecklist, clientSummary, CLOSE_STEPS, receiptCheck, parseAttachmentList, questionsSheet, parseAnswers, matchAnswers, parseBudget, budgetFromHistory, budgetVsActual, nextSteps, parseProfitAndLoss, tieOut, payeeKeyOf, cleanPayee, payeeOf, loanReadiness, taxPlan, ENTITY, pmt, clientQuestions, clientKey, REVIEW_STATUSES, parsePeriod, parseChartOfAccounts, resolveAccounts, roleOf, logicalRows, cashForecast, breakEven, whatIf, trends, customerRisk, mergeParsed, vendorAnalysis, tax1099, benchmarkInputs, benchmarkRequest, readBenchmark, compareBenchmarks, INDUSTRIES, STATES, BENCH_METRICS, fmtMoney, fmtWhole, fmtPct, counterpartyOf, leafAccount,
  };
});
