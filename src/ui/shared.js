/* Ledger Lens UI: shared helpers and small components. */
(function () {
  'use strict';
  const { useState, useEffect } = React;
  const html = htm.bind(React.createElement);
  const E = window.LedgerEngine;
  const { fmtMoney } = E;
  const UI = (window.LedgerUI = window.LedgerUI || {});

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
  // Saved clients and small settings: see src/store.js.
  const { safeStore, ClientStore } = window.LedgerStore;

  // One backup file holds every saved client plus the preparer name. The same file is used for
  // a download and for Google Drive, and restoring merges it (newer copies win).
  const Backup = {
    format: 'ledger-lens-clients',
    build() {
      return JSON.stringify({ format: this.format, version: 2, schema: ClientStore.schema, savedAt: new Date().toISOString(), clients: ClientStore.all(), settings: { preparer: safeStore.get('ll.preparer') || '', layout: safeStore.get('ll.layout') || '' } }, null, 2);
    },
    restore(text) {
      let data;
      try { data = JSON.parse(String(text || '')); } catch (e) { throw new Error('the file is not valid JSON'); }
      if (!data || data.format !== this.format) throw new Error('not a Ledger Lens backup');
      if (data.schema > ClientStore.schema) throw new Error('it was made by a newer version of Ledger Lens; reload the page to update, then try again');
      const n = ClientStore.merge(data.clients);
      const preparer = data.settings && typeof data.settings.preparer === 'string' ? data.settings.preparer : '';
      if (preparer && !safeStore.get('ll.preparer')) safeStore.set('ll.preparer', preparer);
      // The page layout comes back too, unless this browser already has one.
      const layout = data.settings && typeof data.settings.layout === 'string' ? data.settings.layout : '';
      if (layout && !safeStore.get('ll.layout')) safeStore.set('ll.layout', layout);
      return n;
    },
    // When and where the last backup went, for the reminder.
    mark(where) { safeStore.set('ll.lastBackup', JSON.stringify({ at: new Date().toISOString(), where })); },
    last() { try { return JSON.parse(safeStore.get('ll.lastBackup') || 'null'); } catch (e) { return null; } },
    // Saved clients exist and nothing has been backed up in 30 days (or ever).
    overdue() {
      const all = ClientStore.all();
      const newest = Object.values(all).reduce((m, c) => (String(c.updatedAt || '') > m ? String(c.updatedAt) : m), '');
      if (!newest) return false;
      const last = this.last();
      if (!last || !last.at) return true;
      return last.at < newest && Date.now() - Date.parse(last.at) > 30 * 864e5;
    },
  };
  const Firm = window.LedgerFirm || {};
  const emptyProfile = (p) => !p || (!Object.keys(p.accountClass || {}).length && !Object.keys(p.reviewed || {}).length && !p.closed && !Object.keys(p.checklist || {}).length && !(p.customSteps || []).length && !p.cushion && !p.bench && !(p.loan && p.loan.amount) && !(p.tax && (p.tax.entity !== 'sole' || p.tax.rate || p.tax.salary || p.tax.paid)));

  // The Excel reader (SheetJS) is large, so it loads only when an Excel file is dropped in.
  const XLSX_URL = 'vendor/xlsx.full.min.js';
  let xlsxLoading = null;
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (!xlsxLoading) {
      xlsxLoading = new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = XLSX_URL;
        el.onload = () => (window.XLSX ? resolve(window.XLSX) : reject(new Error('the Excel reader did not load')));
        el.onerror = () => { xlsxLoading = null; reject(new Error('could not load the Excel reader. Check the connection, or export the report as CSV instead')); };
        document.head.appendChild(el);
      });
    }
    return xlsxLoading;
  }

  // First sheet of a workbook as CSV text, using the cells' displayed values (dates stay dates).
  async function excelToCsv(buffer) {
    const XLSX = await loadXlsx();
    const wb = XLSX.read(new Uint8Array(buffer), { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) throw new Error('has no sheets.');
    return XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
  }

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

  // Holds a value back until it has stopped changing for `ms`, so typing doesn't re-run the analysis per keystroke.
  function useDebounced(value, ms) {
    const [v, setV] = useState(value);
    useEffect(() => { const id = setTimeout(() => setV(value), ms); return () => clearTimeout(id); }, [value, ms]);
    return v;
  }

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
    home: html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 7.5 8 3l5.5 4.5M4 6.5v6.5h8V6.5"/></svg>`,
    link: html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 9.5a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.8.8M9.5 6.5a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.8-.8"/></svg>`,
    mail: html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="2" y="3.5" width="12" height="9" rx="1.5"/><path d="m2.5 4.5 5.5 4 5.5-4"/></svg>`,
    sliders: html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2.5 4.5h6M11.5 4.5h2M2.5 11.5h2M7.5 11.5h6"/><circle cx="10" cy="4.5" r="1.5"/><circle cx="6" cy="11.5" r="1.5"/></svg>`,
    flag: html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 14V2.5M3.5 2.5h8l-1.8 3 1.8 3h-8"/></svg>`,
    upload: html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 10.5V2.5M4.8 5.5 8 2.3l3.2 3.2M2.5 10.5v2.2c0 .5.4.8.8.8h9.4c.4 0 .8-.3.8-.8v-2.2"/></svg>`,
    report: html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 1.8h5.2L12.5 5v9.2H4z"/><path d="M9 1.8V5h3.5M6 8h4.5M6 10.5h4.5"/></svg>`,
    sample: html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2.5 3.5h11M2.5 8h11M2.5 12.5h7"/></svg>`,
    check: html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3.5 8.5 3 3 6-7"/></svg>`,
    download: html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.5v8M4.8 7.5 8 10.7l3.2-3.2M2.5 12.8h11"/></svg>`,
    copy: html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="5" y="5" width="8.5" height="8.5" rx="1.2"/><path d="M11 5V3.2c0-.4-.3-.7-.7-.7H3.2c-.4 0-.7.3-.7.7v7.1c0 .4.3.7.7.7H5"/></svg>`,
    help: html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M6.2 6.2a1.9 1.9 0 0 1 3.6.8c0 1.3-1.8 1.6-1.8 2.8M8 11.6v.1"/></svg>`,
    cloud: html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5a3 3 0 0 1-.4-6 4 4 0 0 1 7.7-.9 3.2 3.2 0 0 1-.3 6.9z"/></svg>`,
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

  function ReviewSelect({ item, onReview }) {
    const status = item.review ? item.review.status : '';
    return html`<select class=${`review-select ${status}`} aria-label="Review status" value=${status} onChange=${(e) => onReview(item.key, e.target.value)}>
      <option value="">Open</option>
      ${Object.entries(E.REVIEW_STATUSES).map(([k, l]) => html`<option key=${k} value=${k}>${l}</option>`)}
    </select>`;
  }

  const clearedOf = (x) => !!x.review && (x.review.status === 'ok' || x.review.status === 'fixed');

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

  function Slider({ id, label, value, min, max, step, fmt, onChange }) {
    return html`<label class="field slider" for=${id}>
      <span class="slider-head"><span>${label}</span><b class="num">${fmt(value)}</b></span>
      <input id=${id} type="range" min=${min} max=${max} step=${step} value=${value} onInput=${(e) => onChange(parseFloat(e.target.value))} />
    </label>`;
  }

  function InsightList({ items }) {
    return html`<ul class="insight-list">${items.map((i) => html`<li key=${i.text}><span class=${`pill ${i.tone === 'good' ? 'good' : 'high'}`}><span class="dot"></span>${i.tone === 'good' ? 'Better' : 'Watch'}</span><span>${i.text}</span></li>`)}</ul>`;
  }

  function NumberInput({ id, label, value, onChange, suffix, prefix, placeholder, hint }) {
    return html`<label class="field" for=${id}>${label}
      <span class="money-input">${prefix && html`<span aria-hidden="true">${prefix}</span>`}<input id=${id} inputmode="decimal" value=${value} placeholder=${placeholder || ''} onInput=${(e) => onChange(e.target.value.replace(/[^0-9.\-]/g, ''))} />${suffix && html`<span aria-hidden="true" style=${{ paddingRight: '10px' }}>${suffix}</span>`}</span>
      ${hint && html`<span class="hint">${hint}</span>`}
    </label>`;
  }

  function useEscape(onClose) {
    useEffect(() => {
      const onKey = (e) => { if (e.key === 'Escape') onClose(); };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);
  }

  Object.assign(UI, { compactMoney, truncate, safeStore, ClientStore, emptyProfile, excelToCsv, saveTextFile, copyText, slug, useDebounced, useTokens, Icon, Severity, Money, ChartTooltip, ReviewSelect, clearedOf, shortDate, wholeMoney, Banner, MoneyInput, Slider, InsightList, NumberInput, useEscape, Backup, Firm });
})();
