/* Statement-only workflows share the Ledger Lens CSV parser and amount handling. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./csv-input.js'), require('./engine.js'));
  else root.LedgerStatements = factory(root.LedgerCSV, root.LedgerEngine);
})(typeof self !== 'undefined' ? self : this, function (Input, Engine) {
  'use strict';

  const money = (value, currency = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value);
  const validCurrency = (value) => /^[A-Z]{3}$/.test(value || '') ? value : 'USD';
  const cents = (value) => Math.round(value * 100) / 100;
  const key = (text) => String(text).trim().toLowerCase().replace(/\s+/g, ' ');
  const month = (date) => new Date(date).toISOString().slice(0, 7);

  function monthRange(value) {
    if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(value || '')) throw new Error('Choose a reporting month.');
    const [year, number] = value.split('-').map(Number);
    const date = (offset, day) => new Date(Date.UTC(year, number - 1 + offset, day)).toISOString().slice(0, 10);
    return { start: date(0, 1), end: date(1, 0), priorStart: date(-1, 1), priorEnd: date(0, 0) };
  }

  function summaryRows(text) {
    return Input.parseCSV(text).map((cells) => {
      const label = cells[0]?.trim() || '';
      const amounts = cells.slice(1).map(Input.parseAmount);
      return { label, amount: [...amounts].reverse().find((v) => v != null), cells };
    }).filter((row) => row.label);
  }

  function qboRows(report) {
    const result = [];
    const visit = (rows, parents) => {
      for (const row of rows?.Row || []) {
        const header = row.Header?.ColData?.[0]?.value;
        if (row.type === 'Section') {
          const sections = header ? [...parents, header] : parents;
          visit(row.Rows, sections);
          if (row.Summary) {
            const [label, amount] = row.Summary.ColData || [];
            if (label?.value) result.push({ label: label.value, amount: Input.parseAmount(amount?.value), parents, group: row.group, summary: true });
          }
        } else {
          const [label, amount] = row.ColData || [];
          if (label?.value) result.push({ label: label.value, accountId: label.id, amount: Input.parseAmount(amount?.value), parents, group: row.group });
        }
      }
    };
    visit(report?.Rows, []);
    return result;
  }

  function csvProfit(text, range, expectedMonth) {
    const profit = Engine.parseProfitAndLoss(text);
    if (!profit) throw new Error('Choose a standard QuickBooks Profit and Loss report.');
    const header = Input.parseCSV(text).slice(0, 10).find((cells) => cells.some((c) => key(c) === 'total'));
    if (header && header.slice(1).filter((c) => c.trim()).length > 1) throw new Error('Export each month separately with Display columns by set to Total only.');
    if (profit.period && (new Date(profit.period.start).toISOString().slice(0, 10) !== range[0] || new Date(profit.period.end).toISOString().slice(0, 10) !== range[1])) {
      throw new Error(`The P&L dates do not cover the full month of ${expectedMonth}.`);
    }
    return profit;
  }

  function qboProfit(report) {
    const rows = qboRows(report);
    const find = (pattern) => rows.find((row) => pattern.test(key(row.label)))?.amount;
    const totals = { income: find(/^total income$/), cogs: find(/^total cost of (goods sold|sales)$/), grossProfit: find(/^gross profit$/), netIncome: find(/^net income$/) };
    if (totals.netIncome == null) throw new Error('QuickBooks did not return a complete Profit and Loss report.');
    const sections = { income: 'income', 'cost of goods sold': 'cogs', 'cost of sales': 'cogs', expenses: 'expenses', 'other income': 'otherIncome', 'other expenses': 'otherExpenses' };
    const accounts = rows.filter((r) => !r.summary && r.amount != null && r.parents.some((p) => sections[key(p)]))
      .map((r) => ({ name: r.parents.length > 1 ? [...r.parents.slice(1), r.label].join(': ') : r.label, amount: r.amount, section: sections[key(r.parents.find((p) => sections[key(p)]))] }));
    return { totals, accounts, basis: report.Header?.ReportBasis?.toLowerCase() || null, currency: report.Header?.Currency };
  }

  function cashAtClose(rows) {
    const bank = rows.find((r) => /^(total (for )?)?(bank accounts|cash and cash equivalents)$/.test(key(r.label)) && r.amount != null);
    return bank?.amount ?? null;
  }

  function cashMovement(rows) {
    const labels = { operating: 'Day-to-day operations', investing: 'Investing and equipment', financing: 'Loans and owner funding' };
    return Object.entries(labels).flatMap(([type, label]) => {
      const row = rows.find((r) => new RegExp('^net cash (provided|used).*' + type + '|^net cash (from|for) ' + type, 'i').test(r.label));
      if (row?.amount != null) return [{ label, amount: row.amount }];
      const group = rows.find((r) => r.summary && key(r.group) === type + 'activities');
      if (group?.amount == null) return [];
      if (type !== 'operating' || !/^total adjustments/i.test(group.label)) return [{ label, amount: group.amount }];
      const net = rows.find((r) => r.group === 'NetIncome' || (/^net income$/i.test(r.label) && r.parents?.some((p) => /^operating activities/i.test(p))));
      return net?.amount == null ? [] : [{ label, amount: cents(net.amount + group.amount) }];
    });
  }

  function csvBalance(text, p, expectedClose) {
    const rows = summaryRows(text);
    if (!rows.some((r) => /^(total (for )?)?assets$/.test(key(r.label))) || !rows.some((r) => /liabilities|equity/i.test(r.label))) {
      throw new Error('Choose a standard QuickBooks Balance Sheet report.');
    }
    const info = rows.slice(0, 8).map((r) => r.label);
    const header = info.find((line) => /^as of\s/i.test(line));
    const statementDate = header ? new Date(header.replace(/^as of\s/i, '') + ' UTC') : null;
    if (statementDate && !Number.isNaN(statementDate.getTime()) && statementDate.toISOString().slice(0, 10) !== expectedClose) {
      throw new Error('The Balance Sheet date does not match the selected month-end.');
    }
    const title = info.findIndex((line) => /^balance sheet$/i.test(line));
    if (title > 0 && p.company && key(info[title - 1]) !== key(p.company)) throw new Error('The Balance Sheet and P&L show different company names.');
    return rows;
  }

  function executiveBrief({ current, prior, balance, priorBalance, cashFlow, period, currency }) {
    currency = validCurrency(currency || current.currency);
    if (current.basis && prior?.basis && current.basis !== prior.basis) throw new Error('Use the same accounting basis for both P&L reports.');
    const totals = current.totals;
    const before = prior?.totals;
    const revenue = totals.income ?? (totals.grossProfit == null ? null : totals.grossProfit + (totals.cogs || 0));
    const priorRevenue = before?.income ?? (before?.grossProfit == null ? null : before.grossProfit + (before.cogs || 0));
    const gross = totals.grossProfit ?? (revenue == null ? null : revenue - (totals.cogs || 0));
    const priorGross = before?.grossProfit ?? (priorRevenue == null ? null : priorRevenue - (before.cogs || 0));
    const grossMargin = revenue > 0 ? gross / revenue : null;
    const priorMargin = priorRevenue > 0 ? priorGross / priorRevenue : null;
    const marginDelta = grossMargin == null || priorMargin == null ? null : grossMargin - priorMargin;
    const profitDelta = before ? cents(totals.netIncome - before.netIncome) : null;
    const endingCash = cashAtClose(balance || []);
    const beginningCash = cashAtClose(priorBalance || []);
    const cashDelta = endingCash == null || beginningCash == null ? null : cents(endingCash - beginningCash);
    const flows = cashMovement(cashFlow || []);
    const changes = new Map();
    for (const [pnl, sign] of [[current, 1], [prior, -1]]) {
      for (const row of pnl?.accounts || []) {
        const id = row.section + '|' + key(row.name);
        const existing = changes.get(id) || { name: row.name, section: row.section, amount: 0 };
        existing.amount += sign * row.amount;
        changes.set(id, existing);
      }
    }
    const anomalies = prior ? [...changes.values()].map((r) => ({ ...r, amount: cents(r.amount) }))
      .filter((r) => Math.abs(r.amount) >= 1).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount)).slice(0, 3) : [];
    const actions = [];
    if (marginDelta != null && marginDelta <= -0.01) actions.push('Compare labor and materials on recent jobs with the prices you quoted. Start with any jobs that went over budget.');
    if ((cashDelta != null && cashDelta < 0) || flows.some((f) => f.label === 'Day-to-day operations' && f.amount < 0)) actions.push('Review overdue customer invoices and line up collections against the bills and payroll due next.');
    const costing = anomalies.find((a) => !/income/i.test(a.section) && a.amount > 0);
    if (costing) actions.push(`Review the increase in ${costing.name.slice(0, 65)}. Check whether it is a one-time expense or a higher cost to plan for next month.`);
    if (actions.length < 2 && !flows.length) actions.push('Review the Statement of Cash Flows to see how much cash moved through operations, equipment purchases, and financing.');
    if (actions.length < 2) actions.push('Pick one figure from this brief to check at next month’s close and agree on who will follow up.');
    if (actions.length < 2) actions.push('Compare the next month’s sales and direct job costs with this month before adjusting prices or staffing.');
    return { period, currency, basis: current.basis, revenue, profit: totals.netIncome, profitDelta, grossMargin, marginDelta, endingCash, cashDelta, flows, anomalies, actions: actions.slice(0, 3) };
  }

  function fromUploads({ period, current, prior, balance, priorBalance, cashFlow }) {
    const r = monthRange(period);
    const p = csvProfit(current, [r.start, r.end], period);
    const compare = prior ? csvProfit(prior, [r.priorStart, r.priorEnd], month(r.priorStart)) : null;
    if (compare?.company && p.company && key(p.company) !== key(compare.company)) throw new Error('The two P&L reports show different company names.');
    return executiveBrief({ current: p, prior: compare, balance: csvBalance(balance, p, r.end), priorBalance: priorBalance ? csvBalance(priorBalance, p, r.priorEnd) : [], cashFlow: cashFlow ? summaryRows(cashFlow) : [], period });
  }

  const HOLDING = /ask my accountant|uncategori[sz]ed|suspense|to be classified/i;
  const CONTRA = /accumulated (depreciation|amortization)|allowance for|discount on|contra/i;
  function normalSide(name, kind) {
    if (/(asset|bank|receivable|inventory)/i.test(kind)) return 'debit';
    if (/(liabilit|credit card|payable)/i.test(kind)) return 'credit';
    if (kind) return '';
    if (/receivable|checking|savings|^inventory$|cash on hand|^fixed assets?$|^equipment$/i.test(name)) return 'debit';
    if (/payable|credit card|sales tax (due|owed)|loan payable/i.test(name)) return 'credit';
    return '';
  }

  function trialCsv(text) {
    const rows = Input.parseCSV(text);
    const h = rows.findIndex((r) => r.map(key).includes('debit') && r.map(key).includes('credit'));
    if (h < 0) throw new Error('Choose a QuickBooks Trial Balance export with Debit and Credit columns.');
    const fields = rows[h].map(key);
    const debit = fields.indexOf('debit');
    const credit = fields.indexOf('credit');
    const acct = fields.findIndex((s) => /^(account|account name|distribution account)$/.test(s));
    const kind = fields.findIndex((s) => /^account type$|^type$/.test(s));
    const names = rows.slice(h + 1).flatMap((r) => {
      const name = r[acct < 0 ? 0 : acct]?.trim();
      const d = Input.parseAmount(r[debit]), c = Input.parseAmount(r[credit]);
      return name && !/^total\b/i.test(name) && (d != null || c != null) ? [{ name, amount: cents((d || 0) - (c || 0)), side: normalSide(name, r[kind] || '') }] : [];
    });
    if (!names.length) throw new Error('The Trial Balance has no readable account balances.');
    return names;
  }

  function cleanupScore(accounts, { monthsBehind = null, currency = 'USD' } = {}) {
    currency = validCurrency(currency);
    const odd = accounts.filter((a) => a.side && !CONTRA.test(a.name) && !HOLDING.test(a.name) && (a.side === 'debit' ? a.amount < -0.01 : a.amount > 0.01));
    const holding = accounts.filter((a) => HOLDING.test(a.name) && Math.abs(a.amount) > 0.01);
    const total = cents(holding.reduce((sum, a) => sum + Math.abs(a.amount), 0));
    const score = Math.max(0, 100 - Math.min(30, odd.length * 8) - Math.min(40, holding.length * 8 + (total >= 1000 ? 12 : 0)) - Math.min(30, (monthsBehind || 0) * 10));
    const tier = score < 60 ? 'Extensive cleanup' : score < 85 ? 'Targeted cleanup' : 'Light review';
    return { score, tier, odd: odd.length, tested: accounts.filter((a) => a.side && !CONTRA.test(a.name) && !HOLDING.test(a.name)).length, holding: holding.length, holdingTotal: total, monthsBehind, currency };
  }

  return { monthRange, money, qboRows, qboProfit, executiveBrief, fromUploads, trialCsv, cleanupScore, normalSide, HOLDING };
});
