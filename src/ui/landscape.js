/* Ledger Lens UI: Landscaping tab. Shown for clients set (or detected) as landscapers: winter
 * cash planning, profit by service line, contract billing and prices, labor through the season,
 * and equipment and fuel. The figures come from landscapeAnalysis() in the engine. */
(function () {
  'use strict';
  const html = htm.bind(React.createElement);
  const { ResponsiveContainer, BarChart, Bar, ComposedChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Cell, ReferenceLine } = Recharts;
  const E = window.LedgerEngine;
  const { fmtMoney, fmtPct } = E;
  const UI = window.LedgerUI;
  const { compactMoney, useTokens, ChartTooltip, wholeMoney, Banner, MoneyInput, NumberInput, Arrange, safeStore, Firm } = UI;
  const { useState } = React;

  const INDUSTRY_LABELS = { landscaping: 'Landscaping', general: 'General' };
  const monthLabel = (key) => new Date(`${key}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const marginPill = (m) => (m == null ? html`<span class="pill low">n/a</span>` : html`<span class=${`pill ${m < 0 ? 'high' : m < 0.1 ? 'medium' : 'good'} num`}>${fmtPct(m)}</span>`);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;

  // The industry setting, in the bar above the tabs: automatic unless the bookkeeper picks one.
  function IndustryPick({ value, detected, onChange }) {
    return html`<label class="industry-pick" for="industry-pick">Industry
      <select id="industry-pick" class="select" value=${value || ''} onChange=${(e) => onChange(e.target.value)}>
        <option value="">Automatic (${INDUSTRY_LABELS[detected] || 'General'})</option>
        <option value="landscaping">Landscaping</option>
        <option value="general">General</option>
      </select>
    </label>`;
  }

  function OffSeason({ o, t, inputs, setInputs }) {
    if (!o) return html`<section class="panel"><div class="empty">The winter cash plan needs at least 12 months of transactions to see the seasons.</div></section>`;
    const offNames = o.profile.filter((p) => o.offMonths.includes(p.m)).map((p) => p.label);
    const data = o.projection.map((p) => ({ ...p, fullName: p.label }));
    const tick = { fill: t.muted, fontSize: 11 };
    const short = o.low.cash < o.cushion;
    return html`<section class="panel">
      <div class="panel-head"><h2>Off-season cash plan</h2><p>Next 12 months of cash if each month goes like the same month did ${o.years > 1 ? 'on average over the last two years' : 'last year'}, before line-of-credit draws. The slow months (${offNames.join(', ')}) are shaded.</p></div>
      <div class="panel-body">
        ${short
          ? html`<${Banner} level=${o.low.cash < 0 ? 'high' : 'medium'} label=${o.low.cash < 0 ? 'Runs out' : 'Below cushion'}>Cash bottoms out at <strong>${wholeMoney(o.low.cash)}</strong> in ${o.low.label}, ${wholeMoney(o.needed)} under the ${wholeMoney(o.cushion)} cushion.${o.setAside ? html` Setting aside <strong>${wholeMoney(o.setAside)} a month</strong> over the ${plural(o.peakLeft, 'busy month')} left covers it.` : ' Arrange the line of credit before the slow months start.'}</${Banner}>`
          : html`<${Banner} level="good" label="Covered">Cash stays above the ${wholeMoney(o.cushion)} cushion; the low point is ${wholeMoney(o.low.cash)} in ${o.low.label}.</${Banner}>`}
        <div class="drawer-fields" style=${{ margin: '12px 0' }}>
          <${MoneyInput} id="ls-cushion" label="Minimum cash cushion" value=${inputs.cushion} placeholder=${Math.round(o.cushion).toLocaleString('en-US')} onChange=${(v) => setInputs((p) => ({ ...p, cushion: v }))} hint="Shared with the Cash forecast tab" />
        </div>
        <div class="legend"><span><i style=${{ background: t.s1 }}></i>Cash at month end</span><span><i style=${{ background: t.s4, height: '3px' }}></i>Cushion</span></div>
        <div style=${{ height: 240 }}>
          <${ResponsiveContainer} width="100%" height="100%">
            <${ComposedChart} data=${data} margin=${{ top: 8, right: 8, bottom: 0, left: 4 }}>
              <${CartesianGrid} vertical=${false} stroke=${t.grid} />
              <${XAxis} dataKey="label" tickLine=${false} axisLine=${{ stroke: t.axis }} tick=${tick} interval="preserveStartEnd" minTickGap=${8} />
              <${YAxis} tickFormatter=${compactMoney} tickLine=${false} axisLine=${false} tick=${{ fill: t.muted, fontSize: 12 }} width=${52} />
              <${Tooltip} cursor=${{ fill: t.surface2 }} content=${html`<${ChartTooltip} rows=${(d) => [
                { label: 'Cash at month end', value: fmtMoney(d.cash), color: t.s1 },
                { label: 'Change in the month', value: fmtMoney(d.flow) },
              ]} />`} />
              <${Bar} dataKey="flow" isAnimationActive=${false} radius=${[3, 3, 0, 0]}>
                ${data.map((d) => html`<${Cell} key=${d.key} fill=${d.flow < 0 ? t.neg : t.neutral} fillOpacity=${d.off ? 0.9 : 0.45} />`)}
              <//>
              <${Area} type="linear" dataKey="cash" stroke=${t.s1} fill=${t.s1} fillOpacity=${0.12} strokeWidth=${2} isAnimationActive=${false} />
              <${ReferenceLine} y=${o.cushion} stroke=${t.s4} strokeDasharray="4 3" />
              <${ReferenceLine} y=${0} stroke=${t.axis} />
            <//>
          <//>
        </div>
        <p class="chart-note">Bars are each month's cash in or out; darker bars are the slow months.</p>
        <ul class="insight-list">
          ${o.runway != null && html`<li><span class="pill medium"><span class="dot"></span>Runway</span><span>Winter months burn about ${wholeMoney(o.offBurn)} a month. Today's ${wholeMoney(o.cash)} lasts about ${o.runway.toFixed(1)} slow months.</span></li>`}
          ${o.ramp.length > 0 && html`<li><span class="pill medium"><span class="dot"></span>Spring ramp</span><span>${o.ramp.map((r) => r.label).join(' and ')} still ${o.ramp.length === 1 ? 'uses' : 'use'} cash (${o.ramp.map((r) => wholeMoney(r.flow)).join(', ')}): crews, materials and insurance start before the first contract payments come in.</span></li>`}
          ${o.locDraws.length > 0 && html`<li><span class="pill low"><span class="dot"></span>Line of credit</span><span>Drawn ${o.locDraws.map((d) => `${wholeMoney(d.amount)} on ${d.date}`).join(', ')}. Draws are left out of the plan above, so it shows what the business covers on its own.</span></li>`}
        </ul>
      </div>
    </section>`;
  }

  function ServiceLines({ s }) {
    if (!s) return html`<section class="panel"><div class="empty">Profit by service line needs income split by line: use QuickBooks classes (Maintenance, Installation, Snow...) or separate income accounts for each.</div></section>`;
    return html`<section class="panel">
      <div class="panel-head"><h2>Profit by service line</h2><p>Last 12 months (${s.window}). Crew wages, materials and other costs go to a line from their ${s.byClass ? 'class' : 'account name'}; shared overhead (rent, office, insurance...) is spread by each line's share of revenue.</p></div>
      ${s.losing.length > 0 && html`<div class="panel-body"><${Banner} level="high" label="Losing money">${s.losing.map((r) => `${r.label} lost ${wholeMoney(-r.net)}`).join('; ')} after its share of overhead. Look at pricing, crew hours and materials for ${s.losing.length === 1 ? 'that line' : 'those lines'}.</${Banner}></div>`}
      <div class="panel-body flush"><div class="table-wrap"><table>
        <thead><tr><th>Service line</th><th class="num">Revenue</th><th class="num">Crew labor</th><th class="num">Materials</th><th class="num">Other direct</th><th class="num">Gross margin</th><th class="num">Overhead share</th><th class="num">Net</th><th class="num">Net margin</th><th class="num">vs last year</th></tr></thead>
        <tbody>${s.rows.map((r) => html`<tr key=${r.key}>
          <td>${r.label}<span class="sub">${fmtPct(r.share)} of revenue</span></td>
          <td class="num">${wholeMoney(r.revenue)}</td>
          <td class="num">${wholeMoney(r.labor)}</td>
          <td class="num">${wholeMoney(r.materials)}</td>
          <td class="num">${wholeMoney(r.other)}</td>
          <td class="num">${marginPill(r.grossMargin)}</td>
          <td class="num">${wholeMoney(r.overhead)}</td>
          <td class=${`num ${r.net < 0 ? 'neg' : ''}`}>${wholeMoney(r.net)}</td>
          <td class="num">${marginPill(r.netMargin)}</td>
          <td class="num">${r.change == null ? '' : `${r.change > 0 ? '+' : ''}${fmtPct(r.change)}`}</td>
        </tr>`)}</tbody>
      </table></div></div>
      ${!s.byClass && html`<div class="panel-body"><p class="hint">Crew wages are not split by line, so labor shows only where an account names the line. Turning on class tracking for payroll in QuickBooks makes this exact.</p></div>`}
    </section>`;
  }

  function Contracts({ c }) {
    if (!c) return html`<section class="panel"><div class="empty">No customers billed the same amount month after month, so there are no maintenance or snow contracts to check.</div></section>`;
    return html`<section class="panel">
      <div class="panel-head"><h2>Contract billing and prices</h2><p>${plural(c.customers.length, 'customer')} billed a steady amount each month. A month with no invoice for a contract customer is often a missed bill; a price that hasn't moved in a year is money left on the table.</p></div>
      <div class="panel-body">
        <h3 class="sub-head">Contract invoices not sent ${c.missed.length ? html`<span class="pill high"><span class="dot"></span>${wholeMoney(c.missedTotal)}</span>` : ''}</h3>
        ${c.missed.length
          ? html`<div class="table-wrap"><table>
              <thead><tr><th>Customer</th><th>Line</th><th>Month missing</th><th class="num">Usual invoice</th></tr></thead>
              <tbody>${c.missed.map((m) => html`<tr key=${`${m.name}-${m.month}-${m.line}`}><td>${m.name}</td><td>${m.line}</td><td>${monthLabel(m.month)}</td><td class="num">${fmtMoney(m.amount)}</td></tr>`)}</tbody>
            </table></div>`
          : html`<p class="hint">Every contract customer was billed in the last three months.</p>`}
        <h3 class="sub-head" style=${{ marginTop: '18px' }}>Prices not raised in a year or more ${c.stale.length ? html`<span class="pill medium"><span class="dot"></span>${wholeMoney(c.staleYearly)} a year at 5%</span>` : ''}</h3>
        ${c.stale.length
          ? html`<div class="table-wrap"><table>
              <thead><tr><th>Customer</th><th>Line</th><th class="num">Monthly price</th><th>Same since</th><th class="num">A 5% increase adds</th></tr></thead>
              <tbody>${c.stale.map((m) => html`<tr key=${`${m.name}-${m.line}`}><td>${m.name}</td><td>${m.line}</td><td class="num">${fmtMoney(m.amount)}</td><td>${monthLabel(m.since)}<span class="sub">${plural(m.months, 'month')}</span></td><td class="num">${wholeMoney(m.yearly)} a year</td></tr>`)}</tbody>
            </table></div>
            <p class="hint">Fuel, wages and insurance go up every year. Contracts renewed at the same price quietly lose margin.</p>`
          : html`<p class="hint">Every contract price changed within the last year.</p>`}
      </div>
    </section>`;
  }

  function Labor({ l, t }) {
    if (!l) return html`<section class="panel"><div class="empty">Labor by month needs payroll accounts (wages, payroll taxes) and at least six months.</div></section>`;
    const data = l.months.map((m) => ({ ...m, fullName: m.label, pct: m.ratio == null ? null : Math.round(m.ratio * 1000) / 10 }));
    const tick = { fill: t.muted, fontSize: 11 };
    const top = Math.min(150, Math.max(60, ...data.map((d) => d.pct || 0)));
    return html`<section class="panel">
      <div class="panel-head"><h2>Labor through the season</h2><p>Wages, overtime and payroll taxes as a share of each month's revenue. Landscapers usually run ${Math.round(l.band.low * 100)} to ${Math.round(l.band.high * 100)}%; winter months with a year-round crew run higher.${l.ratio != null ? ` Last 12 months: ${fmtPct(l.ratio)}.` : ''}</p></div>
      <div class="panel-body">
        <div class="legend"><span><i style=${{ background: t.s2 }}></i>Labor % of revenue</span><span><i style=${{ background: t.neg }}></i>Above ${Math.round(l.band.high * 100)}%</span></div>
        <div style=${{ height: 220 }}>
          <${ResponsiveContainer} width="100%" height="100%">
            <${BarChart} data=${data} margin=${{ top: 8, right: 8, bottom: 0, left: 4 }} barCategoryGap="20%">
              <${CartesianGrid} vertical=${false} stroke=${t.grid} />
              <${XAxis} dataKey="label" tickLine=${false} axisLine=${{ stroke: t.axis }} tick=${tick} interval="preserveStartEnd" minTickGap=${8} />
              <${YAxis} domain=${[0, top]} allowDataOverflow=${true} tickFormatter=${(v) => `${v}%`} tickLine=${false} axisLine=${false} tick=${{ fill: t.muted, fontSize: 12 }} width=${44} />
              <${Tooltip} cursor=${{ fill: t.surface2 }} content=${html`<${ChartTooltip} rows=${(d) => [
                { label: 'Labor', value: fmtMoney(d.labor), color: t.s2 },
                { label: 'Revenue', value: fmtMoney(d.revenue) },
                { label: 'Labor % of revenue', value: d.pct == null ? 'n/a' : `${d.pct.toFixed(1)}%` },
                ...(l.hasOvertime ? [{ label: 'Overtime', value: fmtMoney(d.overtime) }] : []),
              ]} />`} />
              <${ReferenceLine} y=${l.band.high * 100} stroke=${t.axis} strokeDasharray="4 3" />
              <${Bar} dataKey="pct" isAnimationActive=${false} radius=${[3, 3, 0, 0]}>
                ${data.map((d) => html`<${Cell} key=${d.key} fill=${d.ratio != null && d.ratio > l.band.high ? t.neg : t.s2} />`)}
              <//>
            <//>
          <//>
        </div>
        ${l.flags.length
          ? html`<ul class="insight-list">${l.flags.map((f) => html`<li key=${`${f.key}-${f.kind}`}><span class=${`pill ${f.kind === 'Labor high' ? 'medium' : 'high'}`}><span class="dot"></span>${f.kind}</span><span>${f.text}</span></li>`)}</ul>`
          : html`<p class="hint">No month in the last year stood out.</p>`}
      </div>
    </section>`;
  }

  function Equipment({ e }) {
    if (!e) return null;
    const rows = [['Fuel', e.fuel], ['Equipment repairs', e.repairs], ['Vehicle repairs', e.vehicle], ['Rentals and leases', e.rental], ['Equipment and truck loan payments', e.loanPayments], ['Depreciation', e.depreciation]].filter(([, v]) => v > 0);
    return html`<section class="panel">
      <div class="panel-head"><h2>Equipment and fuel</h2><p>What the fleet costs over the last 12 months${e.perDollar != null ? html`: <strong>${Math.round(e.perDollar * 100)}¢ of every revenue dollar</strong>` : ''}.${e.fuelShare != null && e.fuelSharePrior != null ? ` Fuel was ${fmtPct(e.fuelShare)} of revenue, against ${fmtPct(e.fuelSharePrior)} the year before.` : ''}</p></div>
      <div class="panel-body flush"><div class="table-wrap"><table>
        <thead><tr><th>Cost</th><th class="num">Last 12 months</th><th class="num">Per revenue dollar</th></tr></thead>
        <tbody>${rows.map(([label, v]) => html`<tr key=${label}><td>${label}</td><td class="num">${wholeMoney(v)}</td><td class="num">${e.revenue ? `${(v / e.revenue * 100).toFixed(1)}¢` : ''}</td></tr>`)}
          <tr class="total"><td>Total</td><td class="num">${wholeMoney(e.total)}</td><td class="num">${e.perDollar != null ? `${(e.perDollar * 100).toFixed(1)}¢` : ''}</td></tr></tbody>
      </table></div></div>
      <div class="panel-body">
        <h3 class="sub-head">Machines that keep breaking down</h3>
        ${e.repeat.length
          ? html`<ul class="insight-list">${e.repeat.map((r) => html`<li key=${r.machine}><span class="pill medium"><span class="dot"></span>${plural(r.count, 'repair')}</span><span><strong>${r.machine}</strong>: ${wholeMoney(r.total)} in repairs between ${r.first} and ${r.last}. Compare with the cost of replacing it.</span></li>`)}</ul>`
          : html`<p class="hint">No machine had three or more repairs in the last year. Naming the machine in the memo (for example "Exmark #3 - belts") lets this check find repeat repairs.</p>`}
        <h3 class="sub-head" style=${{ marginTop: '18px' }}>Equipment purchases coded as expenses</h3>
        ${e.capitalize.length
          ? html`<div class="table-wrap"><table>
              <thead><tr><th>Date</th><th>Vendor</th><th>Memo</th><th>Coded to</th><th class="num">Amount</th></tr></thead>
              <tbody>${e.capitalize.map((x) => html`<tr key=${`${x.date}-${x.amount}`}><td>${x.date}</td><td>${x.vendor}</td><td>${x.memo}</td><td>${x.account}</td><td class="num">${fmtMoney(x.amount)}</td></tr>`)}</tbody>
            </table></div>
            <p class="hint">Machines and tools of $2,500 or more usually belong on the balance sheet as fixed assets and are depreciated (or written off under Section 179 at tax time), not expensed as repairs or supplies.</p>`
          : html`<p class="hint">No purchase of $2,500 or more looks like equipment coded to an expense account.</p>`}
      </div>
    </section>`;
  }


  // Profit playbook: Mark's habits that save landscapers time and money, each with the client's
  // own number where the books show it. Crew time uses assumptions the bookkeeper can change.
  const PB_DEFAULTS = { crew: '3', wage: '22', stopMinutes: '20', runMinutes: '45' };
  function Playbook({ pb, growth: g0 }) {
    const [a, setA] = useState(() => { try { return { ...PB_DEFAULTS, ...JSON.parse(safeStore.get('ll.playbook') || '{}') }; } catch (e) { return { ...PB_DEFAULTS }; } });
    const set = (k) => (v) => setA((p) => { const n = { ...p, [k]: v }; safeStore.set('ll.playbook', JSON.stringify(n)); return n; });
    if (!pb) return null;
    const c = E.playbookCost(pb, a);
    const g = pb.growth;
    const bench = Firm.landscapeGrowth;
    const pct = (v) => `${v > 0 ? '+' : ''}${fmtPct(v)}`;
    const item = (level, label, title, body, tip) => html`<li><span class=${`pill ${level}`}><span class="dot"></span>${label}</span><div><strong>${title}</strong><p>${body}</p>${tip && html`<p class="hint">${tip}</p>`}</div></li>`;
    return html`<section class="panel">
      <div class="panel-head"><h2>Profit playbook</h2><p>Habits that saved a growing landscaper time and money, with this client's numbers from the last 12 months where the books show them.</p></div>
      <div class="panel-body">
        <div class="growth-strip">
          <div><span class="kpi-label">Revenue, last 12 months</span><span class="kpi-value">${wholeMoney(g.ttm)}</span><span class="kpi-sub">${g.ttmChange != null ? `${pct(g.ttmChange)} on the 12 months before` : 'Needs two years to compare'}</span></div>
          ${g.perYear != null && html`<div><span class="kpi-label">Average growth</span><span class="kpi-value">${pct(g.perYear)} a year</span><span class="kpi-sub">${g.years[0].year} to ${g.years[g.years.length - 1].year}, ${pct(g.total)} in all</span></div>`}
          ${bench && html`<div class="bench"><span class="kpi-label">Benchmark</span><span class="kpi-value">${pct(bench.perYear)} a year</span><span class="kpi-sub">${bench.text}</span></div>`}
        </div>
        <details class="assumptions"><summary>Crew time assumptions: ${c.crew} people, ${wholeMoney(c.wage)} an hour, ${c.stopMin} min a fuel stop, ${c.runMin} min a supply run</summary>
          <div class="drawer-fields">
            <${NumberInput} id="pb-crew" label="Crew size" value=${a.crew} onChange=${set('crew')} suffix="people" />
            <${MoneyInput} id="pb-wage" label="Crew wage" value=${a.wage} onChange=${set('wage')} hint="Per person per hour, with payroll taxes" />
            <${NumberInput} id="pb-stop" label="Fuel stop" value=${a.stopMinutes} onChange=${set('stopMinutes')} suffix="min" />
            <${NumberInput} id="pb-run" label="Supply run" value=${a.runMinutes} onChange=${set('runMinutes')} suffix="min" />
          </div>
        </details>
        <ul class="insight-list playbook">
          ${pb.fuel.stops > 0 && item(pb.fuel.stops >= 52 ? 'high' : 'medium', 'Fuel stops', `${pb.fuel.stops} fill-ups at gas stations: about ${c.fuelHours} crew hours, ${wholeMoney(c.fuelCost)} in wages`,
            `${pb.fuel.vendors.map((v) => `${v.vendor} ${v.count}×`).join(', ')}. Every stop idles the whole crew.`,
            'Keep fuel at the shop (a tank or bulk delivery), or have the crew lead fill up alone before or after the shift.')}
          ${pb.supply.runs > 0 && item(pb.supply.runs >= 52 ? 'high' : 'medium', 'Supply runs', `${pb.supply.runs} small purchases at hardware and supply stores, about ${(pb.supply.runs / 52).toFixed(1)} a week: ${c.runHours} crew hours, ${wholeMoney(c.runCost)} in wages`,
            `${pb.supply.vendors.map((v) => `${v.vendor} ${v.count}× (${wholeMoney(v.total)})`).join(', ')}.`,
            'Stock spare tools and daily-use items at the shop, buy them in bulk or online, and keep as much inventory as you can safely store.')}
          ${pb.fees.count > 0 && item('medium', 'Vendor fees', `${wholeMoney(pb.fees.total)} in delivery, freight and restocking fees on ${pb.fees.count} tickets`,
            `${pb.fees.vendors.map((v) => `${v.vendor}: ${v.count}× ${wholeMoney(v.total)}`).join('; ')}.`,
            'Ask regular vendors to drop flat per-ticket delivery charges or combine deliveries, and check restocking terms before returning items.')}
          ${pb.customers.newCount > 0 && item('good', 'New customers', `${pb.customers.newCount} new customers in the last 12 months${pb.customers.perCustomer ? `, about ${wholeMoney(pb.customers.perCustomer)} of advertising each` : ''}`,
            `${wholeMoney(pb.customers.adSpend)} spent on advertising and mailers.`,
            'After signing a project, mail the whole neighborhood, and offer homeowners a future discount for referrals.')}
          ${pb.fuel.stops === 0 && pb.supply.runs === 0 && pb.fees.count === 0 && html`<li><span>No fuel stops, supply runs or vendor fees found in the last 12 months.</span></li>`}
        </ul>
      </div>
      ${pb.vendors.length > 0 && html`<div class="panel-body flush"><div class="table-wrap"><table>
        <thead><tr><th>Vendor (materials, parts, equipment)</th><th class="num">Last 12 months</th><th class="num">Purchases</th><th>Paid by</th><th>Worth trying</th></tr></thead>
        <tbody>${pb.vendors.map((v) => html`<tr key=${v.vendor}><td>${v.vendor}</td><td class="num">${wholeMoney(v.total)}</td><td class="num">${v.purchases}</td><td>${v.paidBy}</td><td>${v.advice}</td></tr>`)}</tbody>
      </table></div></div>`}
      <div class="panel-body">
        <div class="grid-2 tips">
          <div><h3 class="sub-head">Lawn crews</h3><ul>${E.PLAYBOOK_TIPS.lawn.map((t) => html`<li key=${t}>${t}</li>`)}</ul></div>
          <div><h3 class="sub-head">Landscape and installs</h3><ul>${E.PLAYBOOK_TIPS.landscape.map((t) => html`<li key=${t}>${t}</li>`)}</ul></div>
        </div>
      </div>
    </section>`;
  }

  function LandscapeTab({ result, inputs, setInputs }) {
    const t = useTokens();
    const L = result.landscape;
    if (!L) return html`<section class="panel"><div class="empty">Set the industry to Landscaping (above the tabs) to see these checks.</div></section>`;
    const o = L.offSeason, c = L.contracts, s = L.serviceLines, e = L.equipment;
    return html`
      <section class="kpis" aria-label="Landscaping summary">
        <div class=${`kpi ${o && o.low.cash < o.cushion ? 'alert' : ''}`}><span class="kpi-label">Winter low point</span><span class="kpi-value">${o ? wholeMoney(o.low.cash) : 'n/a'}</span><span class="kpi-sub">${o ? `${o.low.label}${o.setAside ? ` · set aside ${wholeMoney(o.setAside)}/mo` : ''}` : 'Needs 12 months'}</span></div>
        <div class=${`kpi ${c && c.missed.length ? 'alert' : ''}`}><span class="kpi-label">Contract invoices not sent</span><span class="kpi-value">${c ? c.missed.length : 0}</span><span class="kpi-sub">${c && c.missed.length ? wholeMoney(c.missedTotal) : 'None found'}</span></div>
        <div class="kpi"><span class="kpi-label">Prices unchanged a year+</span><span class="kpi-value">${c ? c.stale.length : 0}</span><span class="kpi-sub">${c && c.stale.length ? `${wholeMoney(c.staleYearly)}/yr at 5%` : 'None found'}</span></div>
        <div class=${`kpi ${s && s.losing.length ? 'alert' : ''}`}><span class="kpi-label">Service lines losing money</span><span class="kpi-value">${s ? s.losing.length : 'n/a'}</span><span class="kpi-sub">${s && s.losing.length ? s.losing.map((r) => r.label).join(', ') : s ? 'All profitable' : 'Needs classes'}</span></div>
        <div class="kpi"><span class="kpi-label">Fleet cost per $1</span><span class="kpi-value">${e && e.perDollar != null ? `${Math.round(e.perDollar * 100)}¢` : 'n/a'}</span><span class="kpi-sub">Fuel, repairs, loans</span></div>
      </section>
      <${Arrange} page="landscape" parts=${[
        ['offseason', 'Off-season cash plan', html`<${OffSeason} o=${o} t=${t} inputs=${inputs} setInputs=${setInputs} />`],
        ['lines', 'Profit by service line', html`<${ServiceLines} s=${s} />`],
        ['contracts', 'Contract billing and prices', html`<${Contracts} c=${c} />`],
        ['labor', 'Labor through the season', html`<${Labor} l=${L.labor} t=${t} />`],
        ['equipment', 'Equipment and fuel', html`<${Equipment} e=${e} />`],
        ['playbook', 'Profit playbook', html`<${Playbook} pb=${L.playbook} />`],
      ]} />`;
  }

  Object.assign(UI, { LandscapeTab, IndustryPick });
})();
