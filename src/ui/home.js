/* Ledger Lens UI: Home, the landing page. Every saved client, what is waiting on the
 * bookkeeper, and what is waiting on clients (answer links sent, not yet answered). Built from
 * the saved client profiles, so it needs no export loaded. */
(function () {
  'use strict';
  const { useState, useEffect } = React;
  const html = htm.bind(React.createElement);
  const UI = window.LedgerUI;
  const { Icon, Firm, clientStatus, safeStore } = UI;
  const { ClientStore, FileStore } = window.LedgerStore;

  const DAY = 864e5;
  const daysAgo = (t) => (t ? Math.max(0, Math.floor((Date.now() - (typeof t === 'number' ? t : Date.parse(t))) / DAY)) : null);
  const ago = (t) => { const d = daysAgo(t); return d == null ? '' : d === 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`; };
  const shortDay = (t) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const monthName = (key) => new Date(`${key}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  const cleared = (r) => !!r && (r.status === 'ok' || r.status === 'fixed');

  // Everything waiting, on the bookkeeper ("you") or on the client, for one saved client.
  function tasksFor(id, c) {
    const out = [];
    const add = (who, rank, text, detail) => out.push({ id, name: c.name || id, who, rank, text, detail });
    const s = c.summary;
    const answers = Object.entries(c.answers || {}).filter(([k]) => !cleared((c.reviewed || {})[k]));
    const portal = c.portal;
    if (answers.length) add('you', 1, `${answers.length} client answer${answers.length === 1 ? '' : 's'} to review`, portal && portal.status === 'received' ? `Came in ${ago(portal.receivedAt)} through the answer link` : 'Under Client answers on the audit tab');
    if (s && s.closedChanges) add('you', 2, `${s.closedChanges} change${s.closedChanges === 1 ? '' : 's'} to a closed month`, `Books were closed through ${monthName(s.closedThrough)}`);
    if (c.loanRequest && c.loanRequest.requested && !c.loanRequest.builtAt) add('you', 3, 'Loan package requested', `Asked ${ago(c.loanRequest.requestedAt)}; create it on the Tax & lending tab`);
    if (portal && portal.status === 'expired') add('you', 4, 'Answer link expired without answers', 'Send a new link from Client questions');
    if (s && s.open && s.openTotal) add('you', 5, `${s.openTotal} flag${s.openTotal === 1 ? '' : 's'} to review`, [s.open.uncategorized && `${s.open.uncategorized} uncategorized`, s.open.duplicates && `${s.open.duplicates} possible duplicates`, s.open.balance && `${s.open.balance} balance sheet`, s.open.receipts && `${s.open.receipts} receipts`].filter(Boolean).join(', ') || 'On the audit tab');
    if (s && s.landscape && s.landscape.missed) add('you', 5, `${s.landscape.missed} contract invoice${s.landscape.missed === 1 ? '' : 's'} not sent`, 'Customers billed every month with no invoice lately; see the Landscaping tab');
    if (s && s.close && s.close.done < s.close.total) add('you', 6, `${monthName(s.close.month)} close: ${s.close.done} of ${s.close.total} done`, 'On the Month-end close tab');
    if (s && s.landscape && s.landscape.stale) add('you', 8, `${s.landscape.stale} contract price${s.landscape.stale === 1 ? '' : 's'} unchanged for a year`, 'Worth raising at renewal; see the Landscaping tab');
    if (daysAgo(c.loadedAt) > 35) add('you', 7, 'Due for a new export', s ? `Books loaded run to ${s.periodEnd}` : 'Upload their latest export');
    if (portal && portal.status === 'waiting' && portal.expiresAt > Date.now()) {
      const d = daysAgo(portal.createdAt);
      add('client', d >= 7 ? 1 : 2, `${portal.count} question${portal.count === 1 ? '' : 's'} sent, no answers yet`, `Sent ${ago(portal.createdAt)}${portal.email ? ` to ${portal.email}` : ''}; link works until ${shortDay(portal.expiresAt)}${d >= 7 ? '. Consider a reminder.' : ''}`);
    }
    return out;
  }


  // Tickets sent with Flag a problem from this browser, with where each stands on GitHub (looked
  // up through the site; the last answer is kept so the list shows at once).
  const STATUS_KEY = 'll.ticketStatus';
  const DONE = new Set(['fixed', 'answered', 'closed', 'missing']);
  const PILL = { received: 'low', proposed: 'medium', building: 'medium', question: 'high', fixed: 'good', answered: 'good', closed: 'low', missing: 'low' };
  function readStatus() { try { return JSON.parse(safeStore.get(STATUS_KEY) || '{}'); } catch (e) { return {}; } }
  function YourTickets() {
    const [list, setList] = useState(() => UI.myTickets());
    const [status, setStatus] = useState(readStatus);
    const [note, setNote] = useState('');
    useEffect(() => {
      if (!list.length || !/^https?:$/.test(location.protocol)) return;
      let live = true;
      fetch('/api/ticket/status', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ numbers: list.map((t) => t.number) }) })
        .then((r) => r.json().then((b) => { if (!r.ok) throw new Error(b.error || `the site answered ${r.status}`); return b; }))
        .then((b) => {
          if (!live) return;
          const prev = readStatus();
          const next = {};
          // "New" until the next visit when the status changed since the last look.
          for (const t of b.tickets || []) next[t.number] = { ...t, fresh: prev[t.number] ? prev[t.number].status !== t.status : false };
          safeStore.set(STATUS_KEY, JSON.stringify(Object.fromEntries(Object.entries(next).map(([k, v]) => [k, { ...v, fresh: false }]))));
          setStatus(next);
          setNote('');
        })
        .catch((e) => { if (live) setNote(`Couldn't check the latest status: ${e.message}.`); });
      return () => { live = false; };
    }, [list.length]);
    if (!list.length) return null;
    const dismiss = (n) => { const rest = list.filter((t) => t.number !== n); UI.saveTickets(rest); setList(rest); };
    const order = (t) => { const s = status[t.number]; return s ? (s.status === 'question' ? 0 : DONE.has(s.status) ? 2 : 1) : 1; };
    const rows = [...list].sort((a, b) => order(a) - order(b) || b.number - a.number);
    return html`<section class="panel">
      <div class="panel-head"><h2>Your tickets</h2><p>Problems flagged from this browser, and where each one stands.</p></div>
      <div class="panel-body flush"><ul class="task-list">${rows.map((t) => {
        const s = status[t.number];
        return html`<li key=${t.number}>
          <div>
            <span class="task-client">#${t.number}</span>
            <span class="task-text">${t.where}${s ? html` <span class=${`pill ${PILL[s.status] || 'low'}`}><span class="dot"></span>${s.label}</span>` : ''}${s && s.fresh ? html` <span class="pill good">New</span>` : ''}</span>
            <span class="sub">${s && s.status === 'question' ? `${s.note || 'Claude needs more detail.'}\nTell Nate the answer, or flag the same spot again with it.` : s && s.note && s.status !== 'proposed' ? s.note : s && s.status === 'proposed' ? 'Nate is reviewing the proposed fix.' : s && s.status === 'received' ? 'Claude looks at it at the next daily check.' : `Sent ${ago(t.sentAt)}`}</span>
          </div>
          ${s && DONE.has(s.status) ? html`<button class="btn" onClick=${() => dismiss(t.number)}>Dismiss</button>` : ''}
        </li>`;
      })}</ul></div>
      ${note && html`<div class="panel-body"><p class="hint">${note}</p></div>`}
    </section>`;
  }

  function HomePage({ onOpen, onUpload, onSample, onHelp, onClients }) {
    const [clients, setClients] = useState(() => ClientStore.all());
    useEffect(() => {
      const refresh = () => setClients(ClientStore.all());
      ClientStore.listeners.add(refresh);
      FileStore.listeners.add(refresh);
      return () => { ClientStore.listeners.delete(refresh); FileStore.listeners.delete(refresh); };
    }, []);
    const ids = Object.keys(clients);
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    if (!ids.length) {
      return html`<main class="home" aria-label="Home">
        <section class="panel home-empty">
          <div class="panel-body">
            <h2>Welcome to Ledger Lens${Firm.name ? ` for ${Firm.name}` : ''}</h2>
            <p>Upload a client's QuickBooks <strong>Transaction Detail by Account</strong> export to review their books, forecast cash and prepare reports. Select all of their files at once: the chart of accounts, Profit and Loss and expense list are recognized too. Each client you load appears here with what needs doing.</p>
            <div class="backup-actions">
              <button class="btn primary" onClick=${onUpload}>${Icon.upload}Upload a client's export</button>
              <button class="btn" onClick=${onSample}>${Icon.sample}Look around with sample data</button>
              <button class="btn" onClick=${onHelp}>${Icon.help}Getting started guide</button>
            </div>
          </div>
        </section>
        <${YourTickets} />
      </main>`;
    }
    const tasks = ids.flatMap((id) => tasksFor(id, clients[id]));
    const mine = tasks.filter((t) => t.who === 'you').sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
    const theirs = tasks.filter((t) => t.who === 'client').sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
    const loans = ids.filter((id) => clients[id].loanRequest && clients[id].loanRequest.requested).length;
    const byUrgency = ids.map((id) => ({ id, c: clients[id], st: clientStatus(clients[id]) })).sort((a, b) => b.st.score - a.st.score || String(a.c.name || a.id).localeCompare(String(b.c.name || b.id)));
    const openBtn = (id, label) => (FileStore.info(id)
      ? html`<button class="btn" onClick=${() => onOpen(id)}>${label || 'Open'}</button>`
      : html`<button class="btn" title="Their files are not saved in this browser; upload the latest export" onClick=${onUpload}>${Icon.upload}Upload</button>`);
    const taskList = (list, empty) => (list.length
      ? html`<ul class="task-list">${list.map((t, i) => html`<li key=${`${t.id}-${i}`}>
          <div><span class="task-client">${t.name}</span><span class="task-text">${t.text}</span><span class="sub">${t.detail}</span></div>
          ${openBtn(t.id)}
        </li>`)}</ul>`
      : html`<div class="empty">${empty}</div>`);
    return html`<main class="home" aria-label="Home">
      <div class="home-head"><h2>${greeting}</h2><span class="sub">${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</span></div>
      <section class="kpis" aria-label="Practice summary">
        <div class="kpi"><span class="kpi-label">Clients</span><span class="kpi-value">${ids.length}</span><span class="kpi-sub">saved in this browser</span></div>
        <div class=${`kpi ${mine.length ? 'alert' : 'okay'}`}><span class="kpi-label">Waiting on you</span><span class="kpi-value">${mine.length}</span><span class="kpi-sub">across ${new Set(mine.map((t) => t.id)).size} client${new Set(mine.map((t) => t.id)).size === 1 ? '' : 's'}</span></div>
        <div class="kpi"><span class="kpi-label">Waiting on clients</span><span class="kpi-value">${theirs.length}</span><span class="kpi-sub">answer links sent, not answered</span></div>
        <div class="kpi"><span class="kpi-label">Loan packages</span><span class="kpi-value">${loans}</span><span class="kpi-sub">requested by clients</span></div>
      </section>
      <div class="grid-2">
        <section class="panel"><div class="panel-head"><h2>Waiting on you</h2><p>Most urgent first. Open a client to work on it.</p></div><div class="panel-body flush">${taskList(mine, 'Nothing waiting. Nice work.')}</div></section>
        <section class="panel"><div class="panel-head"><h2>Waiting on clients</h2><p>Questions sent through an answer link. Answers come in by themselves.</p></div><div class="panel-body flush">${taskList(theirs, 'No questions out with clients.')}</div></section>
      </div>
      <${YourTickets} />
      <section class="panel">
        <div class="panel-head"><h2>Clients</h2><p>Every client loaded in this browser. For backups and to forget a client, use the Clients button.</p></div>
        <div class="panel-body client-cards">
          ${byUrgency.map(({ id, c, st }) => {
            const s = c.summary;
            return html`<div class="client-card" key=${id}>
              <div class="client-card-head"><span class="client-name">${c.name || id}</span><span class=${`pill ${st.level}`}><span class="dot"></span>${st.label}</span></div>
              <span class="sub">${s ? `Books to ${s.periodEnd}` : 'No summary yet'}${c.loadedAt ? ` · loaded ${ago(c.loadedAt)}` : ''}</span>
              ${openBtn(id, 'Open')}
            </div>`;
          })}
        </div>
        <div class="panel-body" style=${{ borderTop: '1px solid var(--hair)' }}>
          <div class="backup-actions">
            <button class="btn" onClick=${onUpload}>${Icon.upload}Upload a client's export</button>
            <button class="btn" onClick=${onClients}>${Icon.cloud}Clients & backup</button>
            <button class="btn" onClick=${onSample}>${Icon.sample}Sample data</button>
          </div>
        </div>
      </section>
    </main>`;
  }

  Object.assign(UI, { HomePage, homeTasks: tasksFor });
})();
