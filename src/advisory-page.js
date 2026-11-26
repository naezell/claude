(function () {
  'use strict';
  const Reports = window.LedgerStatements;
  const { readStatement } = window.LedgerFiles;
  const byId = (id) => document.getElementById(id);
  const node = (type, text) => Object.assign(document.createElement(type), { textContent: text });
  const list = (id, entries) => byId(id).replaceChildren(...entries.map((entry) => node('li', entry)));
  const status = (id, message, error = false) => {
    byId(id).textContent = message;
    byId(id).classList.toggle('error', error);
  };
  const request = async (action, data) => {
    const options = data ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : { cache: 'no-store' };
    const response = await fetch('/api/qbo/' + action, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(body.error || 'QuickBooks is awaiting setup.'), { status: response.status });
    return body;
  };

  const now = new Date();
  byId('period').value = new Date(Date.UTC(now.getFullYear(), now.getMonth() - 1, 1)).toISOString().slice(0, 7);
  const briefNote = (message, error) => status('brief-status', message, error);
  const qboNote = (message, error) => status('qbo-status', message, error);
  let companies = [];

  function showBrief(brief, name) {
    const currency = (value) => Reports.money(value, brief.currency);
    const fmt = (value) => value == null ? 'Unavailable' : currency(value);
    const move = (value) => (value < 0 ? 'down ' : 'up ') + currency(Math.abs(value));
    const periodName = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(brief.period + '-01T00:00:00Z'));
    byId('brief-title').textContent = name ? name + ' · Executive brief' : 'Monthly executive brief';
    byId('brief-period').textContent = periodName + (brief.basis ? ' · ' + brief.basis + ' basis' : '');
    byId('brief-numbers').replaceChildren(...[
      ['Sales', fmt(brief.revenue)], ['Net profit', fmt(brief.profit)],
      ['Gross margin', brief.grossMargin == null ? 'Unavailable' : (brief.grossMargin * 100).toFixed(1) + '%'],
      ['Cash at month-end', fmt(brief.endingCash)],
    ].map(([label, value]) => {
      const item = document.createElement('div');
      item.append(node('dt', label), node('dd', value));
      return item;
    }));
    const cash = brief.flows.map((f) => f.label + ' ' + (f.amount === 0 ? 'broke even.' : (f.amount < 0 ? 'used ' : 'brought in ') + currency(Math.abs(f.amount)) + '.'));
    if (brief.cashDelta != null) cash.unshift(brief.cashDelta ? 'Bank balances ended the month ' + move(brief.cashDelta) + '.' : 'Bank balances ended the month unchanged.');
    if (!brief.flows.length) cash.push('A Statement of Cash Flows is needed to explain where cash moved.');
    list('brief-cash', cash);
    const changes = brief.anomalies.map((row) => row.name + ' was ' + move(row.amount) + '.');
    if (brief.marginDelta != null) {
      const diff = Math.abs(brief.marginDelta * 100).toFixed(1);
      changes.unshift(Number(diff) === 0 ? 'Gross margin held steady.' : `Gross margin ${brief.marginDelta < 0 ? 'fell' : 'rose'} ${diff} percentage points.`);
    } else if (brief.profitDelta == null) changes.push('Add last month’s P&L to compare margins and flag big changes.');
    if (brief.profitDelta != null) changes.unshift(brief.profitDelta ? 'Net profit was ' + move(brief.profitDelta) + '.' : 'Net profit was unchanged.');
    list('brief-changes', changes);
    list('brief-actions', brief.actions);
    byId('brief-preview').hidden = false;
    byId('brief-title').focus();
  }

  async function generate(control, task) {
    control.disabled = true;
    byId('brief-preview').hidden = true;
    briefNote('Preparing the executive brief…');
    try { await task(); briefNote('Your executive brief is ready.'); }
    catch (e) { briefNote(e.message, true); }
    finally { control.disabled = false; }
  }

  byId('brief-form').addEventListener('submit', (event) => {
    event.preventDefault();
    generate(event.submitter, async () => {
      const period = byId('period').value;
      const fields = ['current', 'balance', 'prior', 'priorBalance', 'cashFlow'];
      const inputs = await Promise.all(fields.map((id) => readStatement(byId(id).files[0])));
      const brief = Reports.fromUploads({ period, ...Object.fromEntries(fields.map((id, index) => [id, inputs[index]])) });
      showBrief(brief, byId('report-name').value.trim());
    });
  });
  byId('pull-brief').addEventListener('click', (event) => {
    if (!byId('period').reportValidity()) return;
    const realm = byId('brief-company').value;
    generate(event.currentTarget, async () => {
      const { brief } = await request('brief', { realm, period: byId('period').value });
      showBrief(brief, byId('report-name').value.trim() || companies.find((c) => c.realm === realm)?.name || '');
    });
  });
  byId('print-brief').addEventListener('click', () => window.print());

  function companyPanel(company) {
    const panel = document.createElement('article');
    const date = document.createElement('input');
    date.type = 'date';
    date.value = company.reconciledThrough;
    const label = node('label', 'Reconciled through');
    label.append(date);
    const row = document.createElement('div');
    row.className = 'row';
    const detail = company.last;
    const caption = detail
      ? `Checked ${detail.date}. ${detail.count == null ? 'Posted count unavailable.' : `${detail.count} posted uncategorized transactions in 30 days, compared with ${detail.previous} in the prior 30 days.`}`
      : 'Waiting for the first check.';
    const actions = [
      ['Save date', async () => { await request('reconciliation', { realm: company.realm, date: date.value }); return 'Reconciliation date saved.'; }],
      ['Check now', async () => { await request('scan', { realm: company.realm }); return 'Check finished.'; }],
      ['Disconnect', async () => {
        if (!window.confirm('Disconnect ' + company.name + ' from Ledger Lens?')) return '';
        await request('disconnect', { realm: company.realm });
        return 'Company disconnected.';
      }],
    ];
    row.append(label, ...actions.map(([title, run]) => {
      const button = node('button', title);
      button.addEventListener('click', async () => {
        button.disabled = true;
        try { const note = await run(); if (note) { await refreshCompanies(); qboNote(note); } }
        catch (e) { qboNote(e.message, true); }
        finally { button.disabled = false; }
      });
      return button;
    }));
    const issues = document.createElement('ul');
    const flags = [...(detail?.flags || [])];
    if (!company.reconciledThrough) flags.push('Reconciliation date has not been recorded.');
    issues.append(...flags.map((flag) => node('li', flag)));
    panel.append(node('h3', company.name), node('p', caption));
    if (flags.length) panel.append(issues);
    panel.append(row);
    return panel;
  }

  async function refreshCompanies() {
    ({ companies } = await request('connections'));
    const old = byId('brief-company').value;
    byId('brief-company').replaceChildren(...companies.map((company) => Object.assign(node('option', company.name), { value: company.realm })));
    if (companies.some((c) => c.realm === old)) byId('brief-company').value = old;
    byId('brief-connect').hidden = !companies.length;
    byId('chaser-start').hidden = !companies.length;
    byId('connect').hidden = false;
    byId('company-list').replaceChildren(...companies.map(companyPanel));
  }

  byId('connect').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try { location.assign((await request('start', {})).url); }
    catch (e) { qboNote(e.message, true); button.disabled = false; }
  });

  const callback = new URL(location.href).searchParams.get('qbo');
  refreshCompanies().then(() => qboNote(callback === 'failed' ? 'QuickBooks authorization did not complete. Try connecting the company again.' : callback === 'connected' ? 'QuickBooks company connected.' : companies.length ? '' : 'Connect a QuickBooks company to get started.', callback === 'failed'),
    (e) => qboNote(e.message, true));
})();
