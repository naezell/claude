/* Ledger Lens UI: top-level app. */
(function () {
  'use strict';
  const { useState, useMemo, useEffect, useRef, useCallback } = React;
  const html = htm.bind(React.createElement);
  const E = window.LedgerEngine;
  const UI = window.LedgerUI;
  const { safeStore, ClientStore, emptyProfile, excelToCsv, useDebounced, Icon, AuditTab, GrowthTab, Banner, CashTab, BreakEvenTab, TrendsTab, BudgetTab, VendorsTab, BenchmarksTab, AdvisoryTab, QuestionsDrawer, ClientsDrawer, ReportDrawer, HelpDrawer, Firm, Backup } = UI;

  // ------------------------------------------------------------ top-level app

  function App() {
    const [source, setSource] = useState({ kind: 'sample' });
    const sourceRef = useRef(source);
    sourceRef.current = source;
    const [error, setError] = useState('');
    const [tab, setTab] = useState(() => safeStore.get('ll.tab') || 'audit');
    const [groupBy, setGroupBy] = useState('customer');
    const [accountClass, setAccountClass] = useState({});
    const [reportOpen, setReportOpen] = useState(false);
    const [dragging, setDragging] = useState(false);
    const [benchmarks, setBenchmarks] = useState(null);
    const [reviewed, setReviewed] = useState({});
    const [benchPrefs, setBenchPrefs] = useState(null);
    const [restored, setRestored] = useState(null);
    const [questionsOpen, setQuestionsOpen] = useState(false);
    const [clientsOpen, setClientsOpen] = useState(false);
    const [helpOpen, setHelpOpen] = useState(false);
    const [welcome, setWelcome] = useState(() => !safeStore.get('ll.welcomed'));
    const dismissWelcome = () => { safeStore.set('ll.welcomed', '1'); setWelcome(false); };
    // Checked when the page opens and whenever the backup drawer closes.
    const [backupDue, setBackupDue] = useState(() => Backup.overdue());
    const [backupSnoozed, setBackupSnoozed] = useState(false);
    const [scenario, setScenario] = useState({ levers: [] });
    const [budgetPrefs, setBudgetPrefs] = useState({ mode: 'auto', revenueGrowth: '10', costGrowth: '5' });
    // Snapshot of the months the bookkeeper closed, to catch later edits to them.
    const [closed, setClosed] = useState(null);
    const [loanInputs, setLoanInputs] = useState({ amount: '', rate: '10.5', years: '10', addBacks: '' });
    const [taxInputs, setTaxInputs] = useState({ entity: 'sole', rate: '', salary: '', paid: '' });
    // Forecast inputs. Empty strings mean "use the value estimated from the export".
    const [cashInputs, setCashInputs] = useState({ startingCash: '', cushion: '', includeDoubtful: false });

    const sampleText = useMemo(() => window.LedgerSample.build(), []);
    // One or more uploaded exports are parsed separately, then merged.
    const parsed = useMemo(() => {
      try {
        if (source.kind === 'sample') return { ok: E.parseTransactions(sampleText) };
        return { ok: E.mergeParsed(source.files.map((f) => f.parsed)) };
      } catch (e) { return { err: e.message }; }
    }, [source, sampleText]);
    // The chart of accounts, when one was loaded, gives exact account types.
    const sampleChart = useMemo(() => E.parseChartOfAccounts(window.LedgerSample.chartOfAccounts()), []);
    const chart = source.kind === 'sample' ? sampleChart : source.chart ? source.chart.parsed : null;
    const samplePnl = useMemo(() => E.parseProfitAndLoss(window.LedgerSample.profitAndLoss()), []);
    const pnl = source.kind === 'sample' ? samplePnl : source.pnl ? source.pnl.parsed : null;
    const sampleBudget = useMemo(() => E.parseBudget(window.LedgerSample.budgetOverview()), []);
    const uploadedBudget = source.kind === 'sample' ? { name: 'Sample FY2026 budget', parsed: sampleBudget } : source.budget || null;

    // Stable object: it only changes when one of the inputs does.
    const typedNow = useMemo(() => ({ cash: cashInputs, loan: loanInputs, tax: taxInputs, scenario, budget: budgetPrefs }), [cashInputs, loanInputs, taxInputs, scenario, budgetPrefs]);
    const typed = useDebounced(typedNow, 300);
    const startingCash = typed.cash.startingCash === '' ? undefined : parseFloat(typed.cash.startingCash);
    const result = useMemo(() => (parsed.ok ? E.analyze(parsed.ok, {
      accountClass, groupBy, chart, pnl, reviewed, closed, scenario: typed.scenario,
      budget: uploadedBudget && typed.budget.mode !== 'history' ? uploadedBudget.parsed : null,
      budgetGrowth: { revenueGrowth: parseFloat(typed.budget.revenueGrowth) || 0, costGrowth: parseFloat(typed.budget.costGrowth) || 0 },
      cushion: typed.cash.cushion === '' ? undefined : parseFloat(typed.cash.cushion),
      loan: { amount: parseFloat(typed.loan.amount) || 0, rate: parseFloat(typed.loan.rate) || 0, years: parseFloat(typed.loan.years) || 10, addBacks: parseFloat(typed.loan.addBacks) || 0 },
      tax: { entity: typed.tax.entity, rate: typed.tax.rate === '' ? undefined : parseFloat(typed.tax.rate), salary: parseFloat(typed.tax.salary) || 0, paid: typed.tax.paid === '' ? undefined : parseFloat(typed.tax.paid) }, startingCash: isNaN(startingCash) ? undefined : startingCash, includeDoubtful: cashInputs.includeDoubtful,
    }) : null), [parsed, accountClass, groupBy, chart, pnl, uploadedBudget, reviewed, closed, startingCash, cashInputs.includeDoubtful, typed]);

    // Restore a client's saved settings when their file loads; the sample always starts clean.
    const clientId = source.kind === 'upload' && parsed.ok ? E.clientKey(parsed.ok.meta) : null;
    useEffect(() => {
      const saved = ClientStore.get(clientId);
      setAccountClass(saved ? saved.accountClass || {} : {});
      setReviewed(saved ? saved.reviewed || {} : {});
      setClosed(saved && saved.closed ? saved.closed : null);
      setCashInputs({ startingCash: '', cushion: saved && saved.cushion ? String(saved.cushion) : '', includeDoubtful: false });
      setBenchPrefs(saved ? saved.bench || null : null);
      setScenario({ levers: [] });
      setBudgetPrefs(saved && saved.budgetPrefs ? saved.budgetPrefs : { mode: 'auto', revenueGrowth: '10', costGrowth: '5' });
      setLoanInputs(saved && saved.loan ? saved.loan : { amount: '', rate: '10.5', years: '10', addBacks: '' });
      setTaxInputs(saved && saved.tax ? saved.tax : { entity: 'sole', rate: '', salary: '', paid: '' });
      setRestored(saved && !emptyProfile(saved) ? { name: saved.name, updatedAt: saved.updatedAt, corrections: Object.keys(saved.accountClass || {}).length, reviews: Object.keys(saved.reviewed || {}).length } : null);
    }, [source, clientId]);
    // Save as the bookkeeper works.
    useEffect(() => {
      if (!clientId) return;
      const profile = { name: parsed.ok.meta.company || clientId, accountClass, reviewed, closed, cushion: cashInputs.cushion || '', bench: benchPrefs, loan: loanInputs, tax: taxInputs, budgetPrefs };
      const saved = ClientStore.get(clientId);
      if (emptyProfile(profile) && !saved) return;
      ClientStore.put(clientId, profile);
    }, [clientId, accountClass, reviewed, closed, cashInputs.cushion, benchPrefs, loanInputs, taxInputs, budgetPrefs]);
    const setReview = useCallback((keys, status) => {
      setReviewed((prev) => {
        const next = { ...prev };
        for (const k of [].concat(keys)) {
          if (!status) delete next[k];
          else next[k] = { status, at: new Date().toISOString().slice(0, 10) };
        }
        return next;
      });
    }, []);
    // Default cushion: one month of fixed costs, rounded to the nearest $1,000.
    const defaultCushion = result && result.breakeven ? Math.round(result.breakeven.base.fixed / 1000) * 1000 : 0;
    const cushion = cashInputs.cushion === '' || isNaN(parseFloat(cashInputs.cushion)) ? defaultCushion : parseFloat(cashInputs.cushion);

    useEffect(() => { safeStore.set('ll.tab', tab); }, [tab]);
    useEffect(() => { if (parsed.err) setError(parsed.err); }, [parsed]);

    const readFile = (file) => new Promise((resolve) => {
      const excel = /\.(xlsx|xlsm|xls)$/i.test(file.name);
      if (!excel && !/\.(csv|txt)$/i.test(file.name)) { resolve({ name: file.name, error: 'is not a CSV or Excel file. In QuickBooks, open the report and choose Export.' }); return; }
      const reader = new FileReader();
      reader.onload = async () => {
        let text;
        try {
          text = excel ? await excelToCsv(reader.result) : String(reader.result || '');
        } catch (e) { resolve({ name: file.name, error: e.message }); return; }
        try {
          // A chart of accounts has Account and Type columns and no dates.
          const coa = E.parseChartOfAccounts(text);
          if (coa) { resolve({ name: file.name, chart: coa }); return; }
          const bud = E.parseBudget(text);
          if (bud) { resolve({ name: file.name, budget: bud }); return; }
          // A Profit and Loss report has a Net Income line and no dates.
          const pl = E.parseProfitAndLoss(text);
          if (pl) { resolve({ name: file.name, pnl: pl }); return; }
          const p = E.parseTransactions(text);
          if (!p.transactions.length) throw new Error('has a header row but no dated transactions.');
          resolve({ name: file.name, parsed: p });
        } catch (e) { resolve({ name: file.name, error: e.message }); }
      };
      reader.onerror = () => resolve({ name: file.name, error: 'could not be read.' });
      if (excel) reader.readAsArrayBuffer(file); else reader.readAsText(file);
    });

    // Loads one or more exports. With `append`, adds them to the files already loaded
    // (a file with the same name replaces the earlier copy).
    const loadFiles = useCallback(async (fileList, append) => {
      const files = [...(fileList || [])];
      if (!files.length) return;
      const results = await Promise.all(files.map(readFile));
      const bad = results.filter((r) => r.error);
      const good = results.filter((r) => r.parsed);
      const lastOf = (key) => { const hits = results.filter((r) => r[key]); return hits.length ? { name: hits[hits.length - 1].name, parsed: hits[hits.length - 1][key] } : null; };
      const chartFile = lastOf('chart');
      const pnlFile = lastOf('pnl');
      const budgetFile = lastOf('budget');
      const errors = bad.map((b) => `${b.name} ${b.error}`);
      const prev = sourceRef.current;
      if (!good.length) {
        // A chart or P&L on its own attaches to the transactions already loaded.
        const extra = chartFile || pnlFile || budgetFile;
        if (extra && prev.kind === 'upload') setSource({ ...prev, chart: chartFile || prev.chart, pnl: pnlFile || prev.pnl, budget: budgetFile || prev.budget });
        else if (extra) errors.push(`${extra.name} is a ${chartFile ? 'chart of accounts' : pnlFile ? 'Profit and Loss report' : 'budget'}. Upload the client's Transaction Detail with it.`);
      } else {
        const keepPrev = append && prev.kind === 'upload';
        const kept = keepPrev ? prev.files.filter((f) => !good.some((g) => g.name === f.name)) : [];
        setSource({ kind: 'upload', files: [...kept, ...good], chart: chartFile || (keepPrev ? prev.chart : null), pnl: pnlFile || (keepPrev ? prev.pnl : null), budget: budgetFile || (keepPrev ? prev.budget : null) });
      }
      setError(errors.join(' '));
    }, []);

    useEffect(() => {
      let depth = 0;
      const enter = (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { depth++; setDragging(true); e.preventDefault(); } };
      const over = (e) => { if (dragging || depth) e.preventDefault(); };
      const leave = () => { depth = Math.max(0, depth - 1); if (!depth) setDragging(false); };
      const drop = (e) => { e.preventDefault(); depth = 0; setDragging(false); loadFiles(e.dataTransfer.files, e.shiftKey); };
      window.addEventListener('dragenter', enter); window.addEventListener('dragover', over);
      window.addEventListener('dragleave', leave); window.addEventListener('drop', drop);
      return () => {
        window.removeEventListener('dragenter', enter); window.removeEventListener('dragover', over);
        window.removeEventListener('dragleave', leave); window.removeEventListener('drop', drop);
      };
    }, [loadFiles, dragging]);

    const auditCount = result ? result.audit.open.uncategorized + result.audit.open.duplicates + result.audit.open.mismatches : 0;

    return html`
      <header class="topbar">
        <div class="wrap">
          <div class="brand">
            ${Firm.mark
              ? html`<img class="brand-logo" src=${Firm.mark} alt="" />`
              : html`<div class="brand-mark" aria-hidden="true">
                  <svg viewBox="0 0 16 16" fill="none" stroke="var(--accent-ink)" stroke-width="1.8" stroke-linecap="round"><circle cx="7" cy="7" r="4.2"/><path d="m10.2 10.2 3.3 3.3M5 7h4M7 5v4"/></svg>
                </div>`}
            <div><h1>${Firm.name || 'Ledger Lens'}</h1><small>${Firm.name ? 'Ledger Lens · QuickBooks review, profitability & cash forecast' : 'QuickBooks audit, profitability & cash forecast'}</small></div>
          </div>
          <div class="actions">
            <label class="btn" for="csv-upload">${Icon.upload}Upload export</label>
            <input id="csv-upload" class="file-input" type="file" multiple accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" onChange=${(e) => { loadFiles(e.target.files, false); e.target.value = ''; }} />
            ${source.kind === 'upload' && html`<label class="btn" for="csv-add">${Icon.upload}Add export</label>
              <input id="csv-add" class="file-input" type="file" multiple accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" onChange=${(e) => { loadFiles(e.target.files, true); e.target.value = ''; }} />`}
            ${source.kind !== 'sample' && html`<button class="btn" onClick=${() => { setError(''); setAccountClass({}); setCashInputs({ startingCash: '', cushion: '', includeDoubtful: false }); setSource({ kind: 'sample' }); }}>${Icon.sample}Load sample</button>`}
            <button class="btn" onClick=${() => setClientsOpen(true)}>${Icon.cloud}Saved clients</button>
            <button class="btn" disabled=${!result} onClick=${() => setQuestionsOpen(true)}>${Icon.copy}Client questions</button>
            <button class="btn primary" disabled=${!result} onClick=${() => setReportOpen(true)}>${Icon.report}Client report</button>
            <button class="btn" onClick=${() => setHelpOpen(true)}>${Icon.help}Help</button>
          </div>
        </div>
      </header>

      <div class="wrap">
        <div class="source">
          ${source.kind === 'sample'
            ? html`<span class="pill sample"><span class="dot"></span>Sample data</span><span>Showing a fictional design studio. Upload your QuickBooks <strong>Transaction Detail</strong> export (CSV or Excel; several at once is fine, such as one per year), or drop them anywhere on this page.</span>`
            : html`<span class="pill good"><span class="dot"></span>${source.files.length > 1 ? `${source.files.length} files combined` : 'Your file'}</span><strong>${source.files.map((f) => f.name).join(', ')}</strong>${parsed.ok && parsed.ok.meta.droppedOverlap ? html`<span>${parsed.ok.meta.droppedOverlap} overlapping rows skipped</span>` : ''}`}
          ${result && (result.chart
            ? html`<span class="pill good"><span class="dot"></span>Chart of accounts</span><span>${result.chart.matched} of ${result.chart.of} accounts typed from it</span>`
            : source.kind === 'upload' && html`<span class="hint">Add the client's Chart of Accounts export (Account List report) for exact account types.</span>`)}
          ${uploadedBudget && source.kind === 'upload' && html`<span class="pill good"><span class="dot"></span>Budget</span>`}
          ${result && (result.tieOut
            ? html`<span class=${`pill ${result.tieOut.ties ? 'good' : 'high'}`}><span class="dot"></span>${result.tieOut.ties ? 'Ties to QuickBooks P&L' : 'Does not tie to QuickBooks P&L'}</span>`
            : source.kind === 'upload' && html`<span class="hint">Add the Profit and Loss export for the same dates to confirm the numbers match QuickBooks.</span>`)}
          ${result && html`<span>${result.meta.company && source.kind !== 'sample' ? `${result.meta.company} · ` : ''}${result.period.start} to ${result.period.end} · <span class="num">${result.count.toLocaleString()}</span> rows${result.entryCount !== result.count ? html` (<span class="num">${result.entryCount.toLocaleString()}</span> unique entries)` : ''}</span>`}
        </div>
        ${error && html`<div class="error" role="alert">${error}</div>`}
        ${welcome && html`<${Banner} level="good" label="Welcome">New here? The getting-started guide covers which QuickBooks reports to export, a monthly routine and how to send reports. <button class="linkish" onClick=${() => { dismissWelcome(); setHelpOpen(true); }}>Open the guide</button> · <button class="linkish" onClick=${dismissWelcome}>Dismiss</button></${Banner}>`}
        ${!welcome && backupDue && !backupSnoozed && html`<${Banner} level="medium" label="Back up">Your saved clients have not been backed up in over 30 days. They live only in this browser. <button class="linkish" onClick=${() => setClientsOpen(true)}>Back up now</button> · <button class="linkish" onClick=${() => setBackupSnoozed(true)}>Later</button></${Banner}>`}
        ${restored && html`<${Banner} level="good" label="Settings restored">Picked up where you left off with ${restored.name}${restored.updatedAt ? ` (saved ${restored.updatedAt.slice(0, 10)})` : ''}: ${restored.corrections} account type correction${restored.corrections === 1 ? '' : 's'} and ${restored.reviews} reviewed flag${restored.reviews === 1 ? '' : 's'}. <button class="linkish" onClick=${() => setRestored(null)}>Dismiss</button></${Banner}>`}

        <div class="tabs" role="tablist">
          <button class="tab" role="tab" id="tab-audit" aria-selected=${tab === 'audit'} onClick=${() => setTab('audit')}>Diagnostic audit<span class="count">${auditCount}</span></button>
          <button class="tab" role="tab" id="tab-growth" aria-selected=${tab === 'growth'} onClick=${() => setTab('growth')}>Growth & profitability insights</button>
          <button class="tab" role="tab" id="tab-cash" aria-selected=${tab === 'cash'} onClick=${() => setTab('cash')}>Cash forecast</button>
          <button class="tab" role="tab" id="tab-breakeven" aria-selected=${tab === 'breakeven'} onClick=${() => setTab('breakeven')}>Break-even</button>
          <button class="tab" role="tab" id="tab-trends" aria-selected=${tab === 'trends'} onClick=${() => setTab('trends')}>Trends</button>
          <button class="tab" role="tab" id="tab-budget" aria-selected=${tab === 'budget'} onClick=${() => setTab('budget')}>Budget</button>
          <button class="tab" role="tab" id="tab-vendors" aria-selected=${tab === 'vendors'} onClick=${() => setTab('vendors')}>Vendors</button>
          <button class="tab" role="tab" id="tab-benchmarks" aria-selected=${tab === 'benchmarks'} onClick=${() => setTab('benchmarks')}>Benchmarks</button>
          <button class="tab" role="tab" id="tab-advisory" aria-selected=${tab === 'advisory'} onClick=${() => setTab('advisory')}>Tax & lending</button>
        </div>

        ${result && html`<main role="tabpanel" aria-labelledby=${`tab-${tab}`}>
          ${tab === 'audit' ? html`<${AuditTab} result=${result} accountClass=${accountClass} setAccountClass=${setAccountClass} onReview=${setReview} onClose=${(through) => setClosed(through ? result.closeBooks(through) : null)} canSave=${!!clientId} />`
            : tab === 'growth' ? html`<${GrowthTab} result=${result} groupBy=${groupBy} setGroupBy=${setGroupBy} onReview=${setReview} />`
            : tab === 'cash' ? html`<${CashTab} cash=${result.cash} scenarioCash=${result.cashScenario} scenario=${scenario} setScenario=${setScenario} inputs=${cashInputs} setInputs=${setCashInputs} cushion=${cushion} defaultCushion=${defaultCushion} />`
            : tab === 'breakeven' ? html`<${BreakEvenTab} be=${result.breakeven} onOpenMapping=${() => setTab('audit')} />`
            : tab === 'trends' ? html`<${TrendsTab} trend=${result.trend} />`
            : tab === 'budget' ? html`<${BudgetTab} bva=${result.budget} uploaded=${uploadedBudget} prefs=${budgetPrefs} setPrefs=${setBudgetPrefs} />`
            : tab === 'vendors' ? html`<${VendorsTab} vendors=${result.vendors} />`
            : tab === 'benchmarks' ? html`<${BenchmarksTab} result=${result} onResult=${setBenchmarks} prefs=${benchPrefs} onPrefs=${setBenchPrefs} />`
            : html`<${AdvisoryTab} result=${result} loanInputs=${loanInputs} setLoanInputs=${setLoanInputs} taxInputs=${taxInputs} setTaxInputs=${setTaxInputs} />`}
        </main>`}
        <footer class="foot">Files are processed in your browser and never uploaded. Review settings are saved in this browser only; back them up from Saved clients. Flags are leads for review, not confirmed errors.${Firm.website ? html` · <a href=${/^https?:/.test(Firm.website) ? Firm.website : `https://${Firm.website}`} target="_blank" rel="noopener">${Firm.website}</a>` : ''}</footer>
      </div>

      ${questionsOpen && result && html`<${QuestionsDrawer} result=${result} onClose=${() => setQuestionsOpen(false)} onMarkAsked=${(keys) => setReview(keys, 'asked')} />`}
      ${helpOpen && html`<${HelpDrawer} onClose=${() => setHelpOpen(false)} onOpenClients=${() => setClientsOpen(true)} />`}
      ${clientsOpen && html`<${ClientsDrawer} currentId=${clientId} onClose=${() => { setClientsOpen(false); setBackupDue(Backup.overdue()); }} onForget=${(id) => { if (id === clientId) { setAccountClass({}); setReviewed({}); setBenchPrefs(null); setCashInputs({ startingCash: '', cushion: '', includeDoubtful: false }); setRestored(null); } }} />`}
      ${reportOpen && result && html`<${ReportDrawer} result=${result} groupBy=${groupBy} cushion=${cushion} benchmarks=${benchmarks} onClose=${() => setReportOpen(false)} />`}
      ${dragging && html`<div class="drop-overlay">Drop the QuickBooks CSV to analyze it</div>`}
    `;
  }

  ReactDOM.createRoot(document.getElementById('root')).render(html`<${App} />`);
})();
