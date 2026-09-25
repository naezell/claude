/* Ledger Lens UI: Benchmarks tab. */
(function () {
  'use strict';
  const { useState, useMemo, useEffect } = React;
  const html = htm.bind(React.createElement);
  const E = window.LedgerEngine;
  const { fmtPct } = E;
  const UI = window.LedgerUI;
  const { safeStore, useTokens, wholeMoney, MoneyInput } = UI;

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

  Object.assign(UI, { BenchmarksTab });
})();
