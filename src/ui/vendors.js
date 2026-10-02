/* Ledger Lens UI: Vendors tab. */
(function () {
  'use strict';
  const { useState } = React;
  const html = htm.bind(React.createElement);
  const { ResponsiveContainer, BarChart, Bar, Line, ComposedChart, XAxis, YAxis, CartesianGrid, Tooltip, Cell, ReferenceLine } = Recharts;
  const E = window.LedgerEngine;
  const { fmtMoney, fmtPct } = E;
  const UI = window.LedgerUI;
  const { compactMoney, truncate, useTokens, Icon, Money, ChartTooltip, shortDate, wholeMoney, InsightList, Arrange } = UI;

  // ------------------------------------------------------------ vendors tab

  function AgingTiles({ buckets, total }) {
    const sum = total || 1;
    return html`<div class="aging">${buckets.map((b, i) => html`<div class=${`bucket ${i === 3 && b.amount ? 'bad' : i === 2 && b.amount ? 'warnb' : ''}`} key=${b.label}>
      <span class="kpi-label">${b.label}</span>
      <span class="bucket-value">${wholeMoney(b.amount)}</span>
      <div class="meter"><span style=${{ width: `${(b.amount / sum) * 100}%`, background: i === 3 ? 'var(--critical)' : i === 2 ? 'var(--serious)' : 'var(--series-1)' }}></span></div>
      <span class="kpi-sub">${b.count} bill${b.count === 1 ? '' : 's'}</span>
    </div>`)}</div>`;
  }

  function PriceIncreases({ prices: p }) {
    return html`<section class="panel">
      <div class="panel-head">
        <h2>Vendor price increases</h2>
        <span class="pill medium">${wholeMoney(p.annualIncrease)} a year</span>
        <p>Vendors that charge a steady amount and have raised it. The yearly cost is the increase times how often they charge. Worth a call to renegotiate, or a reason to review your own prices.</p>
      </div>
      <div class="panel-body flush">
        <div class="table-wrap"><table>
          <thead><tr><th>Vendor</th><th>Account</th><th class="num">Was</th><th class="num">Now</th><th class="num">Increase</th><th>Since</th><th class="num">Per year</th></tr></thead>
          <tbody>${p.rows.map((r) => html`<tr key=${`${r.key}|${r.account}`}>
            <td>${r.name}<span class="sub">Charged ${r.cadence}</span></td>
            <td>${r.account}</td>
            <td class="num">${fmtMoney(r.from)}</td>
            <td class="num">${fmtMoney(r.to)}</td>
            <td class="num">+${fmtPct(r.pct)}</td>
            <td class="nowrap num">${new Date(`${r.since}T00:00:00Z`).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })}</td>
            <td class="num">${wholeMoney(r.annualImpact)}</td>
          </tr>`)}</tbody>
        </table></div>
      </div>
      ${p.priceRiseToHold != null && html`<div class="panel-body"><p class="hint" style=${{ margin: 0 }}>To cover these increases without losing profit, prices would need to rise about <strong>${fmtPct(p.priceRiseToHold)}</strong> on today's sales of ${wholeMoney(p.annualRevenue)} a year.</p></div>`}
    </section>`;
  }

  function VendorsTab({ vendors: v, w9, setW9 }) {
    const t = useTokens();
    const [year, setYear] = useState(() => {
      const full = v ? [...v.tax].reverse().find((y) => y.full) : null;
      return full ? full.year : v && v.tax.length ? v.tax[v.tax.length - 1].year : null;
    });
    const [showCard, setShowCard] = useState(false);
    if (!v) return html`<section class="panel"><div class="empty">No vendor spending found in this export.</div></section>`;
    const openTotal = v.buckets.reduce((s, b) => s + b.amount, 0);
    const freed = v.earlyPay.reduce((s, e) => s + e.cashFreed, 0);
    const weekly = v.weekly.map((w) => ({ ...w, label: shortDate(w.start), fullName: `Week of ${shortDate(w.start)}` }));
    const speed = v.rows.filter((r) => r.days != null).map((r) => ({ ...r, fullName: r.name, label: truncate(r.name, 20), fast: r.days <= 10 }));
    const speedMax = Math.max(40, Math.ceil(Math.max(0, ...speed.map((r) => r.days)) / 10) * 10);
    const speedTicks = Array.from({ length: speedMax / 10 + 1 }, (_, i) => i * 10);
    const maxShare = Math.max(...v.rows.map((r) => r.share), 0.01);
    const yr = v.tax.find((y) => y.year === year) || null;
    const taxRows = yr ? yr.vendors.filter((x) => showCard || x.status !== 'Card only') : [];
    const cardCount = yr ? yr.vendors.filter((x) => x.status === 'Card only').length : 0;
    const statusPill = { Review: 'high', 'Likely exempt': 'low', 'Card only': 'low', 'Below threshold': 'medium' };

    return html`
      <${Arrange} page="vendors:top" parts=${[
        ["standout", "What stands out", html`
        ${v.insights.length > 0 && html`<section class="panel">
          <div class="panel-head"><h2>What stands out</h2><p>Vendor relationships and payment timing worth a conversation, ${v.windowLabel}. Payroll is left out.</p></div>
          <div class="panel-body"><${InsightList} items=${v.insights} /></div>
        </section>`}
        `],
      ]} />

      <section class="kpis" aria-label="Vendor summary">
        <div class="kpi"><span class="kpi-label">Vendor spending</span><span class="kpi-value">${wholeMoney(v.monthlyTotal)}</span><span class="kpi-sub">per month, ${v.vendorCount} vendors</span></div>
        <div class=${`kpi ${v.top5Share >= 0.8 ? 'alert' : ''}`}><span class="kpi-label">Top 5 vendors</span><span class="kpi-value">${fmtPct(v.top5Share)}</span><span class="kpi-sub">of spending</span></div>
        <div class="kpi"><span class="kpi-label">Days to pay vendors</span><span class="kpi-value">${v.dpo != null ? `${v.dpo} days` : 'n/a'}</span><span class="kpi-sub">${v.dso != null ? `Customers pay in ${v.dso} days` : 'Needs bills in the export'}</span></div>
        <div class="kpi"><span class="kpi-label">Open bills</span><span class="kpi-value">${wholeMoney(openTotal)}</span><span class="kpi-sub">${v.buckets[3].amount ? `${wholeMoney(v.buckets[3].amount)} over 90 days` : 'Nothing over 90 days'}</span></div>
        ${freed > 0 && html`<div class="kpi okay"><span class="kpi-label">Cash from 30-day terms</span><span class="kpi-value">${wholeMoney(freed)}</span><span class="kpi-sub">if early-paid vendors allow net 30</span></div>`}
      </section>

      <${Arrange} page="vendors" parts=${[
        ["prices", "Price increases", html`
        ${v.prices.rows.length > 0 && html`<${PriceIncreases} prices=${v.prices} />`}
        `],
        ["charts", "Bills due vs. cash, and payment speed", html`
        <div class="grid-2">
          <section class="panel">
            <div class="panel-head"><h2>Bills due vs. projected cash</h2><p>Open bills and expected monthly vendor bills in each forecast week, against the ending cash balance from the Cash forecast tab.</p></div>
            <div class="panel-body">
              <div class="legend"><span><i style=${{ background: t.s2 }}></i>Open bills</span><span><i style=${{ background: t.s4 }}></i>Expected bills</span><span><i style=${{ background: t.s1, height: '3px' }}></i>Ending cash</span></div>
              <div style=${{ height: 260 }}>
                <${ResponsiveContainer} width="100%" height="100%">
                  <${ComposedChart} data=${weekly} margin=${{ top: 8, right: 8, bottom: 0, left: 4 }} barCategoryGap="26%">
                    <${CartesianGrid} vertical=${false} stroke=${t.grid} />
                    <${XAxis} dataKey="label" tickLine=${false} axisLine=${{ stroke: t.axis }} tick=${{ fill: t.muted, fontSize: 11 }} interval="preserveStartEnd" minTickGap=${12} />
                    <${YAxis} tickFormatter=${compactMoney} tickLine=${false} axisLine=${false} tick=${{ fill: t.muted, fontSize: 12 }} width=${52} />
                    <${Tooltip} cursor=${{ fill: t.surface2 }} content=${html`<${ChartTooltip} rows=${(d) => [
                      { label: 'Open bills', value: fmtMoney(d.open), color: t.s2 },
                      { label: 'Expected bills', value: fmtMoney(d.expected), color: t.s4 },
                      { label: 'Ending cash', value: fmtMoney(d.ending), color: t.s1 },
                    ]} />`} />
                    <${Bar} dataKey="open" stackId="b" fill=${t.s2} stroke=${t.surface} strokeWidth=${1} isAnimationActive=${false} />
                    <${Bar} dataKey="expected" stackId="b" fill=${t.s4} stroke=${t.surface} strokeWidth=${1} radius=${[4, 4, 0, 0]} isAnimationActive=${false} />
                    <${Line} type="linear" dataKey="ending" stroke=${t.s1} strokeWidth=${2} dot=${{ r: 3, fill: t.s1, stroke: t.surface, strokeWidth: 2 }} isAnimationActive=${false} />
                  <//>
                <//>
              </div>
            </div>
          </section>
          <section class="panel">
            <div class="panel-head"><h2>How fast vendors get paid</h2><p>Median days from bill to payment. Paying well before the due date spends cash the business could hold onto.</p></div>
            <div class="panel-body">
              ${speed.length ? html`
                <div class="legend"><span><i style=${{ background: t.s2 }}></i>Paid within 10 days</span><span><i style=${{ background: t.neutral }}></i>Paid later</span></div>
                <div style=${{ height: Math.max(180, speed.length * 32 + 40) }}>
                  <${ResponsiveContainer} width="100%" height="100%">
                    <${BarChart} data=${speed} layout="vertical" margin=${{ top: 18, right: 16, bottom: 0, left: 0 }} barCategoryGap="28%">
                      <${CartesianGrid} horizontal=${false} stroke=${t.grid} />
                      <${XAxis} type="number" domain=${[0, speedMax]} ticks=${speedTicks} tickFormatter=${(x) => `${x}d`} tickLine=${false} axisLine=${{ stroke: t.axis }} tick=${{ fill: t.muted, fontSize: 12 }} />
                      <${YAxis} type="category" dataKey="label" width=${150} tickLine=${false} axisLine=${false} tick=${{ fill: t.ink2, fontSize: 12 }} />
                      <${ReferenceLine} x=${30} stroke=${t.axis} label=${{ value: 'Net 30', position: 'top', fill: t.muted, fontSize: 11 }} />
                      <${Tooltip} cursor=${{ fill: t.surface2 }} content=${html`<${ChartTooltip} rows=${(d) => [{ label: 'Median days to pay', value: `${d.days}` }, { label: 'Spend per month', value: fmtMoney(d.monthly) }]} />`} />
                      <${Bar} dataKey="days" maxBarSize=${14} radius=${[0, 4, 4, 0]} isAnimationActive=${false}>
                        ${speed.map((d) => html`<${Cell} key=${d.name} fill=${d.fast ? t.s2 : t.neutral} />`)}
                      <//>
                    <//>
                  <//>
                </div>` : html`<div class="empty" style=${{ padding: 0 }}>Payment timing needs bills and bill payments in the export.</div>`}
            </div>
          </section>
        </div>
        `],
        ["aging", "Payables aging", html`
        <section class="panel">
          <div class="panel-head"><h2>Payables aging</h2><span class="pill">${wholeMoney(openTotal)} open</span><p>Unpaid bills by age. Old open bills are often duplicates or bills paid outside QuickBooks; check them before paying.</p></div>
          <div class="panel-body"><${AgingTiles} buckets=${v.buckets} total=${openTotal} /></div>
        </section>
        `],
        ["list", "Vendors", html`
        <section class="panel">
          <div class="panel-head"><h2>Vendors</h2><span class="pill">${v.vendorCount} vendors · ${wholeMoney(v.monthlyTotal)}/mo</span><p>Spending ${v.windowLabel}, payroll excluded. Trend compares the last 3 months with the 3 before.</p></div>
          <div class="panel-body flush"><div class="table-wrap scroll-y"><table>
            <thead><tr><th>Vendor</th><th class="num">Per month</th><th>Share of spending</th><th>Type</th><th class="num">Last 3 mo.</th><th class="num">Pays in</th><th class="num">Open bills</th><th>Paid by</th></tr></thead>
            <tbody>${v.rows.map((r) => html`<tr key=${r.name}>
              <td>${r.name}<span class="sub">${r.account}${r.aliases && r.aliases.length ? ` · also appears as ${r.aliases.join(', ')}` : ''}</span></td>
              <td class="num">${wholeMoney(r.monthly)}</td>
              <td><div class="share-cell"><span class="share-bar"><span style=${{ width: `${(r.share / maxShare) * 100}%` }}></span></span><span class="num">${fmtPct(r.share)}</span></div></td>
              <td>${r.type}</td>
              <td class="num">${r.isNew ? html`<span class="pill good">New</span>` : r.trendPct == null ? html`<span class="sub">-</span>` : html`<span class=${r.trendPct > 0.1 ? 'neg' : ''}>${r.trendPct > 0 ? '▲' : r.trendPct < 0 ? '▼' : ''} ${fmtPct(Math.abs(r.trendPct))}</span>`}</td>
              <td class="num">${r.days != null ? `${r.days}d` : html`<span class="sub">-</span>`}</td>
              <td class="num">${r.openBills ? html`<${Money} v=${r.openBills} />` : html`<span class="sub">-</span>`}</td>
              <td>${r.paidBy}</td>
            </tr>`)}</tbody>
          </table></div></div>
        </section>
        `],
        ["tax1099", "1099 contractor review", html`
        ${v.tax.length > 0 && html`<section class="panel">
          <div class="panel-head">
            <h2>1099 contractor review</h2>
            ${yr && html`<span class=${`pill ${yr.reviewCount ? 'high' : 'good'}`}>${yr.reviewCount} to review</span>`}
            <p>Vendors paid by check or bank transfer at or above the IRS threshold for the year: $600 for payments made through 2025, $2,000 from 2026 (adjusted for inflation from 2027). A W-9 settles whether each one needs a 1099.</p>
          </div>
          <div class="panel-body" style=${{ display: 'flex', flexWrap: 'wrap', gap: '10px 16px', alignItems: 'center', paddingBottom: '12px' }}>
            <div class="seg" role="group" aria-label="Tax year">${v.tax.map((y) => html`<button key=${y.year} aria-pressed=${y.year === year} onClick=${() => setYear(y.year)}>${y.year}${y.full ? '' : ' so far'}</button>`)}</div>
            ${cardCount > 0 && html`<label class="check" for="show-card" style=${{ paddingTop: 0 }}><input id="show-card" type="checkbox" checked=${showCard} onChange=${(e) => setShowCard(e.target.checked)} />Show ${cardCount} vendor${cardCount === 1 ? '' : 's'} paid only by card</label>`}
          </div>
          <div class="panel-body flush">${taxRows.length ? html`<div class="table-wrap"><table>
            <thead><tr><th>Status</th><th>Vendor</th><th class="num">Check / transfer</th><th class="num">Card</th><th>Form</th>${setW9 && html`<th>W-9</th>`}<th>Note</th></tr></thead>
            <tbody>${taxRows.map((x) => html`<tr key=${x.vendor}>
              <td><span class=${`pill ${statusPill[x.status]}`}>${x.status}</span></td>
              <td>${x.vendor}<span class="sub">${x.accounts.join(', ')}</span></td>
              <td class="num"><${Money} v=${x.bank} /></td>
              <td class="num">${x.card ? html`<${Money} v=${x.card} />` : html`<span class="sub">-</span>`}</td>
              <td class="nowrap">${x.status === 'Review' || x.status === 'Likely exempt' ? x.form : html`<span class="sub">-</span>`}</td>
              ${setW9 && html`<td>${x.status === 'Review' || x.status === 'Likely exempt' ? html`<select class="select" aria-label=${`W-9 for ${x.vendor}`} value=${(w9 || {})[x.vendor] || ''} onChange=${(e) => { const next = { ...(w9 || {}) }; if (e.target.value) next[x.vendor] = e.target.value; else delete next[x.vendor]; setW9(next); }}>
                <option value="">Not asked</option><option value="asked">Requested</option><option value="received">On file</option><option value="exempt">Not needed</option>
              </select>` : html`<span class="sub">-</span>`}</td>`}
              <td class="sub" style=${{ display: 'table-cell' }}>${x.note}</td>
            </tr>`)}</tbody>
          </table></div>` : html`<div class="empty">${Icon.check}No vendors at or near the threshold for ${year}.</div>`}</div>
          ${setW9 && yr && html`<div class="panel-body" style=${{ display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
            <button class="btn" onClick=${() => UI.saveTextFile(`1099-worksheet-${yr.year}.csv`, E.form1099Csv(yr, w9))}>Download 1099 worksheet (CSV)</button>
            <span class="sub">Amounts and W-9 status, with columns for the TIN and address from each W-9. Copy them into the IRS's IRIS template or your tax software. 1099-NECs are due to contractors and the IRS by January 31.</span>
          </div>`}
          <div class="panel-body"><p class="chart-note">A screening list, not tax advice. Payments to corporations are usually exempt (attorneys are not), and card payments are reported by the card company on 1099-K. Rent paid to a landlord that is not a corporation goes on 1099-MISC.</p></div>
        </section>`}
        `],
      ]} />
    `;
  }

  Object.assign(UI, { VendorsTab });
})();
