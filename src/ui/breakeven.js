/* Ledger Lens UI: Break-even tab. */
(function () {
  'use strict';
  const { useState } = React;
  const html = htm.bind(React.createElement);
  const { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell, ReferenceLine } = Recharts;
  const E = window.LedgerEngine;
  const { fmtMoney, fmtPct } = E;
  const UI = window.LedgerUI;
  const { compactMoney, useTokens, ChartTooltip, wholeMoney, MoneyInput, Slider } = UI;

  // ------------------------------------------------------------ break-even tab

  function BreakEvenTab({ be, onOpenMapping }) {
    const t = useTokens();
    const [sc, setSc] = useState({ price: 0, variable: 0, fixed: 0, target: '' });
    if (!be) return html`<section class="panel"><div class="empty">No income or expense postings found to compute break-even.</div></section>`;
    const target = sc.target === '' || isNaN(parseFloat(sc.target)) ? null : parseFloat(sc.target);
    const scen = E.whatIf(be.base, { price: sc.price, variable: sc.variable, fixed: sc.fixed, target });
    const changed = sc.price || sc.variable || sc.fixed;
    const mos = be.marginOfSafety;
    const data = be.monthly.map((m) => ({ ...m, label: new Date(`${m.month}-01T00:00:00Z`).toLocaleString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }), below: be.breakEvenRevenue != null && m.revenue < be.breakEvenRevenue }));
    const R = be.base.revenue || 1;
    const split = [
      { label: 'Variable costs', v: be.base.variable, color: t.s2 },
      { label: 'Fixed costs', v: be.base.fixed, color: t.neutral },
      { label: be.profit >= 0 ? 'Profit' : 'Loss', v: Math.abs(be.profit), color: be.profit >= 0 ? t.s1 : t.neg },
    ];
    const splitTotal = split.reduce((s, x) => s + x.v, 0) || 1;
    const rows = [
      ['Monthly revenue', be.revenue, scen.revenue, 'money'],
      ['Variable costs', be.variable, scen.variable, 'money'],
      ['Fixed costs', be.fixed, scen.fixed, 'money'],
      ['Monthly profit', be.profit, scen.profit, 'money'],
      ['Profit margin', be.profitMargin, scen.profitMargin, 'pct'],
      ['Contribution margin', be.cmRatio, scen.cmRatio, 'pct'],
      ['Break-even revenue', be.breakEvenRevenue, scen.breakEvenRevenue, 'money'],
      ['Margin of safety', be.marginOfSafety, scen.marginOfSafety, 'pct'],
    ];
    const fmtCell = (v, kind) => (v == null ? 'n/a' : kind === 'pct' ? fmtPct(v) : wholeMoney(v));
    const delta = (a, b, kind) => {
      if (a == null || b == null || Math.abs(b - a) < (kind === 'pct' ? 0.0005 : 0.5)) return html`<span class="sub">-</span>`;
      const d = b - a;
      return html`<span class="num">${d > 0 ? '+' : ''}${kind === 'pct' ? `${(d * 100).toFixed(1)} pts` : wholeMoney(d)}</span>`;
    };

    return html`
      <section class="kpis" aria-label="Break-even summary">
        <div class="kpi"><span class="kpi-label">Break-even revenue</span><span class="kpi-value">${be.breakEvenRevenue != null ? wholeMoney(be.breakEvenRevenue) : 'n/a'}</span><span class="kpi-sub">per month</span></div>
        <div class="kpi"><span class="kpi-label">Average revenue</span><span class="kpi-value">${wholeMoney(be.base.revenue)}</span><span class="kpi-sub">${be.trailing ? 'per month, last 12 months' : `per month over ${be.months % 1 === 0 ? be.months : be.months.toFixed(1)} months`}</span></div>
        <div class=${`kpi ${mos == null || mos < 0 ? 'alert' : mos >= 0.2 ? 'okay' : ''}`}><span class="kpi-label">Margin of safety</span><span class="kpi-value">${fmtPct(mos)}</span><span class="kpi-sub">${mos == null ? 'Break-even not reachable' : mos < 0 ? 'Revenue is below break-even' : `Revenue can fall ${fmtPct(mos)} before a loss`}</span></div>
        <div class="kpi"><span class="kpi-label">Contribution margin</span><span class="kpi-value">${fmtPct(be.cmRatio)}</span><span class="kpi-sub">${be.cmRatio != null ? `${Math.round(be.cmRatio * 100)}¢ of each $1 left after job costs` : ''}</span></div>
        <div class=${`kpi ${be.profit < 0 ? 'alert' : ''}`}><span class="kpi-label">Average profit</span><span class="kpi-value">${wholeMoney(be.profit)}</span><span class="kpi-sub">per month · ${fmtPct(be.profitMargin)} margin</span></div>
      </section>

      <div class="grid-2">
        <section class="panel">
          <div class="panel-head"><h2>Monthly revenue vs. break-even</h2><p>Months in red did not cover their costs at the period's average cost structure.</p></div>
          <div class="panel-body">
            <div class="legend"><span><i style=${{ background: t.s1 }}></i>Above break-even</span><span><i style=${{ background: t.neg }}></i>Below break-even</span><span><i style=${{ background: t.ink2, height: '2px' }}></i>Break-even</span></div>
            <div style=${{ height: 260 }}>
              <${ResponsiveContainer} width="100%" height="100%">
                <${BarChart} data=${data} margin=${{ top: 16, right: 12, bottom: 0, left: 4 }} barCategoryGap="30%">
                  <${CartesianGrid} vertical=${false} stroke=${t.grid} />
                  <${XAxis} dataKey="label" tickLine=${false} axisLine=${{ stroke: t.axis }} tick=${{ fill: t.muted, fontSize: 12 }} />
                  <${YAxis} tickFormatter=${compactMoney} tickLine=${false} axisLine=${false} tick=${{ fill: t.muted, fontSize: 12 }} width=${52} />
                  <${Tooltip} cursor=${{ fill: t.surface2 }} content=${html`<${ChartTooltip} rows=${(d) => [
                    { label: 'Revenue', value: fmtMoney(d.revenue), color: d.below ? t.neg : t.s1 },
                    { label: 'Variable costs', value: fmtMoney(d.variable) },
                    { label: 'Fixed costs', value: fmtMoney(d.fixed) },
                    { label: 'Profit', value: fmtMoney(d.profit) },
                  ]} />`} />
                  <${Bar} dataKey="revenue" maxBarSize=${36} radius=${[4, 4, 0, 0]} isAnimationActive=${false}>
                    ${data.map((d) => html`<${Cell} key=${d.month} fill=${d.below ? t.neg : t.s1} />`)}
                  <//>
                  ${be.breakEvenRevenue != null && html`<${ReferenceLine} y=${be.breakEvenRevenue} stroke=${t.ink2} strokeWidth=${2} label=${{ value: `Break-even ${compactMoney(be.breakEvenRevenue)}`, position: 'insideTopLeft', fill: t.ink2, fontSize: 11 }} />`}
                <//>
              <//>
            </div>
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Where each sales dollar goes</h2><p>Variable costs rise with each job. Fixed costs are owed whether or not work comes in.</p></div>
          <div class="panel-body" style=${{ display: 'grid', gap: '16px' }}>
            <div class="split-bar" role="img" aria-label=${split.map((x) => `${x.label} ${Math.round((x.v / R) * 100)} cents`).join(', ')}>
              ${split.map((x) => html`<span key=${x.label} style=${{ width: `${(x.v / splitTotal) * 100}%`, background: x.color }}></span>`)}
            </div>
            <div class="split-legend">${split.map((x) => html`<div key=${x.label}><i style=${{ background: x.color }}></i><span>${x.label}</span><b class="num">${Math.round((x.v / R) * 100)}¢</b><span class="sub num">${wholeMoney(x.v)}/mo</span></div>`)}</div>
            <div class="cost-lists">
              <div><h3>Fixed costs</h3><table><tbody>${be.fixedAccounts.slice(0, 8).map((a) => html`<tr key=${a.name}><td>${a.name}</td><td class="num">${wholeMoney(a.monthly)}</td></tr>`)}</tbody></table></div>
              <div><h3>Variable costs</h3><table><tbody>${be.variableAccounts.length ? be.variableAccounts.slice(0, 8).map((a) => html`<tr key=${a.name}><td>${a.name}</td><td class="num">${wholeMoney(a.monthly)}</td></tr>`) : html`<tr><td class="sub">None found</td></tr>`}</tbody></table></div>
            </div>
            <p class="chart-note">COGS accounts and expenses tagged to a customer count as variable; everything else is fixed. <button class="linkish" onClick=${onOpenMapping}>Change account types in Account mapping</button>.</p>
          </div>
        </section>
      </div>

      <section class="panel">
        <div class="panel-head"><h2>What if?</h2><p>Test a price change or cost change before making it. Price changes assume the same amount of work at the new rate.</p>
          ${changed ? html`<button class="btn spacer" onClick=${() => setSc({ ...sc, price: 0, variable: 0, fixed: 0 })}>Reset</button>` : ''}</div>
        <div class="panel-body whatif">
          <div class="sliders">
            <${Slider} id="wi-price" label="Prices" value=${sc.price} min=${-10} max=${25} step=${1} fmt=${(v) => `${v > 0 ? '+' : ''}${v}%`} onChange=${(v) => setSc({ ...sc, price: v })} />
            <${Slider} id="wi-variable" label="Variable costs" value=${sc.variable} min=${-20} max=${20} step=${1} fmt=${(v) => `${v > 0 ? '+' : ''}${v}%`} onChange=${(v) => setSc({ ...sc, variable: v })} />
            <${Slider} id="wi-fixed" label="Fixed costs per month" value=${sc.fixed} min=${-Math.ceil(be.base.fixed / 2 / 500) * 500} max=${Math.ceil(be.base.fixed / 2 / 500) * 500} step=${250} fmt=${(v) => `${v > 0 ? '+' : v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US')}`} onChange=${(v) => setSc({ ...sc, fixed: v })} />
            <${MoneyInput} id="wi-target" label="Target monthly profit" value=${sc.target} placeholder="e.g. 10,000" onChange=${(v) => setSc({ ...sc, target: v })} />
          </div>
          <div class="whatif-out">
            <div class="table-wrap"><table>
              <thead><tr><th></th><th class="num">Today</th><th class="num">Scenario</th><th class="num">Change</th></tr></thead>
              <tbody>${rows.map(([label, a, b, kind]) => html`<tr key=${label} class=${label === 'Monthly profit' ? 'strong' : ''}><td>${label}</td><td class="num">${fmtCell(a, kind)}</td><td class=${`num ${kind === 'money' && b < 0 ? 'neg' : ''}`}>${fmtCell(b, kind)}</td><td class="num">${delta(a, b, kind)}</td></tr>`)}</tbody>
            </table></div>
            <div class="insights">
              ${scen.volumeCushion != null && scen.volumeCushion > 0 && html`<p>At ${sc.price}% higher prices you could lose <strong>${fmtPct(scen.volumeCushion)}</strong> of your work and still earn today's profit.</p>`}
              ${target != null && (scen.revenueForTarget != null
                ? html`<p>To earn <strong>${wholeMoney(target)}</strong> a month you need <strong>${wholeMoney(scen.revenueForTarget)}</strong> in monthly revenue, ${scen.revenueForTarget > be.base.revenue ? `${fmtPct(scen.revenueForTarget / be.base.revenue - 1)} more than today` : 'which you already reach'}.</p>`
                : html`<p>Costs exceed revenue on each sale in this scenario, so no revenue level reaches that target.</p>`)}
              ${!changed && target == null && html`<p class="sub">Move a slider to compare against today.</p>`}
            </div>
          </div>
        </div>
      </section>
    `;
  }

  Object.assign(UI, { BreakEvenTab });
})();
