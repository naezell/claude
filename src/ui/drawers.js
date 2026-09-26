/* Ledger Lens UI: Report, client questions and saved clients drawers. */
(function () {
  'use strict';
  const { useState, useMemo, useEffect, useRef } = React;
  const html = htm.bind(React.createElement);
  const E = window.LedgerEngine;
  const UI = window.LedgerUI;
  const { safeStore, ClientStore, saveTextFile, copyText, slug, Icon, useEscape, Backup, Firm, Drive, useDrive, excelToCsv, LocalFile, useLocalFile } = UI;

  // ------------------------------------------------------------ client questions drawer

  const QUESTION_SECTIONS = [
    ['uncategorized', 'Uncategorized transactions'],
    ['duplicates', 'Possible double charges'],
    ['coding', 'Entries to confirm'],
    ['unusual', 'Unusual payments'],
    ['receipts', 'Receipts'],
    ['receivables', 'Invoices over 90 days'],
    ['w9', 'W-9 requests'],
  ];

  function QuestionsDrawer({ result, answers, onLoadAnswers, onClose, onMarkAsked }) {
    const [greeting, setGreeting] = useState('');
    const [preparer, setPreparer] = useState(() => safeStore.get('ll.preparer') || '');
    const [include, setInclude] = useState({ uncategorized: true, duplicates: true, coding: true, unusual: true, receipts: true, receivables: true, w9: true });
    const [status, setStatus] = useState('');
    const preRef = useRef(null);
    const q = useMemo(() => E.clientQuestions(result, { greeting: greeting.trim() || undefined, preparer, include, firm: Firm, answers }), [result, greeting, preparer, include, answers]);
    const filename = `${slug(result.meta.company)}-questions-${result.period.end}.txt`;
    useEffect(() => { safeStore.set('ll.preparer', preparer); }, [preparer]);
    useEscape(onClose);
    const toMark = q.keys.filter((k) => {
      const all = [...result.audit.uncategorized, ...result.audit.duplicates, ...result.audit.mismatches, ...(result.unusual ? result.unusual.txns : []), ...(result.receipts ? result.receipts.items : [])];
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
          <button class="btn" disabled=${!q.rows.length} title="A spreadsheet the client fills in and sends back" onClick=${async () => setStatus(`${await saveTextFile(filename.replace(/\.txt$/, '.csv'), E.questionsSheet(q))}. The client types answers in the last two columns and sends it back.`)}>${Icon.download}Spreadsheet for the client</button>
          <label class="btn" for="answers-file">${Icon.upload}Load client's answers</label>
          <input id="answers-file" class="file-input" type="file" accept=".csv,.xlsx,.xls,text/csv" onChange=${async (e) => {
            const f = e.target.files[0];
            e.target.value = '';
            if (!f) return;
            try {
              const text = /\.xlsx?$/i.test(f.name) ? await excelToCsv(await f.arrayBuffer()) : await f.text();
              const parsed = E.parseAnswers(text);
              setStatus(parsed ? onLoadAnswers({ name: f.name, parsed }) : `${f.name} is not a returned questions spreadsheet (it needs the Ref and Your answer columns).`);
            } catch (err) { setStatus(`${f.name} could not be read: ${err.message}`); }
          }} />
          ${toMark.length > 0 && html`<button class="btn" onClick=${() => { onMarkAsked(toMark); setStatus(`Marked ${toMark.length} flag${toMark.length === 1 ? '' : 's'} as asked.`); }}>Mark ${toMark.length} as asked</button>`}
          <span class="status" role="status">${status || `${q.count} question${q.count === 1 ? '' : 's'}; cleared flags${Object.keys(answers || {}).length ? ' and answered questions' : ''} are left out.`}</span>
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

  // A backup file on this computer that the app keeps up to date (Chrome and Edge).
  function ComputerBackup({ onRestored }) {
    const st = useLocalFile();
    const [note, setNote] = useState('');
    const title = html`<h3>${Icon.download}File on this computer ${LocalFile.ready() ? html`<span class="pill good"><span class="dot"></span>Saving automatically</span>` : ''}</h3>`;
    if (!LocalFile.supported()) {
      return html`<div class="backup-block">${title}
        <p>${window.self !== window.top
          ? 'Automatic saving to a file works when the app is opened on its own site in Chrome or Edge.'
          : 'This browser cannot keep saving to a file by itself; Chrome and Edge on a computer can.'} Here, use <strong>Save backup file</strong> below and keep the file somewhere safe, such as Documents.</p>
      </div>`;
    }
    const restored = (n) => { if (n != null) { setNote(`Restored ${n} client${n === 1 ? '' : 's'} from ${LocalFile.state.name} (newer copies kept); saving there from now on.`); onRestored(); } };
    const msg = st.busy || st.error || note;
    if (st.handle && st.permission === 'granted') {
      return html`<div class="backup-block">${title}
        <p>Everything is saved to <strong>${st.name}</strong>${st.lastSaved ? `, last saved ${fmtWhen(st.lastSaved)}` : ''}. The file stays wherever you chose, for example Documents, and can be copied to a USB drive for safekeeping.</p>
        <div class="backup-actions">
          <button class="btn primary" disabled=${!!st.busy} onClick=${() => { setNote(''); LocalFile.save(); }}>Save now</button>
          <button class="btn" disabled=${!!st.busy} onClick=${async () => { const n = await LocalFile.restore(); if (n != null) { setNote(`Restored ${n} client${n === 1 ? '' : 's'} from the file (newer copies kept).`); onRestored(); } }}>Restore from it</button>
          <button class="btn" disabled=${!!st.busy} onClick=${() => { setNote(''); LocalFile.forget(); }}>Stop saving to it</button>
        </div>
        <label class="check" for="file-auto" style=${{ paddingTop: '8px' }}><input id="file-auto" type="checkbox" checked=${st.auto} onChange=${(e) => LocalFile.setAuto(e.target.checked)} />Save to the file automatically after each change</label>
        <p class="backup-status" role="status">${msg}</p>
      </div>`;
    }
    if (st.handle) {
      return html`<div class="backup-block">${title}
        <p>Saving goes to <strong>${st.name}</strong>. For safety the browser asks once each time the page is opened before the app may write to it.</p>
        <div class="backup-actions">
          <button class="btn primary" disabled=${!!st.busy} onClick=${() => LocalFile.reconnect()}>Allow saving to ${st.name}</button>
          <button class="btn" disabled=${!!st.busy} onClick=${() => { setNote(''); LocalFile.forget(); }}>Use a different file</button>
        </div>
        <p class="backup-status" role="status">${msg}</p>
      </div>`;
    }
    return html`<div class="backup-block">${title}
      <p>Pick a file on this computer once, and the app saves every client's settings and reviews to it after each change. No account needed.</p>
      <div class="backup-actions">
        <button class="btn primary" disabled=${!!st.busy} onClick=${() => { setNote(''); LocalFile.create(); }}>Choose where to save</button>
        <button class="btn" disabled=${!!st.busy} onClick=${async () => { setNote(''); restored(await LocalFile.openExisting()); }}>Use an existing backup file</button>
      </div>
      <p class="backup-status" role="status">${msg}</p>
    </div>`;
  }

  function DriveBackup({ onRestored }) {
    const st = useDrive();
    const [note, setNote] = useState('');
    const connected = Drive.connected();
    useEffect(() => { Drive.prepare().catch(() => { /* reported when Connect is pressed */ }); }, []);
    const away = Drive.elsewhere();
    if (away) {
      return html`<div class="backup-block">
        <h3>${Icon.cloud}Google Drive</h3>
        <p>Google Drive saving works on the app's own site. Open <a href=${away} target="_blank" rel="noopener">${away.replace(/^https?:\/\//, '')}</a> to connect. Saved clients don't carry over between addresses by themselves: use <strong>Save backup file</strong> here, then <strong>Restore from file</strong> there.</p>
      </div>`;
    }
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

  const monthLong = (key) => (key ? new Date(`${key}-01T00:00:00Z`).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
  const daysSince = (iso) => (iso ? Math.floor((Date.now() - Date.parse(iso)) / 864e5) : null);
  const money0 = (n) => (n == null ? '-' : `${n < 0 ? '-' : ''}$${Math.round(Math.abs(n)).toLocaleString('en-US')}`);

  // Where each client stands, from the summary saved when their export was last analyzed.
  function clientStatus(c) {
    const s = c.summary;
    if (!s) return { label: 'No summary yet', level: 'low', score: 0 };
    const stale = daysSince(c.loadedAt) > 35;
    const closeDone = s.close && s.close.done === s.close.total;
    if (s.closedChanges) return { label: 'Closed month changed', level: 'high', score: 1000 + s.closedChanges };
    if (s.open.balance || (s.lowestCash != null && s.lowestCash < 0)) return { label: 'Needs attention', level: 'high', score: 500 + s.openTotal };
    if (stale) return { label: 'Due for review', level: 'medium', score: 300 + daysSince(c.loadedAt) };
    if (closeDone) return { label: `${monthLong(s.close.month)} closed`, level: 'good', score: 0 };
    return { label: 'In progress', level: 'medium', score: 100 + s.openTotal };
  }

  function ClientsDrawer({ currentId, onClose, onForget }) {
    const [clients, setClients] = useState(() => ClientStore.all());
    const [confirm, setConfirm] = useState(null);
    const [status, setStatus] = useState('');
    useEscape(onClose);
    const list = Object.entries(clients).map(([id, c]) => ({ id, c, st: clientStatus(c) }))
      .sort((a, b) => b.st.score - a.st.score || String(b.c.loadedAt || b.c.updatedAt || '').localeCompare(String(a.c.loadedAt || a.c.updatedAt || '')));
    const refresh = () => setClients(ClientStore.all());
    const last = Backup.last();
    const attention = list.filter((x) => x.st.level === 'high').length;
    const closedCount = list.filter((x) => x.st.level === 'good').length;
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
    const chip = (n, label) => (n ? html`<span class="pill medium" key=${label}>${n} ${label}</span>` : null);
    return html`<div class="scrim" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside class="drawer wide" role="dialog" aria-modal="true" aria-labelledby="clients-title">
        <div class="drawer-head"><h2 id="clients-title">Clients</h2><button class="btn" onClick=${onClose}>Close</button></div>
        <div class="drawer-scroll">
          ${list.length > 0 && html`<section class="kpis dash-kpis" aria-label="Practice summary">
            <div class="kpi"><span class="kpi-label">Clients</span><span class="kpi-value">${list.length}</span><span class="kpi-sub">saved in this browser</span></div>
            <div class=${`kpi ${attention ? 'alert' : 'okay'}`}><span class="kpi-label">Need attention</span><span class="kpi-value">${attention}</span><span class="kpi-sub">closed-month changes, balance sheet or cash</span></div>
            <div class="kpi"><span class="kpi-label">Closes complete</span><span class="kpi-value">${closedCount}</span><span class="kpi-sub">latest month fully ticked off</span></div>
            <div class=${`kpi ${!last || daysSince(last.at) > 30 ? 'alert' : ''}`}><span class="kpi-label">Last backup</span><span class="kpi-value">${last ? `${daysSince(last.at)}d ago` : 'Never'}</span><span class="kpi-sub">${last ? (last.where === 'Google Drive' ? 'to Google Drive' : last.where === 'computer' ? 'to the file on this computer' : 'to a downloaded file') : 'see Backup below'}</span></div>
          </section>`}
          <div class="panel-body"><p class="chart-note" style=${{ marginTop: 0 }}>Every client whose export has been loaded, most urgent first. Figures are from the last time their export was analyzed; load a client's latest export to update them and work on the books. Settings and reviews are kept in this browser, so back them up.</p></div>
          ${list.length ? html`<div class="table-wrap"><table class="dash-table">
            <thead><tr><th>Client</th><th>Status</th><th>Month-end close</th><th>To review</th><th>Closed through</th><th class="num">Cash / lowest ahead</th><th class="num">Revenue / net, 12 mo</th><th></th></tr></thead>
            <tbody>${list.map(({ id, c, st }) => {
              const s = c.summary;
              const ago = daysSince(c.loadedAt || c.updatedAt);
              return html`<tr key=${id} class="dash-row">
                <td><span class="client-name">${c.name || id}</span>${id === currentId ? html` <span class="pill good">Open now</span>` : ''}
                  <span class="sub">${s ? `Books to ${s.periodEnd}` : 'Load their export'}${ago != null ? ` · loaded ${ago === 0 ? 'today' : `${ago}d ago`}` : ''}</span></td>
                <td><span class=${`pill ${st.level}`}><span class="dot"></span>${st.label}</span></td>
                <td>${s && s.close ? html`<div class="meter" style=${{ width: '110px' }}><span style=${{ width: `${Math.round((s.close.done / s.close.total) * 100)}%`, background: s.close.done === s.close.total ? 'var(--good)' : 'var(--accent)' }}></span></div><span class="sub">${monthLong(s.close.month)}: ${s.close.done}/${s.close.total}</span>` : html`<span class="sub">-</span>`}</td>
                <td>${s ? (s.openTotal ? html`<div class="dash-stats">${[chip(s.open.uncategorized, 'uncategorized'), chip(s.open.duplicates, 'duplicates'), chip(s.open.mismatches, 'miscoded'), chip(s.open.balance, 'balance sheet'), chip(s.open.jobs, 'job costing'), chip(s.open.unusual, 'unusual'), chip(s.open.receipts, 'receipts'), chip(s.open.answers, 'answers to act on')]}</div>` : html`<span class="pill good">All clear</span>`) : html`<span class="sub">-</span>`}</td>
                <td>${s && s.closedThrough ? html`${monthLong(s.closedThrough)}${s.closedChanges ? html`<span class="sub neg">${s.closedChanges} change${s.closedChanges === 1 ? '' : 's'} since</span>` : ''}` : html`<span class="sub">Not closed</span>`}</td>
                <td class="num">${s ? html`${money0(s.cash)}<span class=${`sub ${s.lowestCash != null && s.lowestCash < 0 ? 'neg' : ''}`}>${money0(s.lowestCash)}${s.lowestWeek ? ` wk of ${s.lowestWeek.slice(5)}` : ''}</span>` : '-'}</td>
                <td class="num">${s ? html`${money0(s.revenue12)}<span class=${`sub ${s.netIncome12 < 0 ? 'neg' : ''}`}>${money0(s.netIncome12)}</span>` : '-'}</td>
                <td>${confirm === id
                  ? html`<span class="confirm">Forget? <button class="btn" onClick=${() => { ClientStore.remove(id); onForget(id); setConfirm(null); refresh(); }}>Forget</button><button class="btn" onClick=${() => setConfirm(null)}>Keep</button></span>`
                  : html`<button class="btn" onClick=${() => setConfirm(id)}>Forget</button>`}</td>
              </tr>`;
            })}</tbody>
          </table></div>` : html`<div class="empty">No clients yet. Upload a client's export; it shows up here with where their books stand.</div>`}
          <div class="backup">
            <${ComputerBackup} onRestored=${refresh} />
            <${DriveBackup} onRestored=${refresh} />
            <div class="backup-block">
              <h3>${Icon.download}Download a backup file</h3>
              <p>A one-off copy of everything in a file you can keep anywhere (a USB drive, Dropbox, or email it to yourself) and load on another computer. Works in every browser.${last ? ` Last backup: ${fmtWhen(last.at)}${last.where === 'Google Drive' ? ' to Google Drive' : last.where === 'computer' ? ' to the file on this computer' : ''}.` : ' No backup yet.'}</p>
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
