/* Ledger Lens UI: Growth & profitability tab. */
(function () {
  'use strict';
  const { useState } = React;
  const html = htm.bind(React.createElement);
  const { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell, ReferenceLine } = Recharts;
  const E = window.LedgerEngine;
  const { fmtMoney, fmtPct } = E;
  const UI = window.LedgerUI;
  const { compactMoney, truncate, useTokens, Icon, Money, ChartTooltip, wholeMoney, ReviewSelect, clearedOf, Arrange } = UI;

  // ------------------------------------------------------------ growth tab

  function GrowthTab({ result, groupBy, setGroupBy, onReview }) {
    const { profit, subs } = result;
    const [mode, setMode] = useState('gross');
    const noun = groupBy === 'project' ? 'project' : 'customer';
    return html`
      <section class="kpis" aria-label="Profitability summary">
        <div class="kpi"><span class="kpi-label">Revenue</span><span class="kpi-value">${fmtMoney(profit.totals.revenue)}</span><span class="kpi-sub">${result.period.start} to ${result.period.end}</span></div>
        <div class=${`kpi ${profit.totals.netIncome < 0 ? 'alert' : ''}`}><span class="kpi-label">Net income</span><span class="kpi-value">${fmtMoney(profit.totals.netIncome)}</span><span class="kpi-sub">${fmtPct(profit.totals.netMargin)} net margin</span></div>
        <div class="kpi"><span class="kpi-label">Direct job costs</span><span class="kpi-value">${fmtMoney(profit.groups.reduce((s, g) => s + g.directCost, 0))}</span><span class="kpi-sub">Tagged to a ${noun}</span></div>
        <div class="kpi"><span class="kpi-label">Software spend / yr</span><span class="kpi-value">${fmtMoney(subs.totalAnnual)}</span><span class="kpi-sub">${subs.list.length} recurring subscriptions</span></div>
        <div class=${`kpi ${subs.potentialSavings ? 'okay' : ''}`}><span class="kpi-label">Potential savings / yr</span><span class="kpi-value">${fmtMoney(subs.potentialSavings)}</span><span class="kpi-sub">Overlaps, extra seats, personal</span></div>
      </section>

      <${Arrange} page="growth" parts=${[
        ['margins', 'Net margin by customer', html`
          <div class="section-title"><h2>Net margin by ${noun}</h2></div>
          <div style=${{ display: 'flex', flexWrap: 'wrap', gap: '10px 16px', alignItems: 'center' }}>
            <div class="seg" role="group" aria-label="Group by">
              <button aria-pressed=${groupBy === 'customer'} onClick=${() => setGroupBy('customer')}>By customer</button>
              <button aria-pressed=${groupBy === 'project'} onClick=${() => setGroupBy('project')}>By project</button>
            </div>
            <div class="seg" role="group" aria-label="Margin basis">
              <button aria-pressed=${mode === 'gross'} onClick=${() => setMode('gross')}>Direct costs only</button>
              <button aria-pressed=${mode === 'net'} onClick=${() => setMode('net')}>After overhead</button>
            </div>
          </div>
          ${profit.groups.length
            ? html`<div class="grid-2">
                <${RevenueCostChart} groups=${profit.groups} noun=${noun} />
                <${MarginChart} groups=${profit.groups} mode=${mode} noun=${noun} />
              </div>`
            : html`<section class="panel"><div class="empty">No ${noun} tags found on income. Add the ${groupBy === 'project' ? 'Customer (with sub-customers/projects) or Class' : 'Customer'} column to the QuickBooks report before exporting.</div></section>`}
        `],
        ['detail', 'Customer profitability detail', profit.groups.length > 0 && html`<${ProfitTable} profit=${profit} noun=${noun} />`],
        ['jobcosts', 'Job costing gaps', profit.groups.length > 0 && result.jobCosts && result.jobCosts.mode !== 'none' && html`<${JobCostPanel} jc=${result.jobCosts} noun=${noun} onReview=${onReview} />`],
        ['risk', 'Customer concentration & risk', profit.groups.length > 0 && html`<${CustomerRiskSection} risk=${result.customers} />`],
        ['subscriptions', 'Recurring software & subscriptions', html`
          <div class="section-title"><h2>Recurring software & subscriptions</h2></div>
          <${SubscriptionSection} subs=${subs} />
        `],
      ]} />
    `;
  }

  // Costs that never reached a job make every job look more profitable than it is.
  function JobCostPanel({ jc, noun, onReview }) {
    if (jc.mode === 'untracked') {
      return html`<section class="panel"><div class="panel-head"><h2>Job costing</h2><span class="pill medium">Costs not tracked by ${noun}</span><p>${jc.reason}</p></div></section>`;
    }
    const clean = !jc.items.length && !jc.jobs.length;
    return html`<section class="panel">
      <div class="panel-head">
        <h2>Job costing gaps</h2>
        <span class=${`pill ${jc.open ? 'high' : 'good'}`}>${clean ? 'Every job cost is assigned' : `${jc.open} to fix`}</span>
        <p>${fmtPct(jc.taggedShare)} of job costs are tagged to a ${noun}.${jc.untaggedTotal ? ` ${fmtMoney(jc.untaggedTotal)} sits on no job, so the ${noun} margins above look better than they are. Add the ${noun} to each of these in QuickBooks.` : ''}</p>
      </div>
      ${!clean && html`<div class="panel-body flush"><div class="table-wrap"><table>
        <thead><tr><th>Review</th><th>Issue</th><th>Date</th><th>Vendor</th><th>Likely job</th><th class="num">Amount</th></tr></thead>
        <tbody>
          ${jc.items.map((r) => html`<tr key=${r.key} class=${clearedOf(r) ? 'cleared' : ''}>
            <td><${ReviewSelect} item=${r} onReview=${onReview} /></td>
            <td><strong style=${{ fontWeight: 500 }}>No ${noun}</strong><span class="sub">${r.account}${r.memo ? ` · ${r.memo}` : ''}</span></td>
            <td class="nowrap num">${r.dateStr}</td>
            <td>${r.vendor || html`<span class="sub">No payee</span>`}<span class="sub">${r.type}${r.num ? ` #${r.num}` : ''}</span></td>
            <td>${r.suggestion || html`<span class="sub">Unknown</span>`}</td>
            <td class="num"><${Money} v=${r.cost} /></td>
          </tr>`)}
          ${jc.jobs.map((r) => html`<tr key=${r.key} class=${clearedOf(r) ? 'cleared' : ''}>
            <td><${ReviewSelect} item=${r} onReview=${onReview} /></td>
            <td><strong style=${{ fontWeight: 500 }}>${r.kind}</strong><span class="sub">${r.detail}</span></td>
            <td></td>
            <td>${r.name}</td>
            <td></td>
            <td class="num"><${Money} v=${r.kind === 'Billing, no costs' ? r.revenue : r.cost} /></td>
          </tr>`)}
        </tbody>
      </table></div></div>`}
    </section>`;
  }

  function topN(groups, n) {
    if (groups.length <= n) return groups;
    const head = groups.slice(0, n - 1);
    const tail = groups.slice(n - 1);
    const other = tail.reduce((o, g) => ({
      ...o, revenue: o.revenue + g.revenue, directCost: o.directCost + g.directCost, profit: o.profit + g.profit,
      overhead: o.overhead + g.overhead, netAfterOverhead: o.netAfterOverhead + g.netAfterOverhead,
    }), { name: `Other (${tail.length})`, revenue: 0, directCost: 0, profit: 0, overhead: 0, netAfterOverhead: 0 });
    other.margin = other.revenue ? other.profit / other.revenue : null;
    other.netMargin = other.revenue ? other.netAfterOverhead / other.revenue : null;
    return [...head, other];
  }

  function RevenueCostChart({ groups, noun }) {
    const t = useTokens();
    const data = topN(groups, 10).map((g) => ({ ...g, fullName: g.name, label: truncate(g.name.split(':').pop().trim(), 20) }));
    const h = Math.max(220, data.length * 46 + 40);
    return html`<section class="panel">
      <div class="panel-head"><h2>Revenue vs. direct cost</h2><p>Direct cost is every expense tagged to the ${noun}: subcontractors, materials, billable expenses.</p></div>
      <div class="panel-body">
        <div class="legend"><span><i style=${{ background: t.s1 }}></i>Revenue</span><span><i style=${{ background: t.s2 }}></i>Direct cost</span></div>
        <div style=${{ height: h }}>
          <${ResponsiveContainer} width="100%" height="100%">
            <${BarChart} data=${data} layout="vertical" margin=${{ top: 0, right: 12, bottom: 0, left: 0 }} barGap=${2} barCategoryGap="26%">
              <${CartesianGrid} horizontal=${false} stroke=${t.grid} />
              <${XAxis} type="number" tickFormatter=${compactMoney} tickLine=${false} axisLine=${{ stroke: t.axis }} tick=${{ fill: t.muted, fontSize: 12 }} />
              <${YAxis} type="category" dataKey="label" width=${150} tickLine=${false} axisLine=${false} tick=${{ fill: t.ink2, fontSize: 12 }} />
              <${Tooltip} cursor=${{ fill: t.surface2 }} content=${html`<${ChartTooltip} rows=${(d) => [
                { label: 'Revenue', value: fmtMoney(d.revenue), color: t.s1 },
                { label: 'Direct cost', value: fmtMoney(d.directCost), color: t.s2 },
                { label: 'Gross profit', value: fmtMoney(d.profit) },
                { label: 'Gross margin', value: fmtPct(d.margin) },
              ]} />`} />
              <${Bar} dataKey="revenue" fill=${t.s1} radius=${[0, 4, 4, 0]} maxBarSize=${16} isAnimationActive=${false} />
              <${Bar} dataKey="directCost" fill=${t.s2} radius=${[0, 4, 4, 0]} maxBarSize=${16} isAnimationActive=${false} />
            <//>
          <//>
        </div>
      </div>
    </section>`;
  }

  function MarginChart({ groups, mode, noun }) {
    const t = useTokens();
    const key = mode === 'net' ? 'netMargin' : 'margin';
    const data = topN(groups, 10).filter((g) => g[key] != null)
      .map((g) => ({ ...g, fullName: g.name, label: truncate(g.name.split(':').pop().trim(), 20), value: Math.round(g[key] * 1000) / 10 }))
      .sort((a, b) => b.value - a.value);
    const h = Math.max(220, data.length * 34 + 40);
    const min = Math.min(0, ...data.map((d) => d.value));
    const max = Math.max(0, ...data.map((d) => d.value));
    const step = max - min > 60 ? 25 : 10;
    const domain = [Math.floor(min / step) * step, Math.ceil(max / step) * step || step];
    const ticks = [];
    for (let v = domain[0]; v <= domain[1]; v += step) ticks.push(v);
    return html`<section class="panel">
      <div class="panel-head"><h2>${mode === 'net' ? 'Net margin after overhead' : 'Gross margin'}</h2>
        <p>${mode === 'net'
          ? `Untagged costs (rent, payroll, software) are spread across ${noun}s by share of revenue. Below zero means the ${noun} costs more to serve than it brings in.`
          : `Revenue minus direct cost, as a share of revenue. Switch to "After overhead" for the fully-loaded view.`}</p></div>
      <div class="panel-body">
        <div class="legend"><span><i style=${{ background: t.pos }}></i>Profitable</span><span><i style=${{ background: t.neg }}></i>Losing money</span></div>
        <div style=${{ height: h }}>
          <${ResponsiveContainer} width="100%" height="100%">
            <${BarChart} data=${data} layout="vertical" margin=${{ top: 0, right: 16, bottom: 0, left: 0 }} barCategoryGap="30%">
              <${CartesianGrid} horizontal=${false} stroke=${t.grid} />
              <${XAxis} type="number" domain=${domain} ticks=${ticks} tickFormatter=${(v) => `${v}%`} tickLine=${false} axisLine=${{ stroke: t.axis }} tick=${{ fill: t.muted, fontSize: 12 }} />
              <${YAxis} type="category" dataKey="label" width=${150} tickLine=${false} axisLine=${false} tick=${{ fill: t.ink2, fontSize: 12 }} />
              <${ReferenceLine} x=${0} stroke=${t.axis} />
              <${Tooltip} cursor=${{ fill: t.surface2 }} content=${html`<${ChartTooltip} rows=${(d) => [
                { label: 'Revenue', value: fmtMoney(d.revenue) },
                { label: 'Direct cost', value: fmtMoney(d.directCost) },
                ...(mode === 'net' ? [{ label: 'Overhead share', value: fmtMoney(d.overhead) }, { label: 'Net', value: fmtMoney(d.netAfterOverhead) }] : [{ label: 'Gross profit', value: fmtMoney(d.profit) }]),
                { label: mode === 'net' ? 'Net margin' : 'Gross margin', value: `${d.value.toFixed(1)}%` },
              ]} />`} />
              <${Bar} dataKey="value" maxBarSize=${16} isAnimationActive=${false}>
                ${data.map((d) => html`<${Cell} key=${d.name} fill=${d.value >= 0 ? t.pos : t.neg} radius=${d.value >= 0 ? [0, 4, 4, 0] : [4, 0, 0, 4]} />`)}
              <//>
            <//>
          <//>
        </div>
      </div>
    </section>`;
  }

  function marginPill(m) {
    if (m == null) return html`<span class="pill low">n/a</span>`;
    const cls = m < 0 ? 'high' : m < 0.15 ? 'medium' : 'good';
    return html`<span class=${`pill ${cls} num`}>${fmtPct(m)}</span>`;
  }

  function ProfitTable({ profit, noun }) {
    const { totals } = profit;
    return html`<section class="panel">
      <div class="panel-head">
        <h2>${noun === 'project' ? 'Project' : 'Customer'} profitability detail</h2>
        <p><span class="num">${fmtMoney(totals.unassignedCost)}</span> of costs carry no ${noun} tag and are treated as overhead${totals.unassignedRevenue ? html`; <span class="num">${fmtMoney(totals.unassignedRevenue)}</span> of income has no ${noun}` : ''}. Tagging billable costs in QuickBooks sharpens these margins.</p>
      </div>
      <div class="panel-body flush"><div class="table-wrap"><table>
        <thead><tr><th>${noun === 'project' ? 'Project' : 'Customer'}</th><th class="num">Revenue</th><th class="num">Direct cost</th><th class="num">Gross profit</th><th class="num">Gross margin</th><th class="num">Overhead share</th><th class="num">Net</th><th class="num">Net margin</th></tr></thead>
        <tbody>${profit.groups.map((g) => html`<tr key=${g.name}>
          <td>${g.name}<span class="sub">${g.txnCount} postings</span></td>
          <td class="num"><${Money} v=${g.revenue} /></td>
          <td class="num"><${Money} v=${g.directCost} /></td>
          <td class="num"><${Money} v=${g.profit} /></td>
          <td class="num">${marginPill(g.margin)}</td>
          <td class="num"><${Money} v=${g.overhead} /></td>
          <td class="num"><${Money} v=${g.netAfterOverhead} /></td>
          <td class="num">${marginPill(g.netMargin)}</td>
        </tr>`)}</tbody>
      </table></div></div>
    </section>`;
  }

  function SubscriptionSection({ subs }) {
    const t = useTokens();
    if (!subs.list.length) {
      return html`<section class="panel"><div class="empty">No recurring software charges detected. Subscriptions show up when a vendor bills at a steady weekly, monthly, quarterly or annual rhythm.</div></section>`;
    }
    const data = subs.list.slice(0, 14).map((s) => ({ ...s, fullName: s.vendor, label: truncate(s.vendor, 20), flagged: s.flags.length > 0 }));
    const h = Math.max(220, data.length * 28 + 40);
    return html`
      <div class="grid-2">
        <section class="panel">
          <div class="panel-head"><h2>Annualized cost by vendor</h2><p>Charges repeating on a steady cadence in software accounts or from known SaaS vendors, scaled to a full year.</p></div>
          <div class="panel-body">
            <div class="legend"><span><i style=${{ background: t.s2 }}></i>Flagged for review</span><span><i style=${{ background: t.neutral }}></i>No issues</span></div>
            <div style=${{ height: h }}>
              <${ResponsiveContainer} width="100%" height="100%">
                <${BarChart} data=${data} layout="vertical" margin=${{ top: 0, right: 12, bottom: 0, left: 0 }} barCategoryGap="24%">
                  <${CartesianGrid} horizontal=${false} stroke=${t.grid} />
                  <${XAxis} type="number" tickFormatter=${compactMoney} tickLine=${false} axisLine=${{ stroke: t.axis }} tick=${{ fill: t.muted, fontSize: 12 }} />
                  <${YAxis} type="category" dataKey="label" width=${150} tickLine=${false} axisLine=${false} tick=${{ fill: t.ink2, fontSize: 12 }} />
                  <${Tooltip} cursor=${{ fill: t.surface2 }} content=${html`<${ChartTooltip} rows=${(d) => [
                    { label: 'Category', value: d.category },
                    { label: `${d.cadence} charge`, value: fmtMoney(d.perCharge) },
                    { label: 'Per year', value: fmtMoney(d.annualized) },
                    ...d.flags.map((f) => ({ label: 'Flag', value: f.kind })),
                  ]} />`} />
                  <${Bar} dataKey="annualized" maxBarSize=${14} radius=${[0, 4, 4, 0]} isAnimationActive=${false}>
                    ${data.map((d) => html`<${Cell} key=${d.vendor} fill=${d.flagged ? t.s2 : t.neutral} />`)}
                  <//>
                <//>
              <//>
            </div>
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Where the waste is</h2><p>Tools that do the same job, accounts billed more than once a month, and consumer services on the business card.</p></div>
          <div class="panel-body" style=${{ display: 'grid', gap: '14px' }}>
            ${subs.overlaps.length ? html`<div class="overlaps">${subs.overlaps.map((o) => html`<div class="overlap" key=${o.category}>
              <h3>${o.category}</h3>
              <span class="tools">${o.tools.join(' · ')}</span>
              <span class="save">Save ~${fmtMoney(o.savings)}/yr by consolidating</span>
            </div>`)}</div>` : html`<div class="empty" style=${{ padding: 0 }}>${Icon.check}No overlapping tools.</div>`}
            ${subs.list.filter((s) => s.flags.some((f) => f.kind !== 'Overlapping tool')).map((s) => html`<div key=${s.vendor} style=${{ display: 'grid', gap: '2px', borderTop: '1px solid var(--hair)', paddingTop: '10px' }}>
              <strong style=${{ fontWeight: 600 }}>${s.vendor}</strong>
              ${s.flags.filter((f) => f.kind !== 'Overlapping tool').map((f) => html`<span key=${f.kind} style=${{ color: 'var(--ink-2)', fontSize: '13px' }}><span class="pill medium" style=${{ marginRight: '6px' }}>${f.kind}</span>${f.detail}</span>`)}
            </div>`)}
          </div>
        </section>
      </div>
      <section class="panel">
        <div class="panel-head"><h2>Subscription register</h2><span class="pill">${subs.list.length} subscriptions · ${fmtMoney(subs.totalAnnual)}/yr</span></div>
        <div class="panel-body flush"><div class="table-wrap"><table>
          <thead><tr><th>Vendor</th><th>Category</th><th>Cadence</th><th class="num">Charges</th><th class="num">Per charge</th><th class="num">Per year</th><th>Last charge</th><th>Flags</th><th class="num">Est. savings</th></tr></thead>
          <tbody>${subs.list.map((s) => html`<tr key=${s.vendor}>
            <td>${s.vendor}<span class="sub">${s.account}</span></td>
            <td>${s.category}</td>
            <td>${s.cadence}</td>
            <td class="num">${s.charges}</td>
            <td class="num"><${Money} v=${s.perCharge} /></td>
            <td class="num"><${Money} v=${s.annualized} /></td>
            <td class="num nowrap">${s.lastDate}</td>
            <td><div class="chips">${s.flags.length ? s.flags.map((f) => html`<span key=${f.kind} class="pill medium" title=${f.detail}>${f.kind}</span>`) : html`<span class="sub">None</span>`}</div></td>
            <td class="num">${s.savings ? html`<span class="num" style=${{ color: 'var(--good-ink)' }}>${fmtMoney(s.savings)}</span>` : html`<span class="sub">-</span>`}</td>
          </tr>`)}</tbody>
        </table></div></div>
      </section>
    `;
  }

  // ------------------------------------------------------------ customer concentration

  const FLAG_PILL = { high: 'high', medium: 'medium' };

  function CustomerRiskSection({ risk }) {
    const t = useTokens();
    if (!risk || !risk.rows.length) return null;
    const active = risk.rows.filter((r) => r.revenue > 0);
    const slots = [t.s1, t.s2, t.s3, t.s4, t.s5];
    const segs = active.slice(0, 5).map((r, i) => ({ label: r.name, share: r.share, color: slots[i] }));
    const rest = active.slice(5).reduce((s, r) => s + r.share, 0);
    if (rest > 0.0005) segs.push({ label: `Other (${active.length - 5})`, share: rest, color: t.neutral });
    const top = risk.top;
    const maxShare = Math.max(...risk.rows.map((r) => r.share), 0.01);
    return html`
      <div class="section-title"><h2>Customer concentration & risk</h2></div>
      <section class="kpis" aria-label="Concentration summary">
        <div class=${`kpi ${risk.top1Share >= 0.3 ? 'alert' : ''}`}><span class="kpi-label">Largest customer</span><span class="kpi-value">${fmtPct(risk.top1Share)}</span><span class="kpi-sub">${top.name}</span></div>
        <div class="kpi"><span class="kpi-label">Top 3 customers</span><span class="kpi-value">${fmtPct(risk.top3Share)}</span><span class="kpi-sub">of revenue, ${risk.windowLabel}</span></div>
        <div class="kpi"><span class="kpi-label">Concentration</span><span class="kpi-value"><span class=${`pill ${risk.level.tone}`} style=${{ fontSize: '13px', fontFamily: 'var(--sans)' }}><span class="dot"></span>${risk.level.label}</span></span><span class="kpi-sub">HHI ${risk.hhi.toLocaleString('en-US')} across ${risk.activeCount} customers</span></div>
        ${top.profitIfLost != null && risk.baseProfit != null && html`<div class=${`kpi ${top.profitIfLost < 0 ? 'alert' : ''}`}><span class="kpi-label">If ${truncate(top.name, 22)} left</span><span class="kpi-value">${wholeMoney(top.profitIfLost)}</span><span class="kpi-sub">monthly profit, down from ${wholeMoney(risk.baseProfit)}</span></div>`}
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Share of revenue, ${risk.windowLabel}</h2><p>Above 25% from one customer, losing them becomes a business-level risk. HHI under 1,500 is diversified; over 2,500 is highly concentrated.</p></div>
        <div class="panel-body" style=${{ display: 'grid', gap: '12px' }}>
          <div class="split-bar" role="img" aria-label=${segs.map((x) => `${x.label} ${fmtPct(x.share)}`).join(', ')}>
            ${segs.map((x) => html`<span key=${x.label} title=${`${x.label}: ${fmtPct(x.share)}`} style=${{ width: `${x.share * 100}%`, background: x.color }}></span>`)}
          </div>
          <div class="legend">${segs.map((x) => html`<span key=${x.label}><i style=${{ background: x.color }}></i>${x.label} <b class="num" style=${{ fontWeight: 500 }}>${fmtPct(x.share)}</b></span>`)}</div>
        </div>
        <div class="panel-body flush"><div class="table-wrap"><table>
          <thead><tr><th>Customer</th><th>Share of revenue</th><th class="num">Last 3 mo.</th><th class="num">Gross margin</th><th class="num">Open A/R</th><th class="num">Pays in</th><th>Flags</th><th class="num">Monthly profit if lost</th></tr></thead>
          <tbody>${risk.rows.map((r) => html`<tr key=${r.name}>
            <td>${r.name}${r.status && r.status !== 'Steady' ? html`<span class="sub">${r.status}</span>` : ''}</td>
            <td><div class="share-cell"><span class="share-bar"><span style=${{ width: `${(r.share / maxShare) * 100}%` }}></span></span><span class="num">${fmtPct(r.share)}</span></div></td>
            <td class="num">${r.status === 'New' ? html`<span class="pill good">New</span>` : r.trendPct == null ? html`<span class="sub">-</span>` : html`<span class=${r.trendPct < -0.05 ? 'neg' : ''}>${r.trendPct > 0 ? '▲' : r.trendPct < 0 ? '▼' : ''} ${fmtPct(Math.abs(r.trendPct))}</span>`}</td>
            <td class="num">${marginPill(r.margin)}</td>
            <td class="num">${r.openAR ? html`<${Money} v=${r.openAR} />` : html`<span class="sub">-</span>`}</td>
            <td class="num">${r.days != null ? `${r.days}d` : html`<span class="sub">-</span>`}</td>
            <td><div class="chips">${r.flags.length ? r.flags.map((f) => html`<span key=${f.kind} class=${`pill ${FLAG_PILL[f.level]}`} title=${f.detail}>${f.kind}</span>`) : html`<span class="sub">None</span>`}</div></td>
            <td class="num">${r.profitIfLost == null ? html`<span class="sub">-</span>` : html`<span class=${r.profitIfLost < 0 ? 'neg' : ''}>${wholeMoney(r.profitIfLost)}</span>`}</td>
          </tr>`)}</tbody>
        </table></div></div>
        <div class="panel-body"><p class="chart-note">"Monthly profit if lost" takes today's average monthly profit (${risk.baseProfit != null ? wholeMoney(risk.baseProfit) : 'n/a'}, from the Break-even tab) and removes that customer's monthly revenue less their job costs. Overhead stays, which is why a big customer leaving hurts more than their share suggests.</p></div>
      </section>
    `;
  }

  Object.assign(UI, { GrowthTab, marginPill });
})();
