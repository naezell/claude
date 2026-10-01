/* Ledger Lens UI: the client portal, Mark's side.
 *
 * "Create answer link" seals the current client questions (src/sealed.js) and leaves them on
 * the site under a random id; the key stays in the link, which Mark emails from his own
 * address. The client answers on /portal. When answers come in, collectAnswers() opens them,
 * files them under Client answers for the right client (with any receipt photos), and deletes
 * them from the site. The link's details are kept in the client's saved profile as `portal`.
 */
(function () {
  'use strict';
  const { useState } = React;
  const html = htm.bind(React.createElement);
  const UI = window.LedgerUI;
  const { Icon, Firm } = UI;
  const { ClientStore, AttachStore } = window.LedgerStore;
  const Seal = window.LedgerSeal;
  const DAYS = 30;

  const post = (path, body) => fetch(`/api/portal/${path}`, {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json().catch(() => ({})).then((b) => { if (!r.ok) throw new Error(b.error || `the site answered ${r.status}`); return b; }));

  const shortDate = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  const Portal = {
    // Only on the hosted site: the portal needs its server side.
    available() { return /^https?:$/.test(location.protocol) && (window.LedgerConfig || {}).portal !== false; },
    linkOf(rec) { return `${location.origin}/portal#${rec.id}.${rec.key}`; },
    active(rec) { return !!rec && rec.status === 'waiting' && rec.expiresAt > Date.now(); },

    // Seals the questions and stores them; resolves with the record to keep in the profile.
    async create({ rows, client, message, email, replaces }) {
      const { id, key } = Seal.newLink();
      const questions = rows.map((r) => ({ ref: r.ref, topic: r.section, question: r.question, receipt: /receipt/i.test(r.section) }));
      const firm = { name: Firm.name || '', website: Firm.website || '', logo: Firm.logo ? 'assets/7d-logo.png' : '' };
      const box = await Seal.seal(key, { client, message, questions, firm });
      const res = await post('create', { id, box, expiresAt: Date.now() + DAYS * 864e5, replaces: replaces || undefined });
      const refs = {};
      // The transaction each question is about, so a receipt photo can be checked against it.
      for (const r of rows) refs[r.ref] = { key: r.key, topic: r.section, question: r.question, date: r.date || '', payee: r.payee || '', amount: r.amount };
      return { id, key, email: email || '', createdAt: Date.now(), expiresAt: res.expiresAt, count: rows.length, refs, status: 'waiting' };
    },
    async cancel(rec) {
      await post('done', { id: rec.id });
      return { ...rec, status: 'cancelled' };
    },

    // Checks every saved client's waiting link. Answers for the client open on screen go to
    // `applyOpen(entries, record)` (the page holds them); other clients' are saved directly.
    // Resolves with [{ clientId, name, count }] for the answers that came in.
    async collectAnswers({ openId, openRecord, applyOpen } = {}) {
      if (!this.available()) return [];
      const all = ClientStore.all();
      const waiting = Object.entries(all).map(([cid, p]) => [cid, cid === openId && openRecord ? openRecord : p.portal]).filter(([, rec]) => rec && rec.status === 'waiting');
      if (!waiting.length) return [];
      const { items, gone } = await post('inbox', { ids: waiting.map(([, rec]) => rec.id) });
      const done = [];
      const byId = new Map(waiting.map(([cid, rec]) => [rec.id, { cid, rec }]));
      for (const item of items || []) {
        const { cid, rec } = byId.get(item.id) || {};
        if (!rec) continue;
        let opened;
        try { opened = await Seal.open(rec.key, item.answers); } catch (e) { continue; }
        const at = new Date(item.answeredAt || Date.now()).toISOString().slice(0, 10);
        const entries = {};
        for (const a of opened.answers || []) {
          const q = rec.refs[a.ref];
          if (!q) continue;
          const photos = (a.photos || []).filter((p) => p && /^data:image\/(jpeg|png|webp);base64,/.test(p.data)).slice(0, 3);
          if (photos.length) await AttachStore.put(cid, a.ref, photos);
          entries[q.key] = { ref: a.ref, topic: q.topic, question: q.question, answer: String(a.answer || '').slice(0, 5000), receipt: photos.length > 0, photos: photos.length, photoKey: photos.length ? `${cid}|${a.ref}` : undefined, expect: q.amount != null ? { date: q.date || '', payee: q.payee || '', amount: q.amount } : undefined, at, via: 'portal' };
        }
        const record = { ...rec, status: 'received', receivedAt: Date.now(), receivedCount: Object.keys(entries).length };
        if (cid === openId && applyOpen) applyOpen(entries, record);
        else {
          const p = ClientStore.get(cid);
          if (p) ClientStore.put(cid, { ...p, answers: { ...(p.answers || {}), ...entries }, portal: record });
        }
        try { await post('done', { id: rec.id }); } catch (e) { /* removed on expiry anyway */ }
        done.push({ clientId: cid, name: (all[cid] && all[cid].name) || cid, count: Object.keys(entries).length });
      }
      // Links the site no longer has (expired, or cancelled elsewhere).
      for (const id of gone || []) {
        const { cid, rec } = byId.get(id) || {};
        if (!rec) continue;
        const record = { ...rec, status: 'expired' };
        if (cid === openId && applyOpen) applyOpen({}, record);
        else { const p = ClientStore.get(cid); if (p) ClientStore.put(cid, { ...p, portal: record }); }
      }
      return done;
    },
  };

  // The "Answer link" block in the Client questions drawer.
  function PortalBlock({ q, portal, setPortal, canSave, client, greeting, preparer, onCheck }) {
    const [email, setEmail] = useState(() => (portal && portal.email) || '');
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState('');
    const defaultMessage = `${greeting ? `Hi ${greeting},` : 'Hello,'}\n\nWhile reviewing your books we have a few questions. Please answer below; you can add a photo of a receipt where one is needed.\n\nThank you,\n${preparer || Firm.name || ''}`.trim();
    const [message, setMessage] = useState('');
    const text = message || defaultMessage;
    if (!Portal.available()) return html`<div class="portal-block"><h3>${Icon.link}Answer link</h3><p class="hint">Answer links work on the app's own site (${(window.LedgerConfig && (window.LedgerConfig.googleOrigins || [])[0]) || 'the hosted address'}).</p></div>`;
    if (!canSave) return html`<div class="portal-block"><h3>${Icon.link}Answer link</h3><p class="hint">Upload a client's export to send them an answer link; the sample data can't be sent.</p></div>`;
    const active = Portal.active(portal);
    const link = active ? Portal.linkOf(portal) : '';
    const firmName = Firm.name || 'your bookkeeper';
    const mailto = active ? `mailto:${encodeURIComponent(portal.email || email)}?subject=${encodeURIComponent(`Questions about your books from ${firmName}`)}&body=${encodeURIComponent(`${text}\n\nAnswer here (the link is private to you and works until ${shortDate(portal.expiresAt)}):\n${link}`)}` : '';
    const create = async () => {
      setBusy(true); setStatus('Creating the link…');
      try {
        const rec = await Portal.create({ rows: q.rows, client, message: text, email: email.trim(), replaces: active ? portal.id : undefined });
        setPortal(rec);
        setStatus(`Link ready for ${rec.count} question${rec.count === 1 ? '' : 's'}. Press Email to client to send it from your email.`);
      } catch (e) { setStatus(`The link could not be created: ${e.message}.`); }
      setBusy(false);
    };
    const cancel = async () => {
      setBusy(true);
      try { setPortal(await Portal.cancel(portal)); setStatus('Link cancelled; it no longer opens.'); } catch (e) { setStatus(`Could not cancel: ${e.message}.`); }
      setBusy(false);
    };
    const last = portal && !active ? (portal.status === 'received' ? `Last link: ${portal.receivedCount} answer${portal.receivedCount === 1 ? '' : 's'} received ${shortDate(portal.receivedAt)}.` : portal.status === 'cancelled' ? 'Last link was cancelled.' : 'Last link expired without answers.') : '';
    return html`<div class="portal-block">
      <h3>${Icon.link}Answer link ${active ? html`<span class="pill medium"><span class="dot"></span>Waiting for answers</span>` : ''}</h3>
      ${active
        ? html`<p>Sent ${shortDate(portal.createdAt)} for ${portal.count} question${portal.count === 1 ? '' : 's'}; works until ${shortDate(portal.expiresAt)}. Answers appear under <strong>Client answers</strong> on the audit tab as soon as the client sends them.</p>
          <input class="text portal-link" readonly value=${link} aria-label="Answer link" onFocus=${(e) => e.target.select()} />
          <div class="backup-actions">
            <a class="btn primary" href=${mailto}>${Icon.mail}Email to client</a>
            <button class="btn" onClick=${async (e) => { const input = e.currentTarget.closest('.portal-block').querySelector('.portal-link'); const picked = () => { input.select(); return 'Link selected. Press Ctrl+C / Cmd+C to copy.'; }; setStatus(navigator.clipboard && navigator.clipboard.writeText ? await navigator.clipboard.writeText(link).then(() => 'Link copied.', picked) : picked()); }}>${Icon.copy}Copy link</button>
            <button class="btn" disabled=${busy} onClick=${async () => { setBusy(true); setStatus('Checking…'); const n = await onCheck(); setStatus(n ? '' : 'No answers yet.'); setBusy(false); }}>Check for answers</button>
            <button class="btn" disabled=${busy || !q.rows.length} title="Replace it with a link for the questions as they are now" onClick=${create}>New link</button>
            <button class="btn" disabled=${busy} onClick=${cancel}>Cancel link</button>
          </div>`
        : html`<p>Send the client a private link where they answer each question and add receipt photos. Their answers come straight into Ledger Lens. Questions and answers are locked with a key that is only in the link, so the site stores nothing it can read, and they are deleted once collected.${last ? ` ${last}` : ''}</p>
          <div class="drawer-fields portal-fields">
            <label class="field" for="p-email">Client's email<input id="p-email" type="email" value=${email} onInput=${(e) => setEmail(e.target.value)} placeholder="client@example.com" /></label>
            <label class="field" for="p-message" style=${{ gridColumn: '1 / -1' }}>Message<textarea id="p-message" class="text" rows="5" value=${text} onInput=${(e) => setMessage(e.target.value)}></textarea></label>
          </div>
          <div class="backup-actions"><button class="btn primary" disabled=${busy || !q.rows.length} onClick=${create}>${Icon.link}Create answer link</button></div>`}
      <p class="backup-status" role="status">${status}</p>
    </div>`;
  }

  // Receipt photos a client sent with an answer, shown as thumbnails that download on click.
  function AnswerPhotos({ photoKey, count }) {
    const [photos, setPhotos] = useState(null);
    React.useEffect(() => {
      let live = true;
      const [cid, ref] = String(photoKey || '').split('|');
      AttachStore.get(cid, ref).then((p) => { if (live) setPhotos(p); });
      return () => { live = false; };
    }, [photoKey]);
    if (!photos) return html`<span class="sub">${count} photo${count === 1 ? '' : 's'}…</span>`;
    if (!photos.length) return html`<span class="sub">Photos not on this computer</span>`;
    return html`<span class="answer-photos">${photos.map((p, i) => html`<a key=${i} href=${p.data} download=${p.name || `receipt-${i + 1}.jpg`} title="Download"><img src=${p.data} alt=${`Receipt photo ${i + 1}`} /></a>`)}</span>`;
  }

  // What the receipt photos say, read in the browser (OCR) and checked against the transaction
  // the question was about. Read once when the answer is first shown; the result is saved with
  // the answer (`read`), so it isn't read again on every visit or on the other device.
  const READ_ORDER = { match: 0, mismatch: 1, read: 2, unreadable: 3 };
  function ReceiptRead({ answer: a, onRead }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const E = window.LedgerEngine;
    const OCR = UI.OCR;
    const run = async () => {
      const [cid, ref] = String(a.photoKey || '').split('|');
      setBusy(true); setError('');
      try {
        const photos = await AttachStore.get(cid, ref);
        if (!photos.length) { setError('The photo is not on this computer.'); return; }
        let best = null;
        for (const p of photos) {
          const parsed = E.parseReceiptText(await OCR.read(p.data));
          const check = E.checkReceipt(parsed, a.expect);
          const r = { ...parsed, ...check };
          if (!best || READ_ORDER[r.status] < READ_ORDER[best.status]) best = r;
        }
        const { amounts, derived, fuelChecked, ...keep } = best; // eslint-disable-line no-unused-vars
        onRead(a.key, { ...keep, checked: fuelChecked, at: new Date().toISOString().slice(0, 10) });
      } catch (e) { setError(`Could not read the receipt: ${e.message}.`); } finally { setBusy(false); }
    };
    React.useEffect(() => { if (!a.read && a.photoKey && OCR && OCR.available() && onRead) run(); }, [a.key, a.photoKey]);
    if (!a.photoKey) return null;
    if (!OCR || !OCR.available()) return a.read ? html`<${ReadResult} r=${a.read} expect=${a.expect} />` : html`<span class="sub">Receipts are read on the app's web address.</span>`;
    if (busy) return html`<span class="sub receipt-reading" role="status">Reading the receipt…</span>`;
    return html`<span class="receipt-read">
      ${a.read ? html`<${ReadResult} r=${a.read} expect=${a.expect} />` : ''}
      ${error ? html`<span class="sub">${error}</span>` : ''}
      ${onRead && html`<button class="linkish" onClick=${run}>${a.read ? 'Read again' : 'Read the receipt'}</button>`}
    </span>`;
  }
  function ReadResult({ r, expect }) {
    const money = (n) => (n == null ? '' : window.LedgerEngine.fmtMoney(n));
    const pill = r.status === 'match' ? ['good', `Receipt matches ${money(expect && expect.amount)}`]
      : r.status === 'mismatch' ? ['high', `Receipt shows ${money(r.total)}`]
        : r.status === 'unreadable' ? ['low', "Couldn't read the photo"] : ['low', `Receipt total ${money(r.total)}`];
    const bits = [];
    if (r.date) bits.push(r.date);
    if (r.gallons != null) bits.push(`${r.gallons.toFixed(3)} gal${r.pricePerGallon != null ? ` at $${r.pricePerGallon.toFixed(3)}/gal` : ''}`);
    if (r.fuel) bits.push(r.fuel);
    if (r.tax != null) bits.push(`tax ${money(r.tax)}`);
    if (r.card4) bits.push(`card …${r.card4}`);
    return html`<span class="receipt-result">
      <span class=${`pill ${pill[0]}`}><span class="dot"></span>${pill[1]}</span>
      ${bits.length > 0 && html`<span class="sub">${bits.join(' · ')}</span>`}
      ${(r.notes || []).filter((n) => !/^The receipt shows/.test(n)).map((n, i) => html`<span class="sub warn-text" key=${i}>${n}</span>`)}
    </span>`;
  }

  Object.assign(UI, { Portal, PortalBlock, AnswerPhotos, ReceiptRead });
})();
