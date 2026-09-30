/* Ledger Lens UI: Fixed assets tab. The client's asset register (saved with the client), book
 * depreciation (straight-line) and tax depreciation (MACRS, bonus, Section 179), yearly totals
 * against what the books show, and the depreciation journal entry as a QuickBooks import file.
 * The figures come from assetSchedule() and depreciationEntry() in the engine. */
(function () {
  'use strict';
  const { useState, useMemo } = React;
  const html = htm.bind(React.createElement);
  const E = window.LedgerEngine;
  const { fmtMoney } = E;
  const UI = window.LedgerUI;
  const { Icon, Banner, MoneyInput, NumberInput, wholeMoney, saveTextFile, excelToCsv, Arrange } = UI;

  const newId = () => `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const monthName = (key) => new Date(`${key}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const blank = () => ({ id: newId(), name: '', date: '', cost: '', category: 'equipment', bookLife: '', salvage: '', taxMethod: 'macrs', bonusPct: '', s179: '', disposed: '', salePrice: '' });

  function AssetForm({ initial, onSave, onCancel }) {
    const [a, setA] = useState(initial);
    const set = (k) => (v) => setA((p) => ({ ...p, [k]: v }));
    const cat = E.ASSET_CATEGORIES.find((c) => c.key === a.category) || E.ASSET_CATEGORIES[0];
    const ok = a.name.trim() && /^\d{4}-\d{2}-\d{2}$/.test(a.date) && +a.cost > 0;
    return html`<div class="asset-form">
      <div class="drawer-fields">
        <label class="field" for="af-name">Asset<input id="af-name" class="text" value=${a.name} placeholder="For example: 2024 Ford F-250" onInput=${(e) => set('name')(e.target.value)} /></label>
        <label class="field" for="af-date">Placed in service<input id="af-date" class="text" type="date" value=${a.date} onInput=${(e) => set('date')(e.target.value)} /></label>
        <${MoneyInput} id="af-cost" label="Cost" value=${a.cost} onChange=${set('cost')} hint="Price plus delivery and setup" />
        <label class="field" for="af-cat">Category
          <select id="af-cat" class="select" value=${a.category} onChange=${(e) => set('category')(e.target.value)}>${E.ASSET_CATEGORIES.map((c) => html`<option key=${c.key} value=${c.key}>${c.label}</option>`)}</select>
        </label>
        <${NumberInput} id="af-life" label="Book life" value=${a.bookLife} onChange=${set('bookLife')} suffix="years" placeholder=${String(cat.book)} hint="Straight-line on the books" />
        <${MoneyInput} id="af-salvage" label="Salvage value" value=${a.salvage} onChange=${set('salvage')} placeholder="0" />
        <label class="field" for="af-method">Tax method
          <select id="af-method" class="select" value=${a.taxMethod} onChange=${(e) => set('taxMethod')(e.target.value)}>${Object.entries(E.TAX_METHODS).map(([k, v]) => html`<option key=${k} value=${k}>${v}</option>`)}</select>
        </label>
        ${a.taxMethod === 'bonus' && html`<${NumberInput} id="af-bonus" label="Bonus depreciation" value=${a.bonusPct} onChange=${set('bonusPct')} suffix="%" placeholder=${String(E.defaultBonus(a.date))} hint="Default for the date placed in service" />`}
        ${(a.taxMethod === 'macrs' || a.taxMethod === 'bonus') && html`<${MoneyInput} id="af-179" label="Section 179 (part)" value=${a.s179} onChange=${set('s179')} placeholder="0" hint="Written off first; the rest is depreciated" />`}
        <label class="field" for="af-disposed">Sold or scrapped<input id="af-disposed" class="text" type="date" value=${a.disposed} onInput=${(e) => set('disposed')(e.target.value)} /></label>
        ${a.disposed && html`<${MoneyInput} id="af-price" label="Sold for" value=${a.salePrice} onChange=${set('salePrice')} placeholder="0" />`}
      </div>
      <div class="backup-actions">
        <button class="btn primary" disabled=${!ok} onClick=${() => onSave({ ...a, name: a.name.trim(), cost: +a.cost })}>Save asset</button>
        <button class="btn" onClick=${onCancel}>Cancel</button>
      </div>
    </div>`;
  }

  function AssetsTab({ result, assets, setAssets, canSave }) {
    const fa = result.fixedAssets || { candidates: [], recorded: {}, accounts: {} };
    const months = result.closableMonths || [];
    const asOf = months[months.length - 1] || result.period.end.slice(0, 7);
    const schedule = useMemo(() => E.assetSchedule(assets, { asOf }), [assets, asOf]);
    const [editing, setEditing] = useState(null);
    const [status, setStatus] = useState('');
    const [period, setPeriod] = useState(asOf);
    const [accounts, setAccounts] = useState(() => ({ ...fa.accounts }));
    const entry = useMemo(() => E.depreciationEntry(schedule, period, accounts), [schedule, period, accounts]);
    const year = asOf.slice(0, 4);
    const thisYear = schedule.years.find((y) => String(y.year) === year) || { book: 0, tax: 0 };
    const inRegister = new Set(assets.map((a) => a.fromKey).filter(Boolean));
    const found = fa.candidates.filter((c) => !inRegister.has(c.key));
    const save = (a) => { setAssets((list) => (list.some((x) => x.id === a.id) ? list.map((x) => (x.id === a.id ? a : x)) : [...list, a])); setEditing(null); };
    const addFound = (c) => setEditing({ ...blank(), name: c.memo || `${c.vendor} purchase`, date: c.date, cost: c.amount, category: c.category, fromKey: c.key, expensed: c.expensed });
    const upload = async (file) => {
      if (!file) return;
      try {
        const text = /\.xlsx?$/i.test(file.name) ? await excelToCsv(await file.arrayBuffer()) : await file.text();
        const list = E.parseAssetList(text);
        if (!list) { setStatus(`${file.name} doesn't look like an asset list. It needs columns for the asset, the date placed in service and the cost.`); return; }
        setAssets((prev) => [...prev, ...list]);
        setStatus(`Added ${list.length} asset${list.length === 1 ? '' : 's'} from ${file.name}. Check each one's category and tax method.`);
      } catch (e) { setStatus(`${file.name} could not be read: ${e.message}`); }
    };
    // Years to compare with the books: those in the export.
    const exportYears = new Set([result.period.start.slice(0, 4), result.period.end.slice(0, 4)]);
    for (let y = +result.period.start.slice(0, 4); y <= +result.period.end.slice(0, 4); y++) exportYears.add(String(y));
    const periods = [...new Set([...months.slice(-12).reverse(), ...[...exportYears].sort().reverse()])];
    // Assets added from expense accounts are not in the fixed asset accounts yet, so leave them out.
    const gap = fa.bookCost != null && assets.length ? fa.bookCost - assets.filter((a) => !a.expensed && !a.disposed).reduce((t, a) => t + (+a.cost || 0), 0) : null;

    return html`
      ${!canSave && html`<${Banner} level="medium" label="Not saved">The sample's asset register is kept only until the page reloads. A real client's register is saved with the client.</${Banner}>`}
      <section class="kpis" aria-label="Fixed asset summary">
        <div class="kpi"><span class="kpi-label">Assets</span><span class="kpi-value">${schedule.rows.filter((r) => !r.disposal).length}</span><span class="kpi-sub">${wholeMoney(schedule.cost)} cost</span></div>
        <div class="kpi"><span class="kpi-label">Book value</span><span class="kpi-value">${wholeMoney(schedule.nbv)}</span><span class="kpi-sub">at end of ${monthName(asOf)}</span></div>
        <div class="kpi"><span class="kpi-label">Book depreciation ${year}</span><span class="kpi-value">${wholeMoney(thisYear.book)}</span><span class="kpi-sub">${fa.recorded[year] ? `${wholeMoney(fa.recorded[year])} posted so far` : 'None posted yet this year'}</span></div>
        <div class="kpi"><span class="kpi-label">Tax deduction ${year}</span><span class="kpi-value">${wholeMoney(thisYear.tax)}</span><span class="kpi-sub">MACRS, bonus and Section 179</span></div>
        <div class=${`kpi ${found.length ? 'alert' : ''}`}><span class="kpi-label">Found in the books</span><span class="kpi-value">${found.length}</span><span class="kpi-sub">${found.filter((c) => c.expensed).length} coded to expenses</span></div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Add assets</h2><p>Pick purchases the app found below, upload the client's asset list (CSV or Excel with the asset, date placed in service and cost), or add one by hand.</p></div>
        <div class="panel-body">
          <div class="backup-actions">
            <button class="btn primary" onClick=${() => setEditing(blank())}>Add an asset</button>
            <label class="btn" for="asset-upload">${Icon.upload}Upload asset list</label>
            <input id="asset-upload" class="file-input" type="file" accept=".csv,.xlsx,.xls,text/csv" onChange=${(e) => { upload(e.target.files[0]); e.target.value = ''; }} />
          </div>
          ${editing && html`<${AssetForm} key=${editing.id} initial=${editing} onSave=${save} onCancel=${() => setEditing(null)} />`}
          <p class="backup-status" role="status">${status}</p>
        </div>
      </section>
      <${Arrange} page="assets" parts=${[
        ['found', 'Found in the books', found.length > 0 && html`<section class="panel">
          <div class="panel-head"><h2>Found in the books</h2><p>Purchases recorded to fixed asset accounts, and equipment of $2,500 or more coded to expense accounts. Add the ones that belong in the register; for expensed ones, also move them to a fixed asset account in QuickBooks.</p></div>
          <div class="panel-body flush"><div class="table-wrap"><table>
            <thead><tr><th>Date</th><th>Vendor</th><th>Memo</th><th>Recorded to</th><th class="num">Amount</th><th></th></tr></thead>
            <tbody>${found.map((c) => html`<tr key=${c.key}>
              <td class="nowrap">${c.date}</td><td>${c.vendor}</td><td>${c.memo}</td>
              <td>${c.account}${c.expensed ? html` <span class="pill medium"><span class="dot"></span>Expensed</span>` : ''}</td>
              <td class="num">${fmtMoney(c.amount)}</td>
              <td><button class="btn" onClick=${() => addFound(c)}>Add</button></td>
            </tr>`)}</tbody>
          </table></div></div>
        </section>`],
        ['register', 'Asset register', html`<section class="panel">
          <div class="panel-head"><h2>Asset register</h2><p>Book depreciation is straight-line from the month placed in service. Tax figures follow the IRS tables and are estimates for the tax preparer, who makes the bonus and Section 179 elections on the return.</p></div>
          ${schedule.midQuarterYears.length > 0 && html`<div class="panel-body"><${Banner} level="medium" label="Mid-quarter rule">More than 40% of the equipment placed in service in ${schedule.midQuarterYears.join(', ')} was bought in October to December, so the IRS mid-quarter convention applies to that year's equipment. The tax figures use it.</${Banner}></div>`}
          ${gap != null && Math.abs(gap) > 1 && html`<div class="panel-body"><${Banner} level="medium" label="Register incomplete">The books show ${wholeMoney(fa.bookCost)} in fixed asset accounts${fa.bookAccumulated ? ` (${wholeMoney(fa.bookAccumulated)} depreciated)` : ''}; the register lists ${wholeMoney(fa.bookCost - gap)} of it. Add the older assets from the client's depreciation schedule, which their tax preparer has.</${Banner}></div>`}
          ${schedule.rows.length
            ? html`<div class="panel-body flush"><div class="table-wrap"><table>
                <thead><tr><th>Asset</th><th>In service</th><th class="num">Cost</th><th class="num">Book life</th><th class="num">Depreciated</th><th class="num">Book value</th><th>Tax method</th><th class="num">Tax ${year}</th><th></th></tr></thead>
                <tbody>${schedule.rows.map((r) => html`<tr key=${r.id}>
                  <td>${r.name}<span class="sub">${r.categoryLabel}${r.disposal ? ` · sold ${r.disposal.date}, ${r.disposal.gain >= 0 ? 'gain' : 'loss'} ${wholeMoney(Math.abs(r.disposal.gain))}` : ''}</span></td>
                  <td class="nowrap">${r.date}</td>
                  <td class="num">${fmtMoney(r.cost)}</td>
                  <td class="num">${r.bookLife ? `${r.bookLife} yr` : '—'}</td>
                  <td class="num">${fmtMoney(r.accumulated)}</td>
                  <td class="num">${fmtMoney(r.nbv)}</td>
                  <td>${r.methodLabel}${r.midQuarter ? html`<span class="sub">Mid-quarter</span>` : ''}${r.category === 'vehicle' ? html`<span class="sub">Car limits may apply</span>` : ''}</td>
                  <td class="num">${fmtMoney(r.taxByYear[year] || 0)}</td>
                  <td class="row-actions"><button class="btn" onClick=${() => setEditing(assets.find((a) => a.id === r.id))}>Edit</button><button class="btn" aria-label=${`Remove ${r.name}`} onClick=${() => setAssets((list) => list.filter((a) => a.id !== r.id))}>Remove</button></td>
                </tr>`)}
                <tr class="total"><td>Total</td><td></td><td class="num">${fmtMoney(schedule.cost)}</td><td></td><td class="num">${fmtMoney(schedule.accumulated)}</td><td class="num">${fmtMoney(schedule.nbv)}</td><td></td><td class="num">${fmtMoney(thisYear.tax)}</td><td></td></tr></tbody>
              </table></div></div>`
            : html`<div class="empty">No assets yet. Add them above.</div>`}
        </section>`],
        ['years', 'Depreciation by year', schedule.rows.length > 0 && html`<section class="panel">
          <div class="panel-head"><h2>Depreciation by year</h2><p>Book depreciation from the register against what was posted in QuickBooks, and the tax deduction each year.</p></div>
          <div class="panel-body flush"><div class="table-wrap"><table>
            <thead><tr><th>Year</th><th class="num">Book depreciation</th><th class="num">Posted in the books</th><th class="num">Difference</th><th class="num">Tax deduction</th></tr></thead>
            <tbody>${schedule.years.map((y) => {
              const posted = fa.recorded[y.year];
              const inExport = exportYears.has(String(y.year));
              const diff = inExport ? Math.round(((posted || 0) - y.book) * 100) / 100 : null;
              return html`<tr key=${y.year}>
                <td>${y.year}</td><td class="num">${fmtMoney(y.book)}</td>
                <td class="num">${inExport ? fmtMoney(posted || 0) : ''}</td>
                <td class=${`num ${diff && Math.abs(diff) > 1 ? 'neg' : ''}`}>${diff == null ? '' : Math.abs(diff) <= 1 ? 'Matches' : fmtMoney(diff)}</td>
                <td class="num">${fmtMoney(y.tax)}</td>
              </tr>`;
            })}</tbody>
          </table></div></div>
          <div class="panel-body"><p class="hint">A difference usually means assets missing from the register, or a year-end entry not posted yet.</p></div>
        </section>`],
        ['entry', 'Journal entry', schedule.rows.length > 0 && html`<section class="panel">
          <div class="panel-head"><h2>Depreciation journal entry</h2><p>The book depreciation for a month or a year, ready to import into QuickBooks Online (Settings → Import data → Journal entries) or to key in.</p></div>
          <div class="panel-body">
            <div class="drawer-fields">
              <label class="field" for="je-period">Period
                <select id="je-period" class="select" value=${period} onChange=${(e) => setPeriod(e.target.value)}>${periods.map((p) => html`<option key=${p} value=${p}>${/^\d{4}$/.test(p) ? `Year ${p}` : monthName(p)}</option>`)}</select>
              </label>
              <label class="field" for="je-exp">Expense account<input id="je-exp" class="text" value=${accounts.expense || ''} onInput=${(e) => setAccounts((a) => ({ ...a, expense: e.target.value }))} /></label>
              <label class="field" for="je-acc">Accumulated depreciation account<input id="je-acc" class="text" value=${accounts.accumulated || ''} onInput=${(e) => setAccounts((a) => ({ ...a, accumulated: e.target.value }))} /></label>
            </div>
            ${entry.total > 0
              ? html`<div class="table-wrap"><table>
                  <thead><tr><th>Account</th><th class="num">Debit</th><th class="num">Credit</th></tr></thead>
                  <tbody>
                    <tr><td>${entry.expense}</td><td class="num">${fmtMoney(entry.total)}</td><td></td></tr>
                    <tr><td>${entry.accumulated}</td><td></td><td class="num">${fmtMoney(entry.total)}</td></tr>
                  </tbody>
                </table></div>
                <p class="hint">Dated ${entry.date}, entry ${entry.number}: ${entry.lines.map((l) => `${l.name} ${fmtMoney(l.amount)}`).join(' · ')}</p>
                <div class="backup-actions"><button class="btn primary" onClick=${async () => setStatus(await saveTextFile(`depreciation-${period}.csv`, entry.csv))}>${Icon.download}Download for QuickBooks</button></div>`
              : html`<p class="hint">No depreciation falls in ${/^\d{4}$/.test(period) ? period : monthName(period)}.</p>`}
          </div>
        </section>`],
      ]} />`;
  }

  Object.assign(UI, { AssetsTab });
})();
