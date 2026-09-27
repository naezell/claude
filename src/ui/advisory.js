/* Ledger Lens UI: Tax & lending tab. */
(function () {
  'use strict';
  const html = htm.bind(React.createElement);
  const E = window.LedgerEngine;
  const { fmtWhole, fmtPct } = E;
  const UI = window.LedgerUI;
  const { useTokens, shortDate, wholeMoney, Banner, NumberInput, Arrange } = UI;

  // ------------------------------------------------------------ tax & lending tab

  const CHECK_PILL = { pass: ['good', 'Ready'], warn: ['medium', 'Watch'], fail: ['high', 'Fix first'] };

  function AdvisoryTab({ result, loanInputs, setLoanInputs, taxInputs, setTaxInputs }) {
    const t = useTokens();
    const ln = result.loan;
    const tx = result.tax;
    if (!ln || !tx) return html`<section class="panel"><div class="empty">Loan and tax planning need income and expenses in the export.</div></section>`;
    const setL = (k) => (v) => setLoanInputs({ ...loanInputs, [k]: v });
    const setT = (k) => (v) => setTaxInputs({ ...taxInputs, [k]: v });
    const dscrTone = (d) => (d == null ? 'good' : d >= ln.target ? 'good' : d >= 1.15 ? 'medium' : 'high');
    const dscrText = (d) => (d == null ? 'No loan payments' : d.toFixed(2));
    const pf = ln.proposal;
    const bars = [
      { label: 'Cash available for debt', v: ln.cashAvailable, color: t.s1 },
      { label: 'Existing loan payments', v: ln.debtService, color: t.s2 },
      ...(pf.amount ? [{ label: 'With the proposed loan', v: ln.debtService + pf.payment * 12, color: t.s4 }] : []),
      { label: `Lender minimum (${ln.target.toFixed(2)}x payments)`, v: (ln.debtService + (pf.amount ? pf.payment * 12 : 0)) * ln.target, color: t.neutral },
    ];
    const barMax = Math.max(...bars.map((b) => b.v), 1);
    return html`
      <${Arrange} page="advisory" parts=${[
        ["loan", "Loan readiness", html`
        <section class="panel">
          <div class="panel-head"><h2>Loan readiness</h2><p>How a lender will size up the business: cash it generates before interest and non-cash costs, against yearly loan payments (the debt service coverage ratio). Most lenders want at least ${ln.target.toFixed(2)}; SBA 7(a) small loans now require this analysis for every application.</p></div>
          <div class="panel-body">
            <section class="kpis" aria-label="Loan summary">
              <div class=${`kpi ${ln.dscr != null && ln.dscr < ln.target ? 'alert' : ''}`}><span class="kpi-label">Debt coverage today</span><span class="kpi-value">${dscrText(ln.dscr)}</span><span class="kpi-sub"><span class=${`pill ${dscrTone(ln.dscr)}`}><span class="dot"></span>${ln.dscr == null ? 'No existing debt' : ln.dscr >= ln.target ? 'Meets lender minimum' : ln.dscr >= 1.15 ? 'Borderline' : 'Below minimum'}</span></span></div>
              <div class="kpi"><span class="kpi-label">Cash available for debt</span><span class="kpi-value">${wholeMoney(ln.cashAvailable)}</span><span class="kpi-sub">per year, ${ln.windowLabel}</span></div>
              <div class="kpi"><span class="kpi-label">Existing loan payments</span><span class="kpi-value">${wholeMoney(ln.debtService)}</span><span class="kpi-sub">${wholeMoney(ln.principal)} principal + ${wholeMoney(ln.interest)} interest</span></div>
              <div class="kpi"><span class="kpi-label">Largest new loan</span><span class="kpi-value">${wholeMoney(ln.maxLoan)}</span><span class="kpi-sub">keeping coverage at ${ln.target.toFixed(2)} (${pf.years} yrs at ${pf.rate}%)</span></div>
            </section>
          </div>
          <div class="panel-body inputs-row" style=${{ borderTop: '1px solid var(--hair)' }}>
            <${NumberInput} id="loan-amount" label="Proposed loan" prefix="$" value=${loanInputs.amount} placeholder="e.g. 50,000" onChange=${setL('amount')} />
            <${NumberInput} id="loan-rate" label="Interest rate" suffix="%" value=${loanInputs.rate} onChange=${setL('rate')} />
            <${NumberInput} id="loan-years" label="Term" suffix="years" value=${loanInputs.years} onChange=${setL('years')} />
            <${NumberInput} id="loan-addbacks" label="Owner add-backs (yearly)" prefix="$" value=${loanInputs.addBacks} placeholder="optional" onChange=${setL('addBacks')} hint="One-off or personal costs a lender may add back" />
          </div>
          <div class="panel-body loan-result">
            <div class="bm-bars">${bars.map((b) => html`<div class="bm-row loan-row" key=${b.label}><span>${b.label}</span><span class="bm-track"><span style=${{ width: `${(b.v / barMax) * 100}%`, background: b.color }}></span></span><b class="num">${wholeMoney(b.v)}</b></div>`)}</div>
            ${pf.amount > 0 && html`<p class="loan-verdict">A ${wholeMoney(pf.amount)} loan at ${pf.rate}% over ${pf.years} years costs ${wholeMoney(pf.payment)} a month. Coverage would be <strong>${pf.proForma != null ? pf.proForma.toFixed(2) : 'n/a'}</strong>: <span class=${`pill ${dscrTone(pf.proForma)}`}><span class="dot"></span>${pf.proForma == null ? 'n/a' : pf.proForma >= ln.target ? 'likely to qualify on cash flow' : pf.proForma >= 1.15 ? 'borderline; expect questions' : 'below what most lenders accept'}</span></p>`}
          </div>
        </section>
        `],
        ["lender", "Lender readiness checklist", html`
        <section class="panel">
          <div class="panel-head"><h2>Lender readiness checklist</h2><span class="pill">${ln.score} of ${ln.checks.length} ready</span><p>What a lender will look at first, from this export. Fix the red items before applying.</p></div>
          <div class="panel-body flush"><ul class="checklist">${ln.checks.map((c) => html`<li key=${c.label}><span class=${`pill ${CHECK_PILL[c.status][0]}`}><span class="dot"></span>${CHECK_PILL[c.status][1]}</span><div><strong>${c.label}</strong><span class="sub">${c.detail}</span></div></li>`)}</ul></div>
        </section>
        `],
        ["tax", "Tax set-aside", html`
        <section class="panel">
          <div class="panel-head"><h2>Tax set-aside for ${tx.year}</h2><p>Projected profit for the year and what to hold back for estimated taxes, with the remaining quarterly payments checked against the cash forecast. ${tx.entityNote}</p></div>
          <div class="panel-body inputs-row">
            <label class="field" for="tax-entity">Business type
              <select id="tax-entity" class="select" value=${taxInputs.entity} onChange=${(e) => setTaxInputs({ ...taxInputs, entity: e.target.value, rate: '' })}>
                ${Object.entries(E.ENTITY).map(([k, v]) => html`<option key=${k} value=${k}>${v.label}</option>`)}
              </select>
            </label>
            <${NumberInput} id="tax-rate" label="Set-aside rate" suffix="%" value=${taxInputs.rate} placeholder=${String(E.ENTITY[tx.entity].rate)} onChange=${setT('rate')} hint="Federal, state and self-employment; ask the tax preparer" />
            <${NumberInput} id="tax-paid" label=${`Estimated tax paid in ${tx.year}`} prefix="$" value=${taxInputs.paid} placeholder=${Math.round(tx.paidAuto).toLocaleString('en-US')} onChange=${setT('paid')} hint=${tx.paidAuto ? 'Found in the export; change it if some was paid personally' : 'None found in the export; enter payments made personally'} />
            ${tx.entity === 'scorp' && html`<${NumberInput} id="tax-salary" label="Owner's W-2 salary (yearly)" prefix="$" value=${taxInputs.salary} onChange=${setT('salary')} />`}
          </div>
          <div class="panel-body">
            <section class="kpis" aria-label="Tax summary">
              <div class="kpi"><span class="kpi-label">Profit so far</span><span class="kpi-value">${wholeMoney(tx.ytdProfit)}</span><span class="kpi-sub">${tx.ytdMonths} months of ${tx.year}</span></div>
              <div class="kpi"><span class="kpi-label">Projected for the year</span><span class="kpi-value">${wholeMoney(tx.projectedProfit)}</span><span class="kpi-sub">at ${wholeMoney(tx.monthlyRunRate)}/month for the rest of the year</span></div>
              <div class="kpi"><span class="kpi-label">Set aside</span><span class="kpi-value">${wholeMoney(tx.setAside)}</span><span class="kpi-sub">${fmtPct(tx.rate)} · ${fmtWhole(tx.paid)} paid so far</span></div>
              <div class=${`kpi ${tx.next && tx.next.cashCheck && tx.next.cashCheck.after < 0 ? 'alert' : ''}`}><span class="kpi-label">Next payment</span><span class="kpi-value">${tx.next ? wholeMoney(tx.next.amount) : '-'}</span><span class="kpi-sub">${tx.next ? `${tx.next.label}, due ${shortDate(tx.next.due)}${tx.daysToNext != null && tx.daysToNext >= 0 ? ` (in ${tx.daysToNext} days)` : ''}` : 'No payments left this year'}</span></div>
            </section>
          </div>
          <div class="panel-body flush"><div class="table-wrap"><table>
            <thead><tr><th>Quarter</th><th>Due</th><th class="num">Suggested payment</th><th>Cash check</th></tr></thead>
            <tbody>${tx.schedule.map((q) => html`<tr key=${q.label} class=${q.status === 'Past' ? 'partial' : ''}>
              <td>${q.label}</td><td class="num nowrap">${q.due}</td>
              <td class="num">${q.status === 'Past' ? html`<span class="sub">Past</span>` : wholeMoney(q.amount)}</td>
              <td>${q.cashCheck ? html`<span class=${q.cashCheck.after < 0 ? 'neg' : ''}>Projected cash that week: ${wholeMoney(q.cashCheck.ending)}, ${wholeMoney(q.cashCheck.after)} after paying</span>` : html`<span class="sub">${q.status === 'Past' ? (tx.paid ? '' : 'No payment found in the export') : 'Beyond the 13-week forecast'}</span>`}</td>
            </tr>`)}</tbody>
          </table></div></div>
          ${tx.scorp && html`<div class="panel-body"><${Banner} level=${tx.scorp.status === 'warn' ? 'medium' : 'good'} label="S corp salary">${tx.scorp.detail}</${Banner}></div>`}
        </section>
        `],
        ["ownerpay", "What the owner can safely take", html`
        ${tx.ownerPay && html`<section class="panel">
          <div class="panel-head"><h2>What the owner can safely take</h2><p>Extra owner pay over the next 13 weeks that keeps every week above the ${wholeMoney(tx.ownerPay.cushion)} cash cushion after the tax payments due in that time. Draws already expected from history are counted in the forecast.</p></div>
          <div class="panel-body">
            ${tx.ownerPay.available > 0
              ? html`<${Banner} level="good" label="Room to pay">The owner could take up to <strong>${wholeMoney(tx.ownerPay.available)}</strong> more${tx.ownerPay.plannedDraws ? `, on top of ${wholeMoney(tx.ownerPay.plannedDraws)} of draws already expected` : ''}, and stay above the cushion.</${Banner}>`
              : html`<${Banner} level="high" label="No room">After ${tx.ownerPay.taxInWindow ? `${wholeMoney(tx.ownerPay.taxInWindow)} of tax payments` : 'upcoming payments'}${tx.ownerPay.plannedDraws ? ` and ${wholeMoney(tx.ownerPay.plannedDraws)} of expected draws` : ''}, cash is projected <strong>${wholeMoney(tx.ownerPay.shortfall)}</strong> short of the cushion at its lowest point. Hold off on extra draws, or speed up collections first.</${Banner}>`}
          </div>
        </section>`}
        `],
      ]} />

      <p class="chart-note">Planning estimates from the export, not tax, legal or lending advice. Confirm tax rates and payments with the client's tax preparer, and loan terms with the lender.</p>
    `;
  }

  Object.assign(UI, { AdvisoryTab });
})();
