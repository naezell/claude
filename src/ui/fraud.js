/* Ledger Lens UI: Fraud risk tab, shown for landscapers. Warning signs of theft found in the
 * books (and in two optional reports: Voided/Deleted Transactions and the payroll employee list),
 * grouped the way a crew business loses money: sales that never reach the bank, purchasing,
 * fuel and cards, and payroll. The checks come from fraudChecks() in the engine. */
(function () {
  'use strict';
  const html = htm.bind(React.createElement);
  const { ResponsiveContainer, BarChart, Bar, ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } = Recharts;
  const E = window.LedgerEngine;
  const { fmtMoney, fmtPct } = E;
  const UI = window.LedgerUI;
  const { compactMoney, useTokens, ChartTooltip, wholeMoney, Banner, Arrange } = UI;

  const GROUPS = [
    ['revenue', 'Sales that may not reach the bank', 'Invoices that disappear, credits and refunds, and regular customers who stop being billed: the usual ways cash jobs are kept off the books.'],
    ['purchasing', 'Purchasing and materials', 'Materials bought but not used on the job, sudden jumps with a vendor, and vendors that may not be real.'],
    ['cards', 'Fuel and card spending', 'Company cards used on days off, round amounts, and fill-ups bigger than a truck holds.'],
    ['payroll', 'Payroll', 'Pay that goes around the regular payroll runs, and made-up employees.'],
  ];
  const SEVERITY = { high: ['high', 'High'], medium: ['medium', 'Medium'], low: ['low', 'Low'] };
  const SHOW_ROWS = 25;

  function statusPill(c) {
    if (c.status === 'found') {
      const n = c.items.length;
      return html`<span class=${`pill ${SEVERITY[c.severity][0]}`}><span class="dot"></span>${c.id === 'benford' ? 'Unusual' : `${n} found`}</span>`;
    }
    if (c.status === 'clean') return html`<span class="pill good"><span class="dot"></span>Clear</span>`;
    if (c.status === 'needs') return html`<span class="pill low"><span class="dot"></span>Needs a report</span>`;
    return html`<span class="pill low"><span class="dot"></span>Can't check</span>`;
  }

  function cell(v, kind) {
    if (kind === 'money') return v == null ? '' : fmtMoney(v);
    if (kind === 'pct') return v == null ? 'Nothing billed' : fmtPct(v);
    if (kind === 'times') return v == null ? '' : `${v.toFixed(1)}×`;
    if (kind === 'num') return v == null ? '' : Number(v).toLocaleString('en-US');
    return v == null ? '' : String(v);
  }

  function ItemsTable({ c }) {
    const rows = c.items.slice(0, SHOW_ROWS);
    const right = (kind) => kind === 'money' || kind === 'pct' || kind === 'times' || kind === 'num';
    return html`<div class="table-wrap"><table>
      <thead><tr>${c.columns.map(([label, , kind]) => html`<th key=${label} class=${right(kind) ? 'num' : ''}>${label}</th>`)}</tr></thead>
      <tbody>${rows.map((it, i) => html`<tr key=${i}>${c.columns.map(([label, key, kind]) => html`<td key=${label} class=${right(kind) ? 'num' : key === 'job' || key === 'employees' || key === 'deleted' ? 'names-cell' : ''}>${cell(it[key], kind)}</td>`)}</tr>`)}</tbody>
    </table>${c.items.length > SHOW_ROWS ? html`<p class="hint">And ${c.items.length - SHOW_ROWS} more.</p>` : ''}</div>`;
  }

  // Billed against materials for the jobs with the most materials.
  function JobChart({ data, t }) {
    const rows = data.map((j) => ({ ...j, label: j.job.length > 18 ? `${j.job.slice(0, 17).trimEnd()}…` : j.job, fullName: j.job }));
    return html`<div style=${{ height: 40 + rows.length * 30 }} class="fraud-chart">
      <${ResponsiveContainer} width="100%" height="100%">
        <${BarChart} data=${rows} layout="vertical" margin=${{ top: 4, right: 8, bottom: 0, left: 4 }} barCategoryGap="22%">
          <${CartesianGrid} horizontal=${false} stroke=${t.grid} />
          <${XAxis} type="number" tickFormatter=${compactMoney} tickLine=${false} axisLine=${{ stroke: t.axis }} tick=${{ fill: t.muted, fontSize: 11 }} />
          <${YAxis} type="category" dataKey="label" width=${118} tickLine=${false} axisLine=${false} tick=${{ fill: t.muted, fontSize: 11 }} interval=${0} />
          <${Tooltip} cursor=${{ fill: t.surface2 }} content=${html`<${ChartTooltip} rows=${(d) => [
            { label: 'Billed', value: fmtMoney(d.revenue), color: t.s1 },
            { label: 'Materials', value: fmtMoney(d.materials), color: t.neg },
            { label: 'Materials / billed', value: d.ratio == null ? 'Nothing billed' : fmtPct(d.ratio) },
          ]} />`} />
          <${Legend} wrapperStyle=${{ fontSize: 12 }} />
          <${Bar} dataKey="revenue" name="Billed" fill=${t.s1} isAnimationActive=${false} radius=${[0, 3, 3, 0]} />
          <${Bar} dataKey="materials" name="Materials" fill=${t.neg} isAnimationActive=${false} radius=${[0, 3, 3, 0]} />
        <//>
      <//>
    </div>`;
  }

  // First digits found against the share real spending shows (Benford's pattern).
  function DigitChart({ data, t }) {
    const rows = data.map((d) => ({ ...d, fullName: `First digit ${d.digit}`, actualPct: Math.round(d.actual * 1000) / 10, expectedPct: Math.round(d.expected * 1000) / 10 }));
    return html`<div style=${{ height: 220 }} class="fraud-chart">
      <${ResponsiveContainer} width="100%" height="100%">
        <${ComposedChart} data=${rows} margin=${{ top: 8, right: 8, bottom: 0, left: 4 }}>
          <${CartesianGrid} vertical=${false} stroke=${t.grid} />
          <${XAxis} dataKey="digit" tickLine=${false} axisLine=${{ stroke: t.axis }} tick=${{ fill: t.muted, fontSize: 12 }} />
          <${YAxis} tickFormatter=${(v) => `${v}%`} tickLine=${false} axisLine=${false} tick=${{ fill: t.muted, fontSize: 12 }} width=${40} />
          <${Tooltip} cursor=${{ fill: t.surface2 }} content=${html`<${ChartTooltip} rows=${(d) => [
            { label: 'In these books', value: `${d.actualPct}%`, color: t.s2 },
            { label: 'Natural pattern', value: `${d.expectedPct}%`, color: t.s4 },
          ]} />`} />
          <${Legend} wrapperStyle=${{ fontSize: 12 }} />
          <${Bar} dataKey="actualPct" name="In these books" fill=${t.s2} isAnimationActive=${false} radius=${[3, 3, 0, 0]} />
          <${Line} dataKey="expectedPct" name="Natural pattern" stroke=${t.s4} strokeWidth=${2} dot=${{ r: 3 }} isAnimationActive=${false} />
        <//>
      <//>
    </div>`;
  }

  function Check({ c, t, onAdd }) {
    const sev = SEVERITY[c.severity];
    const showChart = c.chart && c.chart.length > 0 && (c.status === 'found' || c.id === 'benford');
    return html`<li class=${`fraud-check ${c.status}`} data-check=${c.id}>
      <div class="fraud-check-head">
        <div class="fraud-check-title"><strong>${c.title}</strong><span class=${`sev sev-${sev[0]}`}>${sev[1]} risk</span></div>
        <div class="fraud-check-status">${c.status === 'found' && c.amount ? html`<span class="num fraud-amount">${wholeMoney(c.amount)}</span>` : ''}${statusPill(c)}</div>
      </div>
      <p class="fraud-summary">${c.summary}</p>
      ${c.status === 'needs' && onAdd && html`<button class="btn small" onClick=${onAdd}>Add export</button>`}
      ${(c.status === 'found' && c.items.length > 0 && c.id !== 'benford') || showChart ? html`<details class="fraud-details" open=${c.status === 'found' && c.items.length <= 5}>
        <summary>${c.status === 'found' && c.id !== 'benford' ? `Show ${c.items.length === 1 ? 'it' : `the ${c.items.length}`}` : 'Show the chart'}</summary>
        ${showChart && c.id === 'jobCosts' && html`<${JobChart} data=${c.chart} t=${t} />`}
        ${showChart && c.id === 'benford' && html`<${DigitChart} data=${c.chart} t=${t} />`}
        ${c.status === 'found' && c.items.length > 0 && c.id !== 'benford' && html`<${ItemsTable} c=${c} />`}
      </details>` : ''}
    </li>`;
  }

  function Group({ id, title, intro, checks, t, onAdd }) {
    const found = checks.filter((c) => c.status === 'found');
    return html`<section class="panel">
      <div class="panel-head"><h2>${title}</h2><p>${intro}</p></div>
      <div class="panel-body">
        ${found.length
          ? html`<${Banner} level=${found.some((c) => c.severity === 'high') ? 'high' : 'medium'} label=${`${found.length} of ${checks.length}`}>${found.map((c) => c.title).join(' · ')}</${Banner}>`
          : html`<${Banner} level="good" label="Clear">Nothing found${checks.some((c) => c.status === 'needs') ? ' in what could be checked' : ''}.</${Banner}>`}
        <ul class="fraud-checks" data-group=${id}>
          ${checks.map((c) => html`<${Check} key=${c.id} c=${c} t=${t} onAdd=${onAdd} />`)}
        </ul>
      </div>
    </section>`;
  }

  function Reports({ F, onAdd }) {
    const needs = F.checks.filter((c) => c.status === 'needs');
    return html`<section class="panel">
      <div class="panel-head"><h2>Reports that unlock more checks</h2><p>The Transaction Detail can't show what was deleted, or where paychecks are deposited. Two more exports cover that.</p></div>
      <div class="panel-body">
        <ul class="compact-list">
          <li><strong>Voided and deleted transactions.</strong> QuickBooks Online: <strong>Settings (gear) → Audit log</strong>, filter to the last 12 months, then <strong>Export</strong>. QuickBooks Desktop: <strong>Reports → Accountant & Taxes → Voided/Deleted Transactions Summary</strong>, then <strong>Excel → Create new worksheet (CSV)</strong>.${needs.some((c) => c.id === 'deleted') ? '' : html` <span class="pill good"><span class="dot"></span>Added</span>`}</li>
          <li><strong>Employee list with direct deposit.</strong> QuickBooks Payroll: <strong>Reports → Employee Details</strong> (with bank account columns), then <strong>Export</strong>. Gusto: <strong>People → Export</strong>. Masked account numbers (last four digits) are enough.${needs.some((c) => c.id === 'sharedAccounts') ? '' : html` <span class="pill good"><span class="dot"></span>Added</span>`}</li>
        </ul>
        ${needs.length > 0 && onAdd && html`<p><button class="btn" onClick=${onAdd}>Add export</button></p>`}
        <p class="hint">QuickBooks doesn't record the time of day a purchase was made, and who can add vendors is a user setting outside the reports, so those checks are left to a conversation with the owner.</p>
      </div>
    </section>`;
  }

  function FraudTab({ result, onAdd }) {
    const t = useTokens();
    const F = result.fraud;
    if (!F) return html`<section class="panel"><div class="empty">Set the industry to Landscaping (above the tabs) to see these checks.</div></section>`;
    const checkable = F.checks.filter((c) => c.status !== 'needs' && c.status !== 'na').length;
    const levelClass = F.level === 'high' ? 'alert' : '';
    return html`
      <section class="kpis" aria-label="Fraud risk summary">
        <div class=${`kpi ${levelClass}`}><span class="kpi-label">Fraud risk</span><span class="kpi-value">${F.level === 'high' ? 'High' : F.level === 'moderate' ? 'Moderate' : 'Low'}</span><span class="kpi-sub">Score ${F.score} of 100</span></div>
        <div class=${`kpi ${F.found ? 'alert' : ''}`}><span class="kpi-label">Warning signs</span><span class="kpi-value">${F.found}</span><span class="kpi-sub">of ${checkable} checks run</span></div>
        <div class="kpi"><span class="kpi-label">Dollars involved</span><span class="kpi-value">${wholeMoney(F.amount)}</span><span class="kpi-sub">${F.window ? `Mostly ${F.window}` : 'In the warning signs'}</span></div>
        <div class="kpi"><span class="kpi-label">Reports to add</span><span class="kpi-value">${F.needs}</span><span class="kpi-sub">${F.needs ? `${F.needs} check${F.needs === 1 ? '' : 's'} waiting` : 'All checks running'}</span></div>
      </section>
      <${Banner} level="medium" label="Warning signs, not proof">Each item has innocent explanations too. Ask about them calmly, and look at the paperwork (receipts, job tickets, W-9s) before drawing conclusions. Don't confront an employee before talking to the owner.</${Banner}>
      <${Arrange} page="fraud" parts=${[
        ...GROUPS.map(([id, title, intro]) => [id, title, html`<${Group} id=${id} title=${title} intro=${intro} checks=${F.checks.filter((c) => c.group === id)} t=${t} onAdd=${onAdd} />`]),
        ['reports', 'Reports that unlock more checks', html`<${Reports} F=${F} onAdd=${onAdd} />`],
      ]} />`;
  }

  Object.assign(UI, { FraudTab });
})();
