/* Ledger Lens UI: Report, client questions and saved clients drawers. */
(function () {
  'use strict';
  const { useState, useMemo, useEffect, useRef } = React;
  const html = htm.bind(React.createElement);
  const E = window.LedgerEngine;
  const UI = window.LedgerUI;
  const { safeStore, ClientStore, saveTextFile, copyText, slug, Icon, useEscape } = UI;

  // ------------------------------------------------------------ report drawer

  // ------------------------------------------------------------ client questions drawer

  const QUESTION_SECTIONS = [
    ['uncategorized', 'Uncategorized transactions'],
    ['duplicates', 'Possible double charges'],
    ['coding', 'Entries to confirm'],
    ['unusual', 'Unusual payments'],
    ['receivables', 'Invoices over 90 days'],
    ['w9', 'W-9 requests'],
  ];

  function QuestionsDrawer({ result, onClose, onMarkAsked }) {
    const [greeting, setGreeting] = useState('');
    const [preparer, setPreparer] = useState(() => safeStore.get('ll.preparer') || '');
    const [include, setInclude] = useState({ uncategorized: true, duplicates: true, coding: true, unusual: true, receivables: true, w9: true });
    const [status, setStatus] = useState('');
    const preRef = useRef(null);
    const q = useMemo(() => E.clientQuestions(result, { greeting: greeting.trim() || undefined, preparer, include }), [result, greeting, preparer, include]);
    const filename = `${slug(result.meta.company)}-questions-${result.period.end}.txt`;
    useEffect(() => { safeStore.set('ll.preparer', preparer); }, [preparer]);
    useEscape(onClose);
    const toMark = q.keys.filter((k) => {
      const all = [...result.audit.uncategorized, ...result.audit.duplicates, ...result.audit.mismatches, ...(result.unusual ? result.unusual.txns : [])];
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

  // Shows a formatted report inside the drawer without letting its styles touch the page.
  function ShadowPreview({ html: doc }) {
    const hostRef = useRef(null);
    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;
      const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
      const body = doc.replace(/^[\s\S]*<style>/, '<style>').replace(/<\/head><body>/, '').replace(/<\/body><\/html>$/, '').replace(/<meta[^>]*>|<title>[\s\S]*?<\/title>|<!doctype html><html[^>]*><head>/gi, '');
      root.innerHTML = body.replace(/\bbody \{/, ':host { display: block; background: #fff; } .x-body {');
    }, [doc]);
    return html`<div class="report-shadow" ref=${hostRef}></div>`;
  }

  const REPORT_FORMATS = [
    ['owner', 'Owner summary'],
    ['full', 'Full review'],
    ['text', 'Plain text'],
  ];

  function ReportDrawer({ result, groupBy, cushion, benchmarks, onClose }) {
    const [clientName, setClientName] = useState(() => result.meta.company || '');
    const [preparer, setPreparer] = useState(() => safeStore.get('ll.preparer') || '');
    const [format, setFormat] = useState(() => safeStore.get('ll.reportFormat') || 'owner');
    const [status, setStatus] = useState('');
    const preRef = useRef(null);
    const opts = { clientName, preparer, groupBy, cushion, benchmarks };
    const text = useMemo(() => E.buildReport(result, opts), [result, clientName, preparer, groupBy, cushion, benchmarks]);
    const doc = useMemo(() => (format === 'text' ? '' : E.buildHtmlReport(result, { ...opts, version: format })), [result, clientName, preparer, groupBy, cushion, benchmarks, format]);
    const base = `${slug(clientName)}-${format === 'full' ? 'financial-review' : format === 'owner' ? 'financial-summary' : 'books-review'}-${result.period.end}`;

    useEffect(() => { safeStore.set('ll.preparer', preparer); }, [preparer]);
    useEffect(() => { safeStore.set('ll.reportFormat', format); setStatus(''); }, [format]);
    useEscape(onClose);

    const download = async () => setStatus(format === 'text' ? await saveTextFile(`${base}.txt`, text) : await saveTextFile(`${base}.html`, doc));
    const copy = async () => setStatus(await copyText(text, preRef.current));

    return html`<div class="scrim" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside class="drawer wide" role="dialog" aria-modal="true" aria-labelledby="report-title">
        <div class="drawer-head"><h2 id="report-title">Client report</h2><button class="btn" onClick=${onClose}>Close</button></div>
        <div class="drawer-fields">
          <label class="field" for="client-name">Client name<input id="client-name" value=${clientName} onInput=${(e) => setClientName(e.target.value)} placeholder="Client business name" /></label>
          <label class="field" for="preparer">Prepared by<input id="preparer" value=${preparer} onInput=${(e) => setPreparer(e.target.value)} placeholder="Your name or firm" /></label>
          <div class="field" style=${{ gridColumn: '1 / -1' }}><span>Format</span>
            <div class="seg" role="group" aria-label="Report format">${REPORT_FORMATS.map(([k, l]) => html`<button key=${k} aria-pressed=${format === k} onClick=${() => setFormat(k)}>${l}</button>`)}</div>
          </div>
        </div>
        ${format === 'text' ? html`<pre class="report-pre" ref=${preRef}>${text}</pre>` : html`<div class="report-frame"><${ShadowPreview} html=${doc} /></div>`}
        <div class="drawer-foot">
          <button class="btn primary" onClick=${download}>${Icon.download}Download ${format === 'text' ? '.txt' : '.html'}</button>
          ${format === 'text' && html`<button class="btn" onClick=${copy}>${Icon.copy}Copy text</button>`}
          <span class="status" role="status">${status || (format === 'text' ? '' : 'Open the downloaded file in any browser and print it to PDF to send.')}</span>
        </div>
      </aside>
    </div>`;
  }

  Object.assign(UI, { QuestionsDrawer, ClientsDrawer, ReportDrawer });
})();
