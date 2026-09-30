/* Ledger Lens UI: Flag a problem. The bookkeeper taps the part of the page that is wrong (a
 * panel, a figure tile, a tab, or the whole tab), says what is wrong, and it goes to the
 * developer as a ticket (a GitHub issue, via netlify/functions/ticket.mjs) with a picture of that
 * part. Amounts and names are blanked out of the picture before it is taken: the picture is made
 * from a copy of the page, and the copy is redacted first (redactTree below). */
(function () {
  'use strict';
  const { useState, useEffect, useRef } = React;
  const html = htm.bind(React.createElement);
  const UI = window.LedgerUI;
  const { Icon, useEscape, safeStore } = UI;
  const Problem = window.LedgerProblem;

  // What can be picked, most specific first.
  const PICKABLE = '.kpi, section.panel, .tabs .tab, .source';
  const MAX_WIDTH = 1400;
  const MAX_HEIGHT = 5000;

  // Text that is part of the app itself (headings, column names, labels, buttons) stays
  // readable, with digits blanked; everything else is replaced by a grey bar.
  const KEEP = 'h1, h2, h3, h4, th, label, button, .btn, .tab, .legend, .pill, .kpi-label, .panel-head p, .arrange-label, .chart-note, option, .recharts-cartesian-axis-tick, .recharts-legend-item-text';
  const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Redacts a copy of the page in place. `names` are client-specific words (company, customers,
  // vendors, file names) blanked wherever they appear, even in kept text.
  function redactTree(root, names) {
    const doc = root.ownerDocument;
    const list = [...new Set((names || []).map((n) => String(n || '').trim()).filter((n) => n.length >= 3))].sort((a, b) => b.length - a.length).slice(0, 4000);
    const nameRx = list.length ? new RegExp(list.map(escapeRx).join('|'), 'gi') : null;
    const blankNames = (s) => (nameRx ? s.replace(nameRx, (m) => '▇'.repeat(Math.min(m.length, 12))) : s);
    const blankDigits = (s) => s.replace(/\d/g, '•');
    const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.trim()) nodes.push(n);
    for (const n of nodes) {
      const el = n.parentElement;
      if (!el) continue;
      const inSvg = !!el.closest('svg');
      if (inSvg || el.closest(KEEP)) { n.nodeValue = blankDigits(blankNames(n.nodeValue)); continue; }
      // A grey bar about as long as the text.
      const bar = doc.createElement('span');
      bar.className = 'redacted';
      bar.textContent = n.nodeValue.replace(/\S/g, 'x');
      n.parentNode.replaceChild(bar, n);
    }
    for (const input of root.querySelectorAll('input, textarea')) {
      if (input.type === 'checkbox' || input.type === 'radio') continue;
      input.value = input.value ? 'x'.repeat(Math.min(input.value.length, 12)) : '';
      input.setAttribute('placeholder', '');
    }
    for (const img of root.querySelectorAll('img')) if (!img.closest('.brand')) img.style.visibility = 'hidden';
    for (const t of root.querySelectorAll('[title], [aria-label]')) { t.removeAttribute('title'); }
    for (const tip of root.querySelectorAll('.recharts-tooltip-wrapper')) tip.remove();
    return root;
  }

  // A redacted JPEG of `el`, or null if the picture could not be made.
  async function capture(el, names) {
    if (!window.html2canvas || !el) return null;
    const bg = getComputedStyle(document.body).backgroundColor || '#fff';
    const scale = Math.min(window.devicePixelRatio || 1, 1.5);
    try {
      const canvas = await window.html2canvas(el, {
        backgroundColor: bg, scale, logging: false, useCORS: false,
        height: Math.min(el.scrollHeight, MAX_HEIGHT / scale),
        onclone: (doc, copy) => {
          const style = doc.createElement('style');
          style.textContent = '.redacted{color:transparent!important;background:#9aa3ad!important;border-radius:3px;-webkit-text-fill-color:transparent} .flag-hover{outline:none!important}';
          doc.head.appendChild(style);
          redactTree(copy, names);
        },
      });
      // Shrink to a sensible size for the ticket.
      const k = Math.min(1, MAX_WIDTH / canvas.width);
      const out = document.createElement('canvas');
      out.width = Math.round(canvas.width * k);
      out.height = Math.round(canvas.height * k);
      out.getContext('2d').drawImage(canvas, 0, 0, out.width, out.height);
      return out.toDataURL('image/jpeg', 0.82);
    } catch (e) {
      Problem.note('ticket picture', e && e.message);
      return null;
    }
  }

  // Describes the picked element: which tab, which section (from the Arrange wrapper), and the
  // panel's own heading. Headings are the app's labels, not client data.
  function describe(el, tab) {
    const whole = el.matches('main, .home');
    const part = el.closest('[data-part]');
    const title = (sel) => { const h = el.matches(sel) ? el : el.querySelector(sel); return h ? h.textContent.replace(/\s+/g, ' ').trim().slice(0, 80) : ''; };
    const own = el.matches('.kpi') ? title('.kpi-label') : el.matches('.tab') ? el.firstChild && el.firstChild.textContent : el.matches('.source') ? 'Files and industry bar' : title('h2');
    const partLabel = part ? part.getAttribute('data-part-label') : '';
    const sectionLabel = whole ? '' : [partLabel, own && own !== partLabel ? own : ''].filter(Boolean).join(' › ') || own || 'Part of the page';
    return {
      tab: tab.id, tabLabel: tab.label,
      section: whole ? '' : part ? part.getAttribute('data-part') : el.matches('.kpi') ? `${tab.id}:tile` : el.matches('.tab') ? 'tab-button' : el.matches('.source') ? 'source-bar' : `${tab.id}:panel`,
      sectionLabel,
    };
  }

  // Pick mode: highlights what is under the pointer and takes the next tap as the choice.
  function FlagPicker({ onPick, onCancel, onWhole }) {
    useEscape(onCancel);
    useEffect(() => {
      let hover = null;
      const target = (e) => {
        if (!e.target.closest || e.target.closest('.flag-bar, .drawer, .scrim')) return null;
        const el = e.target.closest(PICKABLE);
        return el && el.closest('#root') && !el.closest('.customize-bar') ? el : null;
      };
      const over = (e) => {
        const el = target(e);
        if (el === hover) return;
        if (hover) hover.classList.remove('flag-hover');
        hover = el;
        if (hover) hover.classList.add('flag-hover');
      };
      const click = (e) => {
        if (e.target.closest && e.target.closest('.flag-bar')) return;
        e.preventDefault();
        e.stopPropagation();
        const el = target(e);
        if (el) { el.classList.remove('flag-hover'); onPick(el); }
      };
      document.addEventListener('pointerover', over, true);
      document.addEventListener('click', click, true);
      document.body.classList.add('flagging');
      return () => {
        document.removeEventListener('pointerover', over, true);
        document.removeEventListener('click', click, true);
        document.body.classList.remove('flagging');
        if (hover) hover.classList.remove('flag-hover');
      };
    }, [onPick]);
    return html`<div class="flag-bar" role="dialog" aria-label="Flag a problem">
      <span>${Icon.flag}<span><strong>Tap the part that's wrong</strong>: a chart, table, figure or tab.</span></span>
      <span class="flag-actions">
        <button class="btn" onClick=${onWhole}>The whole page</button>
        <button class="btn" onClick=${onCancel}>Cancel</button>
      </span>
    </div>`;
  }

  const available = () => /^https?:$/.test(location.protocol);

  // Tickets sent from this browser, so Home can show how each one is going.
  const TICKETS_KEY = 'll.tickets';
  function myTickets() { try { return JSON.parse(safeStore.get(TICKETS_KEY) || '[]'); } catch (e) { return []; } }
  function saveTickets(list) { safeStore.set(TICKETS_KEY, JSON.stringify(list.slice(-50))); }
  function rememberTicket(t) { saveTickets([...myTickets().filter((x) => x.number !== t.number), t]); }

  function TicketDrawer({ target, image, context, onClose }) {
    const [comment, setComment] = useState('');
    const [withPicture, setWithPicture] = useState(!!image);
    const [status, setStatus] = useState(image === null ? 'The picture could not be made; the ticket can still be sent without it.' : '');
    const [busy, setBusy] = useState(false);
    const [sent, setSent] = useState(null);
    const [fallback, setFallback] = useState(!available());
    useEscape(onClose);
    const where = target.sectionLabel ? `${target.tabLabel} › ${target.sectionLabel}` : `${target.tabLabel} (whole page)`;
    const details = Problem.details({ ...context, Flagged: `${where}${target.section ? ` [${target.section}]` : ''}` });
    const report = Problem.draft(`Flagged: ${where}\n\n${comment.trim()}`, { ...context, Flagged: target.section || target.tab });
    const send = async () => {
      if (!comment.trim()) { setStatus('Say what is wrong first.'); return; }
      setBusy(true); setStatus('Sending…');
      try {
        const res = await fetch('/api/ticket', {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...target, comment: comment.trim(), details, image: withPicture && image ? image : undefined }),
        });
        const b = await res.json().catch(() => ({}));
        if (!res.ok) { if (res.status === 503 || res.status === 404) setFallback(true); throw new Error(b.error || `the site answered ${res.status}`); }
        setSent(b.number);
        rememberTicket({ number: b.number, where, sentAt: new Date().toISOString() });
        setStatus('');
      } catch (e) { setStatus(`Not sent: ${e.message}`); }
      setBusy(false);
    };
    return html`<div class="scrim" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="ticket-title">
        <div class="drawer-head"><h2 id="ticket-title">Flag a problem</h2><button class="btn" onClick=${onClose}>Close</button></div>
        <div class="drawer-scroll panel-body problem">
          ${sent
            ? html`<div class="banner good" role="status"><span class="pill good"><span class="dot"></span>Sent</span><div>Ticket #${sent} is in. Claude looks at new tickets every day, works out a fix and asks Nate before building it. You can follow it under <strong>Your tickets</strong> on Home.</div></div>
              <div class="backup-actions"><button class="btn primary" onClick=${onClose}>Done</button></div>`
            : html`<p><strong>${where}</strong></p>
              ${image && html`<figure class="ticket-shot">
                ${withPicture ? html`<img src=${image} alt="Picture of the flagged part, with amounts and names blanked out" />` : html`<p class="hint">The picture will not be sent.</p>`}
                <figcaption class="hint">Amounts and names are blanked out. <button class="linkish" onClick=${() => setWithPicture(!withPicture)}>${withPicture ? 'Send without the picture' : 'Include the picture'}</button></figcaption>
              </figure>`}
              <label class="field" for="ticket-what">What is wrong, and what did you expect?
                <textarea id="ticket-what" class="text" rows="5" value=${comment} placeholder="For example: this total should include the June deposits, or: the chart is cut off on my phone." onInput=${(e) => setComment(e.target.value)}></textarea>
              </label>
              <p class="hint">Please don't type client names or account numbers here; say "the second customer in the list" instead.</p>
              <div class="backup-actions">
                ${!fallback && html`<button class="btn primary" disabled=${busy} onClick=${send}>${Icon.flag}Send ticket</button>`}
                ${fallback && report.mailto && html`<a class="btn primary" href=${report.mailto}>${Icon.flag}Email the report</a>`}
                ${fallback && withPicture && image && html`<a class="btn" href=${image} download="flagged-part.jpg">Download the picture</a>`}
              </div>
              ${fallback && html`<p class="hint">${available() ? 'Tickets are not set up on the site yet, so this goes by email. ' : 'Tickets are sent from the app\'s own site; from this copy it goes by email. '}Attach the downloaded picture to the email if it helps.</p>`}`}
          <p class="backup-status" role="status">${status}</p>
        </div>
      </aside>
    </div>`;
  }

  // The whole flow: pick, take the picture, then the drawer. `names()` returns the client
  // words to blank; `tab` is { id, label } of what is on screen.
  function FlagFlow({ tab, names, context, onDone }) {
    const [target, setTarget] = useState(null);
    const [image, setImage] = useState(undefined);
    const busy = useRef(false);
    const pick = async (el) => {
      if (busy.current) return;
      busy.current = true;
      const t = describe(el, tab);
      setTarget({ ...t, working: true });
      setImage(await capture(el, names()));
      setTarget(t);
    };
    const whole = () => { const el = document.querySelector('main[role="tabpanel"], main.home'); if (el) pick(el); };
    if (!target) return html`<${FlagPicker} onPick=${pick} onCancel=${onDone} onWhole=${whole} />`;
    if (target.working) return html`<div class="flag-bar" role="status"><span class="spinner" aria-hidden="true"></span><span>Taking the picture…</span></div>`;
    return html`<${TicketDrawer} target=${target} image=${image} context=${context} onClose=${onDone} />`;
  }

  Object.assign(UI, { FlagFlow, redactTree, myTickets, saveTickets });
})();
