/* Ledger Lens UI: Budget tab. */
(function () {
  'use strict';
  const html = htm.bind(React.createElement);
  const { ResponsiveContainer, Bar, Line, ComposedChart, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine } = Recharts;
  const E = window.LedgerEngine;
  const { fmtMoney, fmtPct } = E;
  const UI = window.LedgerUI;
  const { compactMoney, useTokens, Money, ChartTooltip, wholeMoney, NumberInput, Arrange } = UI;

  // ------------------------------------------------------------ budget tab

  function BudgetTab({ bva, uploaded, prefs, setPrefs }) {
    const t = useTokens();
    const set = (k) => (v) => setPrefs({ ...prefs, [k]: v });
    const usingUpload = uploaded && prefs.mode !== 'history';
    if (!bva) return html`<section class="panel"><div class="empty">A budget needs income and expense history in the export, or an uploaded QuickBooks budget.</div></section>`;
    const T = bva.totals;
    const pctOf = (a, b) => (b ? (a - b) / Math.abs(b) : null);
    const tileDelta = (actual, budget, goodUp) => {
      const p = pctOf(actual, budget);
      if (p == null) return 'No budget for these months';
      const good = goodUp ? actual >= budget : actual <= budget;
      return html`<span class=${`delta ${good ? 'up' : 'down'}`}>${actual >= budget ? '▲' : '▼'} ${fmtPct(Math.abs(p))} ${actual >= budget ? 'over' : 'under'}</span> <span class="delta-label">budget of ${wholeMoney(budget)}</span>`;
    };
    const ytdData = bva.monthly.map((m) => ({ ...m, fullName: m.label }));
    const chart = (title, actualKey, budgetKey, note) => html`<section class="panel">
      <div class="panel-head"><h2>${title}</h2><p>${note}</p></div>
      <div class="panel-body">
        <div class="legend"><span><i style=${{ background: t.s1 }}></i>Actual</span><span><i style=${{ background: t.ink2, height: '3px' }}></i>Budget</span></div>
        <div style=${{ height: 240 }}>
          <${ResponsiveContainer} width="100%" height="100%">
            <${ComposedChart} data=${ytdData} margin=${{ top: 8, right: 8, bottom: 0, left: 4 }} barCategoryGap="28%">
              <${CartesianGrid} vertical=${false} stroke=${t.grid} />
              <${XAxis} dataKey="label" tickLine=${false} axisLine=${{ stroke: t.axis }} tick=${{ fill: t.muted, fontSize: 11 }} interval="preserveStartEnd" minTickGap=${10} />
              <${YAxis} tickFormatter=${compactMoney} tickLine=${false} axisLine=${false} tick=${{ fill: t.muted, fontSize: 12 }} width=${52} />
              <${ReferenceLine} y=${0} stroke=${t.axis} />
              <${Tooltip} cursor=${{ fill: t.surface2 }} content=${html`<${ChartTooltip} rows=${(d) => [
                { label: 'Actual', value: d[actualKey] == null ? 'Not yet' : fmtMoney(d[actualKey]), color: t.s1 },
                { label: 'Budget', value: fmtMoney(d[budgetKey]), color: t.ink2 },
              ]} />`} />
              <${Bar} dataKey=${actualKey} fill=${t.s1} radius=${[4, 4, 0, 0]} maxBarSize=${26} isAnimationActive=${false} />
              <${Line} type="linear" dataKey=${budgetKey} stroke=${t.ink2} strokeWidth=${2} dot=${{ r: 2.5, fill: t.ink2, stroke: t.surface, strokeWidth: 1 }} isAnimationActive=${false} />
            <//>
          <//>
        </div>
      </div>
    </section>`;
    return html`
      <section class="panel">
        <div class="panel-head"><h2>Budget for ${bva.year}</h2>
          <p>${usingUpload ? `Using the uploaded QuickBooks budget (${uploaded.name}).` : `Built from ${bva.basis}, with revenue ${prefs.revenueGrowth >= 0 ? 'up' : 'down'} ${Math.abs(+prefs.revenueGrowth || 0)}% and costs ${prefs.costGrowth >= 0 ? 'up' : 'down'} ${Math.abs(+prefs.costGrowth || 0)}%. Upload the client's QuickBooks Budget Overview export to use their own budget instead.`} Compared through ${bva.ytdLabel}.</p></div>
        <div class="panel-body inputs-row">
          ${uploaded && html`<div class="field"><span>Budget source</span><div class="seg" role="group" aria-label="Budget source">
            <button aria-pressed=${usingUpload} onClick=${() => set('mode')('auto')}>Uploaded budget</button>
            <button aria-pressed=${!usingUpload} onClick=${() => set('mode')('history')}>Build from last year</button></div></div>`}
          ${!usingUpload && html`
            <${NumberInput} id="bud-rev" label="Revenue growth" suffix="%" value=${prefs.revenueGrowth} onChange=${set('revenueGrowth')} />
            <${NumberInput} id="bud-cost" label="Cost growth" suffix="%" value=${prefs.costGrowth} onChange=${set('costGrowth')} />`}
        </div>
      </section>

      <section class="kpis" aria-label="Budget summary">
        <div class="kpi"><span class="kpi-label">Revenue so far</span><span class="kpi-value">${wholeMoney(T.actualYtd.revenue)}</span><span class="kpi-sub">${tileDelta(T.actualYtd.revenue, T.budgetYtd.revenue, true)}</span></div>
        <div class="kpi"><span class="kpi-label">Costs so far</span><span class="kpi-value">${wholeMoney(T.actualYtd.costs)}</span><span class="kpi-sub">${tileDelta(T.actualYtd.costs, T.budgetYtd.costs, false)}</span></div>
        <div class=${`kpi ${T.actualYtd.netIncome < T.budgetYtd.netIncome ? 'alert' : 'okay'}`}><span class="kpi-label">Net income so far</span><span class="kpi-value">${wholeMoney(T.actualYtd.netIncome)}</span><span class="kpi-sub">budget ${wholeMoney(T.budgetYtd.netIncome)} for ${bva.ytdMonths} months</span></div>
        <div class="kpi"><span class="kpi-label">Year on track for</span><span class="kpi-value">${wholeMoney(bva.outlook.netIncome)}</span><span class="kpi-sub">net income if the rest of the year goes to budget (budget ${wholeMoney(T.fullYear.netIncome)})</span></div>
      </section>

      <${Arrange} page="budget" parts=${[
        ["charts", "Revenue and net income by month", html`
        <div class="grid-2">
          ${chart('Revenue by month', 'actualRevenue', 'budgetRevenue', 'Bars are actual revenue; the line is the budget. Months still to come show the budget only.')}
          ${chart('Net income by month', 'actualNet', 'budgetNet', 'Revenue less all costs, against what the budget expected each month.')}
        </div>
        `],
        ["accounts", "By account", html`
        <section class="panel">
          <div class="panel-head"><h2>By account, ${bva.ytdLabel}</h2><p>Largest differences first. Income above budget and costs below budget are favorable. Differences of $500 and 10% or more are flagged.</p></div>
          <div class="panel-body flush"><div class="table-wrap"><table>
            <thead><tr><th>Account</th><th class="num">Budget</th><th class="num">Actual</th><th class="num">Difference</th><th></th><th class="num">Full-year budget</th></tr></thead>
            <tbody>${bva.rows.map((r) => html`<tr key=${r.name}>
              <td>${r.name}<span class="sub">${r.cls === 'income' ? 'Income' : r.cls === 'cogs' ? 'Cost of goods sold' : 'Expense'}${r.unbudgeted ? ' · not in the budget' : ''}</span></td>
              <td class="num"><${Money} v=${r.budgetYtd} /></td>
              <td class="num"><${Money} v=${r.actualYtd} /></td>
              <td class="num"><span class=${r.favorable ? '' : 'neg'}>${r.variance > 0 ? '+' : ''}${wholeMoney(r.variance)}${r.pct != null ? ` (${r.pct > 0 ? '+' : ''}${(r.pct * 100).toFixed(0)}%)` : ''}</span></td>
              <td>${r.flag ? html`<span class=${`pill ${r.favorable ? 'good' : 'high'}`}>${r.favorable ? 'Favorable' : 'Over budget'}</span>` : ''}</td>
              <td class="num">${r.fullYear ? wholeMoney(r.fullYear) : html`<span class="sub">-</span>`}</td>
            </tr>`)}</tbody>
          </table></div></div>
        </section>
        `],
      ]} />
    `;
  }

  Object.assign(UI, { BudgetTab });
})();
