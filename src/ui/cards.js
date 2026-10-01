/* Ledger Lens UI: Credit cards tab. Every company card in one place: what each card charged
 * over the last year (from the books), the card statements combined and checked charge by
 * charge against QuickBooks, spending by person and category, and whether paying the cards
 * off with one loan saves money. Figures come from cardReview() and cardPayoff() in the engine. */
(function () {
  'use strict';
  const html = htm.bind(React.createElement);
  const { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend } = Recharts;
  const E = window.LedgerEngine;
  const { fmtMoney, fmtPct } = E;
  const UI = window.LedgerUI;
  const { compactMoney, useTokens, ChartTooltip, wholeMoney, Banner, MoneyInput, NumberInput, Arrange, saveTextFile } = UI;

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;
  const SHOW = 40;

  function CardsInBooks({ c, t }) {
    if (!c.cards.length) {
      return html`<section class="panel">
        <div class="panel-head"><h2>Cards in the books</h2><p>No credit card accounts were found. Add the client's Chart of Accounts export so the app knows which accounts are cards (QuickBooks type <em>Credit Card</em>).</p></div>
      </section>`;
    }
    // One bar per month, a segment per card.
    const keys = [...new Set(c.cards.flatMap((x) => x.months.map((m) => m.key)))].sort();
    const data = keys.map((k) => {
      const row = { key: k, label: (c.cards.flatMap((x) => x.months).find((m) => m.key === k) || {}).label, fullName: k };
      for (const x of c.cards) row[x.account] = (x.months.find((m) => m.key === k) || {}).amount || 0;
      return row;
    });
    const colors = [t.s1, t.s2, t.s3, t.s4, t.s5 || t.s1];
    return html`<section class="panel">
      <div class="panel-head"><h2>Cards in the books</h2><p>Charges on each card account in QuickBooks over the last 12 months (${c.window}).</p></div>
      ${c.cards.length > 0 && html`<div class="panel-body">
        <div style=${{ height: 220 }}>
          <${ResponsiveContainer} width="100%" height="100%">
            <${BarChart} data=${data} margin=${{ top: 8, right: 8, bottom: 0, left: 4 }}>
              <${CartesianGrid} vertical=${false} stroke=${t.grid} />
              <${XAxis} dataKey="label" tickLine=${false} axisLine=${{ stroke: t.axis }} tick=${{ fill: t.muted, fontSize: 11 }} interval="preserveStartEnd" minTickGap=${8} />
              <${YAxis} tickFormatter=${compactMoney} tickLine=${false} axisLine=${false} tick=${{ fill: t.muted, fontSize: 12 }} width=${52} />
              <${Tooltip} cursor=${{ fill: t.surface2 }} content=${html`<${ChartTooltip} rows=${(d) => c.cards.map((x, i) => ({ label: x.account, value: fmtMoney(d[x.account]), color: colors[i % colors.length] }))} />`} />
              ${c.cards.length > 1 && html`<${Legend} wrapperStyle=${{ fontSize: 12 }} />`}
              ${c.cards.map((x, i) => html`<${Bar} key=${x.account} dataKey=${x.account} stackId="a" fill=${colors[i % colors.length]} isAnimationActive=${false} />`)}
            <//>
          <//>
        </div>
      </div>`}
      <div class="panel-body flush"><div class="table-wrap"><table>
        <thead><tr><th>Card</th><th class="num">Charges, 12 months</th><th class="num">Charges</th><th class="num">Paid</th><th class="num">Balance owed</th><th>Mostly</th></tr></thead>
        <tbody>${c.cards.map((x) => html`<tr key=${x.account}>
          <td>${x.account}</td><td class="num">${fmtMoney(x.charges)}</td><td class="num">${x.count}</td><td class="num">${fmtMoney(x.payments)}</td><td class="num">${fmtMoney(x.balance)}</td>
          <td>${x.topCategories.map((k) => k.category).join(', ')}</td>
        </tr>`)}</tbody>
      </table></div></div>
    </section>`;
  }

  function StatementCheck({ c, statements, onAdd }) {
    const ck = c.check;
    if (!ck) {
      return html`<section class="panel">
        <div class="panel-head"><h2>Card statements</h2><p>Combine every card's statement in one place and check each charge is in QuickBooks.</p></div>
        <div class="panel-body">
          <p>Download each card's activity as a CSV from the bank's website (Chase, Amex, Capital One, Citi, Bank of America, Wells Fargo, Discover...): <strong>Activity → Download → CSV</strong>, for the months you are reviewing. Upload them all at once with <em>Add export</em>; employee cards and cards that aren't in QuickBooks at all are fine.</p>
          ${onAdd && html`<p><button class="btn" onClick=${onAdd}>Add export</button></p>`}
        </div>
      </section>`;
    }
    const save = (name, text) => saveTextFile(name, text);
    return html`<section class="panel">
      <div class="panel-head"><h2>Card statements</h2><p>${plural(ck.statements.length, 'statement')} combined, ${ck.first} to ${ck.last}: ${plural(ck.matched, 'charge')} found in QuickBooks.</p></div>
      <div class="panel-body">
        ${ck.missing.length
          ? html`<${Banner} level="high" label="Not in QuickBooks">${plural(ck.missing.length, 'charge')} on the statements (${fmtMoney(ck.missingTotal)}) ${ck.missing.length === 1 ? 'is' : 'are'} not in the books. Enter them, or upload the file below to the card's account in QuickBooks (Banking → Upload transactions).</${Banner}>`
          : html`<${Banner} level="good" label="All in QuickBooks">Every statement charge is in the books.</${Banner}>`}
        <div class="table-wrap" style=${{ marginTop: '10px' }}><table>
          <thead><tr><th>Statement</th><th class="num">Charges</th><th class="num">Total</th></tr></thead>
          <tbody>${ck.statements.map((s) => html`<tr key=${s.label}><td>${s.label}</td><td class="num">${s.count}</td><td class="num">${fmtMoney(s.charges)}</td></tr>`)}</tbody>
        </table></div>
        <div class="backup-actions" style=${{ marginTop: '10px' }}>
          <button class="btn" onClick=${() => save('combined-card-statements.csv', E.combinedStatementsCsv(statements))}>Download combined statements (CSV)</button>
          ${ck.missing.length > 0 && html`<button class="btn" onClick=${() => save('card-charges-for-quickbooks.csv', E.quickbooksUploadCsv(ck.missing))}>Download missing charges for QuickBooks</button>`}
          ${onAdd && html`<button class="btn" onClick=${onAdd}>Add another statement</button>`}
        </div>
      </div>
      ${ck.missing.length > 0 && html`<div class="panel-body"><h3 class="sub-head">On a statement, not in QuickBooks</h3></div>
      <div class="panel-body flush"><div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Description</th><th>Card</th><th>Card member</th><th class="num">Amount</th></tr></thead>
        <tbody>${ck.missing.slice(0, SHOW).map((x, i) => html`<tr key=${i}><td class="nowrap">${x.date}</td><td>${x.description}</td><td>${x.statement}${x.card ? ` (${x.card})` : ''}</td><td>${x.member}</td><td class="num">${fmtMoney(x.amount)}</td></tr>`)}</tbody>
      </table>${ck.missing.length > SHOW ? html`<p class="hint">And ${ck.missing.length - SHOW} more in the download.</p>` : ''}</div></div>`}
      ${ck.extra.length > 0 && html`<div class="panel-body"><h3 class="sub-head">In QuickBooks, on no statement <span class="pill medium"><span class="dot"></span>${fmtMoney(ck.extraTotal)}</span></h3><p class="hint">Card charges in the books during these dates that no statement shows: a duplicate entry, a charge on another card, or a statement not uploaded yet.</p></div>
      <div class="panel-body flush"><div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Payee</th><th>Card account</th><th>Category</th><th class="num">Amount</th></tr></thead>
        <tbody>${ck.extra.slice(0, SHOW).map((x, i) => html`<tr key=${i}><td class="nowrap">${x.date}</td><td>${x.description}</td><td>${x.account}</td><td>${x.category}</td><td class="num">${fmtMoney(x.amount)}</td></tr>`)}</tbody>
      </table></div></div>`}
    </section>`;
  }

  function Combined({ c }) {
    const ck = c.check;
    return html`<section class="panel">
      <div class="panel-head"><h2>Combined spending</h2><p>All cards together, last 12 months in the books${ck && ck.people.length ? ', and by card member on the statements' : ''}.</p></div>
      ${ck && ck.people.length > 0 && html`<div class="panel-body"><h3 class="sub-head">By person or card (statements)</h3></div>
      <div class="panel-body flush"><div class="table-wrap"><table>
        <thead><tr><th>Card member</th><th class="num">Charges</th><th class="num">Total</th></tr></thead>
        <tbody>${ck.people.map((p) => html`<tr key=${p.who}><td>${p.who}</td><td class="num">${p.count}</td><td class="num">${fmtMoney(p.amount)}</td></tr>`)}</tbody>
      </table></div></div>`}
      <div class="panel-body"><h3 class="sub-head">By category (books) <span class="pill low"><span class="dot"></span>${fmtMoney(c.total)}</span></h3></div>
      ${c.categories.length
        ? html`<div class="panel-body flush"><div class="table-wrap"><table>
          <thead><tr><th>Category</th><th class="num">Amount</th><th class="num">Share</th></tr></thead>
          <tbody>${c.categories.slice(0, 15).map((k) => html`<tr key=${k.category}><td>${k.category}</td><td class="num">${fmtMoney(k.amount)}</td><td class="num">${fmtPct(k.share)}</td></tr>`)}</tbody>
        </table></div></div>`
        : html`<div class="panel-body"><p class="hint">No card charges in the books for the last 12 months.</p></div>`}
    </section>`;
  }

  // Paying several card balances off with one loan. Balances start from the books; the APR and
  // payment come from each statement; the loan terms from the lender's offer.
  function Payoff({ c, debt, setDebt, canSave }) {
    const saved = debt || {};
    const rows = Array.isArray(saved.cards) ? saved.cards : c.cards.filter((x) => x.balance > 0).map((x) => ({ name: x.account, balance: String(Math.round(x.balance)), apr: '', payment: '' }));
    const loan = { rate: '11', years: '5', fee: '3', ...(saved.loan || {}) };
    const set = (next) => setDebt({ cards: next.rows.map((r) => ({ name: r.name, balance: r.balance, apr: r.apr, payment: r.payment })), loan: next.loan });
    const update = (i, k, v) => set({ rows: rows.map((r, j) => (j === i ? { ...r, [k]: v } : r)), loan });
    const add = () => { let n = rows.length + 1; while (rows.some((r) => r.name === `Card ${n}`)) n++; set({ rows: [...rows, { name: `Card ${n}`, balance: '', apr: '', payment: '' }], loan }); };
    const remove = (i) => set({ rows: rows.filter((_, j) => j !== i), loan });
    const p = E.cardPayoff(rows.map((r) => ({ name: r.name, balance: parseFloat(r.balance) || 0, apr: r.apr === '' ? 22 : parseFloat(r.apr) || 0, payment: parseFloat(r.payment) || 0 })), { rate: parseFloat(loan.rate) || 0, years: parseFloat(loan.years) || 5, fee: parseFloat(loan.fee) || 0 });
    const months = (n) => (n >= 600 ? 'never' : n >= 24 ? `${(n / 12).toFixed(1)} years` : plural(n, 'month'));
    return html`<section class="panel">
      <div class="panel-head"><h2>Pay off the cards with one loan</h2><p>Several card balances against one loan at a lower rate. Fill in each card's APR and monthly payment from its statement (blank APR uses 22%, blank payment uses the usual minimum), and the loan offer.${canSave ? ' Saved with the client.' : ''}</p></div>
      <div class="panel-body">
        <div class="payoff-cards">${rows.map((r, i) => html`<div class="payoff-card" key=${i}>
          <label class="field" for=${`pc-name-${i}`}>Card<input id=${`pc-name-${i}`} value=${r.name} onInput=${(e) => update(i, 'name', e.target.value)} /></label>
          <${MoneyInput} id=${`pc-bal-${i}`} label="Balance" value=${r.balance} placeholder="0" onChange=${(v) => update(i, 'balance', v)} />
          <${NumberInput} id=${`pc-apr-${i}`} label="APR" value=${r.apr} placeholder="22" suffix="%" onChange=${(v) => update(i, 'apr', v)} />
          <${MoneyInput} id=${`pc-pay-${i}`} label="Paying a month" value=${r.payment} placeholder="minimum" onChange=${(v) => update(i, 'payment', v)} />
          <button class="btn" aria-label=${`Remove ${r.name}`} onClick=${() => remove(i)}>Remove</button>
        </div>`)}</div>
        <p><button class="btn" onClick=${add}>Add a card</button></p>
        <div class="drawer-fields payoff-loan">
          <${NumberInput} id="pl-rate" label="Loan rate" value=${loan.rate} suffix="%" onChange=${(v) => set({ rows, loan: { ...loan, rate: v } })} />
          <${NumberInput} id="pl-years" label="Years" value=${loan.years} onChange=${(v) => set({ rows, loan: { ...loan, years: v } })} />
          <${NumberInput} id="pl-fee" label="Origination fee" value=${loan.fee} suffix="%" onChange=${(v) => set({ rows, loan: { ...loan, fee: v } })} hint="Taken from the loan, so it borrows a little more" />
        </div>
        ${p && html`<div class="payoff-result">
          ${p.savings != null && p.savings > 0
            ? html`<${Banner} level="good" label="Saves money">One loan saves about <strong>${wholeMoney(p.savings)}</strong> in interest and fees, and the cards are paid off ${p.fasterBy > 0 ? `${months(p.fasterBy)} sooner` : 'in the same time'}. The monthly payment ${p.monthlyChange <= 0 ? `drops by ${wholeMoney(-p.monthlyChange)}` : `goes up by ${wholeMoney(p.monthlyChange)}`}.</${Banner}>`
            : p.savings == null
              ? html`<${Banner} level="high" label="Never paid off">At these payments at least one card is never paid off: the payment doesn't cover the interest. A loan at ${loan.rate}% pays everything off in ${months(p.loan.months)}.</${Banner}>`
              : html`<${Banner} level="medium" label="Costs more">The loan costs about ${wholeMoney(-p.savings)} more than paying the cards as now. A lower rate, a smaller fee or fewer years would change that.</${Banner}>`}
          <div class="table-wrap"><table>
            <thead><tr><th></th><th class="num">Cards as now</th><th class="num">One loan</th></tr></thead>
            <tbody>
              <tr><td>Amount</td><td class="num">${fmtMoney(p.balance)}</td><td class="num">${fmtMoney(p.loan.principal)}</td></tr>
              <tr><td>Rate</td><td class="num">${fmtPct(p.weightedApr)} average</td><td class="num">${loan.rate}%</td></tr>
              <tr><td>Monthly payment</td><td class="num">${fmtMoney(p.current.payment)}</td><td class="num">${fmtMoney(p.loan.payment)}</td></tr>
              <tr><td>Paid off in</td><td class="num">${months(p.current.months)}</td><td class="num">${months(p.loan.months)}</td></tr>
              <tr><td>Interest</td><td class="num">${p.current.never ? 'never ends' : fmtMoney(p.current.interest)}</td><td class="num">${fmtMoney(p.loan.interest)}</td></tr>
              <tr><td>Fee</td><td class="num">—</td><td class="num">${fmtMoney(p.loan.fee)}</td></tr>
            </tbody>
          </table></div>
          <p class="hint">Cards keep their minimum payment shrinking as the balance falls, which is why they take so long. Paying the same total each month as the loan would also clear them faster; the loan's advantage is the lower rate. Close or freeze the paid-off cards so the balances don't come back.</p>
        </div>`}
        ${!p && html`<p class="hint">Enter at least one card balance.</p>`}
      </div>
    </section>`;
  }

  function CardsTab({ result, statements, debt, setDebt, canSave, onAdd }) {
    const t = useTokens();
    const c = result.cards;
    if (!c) return html`<section class="panel"><div class="empty">No card information.</div></section>`;
    const ck = c.check;
    const owed = c.cards.reduce((s, x) => s + x.balance, 0);
    return html`
      <section class="kpis" aria-label="Credit cards summary">
        <div class="kpi"><span class="kpi-label">Card charges, 12 months</span><span class="kpi-value">${wholeMoney(c.total)}</span><span class="kpi-sub">${plural(c.cards.length, 'card account')} in the books</span></div>
        <div class=${`kpi ${ck && ck.missing.length ? 'alert' : ''}`}><span class="kpi-label">Not in QuickBooks</span><span class="kpi-value">${ck ? ck.missing.length : '—'}</span><span class="kpi-sub">${ck ? (ck.missing.length ? wholeMoney(ck.missingTotal) : 'All statement charges found') : 'Add the card statements'}</span></div>
        <div class="kpi"><span class="kpi-label">Statements combined</span><span class="kpi-value">${ck ? ck.statements.length : 0}</span><span class="kpi-sub">${ck ? `${ck.first} to ${ck.last}` : 'None uploaded'}</span></div>
        <div class="kpi"><span class="kpi-label">Balance owed (books)</span><span class="kpi-value">${wholeMoney(owed)}</span><span class="kpi-sub">At the end of the export</span></div>
      </section>
      <${Arrange} page="cards" parts=${[
        ['books', 'Cards in the books', html`<${CardsInBooks} c=${c} t=${t} />`],
        ['statements', 'Card statements', html`<${StatementCheck} c=${c} statements=${statements} onAdd=${onAdd} />`],
        ['combined', 'Combined spending', html`<${Combined} c=${c} />`],
        ['payoff', 'Pay off with one loan', html`<${Payoff} c=${c} debt=${debt} setDebt=${setDebt} canSave=${canSave} />`],
      ]} />`;
  }

  Object.assign(UI, { CardsTab });
})();
