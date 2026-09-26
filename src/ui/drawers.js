/* Ledger Lens UI: Report, client questions and saved clients drawers. */
(function () {
  'use strict';
  const { useState, useMemo, useEffect, useRef } = React;
  const html = htm.bind(React.createElement);
  const E = window.LedgerEngine;
  const UI = window.LedgerUI;
  const { safeStore, ClientStore, saveTextFile, copyText, slug, Icon, useEscape, Backup, Firm, Drive, useDrive } = UI;

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
    const q = useMemo(() => E.clientQuestions(result, { greeting: greeting.trim() || undefined, preparer, include, firm: Firm }), [result, greeting, preparer, include]);
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
          <label class="field" for="q-preparer">Signed by<input id="q-preparer" value=${preparer} onInput=${(e) => setPreparer(e.target.value)} placeholder=${Firm.name ? 'Your name' : 'Your name or firm'} /></label>
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

  const fmtWhen = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    const days = Math.floor((Date.now() - d.getTime()) / 864e5);
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return days < 1 && new Date().toDateString() === d.toDateString() ? `today at ${time}` : days < 2 ? `yesterday at ${time}` : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  function DriveBackup({ onRestored }) {
    const st = useDrive();
    const [note, setNote] = useState('');
    const connected = Drive.connected();
    useEffect(() => { Drive.prepare().catch(() => { /* reported when Connect is pressed */ }); }, []);
    if (!Drive.enabled()) {
      return html`<div class="backup-block">
        <h3>${Icon.cloud}Google Drive</h3>
        <p><strong>Not set up yet.</strong> Saving straight to Google Drive needs a one-time Google sign-in key for this site; until it is added, the Connect button stays hidden.</p>
        <p>Meanwhile, use <strong>Save backup file</strong> below. If Google Drive for desktop is installed, save the file into your Google Drive folder and it syncs like any other file; restore by picking it from there.</p>
      </div>`;
    }
    const restore = async () => {
      const n = await Drive.restore();
      if (n != null) { setNote(`Restored from Google Drive: ${n} client${n === 1 ? '' : 's'} updated (newer copies kept).`); onRestored(); }
    };
    return html`<div class="backup-block">
      <h3>${Icon.cloud}Google Drive ${connected ? html`<span class="pill good"><span class="dot"></span>Connected</span>` : ''}</h3>
      ${connected
        ? html`<p>Saved clients are kept in <strong>Ledger Lens backup.json</strong> in your Google Drive${st.lastSaved ? `, last saved ${fmtWhen(st.lastSaved)}` : ''}. Google Drive keeps earlier versions of the file too.</p>
          <div class="backup-actions">
            <button class="btn primary" disabled=${!!st.busy} onClick=${() => { setNote(''); Drive.save(); }}>Save to Drive now</button>
            <button class="btn" disabled=${!!st.busy} onClick=${restore}>Restore from Drive</button>
            <button class="btn" disabled=${!!st.busy} onClick=${() => Drive.disconnect()}>Disconnect</button>
          </div>
          <label class="check" for="drive-auto" style=${{ paddingTop: '8px' }}><input id="drive-auto" type="checkbox" checked=${st.auto} onChange=${(e) => Drive.setAuto(e.target.checked)} />Save to Drive automatically after each change</label>`
        : html`<p>${st.account ? 'Connect again to save or restore. Google asks every time the page is opened, for safety.' : 'Keep saved clients in your own Google Drive, so they survive a cleared browser and follow you to another computer. Ledger Lens can only see the backup file it creates, nothing else in your Drive.'}</p>
          <div class="backup-actions"><button class="btn primary" disabled=${!!st.busy} onClick=${() => Drive.connect()}>${Icon.cloud}Connect Google Drive</button></div>`}
      <p class="backup-status" role="status">${st.busy || st.error || note}</p>
    </div>`;
  }

  function ClientsDrawer({ currentId, onClose, onForget }) {
    const [clients, setClients] = useState(() => ClientStore.all());
    const [confirm, setConfirm] = useState(null);
    const [status, setStatus] = useState('');
    useEscape(onClose);
    const list = Object.entries(clients).sort((a, b) => String(b[1].updatedAt || '').localeCompare(String(a[1].updatedAt || '')));
    const refresh = () => setClients(ClientStore.all());
    const last = Backup.last();
    const doExport = async () => {
      const msg = await saveTextFile(`ledger-lens-backup-${new Date().toISOString().slice(0, 10)}.json`, Backup.build());
      if (/^(Saved|Downloaded)/.test(msg)) Backup.mark('file');
      setStatus(msg);
    };
    const doImport = (file) => {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const n = Backup.restore(reader.result);
          refresh();
          setStatus(`Imported ${n} client${n === 1 ? '' : 's'} (newer copies kept).`);
        } catch (e) { setStatus(`${file.name} could not be imported: ${e.message}.`); }
      };
      reader.readAsText(file);
    };
    return html`<div class="scrim" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="clients-title">
        <div class="drawer-head"><h2 id="clients-title">Saved clients & backup</h2><button class="btn" onClick=${onClose}>Close</button></div>
        <div class="drawer-scroll">
          <div class="panel-body"><p class="chart-note" style=${{ marginTop: 0 }}>Account type corrections, reviewed flags, the cash cushion and loan, tax and benchmark settings are saved per client as you work, matched by the company name in the report header. They are kept in this browser, so back them up.</p></div>
          <div class="clients-list">
            ${list.length ? list.map(([id, c]) => html`<div class="client-row" key=${id}>
              <div><strong>${c.name || id}</strong>${id === currentId ? html` <span class="pill good">Open now</span>` : ''}
                <span class="sub">${Object.keys(c.accountClass || {}).length} account corrections · ${Object.keys(c.reviewed || {}).length} reviewed flags · saved ${String(c.updatedAt || '').slice(0, 10)}</span></div>
              ${confirm === id
                ? html`<span class="confirm">Forget this client? <button class="btn" onClick=${() => { ClientStore.remove(id); onForget(id); setConfirm(null); refresh(); }}>Forget</button><button class="btn" onClick=${() => setConfirm(null)}>Keep</button></span>`
                : html`<button class="btn" onClick=${() => setConfirm(id)}>Forget</button>`}
            </div>`) : html`<div class="empty">No saved clients yet. Upload a client's export and start reviewing; settings save as you go.</div>`}
          </div>
          <div class="backup">
            <${DriveBackup} onRestored=${refresh} />
            <div class="backup-block">
              <h3>${Icon.download}Backup file</h3>
              <p>Save everything to one file you can keep anywhere (a Google Drive or Dropbox folder works well) and load it on another computer.${last ? ` Last backup: ${fmtWhen(last.at)}${last.where === 'Google Drive' ? ' to Google Drive' : ''}.` : ' No backup yet.'}</p>
              <div class="backup-actions">
                <button class="btn" disabled=${!list.length} onClick=${doExport}>${Icon.download}Save backup file</button>
                <label class="btn" for="clients-import">${Icon.upload}Restore from file</label>
                <input id="clients-import" class="file-input" type="file" accept=".json,application/json" onChange=${(e) => { doImport(e.target.files[0]); e.target.value = ''; }} />
              </div>
              <p class="backup-status" role="status">${status}</p>
            </div>
          </div>
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
    const opts = { clientName, preparer, groupBy, cushion, benchmarks, firm: Firm };
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
          <label class="field" for="preparer">Prepared by<input id="preparer" value=${preparer} onInput=${(e) => setPreparer(e.target.value)} placeholder=${Firm.name ? 'Your name' : 'Your name or firm'} /></label>
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
