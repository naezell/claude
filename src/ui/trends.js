/* Ledger Lens UI: Trends tab. */
(function () {
  'use strict';
  const { useState } = React;
  const html = htm.bind(React.createElement);
  const { ResponsiveContainer, BarChart, Bar, AreaChart, Area, LineChart, Line, ComposedChart, XAxis, YAxis, CartesianGrid, Tooltip, Cell, ReferenceLine } = Recharts;
  const E = window.LedgerEngine;
  const { fmtMoney, fmtPct } = E;
  const UI = window.LedgerUI;
  const { compactMoney, useTokens, ChartTooltip, marginPill, wholeMoney, Arrange } = UI;

  // ------------------------------------------------------------ trends tab

  function Spark({ values, color }) {
    const pts = values.map((v, i) => [i, v]).filter(([, v]) => v != null && isFinite(v));
    if (pts.length < 2) return null;
    const ys = pts.map(([, v]) => v);
    const lo = Math.min(...ys), hi = Math.max(...ys);
    const span = hi - lo || 1;
    const n = values.length - 1 || 1;
    const xy = pts.map(([i, v]) => [(i / n) * 100, 28 - ((v - lo) / span) * 24]);
    const last = xy[xy.length - 1];
    return html`<svg class="spark" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true">
      <polyline points=${xy.map((p) => p.join(',')).join(' ')} fill="none" stroke=${color} stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
      <circle cx=${last[0]} cy=${last[1]} r="2.2" fill=${color} vector-effect="non-scaling-stroke" />
    </svg>`;
  }

  const fmtMetric = (kind, v) => (v == null ? 'n/a' : kind === 'pct' ? fmtPct(v) : kind === 'days' ? `${Math.round(v)} days` : kind === 'count' ? String(Math.round(v)) : wholeMoney(v));

  function Delta({ metric, cmp, label }) {
    if (!cmp) return null;
    const d = cmp.delta;
    if (Math.abs(d) < (metric.kind === 'pct' ? 0.0005 : 0.5)) return html`<span class="delta">${label}: no change</span>`;
    const good = metric.up ? d > 0 : d < 0;
    // Percent change for money; points for percentages; plain units for days and counts.
    const text = metric.kind === 'pct' ? `${(d * 100).toFixed(1)} pts`
      : metric.kind === 'days' || metric.kind === 'count' ? fmtMetric(metric.kind, Math.abs(d))
      : cmp.pct != null ? fmtPct(Math.abs(cmp.pct)) : fmtMetric(metric.kind, Math.abs(d));
    const sign = metric.kind === 'money' && cmp.pct != null ? '' : d > 0 ? '+' : '-';
    return html`<span class=${`delta ${good ? 'up' : 'down'}`}>${d > 0 ? '▲' : '▼'} ${sign}${text} <span class="delta-label">${label}</span></span>`;
  }

  function TrendsTab({ trend }) {
    const t = useTokens();
    const [grain, setGrain] = useState('month');
    if (!trend || trend.months.length < 2) return html`<section class="panel"><div class="empty">Trends need at least two months of transactions. Upload a longer export, or several exports at once.</div></section>`;
    const periods = grain === 'quarter' ? trend.quarters : trend.months;
    const byKey = Object.fromEntries(trend.metrics.map((m) => [m.key, m]));
    const tiles = ['revenue', 'netIncome', 'netMargin', 'fixed', 'dso', 'cashEnd'].map((k) => byKey[k]).filter(Boolean);
    const cmpLabel = trend.hasYoY ? 'vs last year' : 'vs prior 3 mo.';
    const data = periods.map((p) => ({ ...p, fullName: `${p.label}${p.partial ? ' (partial)' : ''}`, costs: p.variable + p.fixed, gm: p.grossMargin != null ? Math.round(p.grossMargin * 1000) / 10 : null, nmPct: p.netMargin != null ? Math.round(p.netMargin * 1000) / 10 : null }));
    // Top cost categories across the whole export, the rest folded into Other.
    const catTotals = new Map();
    for (const p of periods) for (const [c, v] of Object.entries(p.categories)) catTotals.set(c, (catTotals.get(c) || 0) + v);
    const topCats = [...catTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c]) => c);
    const catColors = [t.s1, t.s2, t.s3, t.s4, t.s5];
    const mixData = periods.map((p) => {
      const row = { label: p.label, fullName: p.label };
      let other = 0;
      for (const [c, v] of Object.entries(p.categories)) { if (topCats.includes(c)) row[c] = v; else other += v; }
      row.Other = Math.round(other * 100) / 100;
      return row;
    });
    const hasCash = periods.some((p) => p.cashEnd != null);
    const tick = { fill: t.muted, fontSize: 11 };
    const partialNote = periods.some((p) => p.partial) ? html`<p class="chart-note">Partial ${grain === 'quarter' ? 'quarters' : 'months'} at the edges of the export are shown faded and left out of comparisons.</p>` : '';

    return html`
      <div style=${{ display: 'flex', flexWrap: 'wrap', gap: '10px 16px', alignItems: 'center' }}>
        <div class="seg" role="group" aria-label="Period">
          <button aria-pressed=${grain === 'month'} onClick=${() => setGrain('month')}>Monthly</button>
          <button aria-pressed=${grain === 'quarter'} onClick=${() => setGrain('quarter')}>Quarterly</button>
        </div>
        <span class="hint">Comparing ${trend.windows.last3.join(', ')} with ${trend.hasYoY ? `the same months a year earlier (${trend.windows.yearAgo.join(', ')})` : trend.windows.prior3.length ? `the 3 months before (${trend.windows.prior3.join(', ')})` : 'earlier months'}.</span>
      </div>

      <${Arrange} page="trends:top" parts=${[
        ["changed", "What changed", html`
        ${trend.insights.length > 0 && html`<section class="panel">
          <div class="panel-head"><h2>What changed</h2><p>The movements worth a conversation with the client, largest first.</p></div>
          <div class="panel-body"><ul class="insight-list">${trend.insights.map((i) => html`<li key=${i.text}><span class=${`pill ${i.tone === 'good' ? 'good' : 'high'}`}><span class="dot"></span>${i.tone === 'good' ? 'Better' : 'Watch'}</span><span>${i.text}</span></li>`)}</ul></div>
        </section>`}
        `],
      ]} />

      <section class="kpis trend-kpis" aria-label="Trend summary">
        ${tiles.map((m) => {
          const cmp = trend.hasYoY ? m.yoy : m.recent;
          const value = cmp ? cmp.to : m.latest;
          return html`<div class="kpi" key=${m.key}>
            <span class="kpi-label">${m.label}</span>
            <span class="kpi-value">${fmtMetric(m.kind, value)}</span>
            <span class="kpi-sub">${m.balance ? `At end of ${m.latestLabel}` : m.kind === 'pct' ? 'Last 3 months' : 'Per month, last 3 months'}</span>
            <${Spark} values=${m.series} color=${t.s1} />
            <${Delta} metric=${m} cmp=${cmp} label=${cmpLabel} />
          </div>`;
        })}
      </section>

      <${Arrange} page="trends" parts=${[
        ["costs", "Revenue vs. costs, and margins", html`
        <div class="grid-2">
          <section class="panel">
            <div class="panel-head"><h2>Revenue vs. costs</h2><p>The gap between the revenue line and the bars is profit. Bars above the line are losing ${grain === 'quarter' ? 'quarters' : 'months'}.</p></div>
            <div class="panel-body">
              <div class="legend"><span><i style=${{ background: t.s1, height: '3px' }}></i>Revenue</span><span><i style=${{ background: t.s2 }}></i>Job costs</span><span><i style=${{ background: t.neutral }}></i>Overhead</span></div>
              <div style=${{ height: 260 }}>
                <${ResponsiveContainer} width="100%" height="100%">
                  <${ComposedChart} data=${data} margin=${{ top: 8, right: 8, bottom: 0, left: 4 }} barCategoryGap="22%">
                    <${CartesianGrid} vertical=${false} stroke=${t.grid} />
                    <${XAxis} dataKey="label" tickLine=${false} axisLine=${{ stroke: t.axis }} tick=${tick} interval="preserveStartEnd" minTickGap=${10} />
                    <${YAxis} tickFormatter=${compactMoney} tickLine=${false} axisLine=${false} tick=${{ fill: t.muted, fontSize: 12 }} width=${52} />
                    <${Tooltip} cursor=${{ fill: t.surface2 }} content=${html`<${ChartTooltip} rows=${(d) => [
                      { label: 'Revenue', value: fmtMoney(d.revenue), color: t.s1 },
                      { label: 'Job costs', value: fmtMoney(d.variable), color: t.s2 },
                      { label: 'Overhead', value: fmtMoney(d.fixed), color: t.neutral },
                      { label: 'Net income', value: fmtMoney(d.netIncome) },
                    ]} />`} />
                    <${Bar} dataKey="variable" stackId="c" fill=${t.s2} isAnimationActive=${false} stroke=${t.surface} strokeWidth=${1}>
                      ${data.map((d) => html`<${Cell} key=${d.key} fillOpacity=${d.partial ? 0.4 : 1} />`)}
                    <//>
                    <${Bar} dataKey="fixed" stackId="c" fill=${t.neutral} radius=${[4, 4, 0, 0]} isAnimationActive=${false} stroke=${t.surface} strokeWidth=${1}>
                      ${data.map((d) => html`<${Cell} key=${d.key} fillOpacity=${d.partial ? 0.4 : 1} />`)}
                    <//>
                    <${Line} type="linear" dataKey="revenue" stroke=${t.s1} strokeWidth=${2.5} dot=${{ r: 3, fill: t.s1, stroke: t.surface, strokeWidth: 2 }} isAnimationActive=${false} />
                  <//>
                <//>
              </div>
              ${partialNote}
            </div>
          </section>
          <section class="panel">
            <div class="panel-head"><h2>Margins</h2><p>Gross margin tracks pricing and job costs. Net margin adds overhead, so a gap that widens means overhead is growing faster than gross profit.</p></div>
            <div class="panel-body">
              <div class="legend"><span><i style=${{ background: t.s1, height: '3px' }}></i>Gross margin</span><span><i style=${{ background: t.s3, height: '3px' }}></i>Net margin</span></div>
              <div style=${{ height: 260 }}>
                <${ResponsiveContainer} width="100%" height="100%">
                  <${LineChart} data=${data} margin=${{ top: 8, right: 12, bottom: 0, left: 4 }}>
                    <${CartesianGrid} vertical=${false} stroke=${t.grid} />
                    <${XAxis} dataKey="label" tickLine=${false} axisLine=${{ stroke: t.axis }} tick=${tick} interval="preserveStartEnd" minTickGap=${10} />
                    <${YAxis} tickFormatter=${(v) => `${v}%`} tickLine=${false} axisLine=${false} tick=${{ fill: t.muted, fontSize: 12 }} width=${44} />
                    <${ReferenceLine} y=${0} stroke=${t.axis} />
                    <${Tooltip} cursor=${{ stroke: t.axis }} content=${html`<${ChartTooltip} rows=${(d) => [
                      { label: 'Gross margin', value: d.gm != null ? `${d.gm.toFixed(1)}%` : 'n/a', color: t.s1 },
                      { label: 'Net margin', value: d.nmPct != null ? `${d.nmPct.toFixed(1)}%` : 'n/a', color: t.s3 },
                    ]} />`} />
                    <${Line} type="linear" dataKey="gm" stroke=${t.s1} strokeWidth=${2} dot=${{ r: 3, fill: t.s1, stroke: t.surface, strokeWidth: 2 }} isAnimationActive=${false} connectNulls=${true} />
                    <${Line} type="linear" dataKey="nmPct" stroke=${t.s3} strokeWidth=${2} dot=${{ r: 3, fill: t.s3, stroke: t.surface, strokeWidth: 2 }} isAnimationActive=${false} connectNulls=${true} />
                  <//>
                <//>
              </div>
            </div>
          </section>
        </div>
        `],
        ["money", "Where the money goes, and collections", html`
        <div class="grid-2">
          <section class="panel">
            <div class="panel-head"><h2>Where the money goes</h2><p>The five largest cost accounts over the export; everything else is folded into Other.</p></div>
            <div class="panel-body">
              <div class="legend">${topCats.map((c, i) => html`<span key=${c}><i style=${{ background: catColors[i] }}></i>${c}</span>`)}<span><i style=${{ background: t.neutral }}></i>Other</span></div>
              <div style=${{ height: 260 }}>
                <${ResponsiveContainer} width="100%" height="100%">
                  <${BarChart} data=${mixData} margin=${{ top: 8, right: 8, bottom: 0, left: 4 }} barCategoryGap="22%">
                    <${CartesianGrid} vertical=${false} stroke=${t.grid} />
                    <${XAxis} dataKey="label" tickLine=${false} axisLine=${{ stroke: t.axis }} tick=${tick} interval="preserveStartEnd" minTickGap=${10} />
                    <${YAxis} tickFormatter=${compactMoney} tickLine=${false} axisLine=${false} tick=${{ fill: t.muted, fontSize: 12 }} width=${52} />
                    <${Tooltip} cursor=${{ fill: t.surface2 }} content=${html`<${ChartTooltip} rows=${(d) => [...topCats.map((c, i) => ({ label: c, value: fmtMoney(d[c] || 0), color: catColors[i] })), { label: 'Other', value: fmtMoney(d.Other), color: t.neutral }]} />`} />
                    ${topCats.map((c, i) => html`<${Bar} key=${c} dataKey=${c} stackId="m" fill=${catColors[i]} stroke=${t.surface} strokeWidth=${1} isAnimationActive=${false} />`)}
                    <${Bar} dataKey="Other" stackId="m" fill=${t.neutral} stroke=${t.surface} strokeWidth=${1} radius=${[4, 4, 0, 0]} isAnimationActive=${false} />
                  <//>
                <//>
              </div>
            </div>
          </section>
          <section class="panel">
            <div class="panel-head"><h2>${hasCash ? 'Cash and collections' : 'Collections'}</h2><p>Days to collect (DSO) is receivables divided by recent monthly revenue. Rising DSO ties up cash even when sales are growing.</p></div>
            <div class="panel-body">
              <div class="legend"><span><i style=${{ background: t.s2, height: '3px' }}></i>Days to collect</span></div>
              <div style=${{ height: hasCash ? 120 : 260 }}>
                <${ResponsiveContainer} width="100%" height="100%">
                  <${LineChart} data=${data} margin=${{ top: 8, right: 12, bottom: 0, left: 4 }}>
                    <${CartesianGrid} vertical=${false} stroke=${t.grid} />
                    <${XAxis} dataKey="label" hide=${hasCash} tickLine=${false} axisLine=${{ stroke: t.axis }} tick=${tick} interval="preserveStartEnd" minTickGap=${10} />
                    <${YAxis} tickFormatter=${(v) => `${v}d`} tickLine=${false} axisLine=${false} tick=${{ fill: t.muted, fontSize: 12 }} width=${52} />
                    <${Tooltip} cursor=${{ stroke: t.axis }} content=${html`<${ChartTooltip} rows=${(d) => [
                      { label: 'Days to collect', value: d.dso != null ? `${d.dso}` : 'n/a', color: t.s2 },
                      { label: 'Receivables', value: fmtMoney(d.arEnd) },
                    ]} />`} />
                    <${Line} type="linear" dataKey="dso" stroke=${t.s2} strokeWidth=${2} dot=${{ r: 3, fill: t.s2, stroke: t.surface, strokeWidth: 2 }} isAnimationActive=${false} connectNulls=${true} />
                  <//>
                <//>
              </div>
              ${hasCash && html`
                <div class="legend" style=${{ marginTop: '10px' }}><span><i style=${{ background: t.s1 }}></i>Cash at period end</span></div>
                <div style=${{ height: 140 }}>
                  <${ResponsiveContainer} width="100%" height="100%">
                    <${AreaChart} data=${data} margin=${{ top: 8, right: 12, bottom: 0, left: 4 }}>
                      <${CartesianGrid} vertical=${false} stroke=${t.grid} />
                      <${XAxis} dataKey="label" tickLine=${false} axisLine=${{ stroke: t.axis }} tick=${tick} interval="preserveStartEnd" minTickGap=${10} />
                      <${YAxis} tickFormatter=${compactMoney} tickLine=${false} axisLine=${false} tick=${{ fill: t.muted, fontSize: 12 }} width=${52} />
                      <${Tooltip} cursor=${{ stroke: t.axis }} content=${html`<${ChartTooltip} rows=${(d) => [{ label: 'Cash', value: fmtMoney(d.cashEnd), color: t.s1 }]} />`} />
                      <${Area} type="linear" dataKey="cashEnd" stroke=${t.s1} strokeWidth=${2} fill=${t.s1} fillOpacity=${0.12} isAnimationActive=${false} />
                    <//>
                  <//>
                </div>`}
            </div>
          </section>
        </div>
        `],
        ["changes", "Biggest cost and customer changes", html`
        <div class="grid-2">
          <section class="panel">
            <div class="panel-head"><h2>Biggest cost changes</h2><p>Average per month, last 3 months against the 3 before.</p></div>
            <div class="panel-body flush">${trend.costMovers.length ? html`<div class="table-wrap"><table>
              <thead><tr><th>Account</th><th>Type</th><th class="num">Before</th><th class="num">Now</th><th class="num">Change</th></tr></thead>
              <tbody>${trend.costMovers.map((c) => html`<tr key=${c.name}><td>${c.name}</td><td class="sub" style=${{ display: 'table-cell' }}>${c.type}</td><td class="num">${wholeMoney(c.from)}</td><td class="num">${wholeMoney(c.to)}</td><td class=${`num ${c.delta > 0 ? 'neg' : ''}`}>${c.delta > 0 ? '+' : '-'}${wholeMoney(Math.abs(c.delta))}</td></tr>`)}</tbody>
            </table></div>` : html`<div class="empty">No cost account moved by more than 15%.</div>`}</div>
          </section>
          <section class="panel">
            <div class="panel-head"><h2>Customer changes</h2><p>New customers first billed in the last 6 months. Lost customers have no invoices in the last 3.</p></div>
            <div class="panel-body flush">${trend.customerMovers.length ? html`<div class="table-wrap"><table>
              <thead><tr><th>Customer</th><th>Status</th><th class="num">Before / mo</th><th class="num">Now / mo</th></tr></thead>
              <tbody>${trend.customerMovers.map((c) => html`<tr key=${c.name}><td>${c.name}${c.status === 'Lost' ? html`<span class="sub">Last billed ${c.lastMonth}</span>` : ''}</td>
                <td><span class=${`pill ${c.status === 'Lost' || c.status === 'Shrinking' ? 'high' : c.status === 'New' || c.status === 'Growing' ? 'good' : 'low'}`}>${c.status}</span></td>
                <td class="num">${wholeMoney(c.prior)}</td><td class="num">${wholeMoney(c.recent)}</td></tr>`)}</tbody>
            </table></div>` : html`<div class="empty">Needs at least 4 full months to compare customers.</div>`}</div>
          </section>
        </div>
        `],
        ["table", "Month-by-month table", html`
        <section class="panel">
          <div class="panel-head"><h2>${grain === 'quarter' ? 'Quarter' : 'Month'} by ${grain === 'quarter' ? 'quarter' : 'month'}</h2></div>
          <div class="panel-body flush"><div class="table-wrap"><table>
            <thead><tr><th>${grain === 'quarter' ? 'Quarter' : 'Month'}</th><th class="num">Revenue</th><th class="num">Job costs</th><th class="num">Overhead</th><th class="num">Net income</th><th class="num">Net margin</th><th class="num">Customers</th><th class="num">DSO</th>${hasCash ? html`<th class="num">Cash</th>` : ''}</tr></thead>
            <tbody>${[...periods].reverse().map((p) => html`<tr key=${p.key} class=${p.partial ? 'partial' : ''}>
              <td class="nowrap">${p.label}${p.partial ? html`<span class="sub">partial</span>` : ''}</td>
              <td class="num">${wholeMoney(p.revenue)}</td><td class="num">${wholeMoney(p.variable)}</td><td class="num">${wholeMoney(p.fixed)}</td>
              <td class=${`num ${p.netIncome < 0 ? 'neg' : ''}`}>${wholeMoney(p.netIncome)}</td><td class="num">${marginPill(p.netMargin)}</td>
              <td class="num">${p.customers}</td><td class="num">${p.dso != null ? p.dso : '-'}</td>${hasCash ? html`<td class="num">${p.cashEnd != null ? wholeMoney(p.cashEnd) : '-'}</td>` : ''}
            </tr>`)}</tbody>
          </table></div></div>
        </section>
        `],
      ]} />
    `;
  }

  Object.assign(UI, { TrendsTab });
})();
