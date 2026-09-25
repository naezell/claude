/* Ledger Lens dashboard UI (React + Recharts, templated with htm). */
(function () {
  'use strict';
  const { useState, useMemo, useEffect, useRef, useCallback } = React;
  const html = htm.bind(React.createElement);
  const {
    ResponsiveContainer, BarChart, Bar, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, Cell, ReferenceLine,
  } = Recharts;
  const E = window.LedgerEngine;
  const { fmtMoney, fmtPct, counterpartyOf, leafAccount } = E;

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

  // Chart colors come from CSS tokens so both themes stay in sync.
  function useTokens() {
    const read = () => {
      const cs = getComputedStyle(document.documentElement);
      const g = (n) => cs.getPropertyValue(n).trim();
      return {
        s1: g('--series-1'), s2: g('--series-2'), s3: g('--series-3'), pos: g('--pos'), neg: g('--neg'),
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
    const [source, setSource] = useState({ kind: 'sample', name: 'Harbor & Pine Design Co. (sample)', text: null });
    const [error, setError] = useState('');
    const [tab, setTab] = useState(() => safeStore.get('ll.tab') || 'audit');
    const [groupBy, setGroupBy] = useState('customer');
    const [accountClass, setAccountClass] = useState({});
    const [reportOpen, setReportOpen] = useState(false);
    const [dragging, setDragging] = useState(false);
    // Forecast inputs. Empty strings mean "use the value estimated from the export".
    const [cashInputs, setCashInputs] = useState({ startingCash: '', cushion: '', includeDoubtful: false });

    const sampleText = useMemo(() => window.LedgerSample.build(), []);
    const text = source.kind === 'sample' ? sampleText : source.text;

    const parsed = useMemo(() => {
      try { return { ok: E.parseTransactions(text) }; } catch (e) { return { err: e.message }; }
    }, [text]);

    const startingCash = cashInputs.startingCash === '' ? undefined : parseFloat(cashInputs.startingCash);
    const result = useMemo(() => (parsed.ok ? E.analyze(parsed.ok, {
      accountClass, groupBy, startingCash: isNaN(startingCash) ? undefined : startingCash, includeDoubtful: cashInputs.includeDoubtful,
    }) : null), [parsed, accountClass, groupBy, startingCash, cashInputs.includeDoubtful]);
    // Default cushion: one month of fixed costs, rounded to the nearest $1,000.
    const defaultCushion = result && result.breakeven ? Math.round(result.breakeven.base.fixed / 1000) * 1000 : 0;
    const cushion = cashInputs.cushion === '' || isNaN(parseFloat(cashInputs.cushion)) ? defaultCushion : parseFloat(cashInputs.cushion);

    useEffect(() => { safeStore.set('ll.tab', tab); }, [tab]);
    useEffect(() => { if (parsed.err) setError(parsed.err); }, [parsed]);

    const loadFile = useCallback((file) => {
      if (!file) return;
      if (!/\.(csv|txt)$/i.test(file.name)) { setError(`"${file.name}" is not a CSV. In QuickBooks, open the report and choose Export → Export to CSV.`); return; }
      const reader = new FileReader();
      reader.onload = () => {
        const t = String(reader.result || '');
        try {
          const p = E.parseTransactions(t);
          if (!p.transactions.length) throw new Error('The file has a header row but no dated transactions.');
          setError('');
          setAccountClass({});
          setCashInputs({ startingCash: '', cushion: '', includeDoubtful: false });
          setSource({ kind: 'upload', name: file.name, text: t });
        } catch (e) { setError(`${file.name}: ${e.message}`); }
      };
      reader.onerror = () => setError(`Could not read ${file.name}.`);
      reader.readAsText(file);
    }, []);

    useEffect(() => {
      let depth = 0;
      const enter = (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { depth++; setDragging(true); e.preventDefault(); } };
      const over = (e) => { if (dragging || depth) e.preventDefault(); };
      const leave = () => { depth = Math.max(0, depth - 1); if (!depth) setDragging(false); };
      const drop = (e) => { e.preventDefault(); depth = 0; setDragging(false); loadFile(e.dataTransfer.files[0]); };
      window.addEventListener('dragenter', enter); window.addEventListener('dragover', over);
      window.addEventListener('dragleave', leave); window.addEventListener('drop', drop);
      return () => {
        window.removeEventListener('dragenter', enter); window.removeEventListener('dragover', over);
        window.removeEventListener('dragleave', leave); window.removeEventListener('drop', drop);
      };
    }, [loadFile, dragging]);

    const auditCount = result ? result.audit.uncategorized.length + result.audit.duplicates.length + result.audit.mismatches.length : 0;

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
            <input id="csv-upload" class="file-input" type="file" accept=".csv,text/csv" onChange=${(e) => { loadFile(e.target.files[0]); e.target.value = ''; }} />
            ${source.kind !== 'sample' && html`<button class="btn" onClick=${() => { setError(''); setAccountClass({}); setCashInputs({ startingCash: '', cushion: '', includeDoubtful: false }); setSource({ kind: 'sample', name: 'Harbor & Pine Design Co. (sample)' }); }}>${Icon.sample}Load sample</button>`}
            <button class="btn primary" disabled=${!result} onClick=${() => setReportOpen(true)}>${Icon.report}Client report</button>
          </div>
        </div>
      </header>

      <div class="wrap">
        <div class="source">
          ${source.kind === 'sample'
            ? html`<span class="pill sample"><span class="dot"></span>Sample data</span><span>Showing a fictional design studio. Upload your QuickBooks <strong>Transaction Detail</strong> CSV, or drop it anywhere on this page.</span>`
            : html`<span class="pill good"><span class="dot"></span>Your file</span><strong>${source.name}</strong>`}
          ${result && html`<span>${result.meta.company && source.kind !== 'sample' ? `${result.meta.company} · ` : ''}${result.period.start} to ${result.period.end} · <span class="num">${result.count.toLocaleString()}</span> rows${result.entryCount !== result.count ? html` (<span class="num">${result.entryCount.toLocaleString()}</span> unique entries)` : ''}</span>`}
        </div>
        ${error && html`<div class="error" role="alert">${error}</div>`}

        <div class="tabs" role="tablist">
          <button class="tab" role="tab" id="tab-audit" aria-selected=${tab === 'audit'} onClick=${() => setTab('audit')}>Diagnostic audit<span class="count">${auditCount}</span></button>
          <button class="tab" role="tab" id="tab-growth" aria-selected=${tab === 'growth'} onClick=${() => setTab('growth')}>Growth & profitability insights</button>
          <button class="tab" role="tab" id="tab-cash" aria-selected=${tab === 'cash'} onClick=${() => setTab('cash')}>Cash forecast</button>
          <button class="tab" role="tab" id="tab-breakeven" aria-selected=${tab === 'breakeven'} onClick=${() => setTab('breakeven')}>Break-even</button>
        </div>

        ${result && html`<main role="tabpanel" aria-labelledby=${`tab-${tab}`}>
          ${tab === 'audit' ? html`<${AuditTab} result=${result} accountClass=${accountClass} setAccountClass=${setAccountClass} />`
            : tab === 'growth' ? html`<${GrowthTab} result=${result} groupBy=${groupBy} setGroupBy=${setGroupBy} />`
            : tab === 'cash' ? html`<${CashTab} cash=${result.cash} inputs=${cashInputs} setInputs=${setCashInputs} cushion=${cushion} defaultCushion=${defaultCushion} />`
            : html`<${BreakEvenTab} be=${result.breakeven} onOpenMapping=${() => setTab('audit')} />`}
        </main>`}
        <footer class="foot">Files are processed in your browser and never uploaded. Flags are leads for review, not confirmed errors.</footer>
      </div>

      ${reportOpen && result && html`<${ReportDrawer} result=${result} groupBy=${groupBy} cushion=${cushion} onClose=${() => setReportOpen(false)} />`}
      ${dragging && html`<div class="drop-overlay">Drop the QuickBooks CSV to analyze it</div>`}
    `;
  }

  // ------------------------------------------------------------ audit tab

  function AuditTab({ result, accountClass, setAccountClass }) {
    const { audit } = result;
    const score = audit.healthScore;
    const scoreColor = score >= 90 ? 'var(--good)' : score >= 75 ? 'var(--warn)' : 'var(--critical)';
    const scoreWord = score >= 90 ? 'Clean' : score >= 75 ? 'Needs cleanup' : 'Significant issues';
    return html`
      <section class="kpis" aria-label="Audit summary">
        <div class="kpi">
          <span class="kpi-label">Books health score</span>
          <span class="kpi-value">${score}<span style=${{ fontSize: '14px', color: 'var(--muted)' }}> / 100</span></span>
          <div class="meter"><span style=${{ width: `${score}%`, background: scoreColor }}></span></div>
          <span class="kpi-sub">${scoreWord} · ${audit.flaggedCount} of ${result.entryCount} entries flagged</span>
        </div>
        <div class=${`kpi ${audit.uncategorized.length ? 'alert' : 'okay'}`}>
          <span class="kpi-label">Uncategorized</span>
          <span class="kpi-value">${audit.uncategorized.length}</span>
          <span class="kpi-sub"><span class="num">${fmtMoney(audit.uncategorizedTotal)}</span> not yet coded</span>
        </div>
        <div class=${`kpi ${audit.duplicates.length ? 'alert' : 'okay'}`}>
          <span class="kpi-label">Potential duplicates</span>
          <span class="kpi-value">${audit.duplicates.length}</span>
          <span class="kpi-sub"><span class="num">${fmtMoney(audit.duplicateExposure)}</span> possibly double-counted</span>
        </div>
        <div class=${`kpi ${audit.mismatches.length ? 'alert' : 'okay'}`}>
          <span class="kpi-label">Mismatched entries</span>
          <span class="kpi-value">${audit.mismatches.length}</span>
          <span class="kpi-sub">${audit.mismatches.filter((m) => m.severity === 'High').length} high severity</span>
        </div>
      </section>

      <${IssuesByMonth} audit=${audit} />
      <${UncategorizedPanel} rows=${audit.uncategorized} total=${audit.uncategorizedTotal} />
      <${DuplicatesPanel} groups=${audit.duplicates} exposure=${audit.duplicateExposure} />
      <${MismatchPanel} rows=${audit.mismatches} />
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

  function UncategorizedPanel({ rows, total }) {
    return html`<section class="panel">
      <div class="panel-head">
        <h2>Uncategorized transactions</h2>
        <span class=${`pill ${rows.length ? 'high' : 'good'}`}>${rows.length} rows · ${fmtMoney(total)}</span>
        <p>Posted to Uncategorized Income/Expense, Ask My Accountant, or left without an account. Each needs a category before month-end close.</p>
      </div>
      <div class="panel-body flush">
        ${rows.length ? html`<div class="table-wrap scroll-y"><table>
          <thead><tr><th>CSV row</th><th>Date</th><th>Type</th><th>Payee</th><th>Memo</th><th>Where it sits</th><th class="num">Amount</th></tr></thead>
          <tbody>${rows.map((r) => html`<tr key=${r.id}>
            <td class="row-no">${r.line}</td>
            <td class="nowrap num">${r.dateStr}</td>
            <td class="nowrap">${r.type}</td>
            <td>${counterpartyOf(r) || html`<span class="sub">No payee</span>`}</td>
            <td>${r.memo}</td>
            <td>${r.reason}</td>
            <td class="num"><${Money} v=${r.amount} /></td>
          </tr>`)}</tbody>
        </table></div>` : html`<div class="empty">${Icon.check}Every transaction has a category.</div>`}
      </div>
    </section>`;
  }

  function DuplicatesPanel({ groups, exposure }) {
    return html`<section class="panel">
      <div class="panel-head">
        <h2>Potential duplicates</h2>
        <span class=${`pill ${groups.length ? 'high' : 'good'}`}>${groups.length} groups · ${fmtMoney(exposure)} exposure</span>
        <p>Same payee, same amount and same account within 3 days, or a reference number entered twice. Common causes: a bank-feed match missed after a manual entry, or a bill entered twice.</p>
      </div>
      <div class="panel-body flush">
        ${groups.length ? groups.map((g) => html`<div class="dup-group" key=${g.id}>
          <div class="dup-head"><${Severity} level=${g.confidence} /><strong>${counterpartyOf(g.rows[0]) || g.rows[0].memo || 'No payee'}</strong><span style=${{ color: 'var(--ink-2)' }}>${g.reason}</span><span class="exposure">${fmtMoney(g.exposure)} at risk</span></div>
          <div class="table-wrap"><table class="dup-table"><colgroup><col style=${{ width: '90px' }} /><col style=${{ width: '110px' }} /><col style=${{ width: '150px' }} /><col style=${{ width: '26%' }} /><col /><col style=${{ width: '120px' }} /></colgroup><tbody>${g.rows.map((r) => html`<tr key=${r.id}>
            <td class="row-no" style=${{ paddingLeft: '18px' }}>row ${r.line}</td>
            <td class="nowrap num">${r.dateStr}</td>
            <td class="nowrap">${r.type}${r.num ? ` #${r.num}` : ''}</td>
            <td>${leafAccount(r.account)}</td>
            <td>${r.memo}</td>
            <td class="num"><${Money} v=${r.amount} /></td>
          </tr>`)}</tbody></table></div>
        </div>`) : html`<div class="empty">${Icon.check}No likely duplicates found.</div>`}
      </div>
    </section>`;
  }

  function MismatchPanel({ rows }) {
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
        <span class=${`pill ${rows.length ? 'medium' : 'good'}`}>${rows.length} rows</span>
        <p>Transaction types that conflict with their account (an expense coded to income, a transfer hitting the P&L), vendors coded inconsistently, missing payees and unbalanced journal entries.</p>
      </div>
      ${rows.length > 0 && html`<div class="panel-body" style=${{ paddingBottom: '12px' }}>
        <div class="chips">
          ${[['All', rows.length], ...kinds].map(([k, n]) => html`<button key=${k} class="chip" aria-pressed=${filter === k} onClick=${() => setFilter(k)}>${k}<span class="n">${n}</span></button>`)}
        </div>
      </div>`}
      <div class="panel-body flush">
        ${rows.length ? html`<div class="table-wrap scroll-y"><table>
          <thead><tr><th>Severity</th><th>CSV row</th><th>Date</th><th>Payee</th><th>Issue</th><th class="num">Amount</th></tr></thead>
          <tbody>${shown.map((r, i) => html`<tr key=${`${r.id}-${i}`}>
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

  function AccountMapping({ accounts, accountClass, setAccountClass }) {
    const labels = { income: 'Income', cogs: 'Cost of goods sold', expense: 'Expense', balance: 'Balance sheet' };
    const changed = Object.keys(accountClass).length;
    return html`<details class="panel mapping">
      <summary>Account mapping ${changed ? html`<span class="pill" style=${{ marginLeft: '8px' }}>${changed} overridden</span>` : html`<span style=${{ fontWeight: 400, fontFamily: 'var(--sans)', color: 'var(--muted)', fontSize: '13px', marginLeft: '8px' }}>Detected from account names. Correct any that are wrong and every figure updates.</span>`}</summary>
      <div class="table-wrap"><table>
        <thead><tr><th>Account</th><th class="num">Rows</th><th>Treated as</th></tr></thead>
        <tbody>${accounts.map((a) => html`<tr key=${a.name}>
          <td>${a.name}</td>
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
        </tr>`)}</tbody>
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
          <${ProfitTable} profit=${profit} noun=${noun} />`
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
        <div class="kpi"><span class="kpi-label">Average revenue</span><span class="kpi-value">${wholeMoney(be.base.revenue)}</span><span class="kpi-sub">per month over ${be.months % 1 === 0 ? be.months : be.months.toFixed(1)} months</span></div>
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

  // ------------------------------------------------------------ report drawer

  function ReportDrawer({ result, groupBy, cushion, onClose }) {
    const [clientName, setClientName] = useState(() => result.meta.company || '');
    const [preparer, setPreparer] = useState(() => safeStore.get('ll.preparer') || '');
    const [status, setStatus] = useState('');
    const preRef = useRef(null);
    const report = useMemo(() => E.buildReport(result, { clientName, preparer, groupBy, cushion }), [result, clientName, preparer, groupBy, cushion]);
    const filename = `${(clientName || 'client').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'client'}-books-review-${result.period.end}.txt`;

    useEffect(() => { safeStore.set('ll.preparer', preparer); }, [preparer]);
    useEffect(() => {
      const onKey = (e) => { if (e.key === 'Escape') onClose(); };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    async function download() {
      const downloads = await downloadsReady;
      if (downloads) {
        try {
          await downloads.save({ filename, data: report });
          setStatus(`Saved ${filename}`);
        } catch (e) {
          const code = e && e.code;
          setStatus(code === 'declined' ? 'Download cancelled.' : code === 'rate_limited' ? 'A save prompt is already open.' : 'Downloads are unavailable here. Use Copy instead.');
        }
        return;
      }
      const url = URL.createObjectURL(new Blob([report], { type: 'text/plain;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus(`Downloaded ${filename}`);
    }

    function copy() {
      const selectAll = () => {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(preRef.current);
        sel.removeAllRanges(); sel.addRange(range);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(report).then(() => setStatus('Copied to clipboard.'), () => { selectAll(); setStatus('Text selected. Press Ctrl+C / Cmd+C to copy.'); });
      } else { selectAll(); setStatus('Text selected. Press Ctrl+C / Cmd+C to copy.'); }
    }

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
