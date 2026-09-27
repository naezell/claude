/* Ledger Lens UI: Cash forecast tab and what-if scenarios. */
(function () {
  'use strict';
  const { useMemo } = React;
  const html = htm.bind(React.createElement);
  const { ResponsiveContainer, BarChart, Bar, Area, Line, ComposedChart, XAxis, YAxis, CartesianGrid, Tooltip, Cell, ReferenceLine } = Recharts;
  const E = window.LedgerEngine;
  const { fmtMoney } = E;
  const UI = window.LedgerUI;
  const { compactMoney, truncate, useTokens, Icon, Severity, Money, ChartTooltip, shortDate, wholeMoney, Banner, MoneyInput, NumberInput, Arrange } = UI;

  // ------------------------------------------------------------ cash forecast tab

  function CashTab({ cash: baseCash, scenarioCash, scenario, setScenario, inputs, setInputs, cushion, defaultCushion }) {
    const t = useTokens();
    if (!baseCash) return html`<section class="panel"><div class="empty">Not enough dated transactions to build a forecast.</div></section>`;
    // With what-if changes, every figure below shows the changed forecast; the chart keeps the baseline for comparison.
    const cash = scenarioCash || baseCash;
    const was = (v) => (scenarioCash ? ` · was ${wholeMoney(v)}` : '');
    const set = (k) => (v) => setInputs({ ...inputs, [k]: v });
    const below = cash.weeks.filter((w) => w.ending < cushion);
    const low = cash.lowest;
    const lowIdx = low.week - 1;
    const drivers = cash.outflowRows.map((r) => ({ label: r.label, v: r.values[lowIdx] })).filter((r) => r.v > 0 && !/run-rate/.test(r.label)).sort((a, b) => b.v - a.v).slice(0, 2);
    const driverText = drivers.length ? ` ${drivers.map((d) => `${d.label} (${wholeMoney(d.v)})`).join(' and ')} land${drivers.length === 1 ? 's' : ''} that week.` : '';
    const chartData = [{ label: 'Today', ending: cash.startingCash, baseline: baseCash.startingCash, start: cash.start }, ...cash.weeks.map((w, i) => ({ ...w, baseline: baseCash.weeks[i].ending, label: shortDate(w.start) }))];
    const minY = Math.min(0, ...chartData.map((d) => d.ending));

    return html`
      <section class="panel">
        <div class="panel-body inputs-row">
          <${MoneyInput} id="starting-cash" label="Starting cash" value=${inputs.startingCash} placeholder=${Math.round(cash.estimatedCash).toLocaleString('en-US')} onChange=${set('startingCash')}
            hint=${cash.cashAccounts.length ? `Estimated from ${cash.cashAccounts.join(', ')} on ${cash.asOf}` : 'No bank account in the export; enter today’s balance'} />
          <${MoneyInput} id="cash-cushion" label="Minimum cash cushion" value=${inputs.cushion} placeholder=${defaultCushion.toLocaleString('en-US')} onChange=${set('cushion')} hint="Defaults to one month of fixed costs" />
          <label class="check" for="include-doubtful"><input id="include-doubtful" type="checkbox" checked=${inputs.includeDoubtful} onChange=${(e) => setInputs({ ...inputs, includeDoubtful: e.target.checked })} />Count invoices over 90 days old</label>
        </div>
      </section>

      <${ScenarioPanel} scenario=${scenario} setScenario=${setScenario} base=${baseCash} changed=${scenarioCash} cushion=${cushion} />

      ${cash.firstNegative
        ? html`<${Banner} level="high" label="Cash shortfall">Cash runs out in the week of <strong>${shortDate(cash.firstNegative.start)}</strong>, reaching ${wholeMoney(low.ending)} by ${shortDate(low.start)}.${driverText}</${Banner}>`
        : below.length
          ? html`<${Banner} level="medium" label="Below cushion">Cash dips below your ${wholeMoney(cushion)} cushion in <strong>${below.length} of 13 weeks</strong>, bottoming at <strong>${wholeMoney(low.ending)}</strong> the week of ${shortDate(low.start)}.${driverText}</${Banner}>`
          : html`<${Banner} level="good" label="Healthy">Cash stays above your ${wholeMoney(cushion)} cushion for all 13 weeks. The lowest point is ${wholeMoney(low.ending)} the week of ${shortDate(low.start)}.</${Banner}>`}

      ${cash.ap.duplicateTotal > 0 && html`<${Banner} level="medium" label="Check before paying">${wholeMoney(cash.ap.duplicateTotal)} of open bills match entries the audit flags as possible duplicates. They are still in the forecast; void them in QuickBooks if they are duplicates.</${Banner}>`}

      <section class="kpis" aria-label="Cash summary">
        <div class="kpi"><span class="kpi-label">Starting cash</span><span class="kpi-value">${wholeMoney(cash.startingCash)}</span><span class="kpi-sub">${inputs.startingCash !== '' ? 'Entered manually' : `As of ${cash.asOf}`}</span></div>
        <div class=${`kpi ${low.ending < 0 ? 'alert' : ''}`}><span class="kpi-label">Lowest balance</span><span class="kpi-value">${wholeMoney(low.ending)}</span><span class="kpi-sub">Week of ${shortDate(low.start)}${was(baseCash.lowest.ending)}</span></div>
        <div class="kpi"><span class="kpi-label">Cash at week 13</span><span class="kpi-value">${wholeMoney(cash.totals.ending)}</span><span class="kpi-sub">${scenarioCash ? `was ${wholeMoney(baseCash.totals.ending)}` : `${wholeMoney(cash.totals.inflow)} in · ${wholeMoney(cash.totals.outflow)} out`}</span></div>
        <div class=${`kpi ${cash.ar.doubtfulTotal ? 'alert' : ''}`}><span class="kpi-label">Open receivables</span><span class="kpi-value">${wholeMoney(cash.ar.total)}</span><span class="kpi-sub">${cash.ar.doubtfulTotal ? `${wholeMoney(cash.ar.doubtfulTotal)} over 90 days` : 'Nothing over 90 days'}</span></div>
        <div class="kpi"><span class="kpi-label">Open bills</span><span class="kpi-value">${wholeMoney(cash.ap.total)}</span><span class="kpi-sub">${cash.ap.openBills.length} unpaid${cash.cardBalance ? ` + ${wholeMoney(cash.cardBalance)} on cards` : ''}</span></div>
      </section>

      <${Arrange} page="cash" parts=${[
        ["charts", "Cash balance and cash in vs. out", html`
        <div class="grid-2">
          <section class="panel">
            <div class="panel-head"><h2>Projected cash balance</h2><p>Cash at the end of each week. Points below your cushion are marked red.</p></div>
            <div class="panel-body">
              <div class="legend"><span><i style=${{ background: t.s1 }}></i>${scenarioCash ? 'With your changes' : 'Ending cash'}</span>${scenarioCash && html`<span><i style=${{ background: t.neutral, height: '3px' }}></i>Baseline</span>`}<span><i style=${{ background: t.warnLine, height: '2px' }}></i>Cushion</span></div>
              <div style=${{ height: 260 }}>
                <${ResponsiveContainer} width="100%" height="100%">
                  <${ComposedChart} data=${chartData} margin=${{ top: 8, right: 12, bottom: 0, left: 4 }}>
                    <${CartesianGrid} vertical=${false} stroke=${t.grid} />
                    <${XAxis} dataKey="label" tickLine=${false} axisLine=${{ stroke: t.axis }} tick=${{ fill: t.muted, fontSize: 11 }} interval="preserveStartEnd" minTickGap=${12} />
                    <${YAxis} domain=${[minY < 0 ? 'auto' : 0, 'auto']} tickFormatter=${compactMoney} tickLine=${false} axisLine=${false} tick=${{ fill: t.muted, fontSize: 12 }} width=${52} />
                    <${ReferenceLine} y=${cushion} stroke=${t.warnLine} strokeWidth=${2} />
                    ${minY < 0 && html`<${ReferenceLine} y=${0} stroke=${t.axis} />`}
                    <${Tooltip} cursor=${{ stroke: t.axis }} content=${html`<${ChartTooltip} rows=${(d) => d.week ? [
                      { label: 'Cash in', value: fmtMoney(d.inflow) },
                      { label: 'Cash out', value: fmtMoney(d.outflow) },
                      { label: 'Ending cash', value: fmtMoney(d.ending), color: t.s1 },
                    ].concat(scenarioCash ? [{ label: 'Baseline', value: fmtMoney(d.baseline), color: t.neutral }] : []) : [{ label: 'Starting cash', value: fmtMoney(d.ending), color: t.s1 }]} />`} />
                    ${scenarioCash && html`<${Line} type="linear" dataKey="baseline" stroke=${t.neutral} strokeWidth=${2} dot=${false} isAnimationActive=${false} />`}
                    <${Area} type="linear" dataKey="ending" stroke=${t.s1} strokeWidth=${2} fill=${t.s1} fillOpacity=${0.12} isAnimationActive=${false}
                      dot=${(p) => html`<circle key=${p.index} cx=${p.cx} cy=${p.cy} r=${p.payload.ending < cushion ? 5 : 3.5} fill=${p.payload.ending < cushion ? t.neg : t.s1} stroke=${t.surface} strokeWidth=${2} />`}
                      activeDot=${{ r: 6, stroke: t.surface, strokeWidth: 2 }} />
                  <//>
                <//>
              </div>
            </div>
          </section>
          <section class="panel">
            <div class="panel-head"><h2>Cash in vs. cash out</h2><p>Weeks where payroll and bills cluster ahead of collections are the pinch points.</p></div>
            <div class="panel-body">
              <div class="legend"><span><i style=${{ background: t.s1 }}></i>Cash in</span><span><i style=${{ background: t.s2 }}></i>Cash out</span></div>
              <div style=${{ height: 260 }}>
                <${ResponsiveContainer} width="100%" height="100%">
                  <${BarChart} data=${chartData.slice(1)} margin=${{ top: 8, right: 8, bottom: 0, left: 4 }} barGap=${2} barCategoryGap="22%">
                    <${CartesianGrid} vertical=${false} stroke=${t.grid} />
                    <${XAxis} dataKey="label" tickLine=${false} axisLine=${{ stroke: t.axis }} tick=${{ fill: t.muted, fontSize: 11 }} interval="preserveStartEnd" minTickGap=${12} />
                    <${YAxis} tickFormatter=${compactMoney} tickLine=${false} axisLine=${false} tick=${{ fill: t.muted, fontSize: 12 }} width=${52} />
                    <${Tooltip} cursor=${{ fill: t.surface2 }} content=${html`<${ChartTooltip} rows=${(d) => [
                      { label: 'Cash in', value: fmtMoney(d.inflow), color: t.s1 },
                      { label: 'Cash out', value: fmtMoney(d.outflow), color: t.s2 },
                      { label: 'Net', value: fmtMoney(d.net) },
                    ]} />`} />
                    <${Bar} dataKey="inflow" fill=${t.s1} radius=${[4, 4, 0, 0]} maxBarSize=${14} isAnimationActive=${false} />
                    <${Bar} dataKey="outflow" fill=${t.s2} radius=${[4, 4, 0, 0]} maxBarSize=${14} isAnimationActive=${false} />
                  <//>
                <//>
              </div>
            </div>
          </section>
        </div>
        `],
        ["weeks", "Week by week", html`
        <${WeekGrid} cash=${cash} cushion=${cushion} />
        `],
        ["receivables", "Receivables & payables", html`
        <div class="section-title"><h2>Receivables & payables</h2></div>
        <div class="grid-2">
          <${AgingPanel} ar=${cash.ar} includeDoubtful=${inputs.includeDoubtful} />
          <${PaymentSpeedChart} lags=${cash.ar.customerLags} />
        </div>
        `],
        ["invoices", "Open invoices", html`
        <${OpenInvoices} ar=${cash.ar} includeDoubtful=${inputs.includeDoubtful} />
        `],
        ["bills", "Open bills", html`
        <${OpenBills} ap=${cash.ap} />
        `],
        ["method", "How this forecast is built", html`
        <details class="panel mapping">
          <summary>How this forecast is built</summary>
          <div class="panel-body"><ul class="assumptions">${cash.assumptions.map((a) => html`<li key=${a}>${a}</li>`)}</ul></div>
        </details>
        `],
      ]} />
    `;
  }

  // ------------------------------------------------------------ what-if scenarios

  const LEVER_TYPES = [
    ['delay', 'A customer pays later'],
    ['lose', 'Lose a customer'],
    ['sales', 'Sales go up or down'],
    ['monthly', 'New monthly cost (hire, lease)'],
    ['payment', 'One-time payment'],
    ['receipt', 'One-time money in (loan, owner)'],
  ];

  function ScenarioPanel({ scenario, setScenario, base, changed, cushion }) {
    const levers = scenario.levers;
    const customers = useMemo(() => [...new Set([...base.ar.openInvoices.map((i) => i.party), ...base.newBillings.map((b) => b.customer), ...base.ar.customerLags.map((l) => l.name)])].sort(), [base]);
    const firstNext = (() => { const d = new Date(`${base.asOf}T00:00:00Z`); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10); })();
    const inAMonth = (() => { const d = new Date(`${base.asOf}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 30); return d.toISOString().slice(0, 10); })();
    const defaults = {
      delay: { customer: customers[0] || '', days: '30' }, lose: { customer: customers[0] || '' }, sales: { pct: '-10' },
      monthly: { label: 'New hire', amount: '', date: firstNext }, payment: { label: 'Equipment purchase', amount: '', date: inAMonth }, receipt: { label: 'Loan proceeds', amount: '', date: inAMonth },
    };
    const add = (type) => setScenario({ levers: [...levers, { id: Date.now() + Math.random(), type, ...defaults[type] }] });
    const upd = (id, patch) => setScenario({ levers: levers.map((l) => (l.id === id ? { ...l, ...patch } : l)) });
    const del = (id) => setScenario({ levers: levers.filter((l) => l.id !== id) });
    const belowBase = base.weeks.filter((w) => w.ending < cushion).length;
    const belowNow = changed ? changed.weeks.filter((w) => w.ending < cushion).length : belowBase;
    return html`<section class="panel">
      <div class="panel-head"><h2>What if?</h2><p>Try changes before they happen. Everything on this tab updates; the chart keeps the baseline for comparison. Changes are not saved.</p>
        ${levers.length > 0 && html`<button class="btn spacer" onClick=${() => setScenario({ levers: [] })}>Clear all</button>`}</div>
      <div class="panel-body scenario">
        ${levers.map((l) => html`<div class="lever" key=${l.id}>
          <strong>${(LEVER_TYPES.find((x) => x[0] === l.type) || [])[1]}</strong>
          <div class="lever-inputs">
            ${(l.type === 'delay' || l.type === 'lose') && html`<label class="field" for=${`lv-c-${l.id}`}>Customer<select id=${`lv-c-${l.id}`} class="select" value=${l.customer} onChange=${(e) => upd(l.id, { customer: e.target.value })}>${customers.map((c) => html`<option key=${c} value=${c}>${c}</option>`)}</select></label>`}
            ${l.type === 'delay' && html`<${NumberInput} id=${`lv-d-${l.id}`} label="Days later" suffix="days" value=${l.days} onChange=${(v) => upd(l.id, { days: v })} />`}
            ${l.type === 'sales' && html`<${NumberInput} id=${`lv-p-${l.id}`} label="Change in new billing" suffix="%" value=${l.pct} onChange=${(v) => upd(l.id, { pct: v })} />`}
            ${(l.type === 'monthly' || l.type === 'payment' || l.type === 'receipt') && html`
              <label class="field" for=${`lv-l-${l.id}`}>Label<input id=${`lv-l-${l.id}`} class="text" value=${l.label} onInput=${(e) => upd(l.id, { label: e.target.value })} /></label>
              <${NumberInput} id=${`lv-a-${l.id}`} label=${l.type === 'monthly' ? 'Per month' : 'Amount'} prefix="$" value=${l.amount} placeholder="e.g. 5,000" onChange=${(v) => upd(l.id, { amount: v })} />
              <label class="field" for=${`lv-t-${l.id}`}>${l.type === 'monthly' ? 'Starts' : 'Date'}<input id=${`lv-t-${l.id}`} class="text" type="date" value=${l.date} onInput=${(e) => upd(l.id, { date: e.target.value })} /></label>`}
          </div>
          <button class="btn" aria-label="Remove this change" onClick=${() => del(l.id)}>Remove</button>
        </div>`)}
        <label class="field add-lever" for="add-lever">Add a change
          <select id="add-lever" class="select" value="" onChange=${(e) => { if (e.target.value) add(e.target.value); e.target.value = ''; }}>
            <option value="">Choose…</option>
            ${LEVER_TYPES.map(([k, l]) => html`<option key=${k} value=${k}>${l}</option>`)}
          </select>
        </label>
        ${changed && html`<${Banner} level=${changed.lowest.ending < 0 ? 'high' : belowNow > belowBase || changed.lowest.ending < base.lowest.ending ? 'medium' : 'good'} label="With these changes">
          Lowest balance <strong>${wholeMoney(changed.lowest.ending)}</strong> (week of ${shortDate(changed.lowest.start)}), was ${wholeMoney(base.lowest.ending)}. Cash at week 13 <strong>${wholeMoney(changed.totals.ending)}</strong>, was ${wholeMoney(base.totals.ending)}. Weeks below the cushion: ${belowNow}, was ${belowBase}.${changed.firstNegative ? ` Cash runs out in the week of ${shortDate(changed.firstNegative.start)}.` : ''}
        </${Banner}>`}
      </div>
    </section>`;
  }

  function WeekGrid({ cash, cushion }) {
    const row = (r, cls) => html`<tr key=${r.label} class=${cls || ''}><th scope="row">${r.label}</th>${r.values.map((v, i) => html`<td key=${i} class="num">${wholeMoney(v)}</td>`)}<td class="num total">${wholeMoney(r.total)}</td></tr>`;
    const sum = (rows, i) => rows.reduce((s, r) => s + r.values[i], 0);
    const totalRow = (label, rows, cls) => row({ label, values: cash.weeks.map((_, i) => sum(rows, i)), total: rows.reduce((s, r) => s + r.total, 0) }, cls);
    return html`<section class="panel">
      <div class="panel-head"><h2>13-week cash flow</h2><p>The standard week-by-week view. Hover a chart above for detail, or read across a row to see when each item lands.</p></div>
      <div class="panel-body flush"><div class="table-wrap"><table class="grid13">
        <thead><tr><th>Week of</th>${cash.weeks.map((w) => html`<th key=${w.week} class="num">${shortDate(w.start)}</th>`)}<th class="num">13 weeks</th></tr></thead>
        <tbody>
          <tr class="group"><th scope="row" colspan=${cash.weeks.length + 2}>Cash in</th></tr>
          ${cash.inflowRows.map((r) => row(r))}
          ${totalRow('Total cash in', cash.inflowRows, 'subtotal')}
          <tr class="group"><th scope="row" colspan=${cash.weeks.length + 2}>Cash out</th></tr>
          ${cash.outflowRows.map((r) => row(r))}
          ${totalRow('Total cash out', cash.outflowRows, 'subtotal')}
          <tr class="subtotal"><th scope="row">Net change</th>${cash.weeks.map((w) => html`<td key=${w.week} class=${`num ${w.net < 0 ? 'neg' : ''}`}>${wholeMoney(w.net)}</td>`)}<td class="num total">${wholeMoney(cash.totals.inflow - cash.totals.outflow)}</td></tr>
          <tr class="ending"><th scope="row">Ending cash</th>${cash.weeks.map((w) => html`<td key=${w.week} class=${`num ${w.ending < 0 ? 'neg' : w.ending < cushion ? 'warn' : ''}`}>${wholeMoney(w.ending)}</td>`)}<td class="num total">${wholeMoney(cash.totals.ending)}</td></tr>
        </tbody>
      </table></div></div>
    </section>`;
  }

  function AgingPanel({ ar, includeDoubtful }) {
    const total = ar.total || 1;
    return html`<section class="panel">
      <div class="panel-head"><h2>Receivables aging</h2><span class="pill">${wholeMoney(ar.total)} open</span><p>Open invoices by age. Payments are matched to invoices by amount first, then oldest first.</p></div>
      <div class="panel-body aging">
        ${ar.buckets.map((b, i) => html`<div class=${`bucket ${i === 3 && b.amount ? 'bad' : i === 2 && b.amount ? 'warnb' : ''}`} key=${b.label}>
          <span class="kpi-label">${b.label}</span>
          <span class="bucket-value">${wholeMoney(b.amount)}</span>
          <div class="meter"><span style=${{ width: `${(b.amount / total) * 100}%`, background: i === 3 ? 'var(--critical)' : i === 2 ? 'var(--serious)' : 'var(--series-1)' }}></span></div>
          <span class="kpi-sub">${b.count} invoice${b.count === 1 ? '' : 's'}${i === 3 && b.amount ? (includeDoubtful ? ' · in forecast' : ' · left out of forecast') : ''}</span>
        </div>`)}
      </div>
    </section>`;
  }

  function PaymentSpeedChart({ lags }) {
    const t = useTokens();
    if (!lags.length) return html`<section class="panel"><div class="panel-head"><h2>How fast customers pay</h2></div><div class="empty">No paid invoices to learn from yet.</div></section>`;
    const data = lags.slice(0, 10).map((l) => ({ ...l, fullName: l.name, label: truncate(l.name, 20), slow: l.medianDays > 45 }));
    const h = Math.max(200, data.length * 30 + 40);
    return html`<section class="panel">
      <div class="panel-head"><h2>How fast customers pay</h2><p>Median days from invoice to payment. The forecast uses each customer's own number, not the terms on the invoice.</p></div>
      <div class="panel-body">
        <div class="legend"><span><i style=${{ background: t.s2 }}></i>Slower than 45 days</span><span><i style=${{ background: t.neutral }}></i>45 days or faster</span></div>
        <div style=${{ height: h }}>
          <${ResponsiveContainer} width="100%" height="100%">
            <${BarChart} data=${data} layout="vertical" margin=${{ top: 0, right: 16, bottom: 0, left: 0 }} barCategoryGap="28%">
              <${CartesianGrid} horizontal=${false} stroke=${t.grid} />
              <${XAxis} type="number" tickFormatter=${(v) => `${v}d`} tickLine=${false} axisLine=${{ stroke: t.axis }} tick=${{ fill: t.muted, fontSize: 12 }} />
              <${YAxis} type="category" dataKey="label" width=${150} tickLine=${false} axisLine=${false} tick=${{ fill: t.ink2, fontSize: 12 }} />
              <${ReferenceLine} x=${30} stroke=${t.axis} label=${{ value: 'Net 30', position: 'top', fill: t.muted, fontSize: 11 }} />
              <${Tooltip} cursor=${{ fill: t.surface2 }} content=${html`<${ChartTooltip} rows=${(d) => [
                { label: 'Median days to pay', value: `${d.medianDays}` },
                { label: 'Invoices paid', value: `${d.paid}` },
              ]} />`} />
              <${Bar} dataKey="medianDays" maxBarSize=${14} radius=${[0, 4, 4, 0]} isAnimationActive=${false}>
                ${data.map((d) => html`<${Cell} key=${d.name} fill=${d.slow ? t.s2 : t.neutral} />`)}
              <//>
            <//>
          <//>
        </div>
      </div>
    </section>`;
  }

  function OpenInvoices({ ar, includeDoubtful }) {
    return html`<section class="panel">
      <div class="panel-head"><h2>Open invoices</h2><span class="pill">${ar.openInvoices.length}</span><p>When each open invoice is expected to be paid, based on how that customer has paid before.</p></div>
      <div class="panel-body flush">${ar.openInvoices.length ? html`<div class="table-wrap"><table>
        <thead><tr><th>Status</th><th>Customer</th><th>Invoice</th><th>Date</th><th class="num">Age</th><th class="num">Open</th><th class="num">Usually pays in</th><th>Expected</th></tr></thead>
        <tbody>${ar.openInvoices.map((i) => html`<tr key=${`${i.party}-${i.num}-${i.dateStr}`}>
          <td>${i.doubtful ? html`<${Severity} level="High" />` : i.overdue ? html`<span class="pill medium"><span class="dot"></span>Late</span>` : html`<span class="pill good"><span class="dot"></span>On track</span>`}</td>
          <td>${i.party}</td>
          <td class="nowrap">${i.num ? `#${i.num}` : '-'}<span class="sub">row ${i.line}</span></td>
          <td class="num nowrap">${i.dateStr}</td>
          <td class="num">${i.age}d</td>
          <td class="num"><${Money} v=${i.open} /></td>
          <td class="num">${i.lag}d${i.lagKnown ? '' : html`<span class="sub">assumed</span>`}</td>
          <td class="nowrap">${i.doubtful && !includeDoubtful ? html`<span class="sub">Left out (over 90 days)</span>` : html`<span class="num">${i.expectedStr}</span>${i.overdue ? html`<span class="sub">past usual timing</span>` : ''}`}</td>
        </tr>`)}</tbody>
      </table></div>` : html`<div class="empty">${Icon.check}No open invoices.</div>`}</div>
    </section>`;
  }

  function OpenBills({ ap }) {
    if (!ap.openBills.length) return null;
    return html`<section class="panel">
      <div class="panel-head"><h2>Open bills</h2><span class="pill">${ap.openBills.length} · ${wholeMoney(ap.total)}</span><p>Unpaid vendor bills, scheduled on each vendor's usual payment timing.</p></div>
      <div class="panel-body flush"><div class="table-wrap"><table>
        <thead><tr><th>Vendor</th><th>Bill</th><th>Date</th><th class="num">Open</th><th>Expected payment</th></tr></thead>
        <tbody>${ap.openBills.map((b) => html`<tr key=${`${b.party}-${b.num}-${b.dateStr}`}>
          <td>${b.party}${b.possibleDuplicate ? html`<span class="sub"><span class="pill medium">Possible duplicate</span></span>` : ''}</td>
          <td class="nowrap">${b.num ? `#${b.num}` : '-'}<span class="sub">row ${b.line}</span></td>
          <td class="num nowrap">${b.dateStr}</td>
          <td class="num"><${Money} v=${b.open} /></td>
          <td class="nowrap"><span class="num">${b.dueStr}</span>${b.late ? html`<span class="sub">past usual timing</span>` : ''}</td>
        </tr>`)}</tbody>
      </table></div></div>
    </section>`;
  }

  Object.assign(UI, { CashTab });
})();
