/* Ledger Lens UI: Tax prep tab. The books for one tax year mapped to the business return
 * (Schedule C, 1120-S, 1065 or 1120): each account's line, the book-to-tax adjustments, owner pay
 * against distributions, and purchases that look personal. Exports a mapped trial balance for
 * the tax software. Figures come from taxPrep() in the engine; the return is filed elsewhere. */
(function () {
  'use strict';
  const html = htm.bind(React.createElement);
  const E = window.LedgerEngine;
  const { fmtMoney } = E;
  const UI = window.LedgerUI;
  const { wholeMoney, Banner, Arrange, saveTextFile } = UI;

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;
  const ENTITY_LABEL = { sole: 'sole proprietor', scorp: 'S corporation', partnership: 'partnership', ccorp: 'C corporation' };

  function ReturnLines({ t }) {
    return html`<section class="panel">
      <div class="panel-head"><h2>Return lines</h2><p>${t.formLabel}, tax year ${t.year}: what goes on each line, from the books and after adjustments. Confirm the line numbers in your tax software.</p></div>
      <div class="panel-body flush"><div class="table-wrap"><table>
        <thead><tr><th>Line</th><th class="num">Books</th><th class="num">For the return</th><th class="num">Accounts</th></tr></thead>
        <tbody>
          ${t.lines.map((l) => html`<tr key=${l.code} class=${l.code === '?' ? 'warn-row' : ''}><td>${l.label}</td><td class="num">${fmtMoney(l.book)}</td><td class="num">${fmtMoney(l.tax)}</td><td class="num">${l.accounts}</td></tr>`)}
          <tr class="total-row"><td><strong>Net income (books)</strong></td><td class="num"><strong>${fmtMoney(t.bookNet)}</strong></td><td></td><td></td></tr>
          <tr class="total-row"><td><strong>Ordinary business income (page 1)</strong></td><td></td><td class="num"><strong>${fmtMoney(t.taxNet)}</strong></td><td></td></tr>
        </tbody>
      </table></div></div>
    </section>`;
  }

  function AccountLines({ t, prefs, setPrefs }) {
    const set = (account, code) => {
      const lines = { ...((prefs && prefs.lines) || {}) };
      if (code) lines[account] = code; else delete lines[account];
      setPrefs({ ...(prefs || {}), lines });
    };
    return html`<section class="panel">
      <div class="panel-head"><h2>Accounts to tax lines</h2><p>Each income and expense account in ${t.year}, matched to its line from its name. Change any that don't fit; your choices are saved with the client.</p></div>
      ${t.unmapped.length > 0 && html`<div class="panel-body"><${Banner} level="high" label="Choose a line">${plural(t.unmapped.length, 'account')} could not be matched: ${t.unmapped.map((r) => r.account).join(', ')}.</${Banner}></div>`}
      <div class="panel-body flush"><div class="table-wrap"><table class="tax-map">
        <thead><tr><th>Account</th><th class="num">Books</th><th>Line on the return</th><th class="num">For the return</th></tr></thead>
        <tbody>${t.rows.map((r) => html`<tr key=${r.account}>
          <td>${r.account}<span class="sub">${r.cls === 'income' ? 'Income' : r.cls === 'cogs' ? 'Cost of goods sold' : 'Expense'}</span></td>
          <td class="num">${fmtMoney(r.book)}</td>
          <td><select class="select" aria-label=${`Tax line for ${r.account}`} value=${prefs && prefs.lines && prefs.lines[r.account] ? r.line : ''} onChange=${(e) => set(r.account, e.target.value)}>
            <option value="">${r.auto ? `${r.lineLabel.split(' · ')[0]} (suggested)` : 'Use the suggestion'}</option>
            ${t.lineOptions.map(([code, label]) => html`<option key=${code} value=${code}>${label}</option>`)}
          </select><span class="sub">${r.lineLabel}${r.note ? ` · ${r.note}` : ''}</span></td>
          <td class="num">${fmtMoney(r.tax)}</td>
        </tr>`)}</tbody>
      </table></div></div>
    </section>`;
  }

  function Adjustments({ t }) {
    return html`<section class="panel">
      <div class="panel-head"><h2>Book-to-tax adjustments</h2><p>Where the return differs from the books: meals at 50%, fines, penalties and entertainment not deductible, items reported separately, and tax depreciation from the fixed asset register.</p></div>
      <div class="panel-body">
        ${t.adjustments.length
          ? html`<${Banner} level="medium" label=${`${t.adjustmentTotal >= 0 ? '+' : ''}${wholeMoney(t.adjustmentTotal)}`}>Taxable income is ${t.adjustmentTotal >= 0 ? 'higher' : 'lower'} than book income by ${wholeMoney(Math.abs(t.adjustmentTotal))} for these items. They go on Schedule M-1 for a corporation or partnership.</${Banner}>`
          : html`<${Banner} level="good" label="None">No book-to-tax differences found in the accounts.</${Banner}>`}
        ${!t.depreciationFromRegister && t.rows.some((r) => r.kind === 'depreciation') ? html`<p class="hint">Depreciation is the book figure. Add the client's assets on the Fixed assets tab and the tax depreciation for ${t.year} comes in here.</p>` : ''}
      </div>
      ${t.adjustments.length > 0 && html`<div class="panel-body flush"><div class="table-wrap"><table>
        <thead><tr><th>Account</th><th class="num">Books</th><th class="num">Return</th><th class="num">Difference</th><th>Why</th></tr></thead>
        <tbody>${t.adjustments.map((a) => html`<tr key=${a.account}><td>${a.account}<span class="sub">${a.line}</span></td><td class="num">${fmtMoney(a.book)}</td><td class="num">${fmtMoney(a.tax)}</td><td class="num">${fmtMoney(a.diff)}</td><td class="names-cell">${a.note}</td></tr>`)}</tbody>
      </table></div></div>`}
    </section>`;
  }

  function OwnerChecks({ t }) {
    const o = t.owner;
    return html`<section class="panel">
      <div class="panel-head"><h2>Owner pay and distributions</h2><p>What the owners took out of the business in ${t.year}, against pay booked to them.</p></div>
      <div class="panel-body">
        ${o.flags.length ? html`<ul class="insight-list">${o.flags.map((f, i) => html`<li key=${i}><span class=${`pill ${f.level}`}><span class="dot"></span>${f.level === 'high' ? 'Check' : f.level === 'medium' ? 'Review' : 'Note'}</span><span>${f.text}</span></li>`)}</ul>` : html`<${Banner} level="good" label="Nothing to flag">Owner pay and distributions look in order for a ${t.form === 'S' ? 'S corporation' : t.formLabel}.</${Banner}>`}
        <div class="table-wrap" style=${{ marginTop: '10px' }}><table>
          <thead><tr><th>Taken out by</th><th class="num">${t.year}</th></tr></thead>
          <tbody>
            ${o.draws.map((d) => html`<tr key=${d.who}><td>${d.who}</td><td class="num">${fmtMoney(d.amount)}</td></tr>`)}
            ${!o.draws.length && html`<tr><td colspan="2" class="sub">No draws or distributions found (accounts named draw, distribution or dividend).</td></tr>`}
            <tr><td>Pay booked to owners or officers</td><td class="num">${fmtMoney(o.officerPay)}</td></tr>
          </tbody>
        </table></div>
      </div>
    </section>`;
  }

  function Personal({ t }) {
    return html`<section class="panel">
      <div class="panel-head"><h2>Looks personal</h2><p>Expenses in ${t.year} at places that are often personal (groceries, streaming, gyms, pharmacies...). Ask the client before they go on the return; personal items paid by the business are draws.</p></div>
      ${t.personal.length
        ? html`<div class="panel-body flush"><div class="table-wrap"><table>
            <thead><tr><th>Date</th><th>Payee</th><th>Account</th><th class="num">Amount</th></tr></thead>
            <tbody>${t.personal.map((x, i) => html`<tr key=${i}><td class="nowrap">${x.date}</td><td>${x.payee}</td><td>${x.account}</td><td class="num">${fmtMoney(x.amount)}</td></tr>`)}</tbody>
          </table>${t.personalCount > t.personal.length ? html`<p class="hint">The largest ${t.personal.length} of ${t.personalCount}.</p>` : ''}</div></div>`
        : html`<div class="panel-body"><p class="hint">Nothing that looks personal.</p></div>`}
    </section>`;
  }

  function TaxPrepTab({ result, prefs, setPrefs, entity }) {
    const t = result.taxPrep;
    if (!t) return html`<section class="panel"><div class="empty">No income or expenses to map.</div></section>`;
    const set = (patch) => setPrefs({ ...(prefs || {}), ...patch });
    const exportCsv = () => saveTextFile(`tax-trial-balance-${t.year}-${E.TAX_FORMS[t.form].short.replace(/\s+/g, '-').toLowerCase()}.csv`, E.taxTrialBalanceCsv(t));
    return html`
      <section class="panel">
        <div class="panel-body tax-controls">
          <label class="field" for="tp-form">Return
            <select id="tp-form" class="select" value=${(prefs && prefs.form) || ''} onChange=${(e) => set({ form: e.target.value || undefined, lines: {} })}>
              <option value="">From the entity type (${ENTITY_LABEL[entity] || 'sole proprietor'}): ${E.TAX_FORMS[t.form].label}</option>
              ${Object.entries(E.TAX_FORMS).map(([k, f]) => html`<option key=${k} value=${k}>${f.label}</option>`)}
            </select>
          </label>
          <label class="field" for="tp-year">Tax year
            <select id="tp-year" class="select" value=${String(t.year)} onChange=${(e) => set({ year: +e.target.value })}>
              ${t.years.map((y) => html`<option key=${y} value=${String(y)}>${y}</option>`)}
            </select>
          </label>
          <button class="btn primary" onClick=${exportCsv}>Download tax trial balance (CSV)</button>
        </div>
        <div class="panel-body"><p class="hint">The entity type is set on the Tax & lending tab. This prepares the numbers; the return itself is filed in your tax software, and the figures are for your review.</p></div>
      </section>
      <section class="kpis" aria-label="Tax prep summary">
        <div class="kpi"><span class="kpi-label">Net income (books)</span><span class="kpi-value">${wholeMoney(t.bookNet)}</span><span class="kpi-sub">${t.year}</span></div>
        <div class="kpi"><span class="kpi-label">Ordinary business income</span><span class="kpi-value">${wholeMoney(t.taxNet)}</span><span class="kpi-sub">${E.TAX_FORMS[t.form].short}, page 1</span></div>
        <div class=${`kpi ${t.adjustments.length ? 'alert' : ''}`}><span class="kpi-label">Book-to-tax difference</span><span class="kpi-value">${wholeMoney(t.adjustmentTotal)}</span><span class="kpi-sub">${plural(t.adjustments.length, 'account')}</span></div>
        <div class=${`kpi ${t.unmapped.length || t.owner.flags.some((f) => f.level === 'high') ? 'alert' : ''}`}><span class="kpi-label">To look at</span><span class="kpi-value">${t.unmapped.length + t.owner.flags.length + (t.personalCount ? 1 : 0)}</span><span class="kpi-sub">${[t.unmapped.length ? plural(t.unmapped.length, 'account') + ' to map' : '', t.owner.flags.length ? plural(t.owner.flags.length, 'owner check') : '', t.personalCount ? `${t.personalCount} personal-looking` : ''].filter(Boolean).join(' · ') || 'Nothing'}</span></div>
      </section>
      <${Arrange} page="taxprep" parts=${[
        ['lines', 'Return lines', html`<${ReturnLines} t=${t} />`],
        ['accounts', 'Accounts to tax lines', html`<${AccountLines} t=${t} prefs=${prefs} setPrefs=${setPrefs} />`],
        ['adjust', 'Book-to-tax adjustments', html`<${Adjustments} t=${t} />`],
        ['owner', 'Owner pay and distributions', html`<${OwnerChecks} t=${t} />`],
        ['personal', 'Looks personal', html`<${Personal} t=${t} />`],
      ]} />`;
  }

  Object.assign(UI, { TaxPrepTab });
})();
