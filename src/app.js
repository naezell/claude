/* Ledger Lens dashboard UI (React + Recharts, templated with htm). */
(function () {
  'use strict';
  const { useState, useMemo, useEffect, useRef, useCallback } = React;
  const html = htm.bind(React.createElement);
  const {
    ResponsiveContainer, BarChart, Bar, AreaChart, Area, LineChart, Line, ComposedChart, XAxis, YAxis, CartesianGrid, Tooltip, Cell, ReferenceLine,
  } = Recharts;
  const E = window.LedgerEngine;
  const { fmtMoney, fmtWhole, fmtPct, counterpartyOf, leafAccount } = E;

  // Resolve the viewer's download capability early; null outside claude.ai.
  const downloadsReady = window.claude && typeof window.claude.use === 'function'
    ? window.claude.use('downloads').catch(() => null)
    : Promise.resolve(null);

  // ------------------------------------------------------------ helpers

  const compactMoney = (n) => {
    const a = Math.abs(n);
    const s = a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k` : a.toFixed(0);
    return `${n < 0 ? '-' : ''}$${s}`;
  };
  const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const safeStore = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } },
  };

  // Saved client settings live in this browser only (the page never uploads client data).
  // Everything goes through this object, so moving storage elsewhere is a one-place change.
  const ClientStore = {
    key: 'll.clients.v1',
    all() { try { return JSON.parse(safeStore.get(this.key) || '{}') || {}; } catch (e) { return {}; } },
    get(id) { return id ? this.all()[id] || null : null; },
    put(id, profile) {
      if (!id) return;
      const all = this.all();
      all[id] = { ...profile, updatedAt: new Date().toISOString() };
      safeStore.set(this.key, JSON.stringify(all));
    },
    remove(id) { const all = this.all(); delete all[id]; safeStore.set(this.key, JSON.stringify(all)); },
    // Import keeps whichever copy of each client was updated more recently.
    merge(incoming) {
      const all = this.all();
      let n = 0;
      for (const [id, p] of Object.entries(incoming || {})) {
        if (!p || typeof p !== 'object') continue;
        if (!all[id] || String(p.updatedAt || '') > String(all[id].updatedAt || '')) { all[id] = p; n++; }
      }
      safeStore.set(this.key, JSON.stringify(all));
      return n;
    },
  };
  const emptyProfile = (p) => !p || (!Object.keys(p.accountClass || {}).length && !Object.keys(p.reviewed || {}).length && !p.cushion && !p.bench && !(p.loan && p.loan.amount) && !(p.tax && (p.tax.entity !== 'sole' || p.tax.rate || p.tax.salary || p.tax.paid)));

  async function saveTextFile(filename, data) {
    const downloads = await downloadsReady;
    if (downloads) {
      try { await downloads.save({ filename, data }); return `Saved ${filename}`; } catch (e) {
        const code = e && e.code;
        return code === 'declined' ? 'Download cancelled.' : code === 'rate_limited' ? 'A save prompt is already open.' : 'Downloads are unavailable here. Use Copy instead.';
      }
    }
    const url = URL.createObjectURL(new Blob([data], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return `Downloaded ${filename}`;
  }

  function copyText(text, el) {
    const selectAll = () => {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges(); sel.addRange(range);
      return 'Text selected. Press Ctrl+C / Cmd+C to copy.';
    };
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(() => 'Copied to clipboard.', selectAll);
    return Promise.resolve(selectAll());
  }

  const slug = (s) => (s || 'client').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'client';

  // Chart colors come from CSS tokens so both themes stay in sync.
  function useTokens() {
    const read = () => {
      const cs = getComputedStyle(document.documentElement);
      const g = (n) => cs.getPropertyValue(n).trim();
      return {
        s1: g('--series-1'), s2: g('--series-2'), s3: g('--series-3'), s4: g('--series-4'), s5: g('--series-5'), pos: g('--pos'), neg: g('--neg'),
        neutral: g('--neutral-mark'), grid: g('--hair'), axis: g('--axis'), muted: g('--muted'), ink2: g('--ink-2'),
        surface: g('--surface'), surface2: g('--surface-2'), warnLine: g('--warn'),
      };
    };
    const [tokens, setTokens] = useState(read);
    useEffect(() => {
      const update = () => setTokens(read());
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      mq.addEventListener('change', update);
      const mo = new MutationObserver(update);
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      return () => { mq.removeEventListener('change', update); mo.disconnect(); };
    }, []);
    return tokens;
  }

  const Icon = {
    upload: html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 10.5V2.5M4.8 5.5 8 2.3l3.2 3.2M2.5 10.5v2.2c0 .5.4.8.8.8h9.4c.4 0 .8-.3.8-.8v-2.2"/></svg>`,
    report: html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 1.8h5.2L12.5 5v9.2H4z"/><path d="M9 1.8V5h3.5M6 8h4.5M6 10.5h4.5"/></svg>`,
    sample: html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2.5 3.5h11M2.5 8h11M2.5 12.5h7"/></svg>`,
    check: html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3.5 8.5 3 3 6-7"/></svg>`,
    download: html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.5v8M4.8 7.5 8 10.7l3.2-3.2M2.5 12.8h11"/></svg>`,
    copy: html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="5" y="5" width="8.5" height="8.5" rx="1.2"/><path d="M11 5V3.2c0-.4-.3-.7-.7-.7H3.2c-.4 0-.7.3-.7.7v7.1c0 .4.3.7.7.7H5"/></svg>`,
  };

  function Severity({ level }) {
    return html`<span class=${`pill ${level.toLowerCase()}`}><span class="dot"></span>${level}</span>`;
  }

  function Money({ v, cls }) {
    return html`<span class=${`num ${cls || ''} ${v < 0 ? 'neg' : ''}`}>${fmtMoney(v)}</span>`;
  }

  function ChartTooltip({ active, payload, label, rows }) {
    if (!active || !payload || !payload.length) return null;
    const d = payload[0].payload;
    return html`<div class="tt">
      <strong>${d.fullName || label}</strong>
      ${rows(d).map((r) => html`<div class="tt-row" key=${r.label}><span>${r.color ? html`<i style=${{ background: r.color }}></i>` : null}${r.label}</span><b>${r.value}</b></div>`)}
    </div>`;
  }

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

    const startingCash = cashInputs.startingCash === '' ? undefined : parseFloat(cashInputs.startingCash);
    const result = useMemo(() => (parsed.ok ? E.analyze(parsed.ok, {
      accountClass, groupBy, chart, reviewed,
      cushion: cashInputs.cushion === '' ? undefined : parseFloat(cashInputs.cushion),
      loan: { amount: parseFloat(loanInputs.amount) || 0, rate: parseFloat(loanInputs.rate) || 0, years: parseFloat(loanInputs.years) || 10, addBacks: parseFloat(loanInputs.addBacks) || 0 },
      tax: { entity: taxInputs.entity, rate: taxInputs.rate === '' ? undefined : parseFloat(taxInputs.rate), salary: parseFloat(taxInputs.salary) || 0, paid: taxInputs.paid === '' ? undefined : parseFloat(taxInputs.paid) }, startingCash: isNaN(startingCash) ? undefined : startingCash, includeDoubtful: cashInputs.includeDoubtful,
    }) : null), [parsed, accountClass, groupBy, chart, reviewed, startingCash, cashInputs.includeDoubtful, cashInputs.cushion, loanInputs, taxInputs]);

    // Restore a client's saved settings when their file loads; the sample always starts clean.
    const clientId = source.kind === 'upload' && parsed.ok ? E.clientKey(parsed.ok.meta) : null;
    useEffect(() => {
      const saved = ClientStore.get(clientId);
      setAccountClass(saved ? saved.accountClass || {} : {});
      setReviewed(saved ? saved.reviewed || {} : {});
      setCashInputs({ startingCash: '', cushion: saved && saved.cushion ? String(saved.cushion) : '', includeDoubtful: false });
      setBenchPrefs(saved ? saved.bench || null : null);
      setLoanInputs(saved && saved.loan ? saved.loan : { amount: '', rate: '10.5', years: '10', addBacks: '' });
      setTaxInputs(saved && saved.tax ? saved.tax : { entity: 'sole', rate: '', salary: '', paid: '' });
      setRestored(saved && !emptyProfile(saved) ? { name: saved.name, updatedAt: saved.updatedAt, corrections: Object.keys(saved.accountClass || {}).length, reviews: Object.keys(saved.reviewed || {}).length } : null);
    }, [source, clientId]);
    // Save as the bookkeeper works.
    useEffect(() => {
      if (!clientId) return;
      const profile = { name: parsed.ok.meta.company || clientId, accountClass, reviewed, cushion: cashInputs.cushion || '', bench: benchPrefs, loan: loanInputs, tax: taxInputs };
      const saved = ClientStore.get(clientId);
      if (emptyProfile(profile) && !saved) return;
      ClientStore.put(clientId, profile);
    }, [clientId, accountClass, reviewed, cashInputs.cushion, benchPrefs, loanInputs, taxInputs]);
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
      if (!/\.(csv|txt)$/i.test(file.name)) { resolve({ name: file.name, error: 'is not a CSV. In QuickBooks, open the report and choose Export → Export to CSV.' }); return; }
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result || '');
        try {
          // A chart of accounts has Account and Type columns and no dates.
          const coa = E.parseChartOfAccounts(text);
          if (coa) { resolve({ name: file.name, chart: coa }); return; }
          const p = E.parseTransactions(text);
          if (!p.transactions.length) throw new Error('has a header row but no dated transactions.');
          resolve({ name: file.name, parsed: p });
        } catch (e) { resolve({ name: file.name, error: e.message }); }
      };
      reader.onerror = () => resolve({ name: file.name, error: 'could not be read.' });
      reader.readAsText(file);
    });

    // Loads one or more exports. With `append`, adds them to the files already loaded
    // (a file with the same name replaces the earlier copy).
    const loadFiles = useCallback(async (fileList, append) => {
      const files = [...(fileList || [])];
      if (!files.length) return;
      const results = await Promise.all(files.map(readFile));
      const bad = results.filter((r) => r.error);
      const good = results.filter((r) => r.parsed);
      const charts = results.filter((r) => r.chart);
      const chartFile = charts.length ? { name: charts[charts.length - 1].name, parsed: charts[charts.length - 1].chart } : null;
      const errors = bad.map((b) => `${b.name} ${b.error}`);
      const prev = sourceRef.current;
      if (!good.length) {
        // A chart on its own attaches to the transactions already loaded.
        if (chartFile && prev.kind === 'upload') setSource({ ...prev, chart: chartFile });
        else if (chartFile) errors.push(`${chartFile.name} is a chart of accounts. Upload the client's Transaction Detail with it.`);
      } else {
        const keepPrev = append && prev.kind === 'upload';
        const kept = keepPrev ? prev.files.filter((f) => !good.some((g) => g.name === f.name)) : [];
        setSource({ kind: 'upload', files: [...kept, ...good], chart: chartFile || (keepPrev ? prev.chart : null) });
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
            <div class="brand-mark" aria-hidden="true">
              <svg viewBox="0 0 16 16" fill="none" stroke="var(--accent-ink)" stroke-width="1.8" stroke-linecap="round"><circle cx="7" cy="7" r="4.2"/><path d="m10.2 10.2 3.3 3.3M5 7h4M7 5v4"/></svg>
            </div>
            <div><h1>Ledger Lens</h1><small>QuickBooks audit, profitability & cash forecast</small></div>
          </div>
          <div class="actions">
            <label class="btn" for="csv-upload">${Icon.upload}Upload CSV</label>
            <input id="csv-upload" class="file-input" type="file" multiple accept=".csv,text/csv" onChange=${(e) => { loadFiles(e.target.files, false); e.target.value = ''; }} />
            ${source.kind === 'upload' && html`<label class="btn" for="csv-add">${Icon.upload}Add export</label>
              <input id="csv-add" class="file-input" type="file" multiple accept=".csv,text/csv" onChange=${(e) => { loadFiles(e.target.files, true); e.target.value = ''; }} />`}
            ${source.kind !== 'sample' && html`<button class="btn" onClick=${() => { setError(''); setAccountClass({}); setCashInputs({ startingCash: '', cushion: '', includeDoubtful: false }); setSource({ kind: 'sample' }); }}>${Icon.sample}Load sample</button>`}
            <button class="btn" onClick=${() => setClientsOpen(true)}>${Icon.sample}Saved clients</button>
            <button class="btn" disabled=${!result} onClick=${() => setQuestionsOpen(true)}>${Icon.copy}Client questions</button>
            <button class="btn primary" disabled=${!result} onClick=${() => setReportOpen(true)}>${Icon.report}Client report</button>
          </div>
        </div>
      </header>

      <div class="wrap">
        <div class="source">
          ${source.kind === 'sample'
            ? html`<span class="pill sample"><span class="dot"></span>Sample data</span><span>Showing a fictional design studio. Upload your QuickBooks <strong>Transaction Detail</strong> CSV (or several, such as one per year), or drop them anywhere on this page.</span>`
            : html`<span class="pill good"><span class="dot"></span>${source.files.length > 1 ? `${source.files.length} files combined` : 'Your file'}</span><strong>${source.files.map((f) => f.name).join(', ')}</strong>${parsed.ok && parsed.ok.meta.droppedOverlap ? html`<span>${parsed.ok.meta.droppedOverlap} overlapping rows skipped</span>` : ''}`}
          ${result && (result.chart
            ? html`<span class="pill good"><span class="dot"></span>Chart of accounts</span><span>${result.chart.matched} of ${result.chart.of} accounts typed from it</span>`
            : source.kind === 'upload' && html`<span class="hint">Add the client's Chart of Accounts export (Account List report) for exact account types.</span>`)}
          ${result && html`<span>${result.meta.company && source.kind !== 'sample' ? `${result.meta.company} · ` : ''}${result.period.start} to ${result.period.end} · <span class="num">${result.count.toLocaleString()}</span> rows${result.entryCount !== result.count ? html` (<span class="num">${result.entryCount.toLocaleString()}</span> unique entries)` : ''}</span>`}
        </div>
        ${error && html`<div class="error" role="alert">${error}</div>`}
        ${restored && html`<${Banner} level="good" label="Settings restored">Picked up where you left off with ${restored.name}${restored.updatedAt ? ` (saved ${restored.updatedAt.slice(0, 10)})` : ''}: ${restored.corrections} account type correction${restored.corrections === 1 ? '' : 's'} and ${restored.reviews} reviewed flag${restored.reviews === 1 ? '' : 's'}. <button class="linkish" onClick=${() => setRestored(null)}>Dismiss</button></${Banner}>`}

        <div class="tabs" role="tablist">
          <button class="tab" role="tab" id="tab-audit" aria-selected=${tab === 'audit'} onClick=${() => setTab('audit')}>Diagnostic audit<span class="count">${auditCount}</span></button>
          <button class="tab" role="tab" id="tab-growth" aria-selected=${tab === 'growth'} onClick=${() => setTab('growth')}>Growth & profitability insights</button>
          <button class="tab" role="tab" id="tab-cash" aria-selected=${tab === 'cash'} onClick=${() => setTab('cash')}>Cash forecast</button>
          <button class="tab" role="tab" id="tab-breakeven" aria-selected=${tab === 'breakeven'} onClick=${() => setTab('breakeven')}>Break-even</button>
          <button class="tab" role="tab" id="tab-trends" aria-selected=${tab === 'trends'} onClick=${() => setTab('trends')}>Trends</button>
          <button class="tab" role="tab" id="tab-vendors" aria-selected=${tab === 'vendors'} onClick=${() => setTab('vendors')}>Vendors</button>
          <button class="tab" role="tab" id="tab-benchmarks" aria-selected=${tab === 'benchmarks'} onClick=${() => setTab('benchmarks')}>Benchmarks</button>
          <button class="tab" role="tab" id="tab-advisory" aria-selected=${tab === 'advisory'} onClick=${() => setTab('advisory')}>Tax & lending</button>
        </div>

        ${result && html`<main role="tabpanel" aria-labelledby=${`tab-${tab}`}>
          ${tab === 'audit' ? html`<${AuditTab} result=${result} accountClass=${accountClass} setAccountClass=${setAccountClass} onReview=${setReview} />`
            : tab === 'growth' ? html`<${GrowthTab} result=${result} groupBy=${groupBy} setGroupBy=${setGroupBy} />`
            : tab === 'cash' ? html`<${CashTab} cash=${result.cash} inputs=${cashInputs} setInputs=${setCashInputs} cushion=${cushion} defaultCushion=${defaultCushion} />`
            : tab === 'breakeven' ? html`<${BreakEvenTab} be=${result.breakeven} onOpenMapping=${() => setTab('audit')} />`
            : tab === 'trends' ? html`<${TrendsTab} trend=${result.trend} />`
            : tab === 'vendors' ? html`<${VendorsTab} vendors=${result.vendors} />`
            : tab === 'benchmarks' ? html`<${BenchmarksTab} result=${result} onResult=${setBenchmarks} prefs=${benchPrefs} onPrefs=${setBenchPrefs} />`
            : html`<${AdvisoryTab} result=${result} loanInputs=${loanInputs} setLoanInputs=${setLoanInputs} taxInputs=${taxInputs} setTaxInputs=${setTaxInputs} />`}
        </main>`}
        <footer class="foot">Files are processed in your browser and never uploaded. Review settings are saved in this browser only; back them up from Saved clients. Flags are leads for review, not confirmed errors.</footer>
      </div>

      ${questionsOpen && result && html`<${QuestionsDrawer} result=${result} onClose=${() => setQuestionsOpen(false)} onMarkAsked=${(keys) => setReview(keys, 'asked')} />`}
      ${clientsOpen && html`<${ClientsDrawer} currentId=${clientId} onClose=${() => setClientsOpen(false)} onForget=${(id) => { if (id === clientId) { setAccountClass({}); setReviewed({}); setBenchPrefs(null); setCashInputs({ startingCash: '', cushion: '', includeDoubtful: false }); setRestored(null); } }} />`}
      ${reportOpen && result && html`<${ReportDrawer} result=${result} groupBy=${groupBy} cushion=${cushion} benchmarks=${benchmarks} onClose=${() => setReportOpen(false)} />`}
      ${dragging && html`<div class="drop-overlay">Drop the QuickBooks CSV to analyze it</div>`}
    `;
  }

  // ------------------------------------------------------------ audit tab

  function ReviewSelect({ item, onReview }) {
    const status = item.review ? item.review.status : '';
    return html`<select class=${`review-select ${status}`} aria-label="Review status" value=${status} onChange=${(e) => onReview(item.key, e.target.value)}>
      <option value="">Open</option>
      ${Object.entries(E.REVIEW_STATUSES).map(([k, l]) => html`<option key=${k} value=${k}>${l}</option>`)}
    </select>`;
  }

  const clearedOf = (x) => !!x.review && (x.review.status === 'ok' || x.review.status === 'fixed');

  function AuditTab({ result, accountClass, setAccountClass, onReview }) {
    const { audit } = result;
    const [showCleared, setShowCleared] = useState(false);
    const vis = (list) => (showCleared ? list : list.filter((x) => !clearedOf(x)));
    const score = audit.healthScore;
    const scoreColor = score >= 90 ? 'var(--good)' : score >= 75 ? 'var(--warn)' : 'var(--critical)';
    const scoreWord = score >= 90 ? 'Clean' : score >= 75 ? 'Needs cleanup' : 'Significant issues';
    const asked = [...audit.uncategorized, ...audit.duplicates, ...audit.mismatches].filter((x) => x.review && x.review.status === 'asked').length;
    return html`
      <section class="kpis" aria-label="Audit summary">
        <div class="kpi">
          <span class="kpi-label">Books health score</span>
          <span class="kpi-value">${score}<span style=${{ fontSize: '14px', color: 'var(--muted)' }}> / 100</span></span>
          <div class="meter"><span style=${{ width: `${score}%`, background: scoreColor }}></span></div>
          <span class="kpi-sub">${scoreWord} · ${audit.flaggedCount} of ${result.entryCount} entries still flagged</span>
        </div>
        <div class=${`kpi ${audit.open.uncategorized ? 'alert' : 'okay'}`}>
          <span class="kpi-label">Uncategorized</span>
          <span class="kpi-value">${audit.open.uncategorized}</span>
          <span class="kpi-sub"><span class="num">${fmtMoney(audit.uncategorizedOpenTotal)}</span> not yet coded</span>
        </div>
        <div class=${`kpi ${audit.open.duplicates ? 'alert' : 'okay'}`}>
          <span class="kpi-label">Potential duplicates</span>
          <span class="kpi-value">${audit.open.duplicates}</span>
          <span class="kpi-sub"><span class="num">${fmtMoney(audit.duplicateOpenExposure)}</span> possibly double-counted</span>
        </div>
        <div class=${`kpi ${audit.open.mismatches ? 'alert' : 'okay'}`}>
          <span class="kpi-label">Mismatched entries</span>
          <span class="kpi-value">${audit.open.mismatches}</span>
          <span class="kpi-sub">${audit.mismatches.filter((m) => m.severity === 'High' && !clearedOf(m)).length} high severity</span>
        </div>
      </section>

      <div class="review-bar">
        <span>Mark each flag as you work through it. Cleared flags stay cleared when you load next month's export.</span>
        <span class="hint">${audit.cleared} cleared · ${asked} asked the client</span>
        ${audit.cleared > 0 && html`<label class="check" for="show-cleared" style=${{ paddingTop: 0 }}><input id="show-cleared" type="checkbox" checked=${showCleared} onChange=${(e) => setShowCleared(e.target.checked)} />Show cleared</label>`}
      </div>

      <${IssuesByMonth} audit=${audit} />
      <${UncategorizedPanel} rows=${vis(audit.uncategorized)} open=${audit.open.uncategorized} total=${audit.uncategorizedOpenTotal} onReview=${onReview} />
      <${DuplicatesPanel} groups=${vis(audit.duplicates)} open=${audit.open.duplicates} exposure=${audit.duplicateOpenExposure} onReview=${onReview} />
      <${MismatchPanel} rows=${vis(audit.mismatches)} open=${audit.open.mismatches} onReview=${onReview} />
      <${AccountMapping} accounts=${result.accounts} accountClass=${accountClass} setAccountClass=${setAccountClass} />
    `;
  }

  function IssuesByMonth({ audit }) {
    const t = useTokens();
    const data = useMemo(() => {
      const m = new Map();
      const bump = (dateStr, key) => {
        const k = dateStr.slice(0, 7);
        if (!m.has(k)) m.set(k, { month: k, uncategorized: 0, duplicates: 0, mismatches: 0 });
        m.get(k)[key]++;
      };
      audit.uncategorized.forEach((r) => bump(r.dateStr, 'uncategorized'));
      audit.duplicates.forEach((g) => bump(g.rows[g.rows.length - 1].dateStr, 'duplicates'));
      audit.mismatches.forEach((r) => bump(r.dateStr, 'mismatches'));
      return [...m.values()].sort((a, b) => a.month.localeCompare(b.month)).map((d) => ({
        ...d,
        label: new Date(`${d.month}-01T00:00:00Z`).toLocaleString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }),
      }));
    }, [audit]);
    if (!data.length) return null;
    const series = [
      { key: 'uncategorized', label: 'Uncategorized', color: t.s1 },
      { key: 'duplicates', label: 'Duplicate groups', color: t.s2 },
      { key: 'mismatches', label: 'Mismatches', color: t.s3 },
    ];
    return html`<section class="panel">
      <div class="panel-head"><h2>Issues by month</h2><p>Where cleanup work is concentrated. Months with a cluster usually point to a missed bank-feed review.</p></div>
      <div class="panel-body">
        <div class="legend">${series.map((s) => html`<span key=${s.key}><i style=${{ background: s.color }}></i>${s.label}</span>`)}</div>
        <div style=${{ height: 200 }}>
          <${ResponsiveContainer} width="100%" height="100%">
            <${BarChart} data=${data} margin=${{ top: 6, right: 8, bottom: 0, left: -18 }} barCategoryGap="28%">
              <${CartesianGrid} vertical=${false} stroke=${t.grid} />
              <${XAxis} dataKey="label" tickLine=${false} axisLine=${{ stroke: t.axis }} tick=${{ fill: t.muted, fontSize: 12 }} />
              <${YAxis} allowDecimals=${false} tickLine=${false} axisLine=${false} tick=${{ fill: t.muted, fontSize: 12 }} />
              <${Tooltip} cursor=${{ fill: t.surface2 }} content=${html`<${ChartTooltip} rows=${(d) => series.map((s) => ({ label: s.label, value: d[s.key], color: s.color }))} />`} />
              ${series.map((s, i) => html`<${Bar} key=${s.key} dataKey=${s.key} stackId="a" fill=${s.color} stroke=${t.surface} strokeWidth=${2} radius=${i === series.length - 1 ? [4, 4, 0, 0] : 0} isAnimationActive=${false} />`)}
            <//>
          <//>
        </div>
      </div>
    </section>`;
  }

  function UncategorizedPanel({ rows, open, total, onReview }) {
    return html`<section class="panel">
      <div class="panel-head">
        <h2>Uncategorized transactions</h2>
        <span class=${`pill ${open ? 'high' : 'good'}`}>${open} open · ${fmtMoney(total)}</span>
        <p>Posted to Uncategorized Income/Expense, Ask My Accountant, or left without an account. Each needs a category before month-end close.</p>
      </div>
      <div class="panel-body flush">
        ${rows.length ? html`<div class="table-wrap scroll-y"><table>
          <thead><tr><th>Review</th><th>CSV row</th><th>Date</th><th>Type</th><th>Payee</th><th>Memo</th><th>Where it sits</th><th class="num">Amount</th></tr></thead>
          <tbody>${rows.map((r) => html`<tr key=${r.id} class=${clearedOf(r) ? 'cleared' : ''}>
            <td><${ReviewSelect} item=${r} onReview=${onReview} /></td>
            <td class="row-no">${r.line}</td>
            <td class="nowrap num">${r.dateStr}</td>
            <td class="nowrap">${r.type}</td>
            <td>${counterpartyOf(r) || html`<span class="sub">No payee</span>`}</td>
            <td>${r.memo}</td>
            <td>${r.reason}</td>
            <td class="num"><${Money} v=${r.amount} /></td>
          </tr>`)}</tbody>
        </table></div>` : html`<div class="empty">${Icon.check}${open ? 'All open items are hidden.' : 'Nothing left to categorize.'}</div>`}
      </div>
    </section>`;
  }

  function DuplicatesPanel({ groups, open, exposure, onReview }) {
    return html`<section class="panel">
      <div class="panel-head">
        <h2>Potential duplicates</h2>
        <span class=${`pill ${open ? 'high' : 'good'}`}>${open} open · ${fmtMoney(exposure)} exposure</span>
        <p>Same payee, same amount and same account within 3 days, or a reference number entered twice. Common causes: a bank-feed match missed after a manual entry, or a bill entered twice.</p>
      </div>
      <div class="panel-body flush">
        ${groups.length ? groups.map((g) => html`<div class=${`dup-group ${clearedOf(g) ? 'cleared' : ''}`} key=${g.id}>
          <div class="dup-head"><${ReviewSelect} item=${g} onReview=${onReview} /><${Severity} level=${g.confidence} /><strong>${counterpartyOf(g.rows[0]) || g.rows[0].memo || 'No payee'}</strong><span style=${{ color: 'var(--ink-2)' }}>${g.reason}</span><span class="exposure">${fmtMoney(g.exposure)} at risk</span></div>
          <div class="table-wrap"><table class="dup-table"><colgroup><col style=${{ width: '90px' }} /><col style=${{ width: '110px' }} /><col style=${{ width: '150px' }} /><col style=${{ width: '26%' }} /><col /><col style=${{ width: '120px' }} /></colgroup><tbody>${g.rows.map((r) => html`<tr key=${r.id}>
            <td class="row-no" style=${{ paddingLeft: '18px' }}>row ${r.line}</td>
            <td class="nowrap num">${r.dateStr}</td>
            <td class="nowrap">${r.type}${r.num ? ` #${r.num}` : ''}</td>
            <td>${leafAccount(r.account)}</td>
            <td>${r.memo}</td>
            <td class="num"><${Money} v=${r.amount} /></td>
          </tr>`)}</tbody></table></div>
        </div>`) : html`<div class="empty">${Icon.check}No open duplicates.</div>`}
      </div>
    </section>`;
  }

  function MismatchPanel({ rows, open, onReview }) {
    const kinds = useMemo(() => {
      const m = new Map();
      rows.forEach((r) => m.set(r.kind, (m.get(r.kind) || 0) + 1));
      return [...m.entries()];
    }, [rows]);
    const [filter, setFilter] = useState('All');
    const shown = filter === 'All' ? rows : rows.filter((r) => r.kind === filter);
    return html`<section class="panel">
      <div class="panel-head">
        <h2>Mismatched entries</h2>
        <span class=${`pill ${open ? 'medium' : 'good'}`}>${open} open</span>
        <p>Transaction types that conflict with their account (an expense coded to income, a transfer hitting the P&L), vendors coded inconsistently, missing payees and unbalanced journal entries.</p>
      </div>
      ${rows.length > 0 && html`<div class="panel-body" style=${{ paddingBottom: '12px' }}>
        <div class="chips">
          ${[['All', rows.length], ...kinds].map(([k, n]) => html`<button key=${k} class="chip" aria-pressed=${filter === k} onClick=${() => setFilter(k)}>${k}<span class="n">${n}</span></button>`)}
        </div>
      </div>`}
      <div class="panel-body flush">
        ${rows.length ? html`<div class="table-wrap scroll-y"><table>
          <thead><tr><th>Review</th><th>Severity</th><th>CSV row</th><th>Date</th><th>Payee</th><th>Issue</th><th class="num">Amount</th></tr></thead>
          <tbody>${shown.map((r, i) => html`<tr key=${`${r.id}-${i}`} class=${clearedOf(r) ? 'cleared' : ''}>
            <td><${ReviewSelect} item=${r} onReview=${onReview} /></td>
            <td><${Severity} level=${r.severity} /></td>
            <td class="row-no">${r.line}</td>
            <td class="nowrap num">${r.dateStr}</td>
            <td>${counterpartyOf(r) || html`<span class="sub">No payee</span>`}<span class="sub">${r.type}</span></td>
            <td><strong style=${{ fontWeight: 500 }}>${r.kind}</strong><span class="sub">${r.detail}</span></td>
            <td class="num"><${Money} v=${r.amount} /></td>
          </tr>`)}</tbody>
        </table></div>` : html`<div class="empty">${Icon.check}No coding conflicts found.</div>`}
      </div>
    </section>`;
  }

  const ROLE_LABEL = { cash: 'Bank', card: 'Credit card', ar: 'Receivable', ap: 'Payable', loan: 'Loan', equity: 'Owner equity', salestax: 'Sales tax', payrolltax: 'Payroll tax', otherbalance: 'Other balance sheet' };

  function AccountMapping({ accounts, accountClass, setAccountClass }) {
    const labels = { income: 'Income', cogs: 'Cost of goods sold', expense: 'Expense', balance: 'Balance sheet' };
    const changed = Object.keys(accountClass).length;
    const fromChart = accounts.filter((a) => a.source === 'chart').length;
    return html`<details class="panel mapping">
      <summary>Account mapping ${changed ? html`<span class="pill" style=${{ marginLeft: '8px' }}>${changed} changed by you</span>` : ''}<span style=${{ fontWeight: 400, fontFamily: 'var(--sans)', color: 'var(--muted)', fontSize: '13px', marginLeft: '8px' }}>${fromChart ? `${fromChart} of ${accounts.length} typed from the chart of accounts.` : 'Guessed from account names.'} Correct any that are wrong and every figure updates.</span></summary>
      <div class="table-wrap"><table>
        <thead><tr><th>Account</th><th class="num">Rows</th><th>Treated as</th><th>Source</th></tr></thead>
        <tbody>${accounts.map((a) => {
          const manual = accountClass[a.name] != null;
          return html`<tr key=${a.name}>
          <td>${a.name}${(accountClass[a.name] || a.detected) === 'balance' ? html`<span class="sub">${ROLE_LABEL[a.role] || ''}</span>` : ''}</td>
          <td class="num">${a.count}</td>
          <td>
            <select aria-label=${`Account type for ${a.name}`} value=${accountClass[a.name] || a.detected} onChange=${(e) => {
              const v = e.target.value;
              const next = { ...accountClass };
              if (v === a.detected) delete next[a.name]; else next[a.name] = v;
              setAccountClass(next);
            }}>
              ${Object.entries(labels).map(([k, l]) => html`<option key=${k} value=${k}>${l}</option>`)}
              ${a.detected === 'blank' && html`<option value="blank">Unassigned</option>`}
            </select>
          </td>
          <td class="sub" style=${{ display: 'table-cell' }}>${manual ? 'Changed by you' : a.source === 'chart' ? `Chart of accounts: ${a.type}` : 'Guessed from name'}</td>
        </tr>`;
        })}</tbody>
      </table></div>
    </details>`;
  }

  // ------------------------------------------------------------ growth tab

  function GrowthTab({ result, groupBy, setGroupBy }) {
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
          </div>
          <${ProfitTable} profit=${profit} noun=${noun} />
          <${CustomerRiskSection} risk=${result.customers} />`
        : html`<section class="panel"><div class="empty">No ${noun} tags found on income. Add the ${groupBy === 'project' ? 'Customer (with sub-customers/projects) or Class' : 'Customer'} column to the QuickBooks report before exporting.</div></section>`}

      <div class="section-title"><h2>Recurring software & subscriptions</h2></div>
      <${SubscriptionSection} subs=${subs} />
    `;
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

  // ------------------------------------------------------------ cash forecast tab

  const shortDate = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const wholeMoney = (n) => (Math.abs(n) < 0.5 ? '-' : `${n < 0 ? '-' : ''}$${Math.round(Math.abs(n)).toLocaleString('en-US')}`);

  function Banner({ level, label, children }) {
    return html`<div class=${`banner ${level}`} role="status"><span class=${`pill ${level}`}><span class="dot"></span>${label}</span><div>${children}</div></div>`;
  }

  function MoneyInput({ id, label, value, placeholder, onChange, hint }) {
    return html`<label class="field" for=${id}>${label}
      <span class="money-input"><span aria-hidden="true">$</span><input id=${id} inputmode="decimal" value=${value} placeholder=${placeholder} onInput=${(e) => onChange(e.target.value.replace(/[^0-9.\-]/g, ''))} /></span>
      ${hint && html`<span class="hint">${hint}</span>`}
    </label>`;
  }

  function CashTab({ cash, inputs, setInputs, cushion, defaultCushion }) {
    const t = useTokens();
    if (!cash) return html`<section class="panel"><div class="empty">Not enough dated transactions to build a forecast.</div></section>`;
    const set = (k) => (v) => setInputs({ ...inputs, [k]: v });
    const below = cash.weeks.filter((w) => w.ending < cushion);
    const low = cash.lowest;
    const lowIdx = low.week - 1;
    const drivers = cash.outflowRows.map((r) => ({ label: r.label, v: r.values[lowIdx] })).filter((r) => r.v > 0 && !/run-rate/.test(r.label)).sort((a, b) => b.v - a.v).slice(0, 2);
    const driverText = drivers.length ? ` ${drivers.map((d) => `${d.label} (${wholeMoney(d.v)})`).join(' and ')} land${drivers.length === 1 ? 's' : ''} that week.` : '';
    const chartData = [{ label: 'Today', ending: cash.startingCash, start: cash.start }, ...cash.weeks.map((w) => ({ ...w, label: shortDate(w.start) }))];
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

      ${cash.firstNegative
        ? html`<${Banner} level="high" label="Cash shortfall">Cash runs out in the week of <strong>${shortDate(cash.firstNegative.start)}</strong>, reaching ${wholeMoney(low.ending)} by ${shortDate(low.start)}.${driverText}</${Banner}>`
        : below.length
          ? html`<${Banner} level="medium" label="Below cushion">Cash dips below your ${wholeMoney(cushion)} cushion in <strong>${below.length} of 13 weeks</strong>, bottoming at <strong>${wholeMoney(low.ending)}</strong> the week of ${shortDate(low.start)}.${driverText}</${Banner}>`
          : html`<${Banner} level="good" label="Healthy">Cash stays above your ${wholeMoney(cushion)} cushion for all 13 weeks. The lowest point is ${wholeMoney(low.ending)} the week of ${shortDate(low.start)}.</${Banner}>`}
      ${cash.ap.duplicateTotal > 0 && html`<${Banner} level="medium" label="Check before paying">${wholeMoney(cash.ap.duplicateTotal)} of open bills match entries the audit flags as possible duplicates. They are still in the forecast; void them in QuickBooks if they are duplicates.</${Banner}>`}

      <section class="kpis" aria-label="Cash summary">
        <div class="kpi"><span class="kpi-label">Starting cash</span><span class="kpi-value">${wholeMoney(cash.startingCash)}</span><span class="kpi-sub">${inputs.startingCash !== '' ? 'Entered manually' : `As of ${cash.asOf}`}</span></div>
        <div class=${`kpi ${low.ending < 0 ? 'alert' : ''}`}><span class="kpi-label">Lowest balance</span><span class="kpi-value">${wholeMoney(low.ending)}</span><span class="kpi-sub">Week of ${shortDate(low.start)}</span></div>
        <div class="kpi"><span class="kpi-label">Cash at week 13</span><span class="kpi-value">${wholeMoney(cash.totals.ending)}</span><span class="kpi-sub">${wholeMoney(cash.totals.inflow)} in · ${wholeMoney(cash.totals.outflow)} out</span></div>
        <div class=${`kpi ${cash.ar.doubtfulTotal ? 'alert' : ''}`}><span class="kpi-label">Open receivables</span><span class="kpi-value">${wholeMoney(cash.ar.total)}</span><span class="kpi-sub">${cash.ar.doubtfulTotal ? `${wholeMoney(cash.ar.doubtfulTotal)} over 90 days` : 'Nothing over 90 days'}</span></div>
        <div class="kpi"><span class="kpi-label">Open bills</span><span class="kpi-value">${wholeMoney(cash.ap.total)}</span><span class="kpi-sub">${cash.ap.openBills.length} unpaid${cash.cardBalance ? ` + ${wholeMoney(cash.cardBalance)} on cards` : ''}</span></div>
      </section>

      <div class="grid-2">
        <section class="panel">
          <div class="panel-head"><h2>Projected cash balance</h2><p>Cash at the end of each week. Points below your cushion are marked red.</p></div>
          <div class="panel-body">
            <div class="legend"><span><i style=${{ background: t.s1 }}></i>Ending cash</span><span><i style=${{ background: t.warnLine, height: '2px' }}></i>Cushion</span></div>
            <div style=${{ height: 260 }}>
              <${ResponsiveContainer} width="100%" height="100%">
                <${AreaChart} data=${chartData} margin=${{ top: 8, right: 12, bottom: 0, left: 4 }}>
                  <${CartesianGrid} vertical=${false} stroke=${t.grid} />
                  <${XAxis} dataKey="label" tickLine=${false} axisLine=${{ stroke: t.axis }} tick=${{ fill: t.muted, fontSize: 11 }} interval="preserveStartEnd" minTickGap=${12} />
                  <${YAxis} domain=${[minY < 0 ? 'auto' : 0, 'auto']} tickFormatter=${compactMoney} tickLine=${false} axisLine=${false} tick=${{ fill: t.muted, fontSize: 12 }} width=${52} />
                  <${ReferenceLine} y=${cushion} stroke=${t.warnLine} strokeWidth=${2} />
                  ${minY < 0 && html`<${ReferenceLine} y=${0} stroke=${t.axis} />`}
                  <${Tooltip} cursor=${{ stroke: t.axis }} content=${html`<${ChartTooltip} rows=${(d) => d.week ? [
                    { label: 'Cash in', value: fmtMoney(d.inflow) },
                    { label: 'Cash out', value: fmtMoney(d.outflow) },
                    { label: 'Ending cash', value: fmtMoney(d.ending), color: t.s1 },
                  ] : [{ label: 'Starting cash', value: fmtMoney(d.ending), color: t.s1 }]} />`} />
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

      <${WeekGrid} cash=${cash} cushion=${cushion} />

      <div class="section-title"><h2>Receivables & payables</h2></div>
      <div class="grid-2">
        <${AgingPanel} ar=${cash.ar} includeDoubtful=${inputs.includeDoubtful} />
        <${PaymentSpeedChart} lags=${cash.ar.customerLags} />
      </div>
      <${OpenInvoices} ar=${cash.ar} includeDoubtful=${inputs.includeDoubtful} />
      <${OpenBills} ap=${cash.ap} />

      <details class="panel mapping">
        <summary>How this forecast is built</summary>
        <div class="panel-body"><ul class="assumptions">${cash.assumptions.map((a) => html`<li key=${a}>${a}</li>`)}</ul></div>
      </details>
    `;
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

  function Slider({ id, label, value, min, max, step, fmt, onChange }) {
    return html`<label class="field slider" for=${id}>
      <span class="slider-head"><span>${label}</span><b class="num">${fmt(value)}</b></span>
      <input id=${id} type="range" min=${min} max=${max} step=${step} value=${value} onInput=${(e) => onChange(parseFloat(e.target.value))} />
    </label>`;
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

  // ------------------------------------------------------------ trends tab

  function Spark({ values, color }) {
    const pts = values.map((v, i) => [i, v]).filter(([, v]) => v != null && isFinite(v));
    if (pts.length < 2) return null;
    const ys = pts.map(([, v]) => v);
    const lo = Math.min(...ys), hi = Math.max(...ys);
    const span = hi - lo || 1;
    const n = values.length - 1 || 1;
    const xy = pts.map(([i, v]) => [(i / n) * 100, 28 - ((v - lo) / span) * 24]);
    const last = xy[xy.length - 1];
    return html`<svg class="spark" viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true">
      <polyline points=${xy.map((p) => p.join(',')).join(' ')} fill="none" stroke=${color} stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
      <circle cx=${last[0]} cy=${last[1]} r="2.2" fill=${color} vector-effect="non-scaling-stroke" />
    </svg>`;
  }

  const fmtMetric = (kind, v) => (v == null ? 'n/a' : kind === 'pct' ? fmtPct(v) : kind === 'days' ? `${Math.round(v)} days` : kind === 'count' ? String(Math.round(v)) : wholeMoney(v));

  function Delta({ metric, cmp, label }) {
    if (!cmp) return null;
    const d = cmp.delta;
    if (Math.abs(d) < (metric.kind === 'pct' ? 0.0005 : 0.5)) return html`<span class="delta">${label}: no change</span>`;
    const good = metric.up ? d > 0 : d < 0;
    // Percent change for money; points for percentages; plain units for days and counts.
    const text = metric.kind === 'pct' ? `${(d * 100).toFixed(1)} pts`
      : metric.kind === 'days' || metric.kind === 'count' ? fmtMetric(metric.kind, Math.abs(d))
      : cmp.pct != null ? fmtPct(Math.abs(cmp.pct)) : fmtMetric(metric.kind, Math.abs(d));
    const sign = metric.kind === 'money' && cmp.pct != null ? '' : d > 0 ? '+' : '-';
    return html`<span class=${`delta ${good ? 'up' : 'down'}`}>${d > 0 ? '▲' : '▼'} ${sign}${text} <span class="delta-label">${label}</span></span>`;
  }

  function TrendsTab({ trend }) {
    const t = useTokens();
    const [grain, setGrain] = useState('month');
    if (!trend || trend.months.length < 2) return html`<section class="panel"><div class="empty">Trends need at least two months of transactions. Upload a longer export, or several exports at once.</div></section>`;
    const periods = grain === 'quarter' ? trend.quarters : trend.months;
    const byKey = Object.fromEntries(trend.metrics.map((m) => [m.key, m]));
    const tiles = ['revenue', 'netIncome', 'netMargin', 'fixed', 'dso', 'cashEnd'].map((k) => byKey[k]).filter(Boolean);
    const cmpLabel = trend.hasYoY ? 'vs last year' : 'vs prior 3 mo.';
    const data = periods.map((p) => ({ ...p, fullName: `${p.label}${p.partial ? ' (partial)' : ''}`, costs: p.variable + p.fixed, gm: p.grossMargin != null ? Math.round(p.grossMargin * 1000) / 10 : null, nmPct: p.netMargin != null ? Math.round(p.netMargin * 1000) / 10 : null }));
    // Top cost categories across the whole export, the rest folded into Other.
    const catTotals = new Map();
    for (const p of periods) for (const [c, v] of Object.entries(p.categories)) catTotals.set(c, (catTotals.get(c) || 0) + v);
    const topCats = [...catTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([c]) => c);
    const catColors = [t.s1, t.s2, t.s3, t.s4, t.s5];
    const mixData = periods.map((p) => {
      const row = { label: p.label, fullName: p.label };
      let other = 0;
      for (const [c, v] of Object.entries(p.categories)) { if (topCats.includes(c)) row[c] = v; else other += v; }
      row.Other = Math.round(other * 100) / 100;
      return row;
    });
    const hasCash = periods.some((p) => p.cashEnd != null);
    const tick = { fill: t.muted, fontSize: 11 };
    const partialNote = periods.some((p) => p.partial) ? html`<p class="chart-note">Partial ${grain === 'quarter' ? 'quarters' : 'months'} at the edges of the export are shown faded and left out of comparisons.</p>` : '';

    return html`
      <div style=${{ display: 'flex', flexWrap: 'wrap', gap: '10px 16px', alignItems: 'center' }}>
        <div class="seg" role="group" aria-label="Period">
          <button aria-pressed=${grain === 'month'} onClick=${() => setGrain('month')}>Monthly</button>
          <button aria-pressed=${grain === 'quarter'} onClick=${() => setGrain('quarter')}>Quarterly</button>
        </div>
        <span class="hint">Comparing ${trend.windows.last3.join(', ')} with ${trend.hasYoY ? `the same months a year earlier (${trend.windows.yearAgo.join(', ')})` : trend.windows.prior3.length ? `the 3 months before (${trend.windows.prior3.join(', ')})` : 'earlier months'}.</span>
      </div>

      ${trend.insights.length > 0 && html`<section class="panel">
        <div class="panel-head"><h2>What changed</h2><p>The movements worth a conversation with the client, largest first.</p></div>
        <div class="panel-body"><ul class="insight-list">${trend.insights.map((i) => html`<li key=${i.text}><span class=${`pill ${i.tone === 'good' ? 'good' : 'high'}`}><span class="dot"></span>${i.tone === 'good' ? 'Better' : 'Watch'}</span><span>${i.text}</span></li>`)}</ul></div>
      </section>`}

      <section class="kpis trend-kpis" aria-label="Trend summary">
        ${tiles.map((m) => {
          const cmp = trend.hasYoY ? m.yoy : m.recent;
          const value = cmp ? cmp.to : m.latest;
          return html`<div class="kpi" key=${m.key}>
            <span class="kpi-label">${m.label}</span>
            <span class="kpi-value">${fmtMetric(m.kind, value)}</span>
            <span class="kpi-sub">${m.balance ? `At end of ${m.latestLabel}` : m.kind === 'pct' ? 'Last 3 months' : 'Per month, last 3 months'}</span>
            <${Spark} values=${m.series} color=${t.s1} />
            <${Delta} metric=${m} cmp=${cmp} label=${cmpLabel} />
          </div>`;
        })}
      </section>

      <div class="grid-2">
        <section class="panel">
          <div class="panel-head"><h2>Revenue vs. costs</h2><p>The gap between the revenue line and the bars is profit. Bars above the line are losing ${grain === 'quarter' ? 'quarters' : 'months'}.</p></div>
          <div class="panel-body">
            <div class="legend"><span><i style=${{ background: t.s1, height: '3px' }}></i>Revenue</span><span><i style=${{ background: t.s2 }}></i>Job costs</span><span><i style=${{ background: t.neutral }}></i>Overhead</span></div>
            <div style=${{ height: 260 }}>
              <${ResponsiveContainer} width="100%" height="100%">
                <${ComposedChart} data=${data} margin=${{ top: 8, right: 8, bottom: 0, left: 4 }} barCategoryGap="22%">
                  <${CartesianGrid} vertical=${false} stroke=${t.grid} />
                  <${XAxis} dataKey="label" tickLine=${false} axisLine=${{ stroke: t.axis }} tick=${tick} interval="preserveStartEnd" minTickGap=${10} />
                  <${YAxis} tickFormatter=${compactMoney} tickLine=${false} axisLine=${false} tick=${{ fill: t.muted, fontSize: 12 }} width=${52} />
                  <${Tooltip} cursor=${{ fill: t.surface2 }} content=${html`<${ChartTooltip} rows=${(d) => [
                    { label: 'Revenue', value: fmtMoney(d.revenue), color: t.s1 },
                    { label: 'Job costs', value: fmtMoney(d.variable), color: t.s2 },
                    { label: 'Overhead', value: fmtMoney(d.fixed), color: t.neutral },
                    { label: 'Net income', value: fmtMoney(d.netIncome) },
                  ]} />`} />
                  <${Bar} dataKey="variable" stackId="c" fill=${t.s2} isAnimationActive=${false} stroke=${t.surface} strokeWidth=${1}>
                    ${data.map((d) => html`<${Cell} key=${d.key} fillOpacity=${d.partial ? 0.4 : 1} />`)}
                  <//>
                  <${Bar} dataKey="fixed" stackId="c" fill=${t.neutral} radius=${[4, 4, 0, 0]} isAnimationActive=${false} stroke=${t.surface} strokeWidth=${1}>
                    ${data.map((d) => html`<${Cell} key=${d.key} fillOpacity=${d.partial ? 0.4 : 1} />`)}
                  <//>
                  <${Line} type="linear" dataKey="revenue" stroke=${t.s1} strokeWidth=${2.5} dot=${{ r: 3, fill: t.s1, stroke: t.surface, strokeWidth: 2 }} isAnimationActive=${false} />
                <//>
              <//>
            </div>
            ${partialNote}
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Margins</h2><p>Gross margin tracks pricing and job costs. Net margin adds overhead, so a gap that widens means overhead is growing faster than gross profit.</p></div>
          <div class="panel-body">
            <div class="legend"><span><i style=${{ background: t.s1, height: '3px' }}></i>Gross margin</span><span><i style=${{ background: t.s3, height: '3px' }}></i>Net margin</span></div>
            <div style=${{ height: 260 }}>
              <${ResponsiveContainer} width="100%" height="100%">
                <${LineChart} data=${data} margin=${{ top: 8, right: 12, bottom: 0, left: 4 }}>
                  <${CartesianGrid} vertical=${false} stroke=${t.grid} />
                  <${XAxis} dataKey="label" tickLine=${false} axisLine=${{ stroke: t.axis }} tick=${tick} interval="preserveStartEnd" minTickGap=${10} />
                  <${YAxis} tickFormatter=${(v) => `${v}%`} tickLine=${false} axisLine=${false} tick=${{ fill: t.muted, fontSize: 12 }} width=${44} />
                  <${ReferenceLine} y=${0} stroke=${t.axis} />
                  <${Tooltip} cursor=${{ stroke: t.axis }} content=${html`<${ChartTooltip} rows=${(d) => [
                    { label: 'Gross margin', value: d.gm != null ? `${d.gm.toFixed(1)}%` : 'n/a', color: t.s1 },
                    { label: 'Net margin', value: d.nmPct != null ? `${d.nmPct.toFixed(1)}%` : 'n/a', color: t.s3 },
                  ]} />`} />
                  <${Line} type="linear" dataKey="gm" stroke=${t.s1} strokeWidth=${2} dot=${{ r: 3, fill: t.s1, stroke: t.surface, strokeWidth: 2 }} isAnimationActive=${false} connectNulls=${true} />
                  <${Line} type="linear" dataKey="nmPct" stroke=${t.s3} strokeWidth=${2} dot=${{ r: 3, fill: t.s3, stroke: t.surface, strokeWidth: 2 }} isAnimationActive=${false} connectNulls=${true} />
                <//>
              <//>
            </div>
          </div>
        </section>
      </div>

      <div class="grid-2">
        <section class="panel">
          <div class="panel-head"><h2>Where the money goes</h2><p>The five largest cost accounts over the export; everything else is folded into Other.</p></div>
          <div class="panel-body">
            <div class="legend">${topCats.map((c, i) => html`<span key=${c}><i style=${{ background: catColors[i] }}></i>${c}</span>`)}<span><i style=${{ background: t.neutral }}></i>Other</span></div>
            <div style=${{ height: 260 }}>
              <${ResponsiveContainer} width="100%" height="100%">
                <${BarChart} data=${mixData} margin=${{ top: 8, right: 8, bottom: 0, left: 4 }} barCategoryGap="22%">
                  <${CartesianGrid} vertical=${false} stroke=${t.grid} />
                  <${XAxis} dataKey="label" tickLine=${false} axisLine=${{ stroke: t.axis }} tick=${tick} interval="preserveStartEnd" minTickGap=${10} />
                  <${YAxis} tickFormatter=${compactMoney} tickLine=${false} axisLine=${false} tick=${{ fill: t.muted, fontSize: 12 }} width=${52} />
                  <${Tooltip} cursor=${{ fill: t.surface2 }} content=${html`<${ChartTooltip} rows=${(d) => [...topCats.map((c, i) => ({ label: c, value: fmtMoney(d[c] || 0), color: catColors[i] })), { label: 'Other', value: fmtMoney(d.Other), color: t.neutral }]} />`} />
                  ${topCats.map((c, i) => html`<${Bar} key=${c} dataKey=${c} stackId="m" fill=${catColors[i]} stroke=${t.surface} strokeWidth=${1} isAnimationActive=${false} />`)}
                  <${Bar} dataKey="Other" stackId="m" fill=${t.neutral} stroke=${t.surface} strokeWidth=${1} radius=${[4, 4, 0, 0]} isAnimationActive=${false} />
                <//>
              <//>
            </div>
          </div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>${hasCash ? 'Cash and collections' : 'Collections'}</h2><p>Days to collect (DSO) is receivables divided by recent monthly revenue. Rising DSO ties up cash even when sales are growing.</p></div>
          <div class="panel-body">
            <div class="legend"><span><i style=${{ background: t.s2, height: '3px' }}></i>Days to collect</span></div>
            <div style=${{ height: hasCash ? 120 : 260 }}>
              <${ResponsiveContainer} width="100%" height="100%">
                <${LineChart} data=${data} margin=${{ top: 8, right: 12, bottom: 0, left: 4 }}>
                  <${CartesianGrid} vertical=${false} stroke=${t.grid} />
                  <${XAxis} dataKey="label" hide=${hasCash} tickLine=${false} axisLine=${{ stroke: t.axis }} tick=${tick} interval="preserveStartEnd" minTickGap=${10} />
                  <${YAxis} tickFormatter=${(v) => `${v}d`} tickLine=${false} axisLine=${false} tick=${{ fill: t.muted, fontSize: 12 }} width=${52} />
                  <${Tooltip} cursor=${{ stroke: t.axis }} content=${html`<${ChartTooltip} rows=${(d) => [
                    { label: 'Days to collect', value: d.dso != null ? `${d.dso}` : 'n/a', color: t.s2 },
                    { label: 'Receivables', value: fmtMoney(d.arEnd) },
                  ]} />`} />
                  <${Line} type="linear" dataKey="dso" stroke=${t.s2} strokeWidth=${2} dot=${{ r: 3, fill: t.s2, stroke: t.surface, strokeWidth: 2 }} isAnimationActive=${false} connectNulls=${true} />
                <//>
              <//>
            </div>
            ${hasCash && html`
              <div class="legend" style=${{ marginTop: '10px' }}><span><i style=${{ background: t.s1 }}></i>Cash at period end</span></div>
              <div style=${{ height: 140 }}>
                <${ResponsiveContainer} width="100%" height="100%">
                  <${AreaChart} data=${data} margin=${{ top: 8, right: 12, bottom: 0, left: 4 }}>
                    <${CartesianGrid} vertical=${false} stroke=${t.grid} />
                    <${XAxis} dataKey="label" tickLine=${false} axisLine=${{ stroke: t.axis }} tick=${tick} interval="preserveStartEnd" minTickGap=${10} />
                    <${YAxis} tickFormatter=${compactMoney} tickLine=${false} axisLine=${false} tick=${{ fill: t.muted, fontSize: 12 }} width=${52} />
                    <${Tooltip} cursor=${{ stroke: t.axis }} content=${html`<${ChartTooltip} rows=${(d) => [{ label: 'Cash', value: fmtMoney(d.cashEnd), color: t.s1 }]} />`} />
                    <${Area} type="linear" dataKey="cashEnd" stroke=${t.s1} strokeWidth=${2} fill=${t.s1} fillOpacity=${0.12} isAnimationActive=${false} />
                  <//>
                <//>
              </div>`}
          </div>
        </section>
      </div>

      <div class="grid-2">
        <section class="panel">
          <div class="panel-head"><h2>Biggest cost changes</h2><p>Average per month, last 3 months against the 3 before.</p></div>
          <div class="panel-body flush">${trend.costMovers.length ? html`<div class="table-wrap"><table>
            <thead><tr><th>Account</th><th>Type</th><th class="num">Before</th><th class="num">Now</th><th class="num">Change</th></tr></thead>
            <tbody>${trend.costMovers.map((c) => html`<tr key=${c.name}><td>${c.name}</td><td class="sub" style=${{ display: 'table-cell' }}>${c.type}</td><td class="num">${wholeMoney(c.from)}</td><td class="num">${wholeMoney(c.to)}</td><td class=${`num ${c.delta > 0 ? 'neg' : ''}`}>${c.delta > 0 ? '+' : '-'}${wholeMoney(Math.abs(c.delta))}</td></tr>`)}</tbody>
          </table></div>` : html`<div class="empty">No cost account moved by more than 15%.</div>`}</div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Customer changes</h2><p>New customers first billed in the last 6 months. Lost customers have no invoices in the last 3.</p></div>
          <div class="panel-body flush">${trend.customerMovers.length ? html`<div class="table-wrap"><table>
            <thead><tr><th>Customer</th><th>Status</th><th class="num">Before / mo</th><th class="num">Now / mo</th></tr></thead>
            <tbody>${trend.customerMovers.map((c) => html`<tr key=${c.name}><td>${c.name}${c.status === 'Lost' ? html`<span class="sub">Last billed ${c.lastMonth}</span>` : ''}</td>
              <td><span class=${`pill ${c.status === 'Lost' || c.status === 'Shrinking' ? 'high' : c.status === 'New' || c.status === 'Growing' ? 'good' : 'low'}`}>${c.status}</span></td>
              <td class="num">${wholeMoney(c.prior)}</td><td class="num">${wholeMoney(c.recent)}</td></tr>`)}</tbody>
          </table></div>` : html`<div class="empty">Needs at least 4 full months to compare customers.</div>`}</div>
        </section>
      </div>

      <section class="panel">
        <div class="panel-head"><h2>${grain === 'quarter' ? 'Quarter' : 'Month'} by ${grain === 'quarter' ? 'quarter' : 'month'}</h2></div>
        <div class="panel-body flush"><div class="table-wrap"><table>
          <thead><tr><th>${grain === 'quarter' ? 'Quarter' : 'Month'}</th><th class="num">Revenue</th><th class="num">Job costs</th><th class="num">Overhead</th><th class="num">Net income</th><th class="num">Net margin</th><th class="num">Customers</th><th class="num">DSO</th>${hasCash ? html`<th class="num">Cash</th>` : ''}</tr></thead>
          <tbody>${[...periods].reverse().map((p) => html`<tr key=${p.key} class=${p.partial ? 'partial' : ''}>
            <td class="nowrap">${p.label}${p.partial ? html`<span class="sub">partial</span>` : ''}</td>
            <td class="num">${wholeMoney(p.revenue)}</td><td class="num">${wholeMoney(p.variable)}</td><td class="num">${wholeMoney(p.fixed)}</td>
            <td class=${`num ${p.netIncome < 0 ? 'neg' : ''}`}>${wholeMoney(p.netIncome)}</td><td class="num">${marginPill(p.netMargin)}</td>
            <td class="num">${p.customers}</td><td class="num">${p.dso != null ? p.dso : '-'}</td>${hasCash ? html`<td class="num">${p.cashEnd != null ? wholeMoney(p.cashEnd) : '-'}</td>` : ''}
          </tr>`)}</tbody>
        </table></div></div>
      </section>
    `;
  }

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

  function InsightList({ items }) {
    return html`<ul class="insight-list">${items.map((i) => html`<li key=${i.text}><span class=${`pill ${i.tone === 'good' ? 'good' : 'high'}`}><span class="dot"></span>${i.tone === 'good' ? 'Better' : 'Watch'}</span><span>${i.text}</span></li>`)}</ul>`;
  }

  function VendorsTab({ vendors: v }) {
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
      ${v.insights.length > 0 && html`<section class="panel">
        <div class="panel-head"><h2>What stands out</h2><p>Vendor relationships and payment timing worth a conversation, ${v.windowLabel}. Payroll is left out.</p></div>
        <div class="panel-body"><${InsightList} items=${v.insights} /></div>
      </section>`}

      <section class="kpis" aria-label="Vendor summary">
        <div class="kpi"><span class="kpi-label">Vendor spending</span><span class="kpi-value">${wholeMoney(v.monthlyTotal)}</span><span class="kpi-sub">per month, ${v.vendorCount} vendors</span></div>
        <div class=${`kpi ${v.top5Share >= 0.8 ? 'alert' : ''}`}><span class="kpi-label">Top 5 vendors</span><span class="kpi-value">${fmtPct(v.top5Share)}</span><span class="kpi-sub">of spending</span></div>
        <div class="kpi"><span class="kpi-label">Days to pay vendors</span><span class="kpi-value">${v.dpo != null ? `${v.dpo} days` : 'n/a'}</span><span class="kpi-sub">${v.dso != null ? `Customers pay in ${v.dso} days` : 'Needs bills in the export'}</span></div>
        <div class="kpi"><span class="kpi-label">Open bills</span><span class="kpi-value">${wholeMoney(openTotal)}</span><span class="kpi-sub">${v.buckets[3].amount ? `${wholeMoney(v.buckets[3].amount)} over 90 days` : 'Nothing over 90 days'}</span></div>
        ${freed > 0 && html`<div class="kpi okay"><span class="kpi-label">Cash from 30-day terms</span><span class="kpi-value">${wholeMoney(freed)}</span><span class="kpi-sub">if early-paid vendors allow net 30</span></div>`}
      </section>

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

      <section class="panel">
        <div class="panel-head"><h2>Payables aging</h2><span class="pill">${wholeMoney(openTotal)} open</span><p>Unpaid bills by age. Old open bills are often duplicates or bills paid outside QuickBooks; check them before paying.</p></div>
        <div class="panel-body"><${AgingTiles} buckets=${v.buckets} total=${openTotal} /></div>
      </section>

      <section class="panel">
        <div class="panel-head"><h2>Vendors</h2><span class="pill">${v.vendorCount} vendors · ${wholeMoney(v.monthlyTotal)}/mo</span><p>Spending ${v.windowLabel}, payroll excluded. Trend compares the last 3 months with the 3 before.</p></div>
        <div class="panel-body flush"><div class="table-wrap scroll-y"><table>
          <thead><tr><th>Vendor</th><th class="num">Per month</th><th>Share of spending</th><th>Type</th><th class="num">Last 3 mo.</th><th class="num">Pays in</th><th class="num">Open bills</th><th>Paid by</th></tr></thead>
          <tbody>${v.rows.map((r) => html`<tr key=${r.name}>
            <td>${r.name}<span class="sub">${r.account}</span></td>
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
          <thead><tr><th>Status</th><th>Vendor</th><th class="num">Check / transfer</th><th class="num">Card</th><th>Form</th><th>Note</th></tr></thead>
          <tbody>${taxRows.map((x) => html`<tr key=${x.vendor}>
            <td><span class=${`pill ${statusPill[x.status]}`}>${x.status}</span></td>
            <td>${x.vendor}<span class="sub">${x.accounts.join(', ')}</span></td>
            <td class="num"><${Money} v=${x.bank} /></td>
            <td class="num">${x.card ? html`<${Money} v=${x.card} />` : html`<span class="sub">-</span>`}</td>
            <td class="nowrap">${x.status === 'Review' || x.status === 'Likely exempt' ? x.form : html`<span class="sub">-</span>`}</td>
            <td class="sub" style=${{ display: 'table-cell' }}>${x.note}</td>
          </tr>`)}</tbody>
        </table></div>` : html`<div class="empty">${Icon.check}No vendors at or near the threshold for ${year}.</div>`}</div>
        <div class="panel-body"><p class="chart-note">A screening list, not tax advice. Payments to corporations are usually exempt (attorneys are not), and card payments are reported by the card company on 1099-K. Rent paid to a landlord that is not a corporation goes on 1099-MISC.</p></div>
      </section>`}
    `;
  }

  // ------------------------------------------------------------ benchmarks tab

  const QB_SERVER = 'Intuit QuickBooks';
  const QB_TOOL = 'benchmarking_against_industry';
  const mcpReady = window.claude && typeof window.claude.use === 'function'
    ? window.claude.use('mcp').catch(() => null)
    : Promise.resolve(null);

  // What to tell the viewer for each connector failure; codes with their own fix get their own words.
  function connectorMessage(err) {
    const code = err && err.code;
    switch (code) {
      case 'needs_reauth': return 'Your Intuit QuickBooks connection has expired. Reconnect it in claude.ai under Settings → Connectors, then try again.';
      case 'server_not_connected': return 'Add the Intuit QuickBooks connector in claude.ai under Settings → Connectors to pull live industry benchmarks.';
      case 'selection_required': return 'You have more than one Intuit QuickBooks connection. Choose one when claude.ai asks, then try again.';
      case 'not_in_manifest': case 'consent_required': return 'Intuit QuickBooks is turned off for this page. Allow it when asked, or enter peer figures by hand below.';
      case 'blocked_by_policy': case 'approval_required': return 'Your organization does not allow this page to use Intuit QuickBooks. Enter peer figures by hand below.';
      case 'server_unavailable': return 'Intuit QuickBooks did not respond. Wait a moment and try again.';
      case 'tool_error': return `Intuit QuickBooks could not produce this benchmark: ${err.message || 'no details given'}.`;
      case 'not_granted': case 'capability_disabled': case 'capability_removed': return null;
      default: return `The benchmark request failed${err && err.message ? `: ${err.message}` : ''}. Try again, or enter peer figures by hand below.`;
    }
  }

  function findIndustry(code) {
    for (const g of E.INDUSTRIES) for (const i of g.industries) if (i.code === code) return i;
    return null;
  }

  function BenchmarksTab({ result, onResult, prefs, onPrefs }) {
    const t = useTokens();
    const inputs = useMemo(() => E.benchmarkInputs(result), [result]);
    // A saved client's industry and state win over the last ones used in this browser.
    const [code, setCode] = useState(() => (prefs && prefs.code) || safeStore.get('ll.naics') || '541430');
    const [customCode, setCustomCode] = useState(() => (prefs && prefs.customCode) || safeStore.get('ll.naicsCustom') || '');
    const [customName, setCustomName] = useState(() => (prefs && prefs.customName) || safeStore.get('ll.naicsCustomName') || '');
    const [state, setState] = useState(() => (prefs && prefs.state) || safeStore.get('ll.state') || '');
    const [mcp, setMcp] = useState(undefined);
    const [live, setLive] = useState({ phase: 'idle' });
    const [manual, setManual] = useState(() => {
      try { return JSON.parse(safeStore.get('ll.manualPeers') || 'null') || { revenue: '', profit: '', margin: '', expenses: '', source: '' }; } catch (e) { return { revenue: '', profit: '', margin: '', expenses: '', source: '' }; }
    });
    const industry = code === 'other' ? (/^\d{2,6}$/.test(customCode) ? { code: customCode, name: customName || `NAICS ${customCode}` } : null) : findIndustry(code);

    useEffect(() => { let on = true; mcpReady.then((m) => { if (on) setMcp(m || null); }); return () => { on = false; }; }, []);
    useEffect(() => {
      safeStore.set('ll.naics', code); safeStore.set('ll.naicsCustom', customCode); safeStore.set('ll.naicsCustomName', customName); safeStore.set('ll.state', state);
      if (onPrefs && (!prefs || prefs.code !== code || prefs.customCode !== customCode || prefs.customName !== customName || prefs.state !== state)) onPrefs({ code, customCode, customName, state });
    }, [code, customCode, customName, state]);
    useEffect(() => { safeStore.set('ll.manualPeers', JSON.stringify(manual)); }, [manual]);
    // A new file or industry makes earlier live results stale.
    useEffect(() => { setLive({ phase: 'idle' }); }, [result, code, customCode, state]);

    const num = (v) => { const n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : null; };
    const manualPeers = { revenue: num(manual.revenue), profit: num(manual.profit), margin: num(manual.margin) != null ? num(manual.margin) / 100 : null, expenses: num(manual.expenses) };
    const hasManual = Object.values(manualPeers).some((v) => v != null);
    const usingLive = live.phase === 'done';
    const peers = usingLive ? live.peers : manualPeers;
    const rows = inputs ? E.compareBenchmarks(inputs, peers) : [];
    const shown = usingLive || hasManual;

    useEffect(() => {
      if (!inputs || !industry) return;
      if (!shown) { onResult(null); return; }
      onResult({
        industry: industry.name, code: industry.code, state: usingLive ? state : '',
        source: usingLive ? 'Intuit QuickBooks industry benchmarks (regional average)' : `Entered manually${manual.source ? ` from ${manual.source}` : ''}`,
        periodRange: usingLive ? live.periodRange : '', companyPeriod: inputs.periodLabel, rows,
      });
    }, [JSON.stringify(rows), usingLive, state, industry && industry.code, manual.source]);

    async function runLive() {
      if (!mcp || !industry || !state || !inputs) return;
      setLive({ phase: 'loading' });
      const callOne = async (metric, retried) => {
        try {
          const res = await mcp.callTool(QB_SERVER, QB_TOOL, E.benchmarkRequest(inputs, metric, industry, state, result.meta.company), { cache: { staleTime: 300000, gcTime: 86400000 } });
          return { metric, data: E.readBenchmark(res.payload, metric) };
        } catch (err) {
          if (err && err.retryable && !retried) {
            await new Promise((r) => setTimeout(r, err.retryAfterMs || 1200 + Math.random() * 1200));
            return callOne(metric, true);
          }
          return { metric, error: err instanceof Error && !err.code ? { code: 'tool_error', message: err.message } : err };
        }
      };
      const out = await Promise.all(E.BENCH_METRICS.map((m) => callOne(m.metric)));
      const ok = out.filter((o) => o.data);
      const failed = out.filter((o) => o.error);
      if (!ok.length) {
        const codes = new Set(failed.map((f) => f.error && f.error.code));
        const msg = connectorMessage(failed[0].error);
        if (msg === null) { setMcp(null); setLive({ phase: 'idle' }); return; }
        setLive({ phase: 'error', message: codes.size === 1 ? msg : connectorMessage({ code: 'upstream_error' }) });
        return;
      }
      const peersLive = {};
      const national = {};
      for (const o of ok) { peersLive[o.metric] = o.data.regional; national[o.metric] = o.data.national; }
      setLive({
        phase: 'done', peers: peersLive, national,
        periodRange: ok[0].data.periodRange,
        partial: failed.map((f) => ({ metric: f.metric, message: connectorMessage(f.error) || 'Unavailable here.' })),
      });
    }

    if (!inputs) return html`<section class="panel"><div class="empty">Benchmarks need income and expenses in the export.</div></section>`;
    const f = (r, v) => (v == null ? 'n/a' : r.kind === 'pct' ? fmtPct(v) : wholeMoney(v));
    const margin = rows.find((r) => r.metric === 'margin');
    const revenue = rows.find((r) => r.metric === 'revenue');
    const profitRow = rows.find((r) => r.metric === 'profit');
    const takeaways = [];
    if (margin && margin.peer != null && margin.company != null && margin.diff < -0.02) takeaways.push(`At the peer margin of ${fmtPct(margin.peer)}, this business would keep about ${wholeMoney((margin.peer - margin.company) * inputs.revenue)} more a year on the same revenue.`);
    if (margin && margin.peer != null && margin.diff > 0.02) takeaways.push(`Margin is ${((margin.diff) * 100).toFixed(1)} points above peers: pricing or cost control is working. Protect it as the business grows.`);
    if (revenue && profitRow && revenue.read === 'Ahead' && profitRow.read !== 'Ahead') takeaways.push('Revenue is above typical peers but profit is not, so costs are the gap. The Break-even and Vendors tabs show where they sit.');
    if (revenue && revenue.read === 'Behind' && margin && margin.read !== 'Behind') takeaways.push('Smaller than typical peers but as profitable or better: the model works, and growth is the lever.');

    return html`
      <section class="panel">
        <div class="panel-head"><h2>Compare with industry peers</h2><p>The client's last 12 months against businesses in the same industry and state. Live figures come from the Intuit QuickBooks benchmark service through your claude.ai connector.</p></div>
        <div class="panel-body inputs-row">
          <label class="field" for="bm-industry">Industry
            <select id="bm-industry" class="select" value=${code} onChange=${(e) => setCode(e.target.value)}>
              ${E.INDUSTRIES.map((g) => html`<optgroup key=${g.group} label=${g.group}>${g.industries.map((i) => html`<option key=${i.code} value=${i.code}>${i.name}</option>`)}</optgroup>`)}
              <option value="other">Other (enter a NAICS code)</option>
            </select>
          </label>
          ${code === 'other' && html`<label class="field" for="bm-code">NAICS code<input id="bm-code" class="text" inputmode="numeric" value=${customCode} placeholder="e.g. 541990" onInput=${(e) => setCustomCode(e.target.value.replace(/\D/g, '').slice(0, 6))} /></label>
            <label class="field" for="bm-code-name">Industry name<input id="bm-code-name" class="text" value=${customName} placeholder="e.g. Translation Services" onInput=${(e) => setCustomName(e.target.value)} /></label>`}
          <label class="field" for="bm-state">State
            <select id="bm-state" class="select" value=${state} onChange=${(e) => setState(e.target.value)}>
              <option value="">Choose a state</option>
              ${E.STATES.map((s) => html`<option key=${s} value=${s}>${s}</option>`)}
            </select>
          </label>
          <div class="field"><span>Client's figures</span><span class="hint">${inputs.periodLabel}</span></div>
        </div>
        <div class="panel-body bm-live">
          ${mcp === undefined ? html`<span class="hint">Checking for the Intuit QuickBooks connector…</span>`
            : mcp === null ? html`<p class="chart-note">Live benchmarks run when this page is opened in claude.ai with the Intuit QuickBooks connector allowed for it. You can enter peer figures from any source below.</p>`
            : html`<button class="btn primary" disabled=${!industry || !state || live.phase === 'loading'} onClick=${runLive}>${live.phase === 'loading' ? 'Fetching benchmarks…' : usingLive ? 'Refresh benchmarks' : 'Get live benchmarks'}</button>
              ${!state && html`<span class="hint">Choose a state first.</span>`}
              ${usingLive && html`<span class="hint">Intuit QuickBooks benchmarks, ${state}, ${live.periodRange || 'latest period'}</span>`}`}
          ${live.phase === 'error' && html`<div class="banner high" role="alert"><span class="pill high"><span class="dot"></span>Not loaded</span><div>${live.message}</div></div>`}
        </div>
      </section>

      ${shown ? html`
        <section class="bm-grid" aria-label="Benchmark comparison">
          ${rows.map((r) => {
            const max = Math.max(Math.abs(r.company || 0), Math.abs(r.peer || 0), 1e-9);
            const pill = r.read === 'Ahead' ? 'good' : r.read === 'Behind' ? 'high' : r.read === 'n/a' ? 'low' : 'medium';
            const nat = usingLive && live.national ? live.national[r.metric] : null;
            const gap = r.diff == null ? '' : r.kind === 'pct' ? `${r.diff > 0 ? '+' : ''}${(r.diff * 100).toFixed(1)} pts vs peers` : `${r.diff > 0 ? '+' : ''}${fmtPct(r.diff)} vs peers`;
            const miss = usingLive && live.partial.find((p) => p.metric === r.metric);
            return html`<div class="panel bm-card" key=${r.metric}>
              <div class="bm-head"><span class="kpi-label">${r.label}</span><span class=${`pill ${pill}`}><span class="dot"></span>${r.read}</span></div>
              <div class="bm-bars">
                <div class="bm-row"><span>Client</span><span class="bm-track"><span style=${{ width: `${(Math.max(0, r.company || 0) / max) * 100}%`, background: t.s1 }}></span></span><b class="num">${f(r, r.company)}</b></div>
                <div class="bm-row"><span>Peers</span><span class="bm-track"><span style=${{ width: `${(Math.max(0, r.peer || 0) / max) * 100}%`, background: t.neutral }}></span></span><b class="num">${f(r, r.peer)}</b></div>
                ${nat != null && html`<div class="bm-row"><span>National</span><span class="bm-track"></span><b class="num">${f(r, nat)}</b></div>`}
              </div>
              <span class="kpi-sub">${miss ? miss.message : gap || 'No peer figure'}</span>
            </div>`;
          })}
        </section>
        ${takeaways.length > 0 && html`<section class="panel"><div class="panel-head"><h2>What the gaps mean</h2></div><div class="panel-body"><ul class="assumptions">${takeaways.map((x) => html`<li key=${x}>${x}</li>`)}</ul></div></section>`}
        <p class="chart-note">${usingLive
          ? `Peer figures are regional averages for ${industry ? industry.name : 'the industry'} (NAICS ${industry ? industry.code : ''}) in ${state}. When the service has too few businesses for a code, it falls back to the broader industry group, so treat small or unusual industries as a rough guide.`
          : 'Peer figures below were entered by hand; note the source so the client knows where they came from.'}</p>
      ` : ''}

      <details class="panel mapping" open=${!mcp && !hasManual}>
        <summary>Enter peer figures by hand</summary>
        <div class="panel-body inputs-row">
          <${MoneyInput} id="mp-revenue" label="Peer yearly revenue" value=${manual.revenue} placeholder="e.g. 250,000" onChange=${(x) => setManual({ ...manual, revenue: x })} />
          <${MoneyInput} id="mp-profit" label="Peer yearly profit" value=${manual.profit} placeholder="e.g. 30,000" onChange=${(x) => setManual({ ...manual, profit: x })} />
          <label class="field" for="mp-margin">Peer profit margin
            <span class="money-input"><input id="mp-margin" inputmode="decimal" value=${manual.margin} placeholder="e.g. 12" onInput=${(e) => setManual({ ...manual, margin: e.target.value.replace(/[^0-9.\-]/g, '') })} /><span aria-hidden="true" style=${{ paddingRight: '10px' }}>%</span></span>
          </label>
          <${MoneyInput} id="mp-expenses" label="Peer yearly expenses" value=${manual.expenses} placeholder="e.g. 220,000" onChange=${(x) => setManual({ ...manual, expenses: x })} />
          <label class="field" for="mp-source">Source<input id="mp-source" class="text" value=${manual.source} placeholder="e.g. RMA 2026, trade association survey" onInput=${(e) => setManual({ ...manual, source: e.target.value })} /></label>
        </div>
        <div class="panel-body"><p class="chart-note">${usingLive ? 'Live benchmarks are showing; clear them by changing the industry or state to compare against these instead.' : 'Saved in this browser only.'}</p></div>
      </details>
    `;
  }

  // ------------------------------------------------------------ tax & lending tab

  const CHECK_PILL = { pass: ['good', 'Ready'], warn: ['medium', 'Watch'], fail: ['high', 'Fix first'] };

  function NumberInput({ id, label, value, onChange, suffix, prefix, placeholder, hint }) {
    return html`<label class="field" for=${id}>${label}
      <span class="money-input">${prefix && html`<span aria-hidden="true">${prefix}</span>`}<input id=${id} inputmode="decimal" value=${value} placeholder=${placeholder || ''} onInput=${(e) => onChange(e.target.value.replace(/[^0-9.\-]/g, ''))} />${suffix && html`<span aria-hidden="true" style=${{ paddingRight: '10px' }}>${suffix}</span>`}</span>
      ${hint && html`<span class="hint">${hint}</span>`}
    </label>`;
  }

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

      <section class="panel">
        <div class="panel-head"><h2>Lender readiness checklist</h2><span class="pill">${ln.score} of ${ln.checks.length} ready</span><p>What a lender will look at first, from this export. Fix the red items before applying.</p></div>
        <div class="panel-body flush"><ul class="checklist">${ln.checks.map((c) => html`<li key=${c.label}><span class=${`pill ${CHECK_PILL[c.status][0]}`}><span class="dot"></span>${CHECK_PILL[c.status][1]}</span><div><strong>${c.label}</strong><span class="sub">${c.detail}</span></div></li>`)}</ul></div>
      </section>

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

      ${tx.ownerPay && html`<section class="panel">
        <div class="panel-head"><h2>What the owner can safely take</h2><p>Extra owner pay over the next 13 weeks that keeps every week above the ${wholeMoney(tx.ownerPay.cushion)} cash cushion after the tax payments due in that time. Draws already expected from history are counted in the forecast.</p></div>
        <div class="panel-body">
          ${tx.ownerPay.available > 0
            ? html`<${Banner} level="good" label="Room to pay">The owner could take up to <strong>${wholeMoney(tx.ownerPay.available)}</strong> more${tx.ownerPay.plannedDraws ? `, on top of ${wholeMoney(tx.ownerPay.plannedDraws)} of draws already expected` : ''}, and stay above the cushion.</${Banner}>`
            : html`<${Banner} level="high" label="No room">After ${tx.ownerPay.taxInWindow ? `${wholeMoney(tx.ownerPay.taxInWindow)} of tax payments` : 'upcoming payments'}${tx.ownerPay.plannedDraws ? ` and ${wholeMoney(tx.ownerPay.plannedDraws)} of expected draws` : ''}, cash is projected <strong>${wholeMoney(tx.ownerPay.shortfall)}</strong> short of the cushion at its lowest point. Hold off on extra draws, or speed up collections first.</${Banner}>`}
        </div>
      </section>`}

      <p class="chart-note">Planning estimates from the export, not tax, legal or lending advice. Confirm tax rates and payments with the client's tax preparer, and loan terms with the lender.</p>
    `;
  }

  // ------------------------------------------------------------ report drawer

  function useEscape(onClose) {
    useEffect(() => {
      const onKey = (e) => { if (e.key === 'Escape') onClose(); };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);
  }

  // ------------------------------------------------------------ client questions drawer

  const QUESTION_SECTIONS = [
    ['uncategorized', 'Uncategorized transactions'],
    ['duplicates', 'Possible double charges'],
    ['coding', 'Entries to confirm'],
    ['receivables', 'Invoices over 90 days'],
    ['w9', 'W-9 requests'],
  ];

  function QuestionsDrawer({ result, onClose, onMarkAsked }) {
    const [greeting, setGreeting] = useState('');
    const [preparer, setPreparer] = useState(() => safeStore.get('ll.preparer') || '');
    const [include, setInclude] = useState({ uncategorized: true, duplicates: true, coding: true, receivables: true, w9: true });
    const [status, setStatus] = useState('');
    const preRef = useRef(null);
    const q = useMemo(() => E.clientQuestions(result, { greeting: greeting.trim() || undefined, preparer, include }), [result, greeting, preparer, include]);
    const filename = `${slug(result.meta.company)}-questions-${result.period.end}.txt`;
    useEffect(() => { safeStore.set('ll.preparer', preparer); }, [preparer]);
    useEscape(onClose);
    const toMark = q.keys.filter((k) => {
      const all = [...result.audit.uncategorized, ...result.audit.duplicates, ...result.audit.mismatches];
      const item = all.find((x) => x.key === k);
      return item && !(item.review && item.review.status === 'asked');
    });
    return html`<div class="scrim" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="questions-title">
        <div class="drawer-head"><h2 id="questions-title">Questions for the client</h2><button class="btn" onClick=${onClose}>Close</button></div>
        <div class="drawer-fields">
          <label class="field" for="q-greeting">Client's first name<input id="q-greeting" value=${greeting} onInput=${(e) => setGreeting(e.target.value)} placeholder="e.g. Jordan" /></label>
          <label class="field" for="q-preparer">Signed by<input id="q-preparer" value=${preparer} onInput=${(e) => setPreparer(e.target.value)} placeholder="Your name or firm" /></label>
          <div class="field" style=${{ gridColumn: '1 / -1' }}><span>Include</span>
            <div class="chips">${QUESTION_SECTIONS.map(([k, l]) => html`<button key=${k} class="chip" aria-pressed=${include[k]} onClick=${() => setInclude({ ...include, [k]: !include[k] })}>${l}</button>`)}</div>
          </div>
        </div>
        <pre class="report-pre" ref=${preRef}>${q.text}</pre>
        <div class="drawer-foot">
          <button class="btn primary" onClick=${async () => setStatus(await copyText(q.text, preRef.current))}>${Icon.copy}Copy text</button>
          <button class="btn" onClick=${async () => setStatus(await saveTextFile(filename, q.text))}>${Icon.download}Download .txt</button>
          ${toMark.length > 0 && html`<button class="btn" onClick=${() => { onMarkAsked(toMark); setStatus(`Marked ${toMark.length} flag${toMark.length === 1 ? '' : 's'} as asked.`); }}>Mark ${toMark.length} as asked</button>`}
          <span class="status" role="status">${status || `${q.count} question${q.count === 1 ? '' : 's'}; cleared flags are left out.`}</span>
        </div>
      </aside>
    </div>`;
  }

  // ------------------------------------------------------------ saved clients drawer

  function ClientsDrawer({ currentId, onClose, onForget }) {
    const [clients, setClients] = useState(() => ClientStore.all());
    const [confirm, setConfirm] = useState(null);
    const [status, setStatus] = useState('');
    useEscape(onClose);
    const list = Object.entries(clients).sort((a, b) => String(b[1].updatedAt || '').localeCompare(String(a[1].updatedAt || '')));
    const refresh = () => setClients(ClientStore.all());
    const doExport = async () => setStatus(await saveTextFile(`ledger-lens-clients-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ format: 'ledger-lens-clients', version: 1, clients: ClientStore.all() }, null, 2)));
    const doImport = (file) => {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(String(reader.result || ''));
          if (!data || data.format !== 'ledger-lens-clients') throw new Error('not a Ledger Lens backup');
          const n = ClientStore.merge(data.clients);
          refresh();
          setStatus(`Imported ${n} client${n === 1 ? '' : 's'} (newer copies kept).`);
        } catch (e) { setStatus(`${file.name} could not be imported: ${e.message}.`); }
      };
      reader.readAsText(file);
    };
    return html`<div class="scrim" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="clients-title">
        <div class="drawer-head"><h2 id="clients-title">Saved clients</h2><button class="btn" onClick=${onClose}>Close</button></div>
        <div class="panel-body"><p class="chart-note" style=${{ marginTop: 0 }}>Account type corrections, reviewed flags, the cash cushion and benchmark settings are saved per client, matched by the company name in the report header. They live in this browser only: export a backup to move them to another computer or share them with a colleague.</p></div>
        <div class="clients-list">
          ${list.length ? list.map(([id, c]) => html`<div class="client-row" key=${id}>
            <div><strong>${c.name || id}</strong>${id === currentId ? html` <span class="pill good">Open now</span>` : ''}
              <span class="sub">${Object.keys(c.accountClass || {}).length} account corrections · ${Object.keys(c.reviewed || {}).length} reviewed flags · saved ${String(c.updatedAt || '').slice(0, 10)}</span></div>
            ${confirm === id
              ? html`<span class="confirm">Forget this client? <button class="btn" onClick=${() => { ClientStore.remove(id); onForget(id); setConfirm(null); refresh(); }}>Forget</button><button class="btn" onClick=${() => setConfirm(null)}>Keep</button></span>`
              : html`<button class="btn" onClick=${() => setConfirm(id)}>Forget</button>`}
          </div>`) : html`<div class="empty">No saved clients yet. Upload a client's export and start reviewing; settings save as you go.</div>`}
        </div>
        <div class="drawer-foot">
          <button class="btn primary" disabled=${!list.length} onClick=${doExport}>${Icon.download}Export backup (.json)</button>
          <label class="btn" for="clients-import">${Icon.upload}Import backup</label>
          <input id="clients-import" class="file-input" type="file" accept=".json,application/json" onChange=${(e) => { doImport(e.target.files[0]); e.target.value = ''; }} />
          <span class="status" role="status">${status}</span>
        </div>
      </aside>
    </div>`;
  }

  function ReportDrawer({ result, groupBy, cushion, benchmarks, onClose }) {
    const [clientName, setClientName] = useState(() => result.meta.company || '');
    const [preparer, setPreparer] = useState(() => safeStore.get('ll.preparer') || '');
    const [status, setStatus] = useState('');
    const preRef = useRef(null);
    const report = useMemo(() => E.buildReport(result, { clientName, preparer, groupBy, cushion, benchmarks }), [result, clientName, preparer, groupBy, cushion, benchmarks]);
    const filename = `${slug(clientName)}-books-review-${result.period.end}.txt`;

    useEffect(() => { safeStore.set('ll.preparer', preparer); }, [preparer]);
    useEscape(onClose);

    const download = async () => setStatus(await saveTextFile(filename, report));
    const copy = async () => setStatus(await copyText(report, preRef.current));

    return html`<div class="scrim" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="report-title">
        <div class="drawer-head"><h2 id="report-title">Client summary report</h2><button class="btn" onClick=${onClose}>Close</button></div>
        <div class="drawer-fields">
          <label class="field" for="client-name">Client name<input id="client-name" value=${clientName} onInput=${(e) => setClientName(e.target.value)} placeholder="Client business name" /></label>
          <label class="field" for="preparer">Prepared by<input id="preparer" value=${preparer} onInput=${(e) => setPreparer(e.target.value)} placeholder="Your name or firm" /></label>
        </div>
        <pre class="report-pre" ref=${preRef}>${report}</pre>
        <div class="drawer-foot">
          <button class="btn primary" onClick=${download}>${Icon.download}Download .txt</button>
          <button class="btn" onClick=${copy}>${Icon.copy}Copy text</button>
          <span class="status" role="status">${status}</span>
        </div>
      </aside>
    </div>`;
  }

  ReactDOM.createRoot(document.getElementById('root')).render(html`<${App} />`);
})();
