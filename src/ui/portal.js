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
      const questions = rows.map((r) => ({ ref: r.ref, topic: r.section, question: r.question, receipt: !!r.coding || /receipt/i.test(r.section) || !!r.docs, coding: r.coding, docs: !!r.docs }));
      const firm = { name: Firm.name || '', website: Firm.website || '', logo: Firm.logo ? 'assets/7d-logo.png' : '' };
      const box = await Seal.seal(key, { client, message, questions, firm });
      const res = await post('create', { id, box, expiresAt: Date.now() + DAYS * 864e5, replaces: replaces || undefined });
      const refs = {};
      // The transaction each question is about, so a receipt photo can be checked against it.
      for (const r of rows) refs[r.ref] = { key: r.key, topic: r.section, question: r.question, date: r.date || '', payee: r.payee || '', amount: r.amount, docs: !!r.docs };
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
          const photos = (a.photos || []).filter((p) => p && /^data:(image\/(jpeg|png|webp)|application\/pdf);base64,/.test(p.data)).slice(0, 3);
          if (photos.length) await AttachStore.put(cid, a.ref, photos);
          const category = String(a.category || '').trim().slice(0, 100);
          const job = String(a.job || '').trim().slice(0, 100);
          const notes = String(a.answer || '').slice(0, 4600);
          const answer = [category && `Category: ${category}`, job && `Job: ${job}`, notes].filter(Boolean).join(' · ');
          entries[q.key] = { ref: a.ref, topic: q.topic, question: q.question, answer, category: category || undefined, job: job || undefined, receipt: photos.length > 0, photos: photos.length, photoKey: photos.length ? `${cid}|${a.ref}` : undefined, docs: q.docs || undefined, expect: q.amount != null ? { date: q.date || '', payee: q.payee || '', amount: q.amount } : undefined, at, via: 'portal' };
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
  // Tax documents a client can be asked for with the answer link, by who they apply to.
  const TAX_DOCS = [
    ['w2', 'owner', 'Form W-2 from each employer'],
    ['1099', 'owner', '1099 forms you received (1099-NEC, 1099-K, 1099-INT, 1099-DIV, 1099-B, 1099-R)'],
    ['ssa', 'owner', 'Social Security statement (SSA-1099)'],
    ['1098', 'owner', 'Mortgage interest statement (Form 1098) and property tax bills'],
    ['edu', 'owner', 'Tuition (1098-T) or student loan interest (1098-E) statements'],
    ['1095', 'owner', 'Marketplace health insurance statement (Form 1095-A)'],
    ['hsa', 'owner', 'HSA statements (1099-SA, 5498-SA)'],
    ['charity', 'owner', 'Receipts for charitable donations'],
    ['childcare', 'owner', 'Childcare provider name, address, tax ID and amount paid'],
    ['estimates', 'both', 'Estimated tax payments you made (dates and amounts)'],
    ['k1', 'both', 'Schedule K-1s from partnerships, S corporations or trusts'],
    ['notices', 'both', 'Any letters or notices from the IRS or the state'],
    ['priorreturn', 'both', "Last year's tax return (if we didn't prepare it)"],
    ['statements', 'business', 'December bank, credit card and loan statements'],
    ['assets', 'business', 'Invoices for equipment or vehicles bought or sold this year'],
    ['mileage', 'business', 'Vehicle mileage log (business and total miles)'],
    ['homeoffice', 'business', 'Home office: square feet used for business and total home square feet'],
    ['payroll', 'business', 'Year-end payroll reports (W-3, Forms 940 and 941)'],
    ['inventory', 'business', 'Inventory count and value at year end'],
  ];
  function taxDocRows(selected, year) {
    return TAX_DOCS.filter(([id]) => selected[id]).map(([id, , text], i) => ({ key: `taxdoc|${year}|${id}`, ref: `T${i + 1}`, section: 'Tax documents', question: `${text} for ${year}. Add a photo or PDF, or tell us if it doesn't apply.`, docs: true }));
  }
  function defaultTaxDocs(entity) {
    const sole = !entity || entity === 'C';
    return Object.fromEntries(TAX_DOCS.filter(([, who]) => who === 'business' || who === 'both' || sole).map(([id]) => [id, ['w2', 'ssa', 'edu', 'hsa', 'childcare', 'inventory', 'payroll'].indexOf(id) === -1]));
  }

  function PortalBlock({ q, portal, setPortal, canSave, client, greeting, preparer, onCheck, taxYear, taxForm }) {
    const [email, setEmail] = useState(() => (portal && portal.email) || '');
    const [askDocs, setAskDocs] = useState(false);
    const [docs, setDocs] = useState(() => defaultTaxDocs(taxForm));
    const year = taxYear || new Date().getFullYear() - 1;
    const docRows = askDocs ? taxDocRows(docs, year) : [];
    const rows = [...q.rows, ...docRows];
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState('');
    const defaultMessage = `${greeting ? `Hi ${greeting},` : 'Hello,'}\n\nWhile reviewing your books we have a few questions. Please answer below; you can add a photo of a receipt where one is needed.\n\nThank you,\n${preparer || Firm.name || ''}`.trim();
    const [message, setMessage] = useState('');
    const text = message || defaultMessage;
    if (!Portal.available()) return html`<div class="portal-block"><h3>${Icon.link}Answer link</h3><p class="hint">Answer links work on the app's own site (${(window.LedgerConfig && (window.LedgerConfig.googleOrigins || [])[0]) || 'the hosted address'}).</p></div>`;
    if (!canSave) return html`<div class="portal-block"><h3>${Icon.link}Answer link</h3><p class="hint">Upload a client's export to send them an answer link; the sample data can't be sent.</p></div>`;
    const active = Portal.active(portal);
    const sms = active ? `sms:${/iPhone|iPad|iPod/.test(navigator.userAgent) ? '&' : '?'}body=${encodeURIComponent(`Please review these questions about your books: ${Portal.linkOf(portal)}`)}` : '';
    const link = active ? Portal.linkOf(portal) : '';
    const firmName = Firm.name || 'your bookkeeper';
    const mailto = active ? `mailto:${encodeURIComponent(portal.email || email)}?subject=${encodeURIComponent(`Questions about your books from ${firmName}`)}&body=${encodeURIComponent(`${text}\n\nAnswer here (the link is private to you and works until ${shortDate(portal.expiresAt)}):\n${link}`)}` : '';
    const create = async () => {
      setBusy(true); setStatus('Creating the link…');
      try {
        const rec = await Portal.create({ rows, client, message: text, email: email.trim(), replaces: active ? portal.id : undefined });
        setPortal(rec);
        setStatus(`Link ready for ${rec.count} question${rec.count === 1 ? '' : 's'}. Use Email to client, Text link, or Copy link to share it.`);
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
            <a class="btn" href=${sms}>Text link</a>
            <button class="btn" onClick=${async (e) => { const input = e.currentTarget.closest('.portal-block').querySelector('.portal-link'); const picked = () => { input.select(); return 'Link selected. Press Ctrl+C / Cmd+C to copy.'; }; setStatus(navigator.clipboard && navigator.clipboard.writeText ? await navigator.clipboard.writeText(link).then(() => 'Link copied.', picked) : picked()); }}>${Icon.copy}Copy link</button>
            <button class="btn" disabled=${busy} onClick=${async () => { setBusy(true); setStatus('Checking…'); const n = await onCheck(); setStatus(n ? '' : 'No answers yet.'); setBusy(false); }}>Check for answers</button>
            <button class="btn" disabled=${busy || !rows.length} title="Replace it with a link for the questions as they are now" onClick=${create}>New link</button>
            <button class="btn" disabled=${busy} onClick=${cancel}>Cancel link</button>
          </div>`
        : html`<p>Send the client a private link where they answer each question and add receipt photos. Their answers come straight into Ledger Lens. Questions and answers are locked with a key that is only in the link, so the site stores nothing it can read, and they are deleted once collected.${last ? ` ${last}` : ''}</p>
          <div class="drawer-fields portal-fields">
            <label class="field" for="p-email">Client's email<input id="p-email" type="email" value=${email} onInput=${(e) => setEmail(e.target.value)} placeholder="client@example.com" /></label>
            <label class="field" for="p-message" style=${{ gridColumn: '1 / -1' }}>Message<textarea id="p-message" class="text" rows="5" value=${text} onInput=${(e) => setMessage(e.target.value)}></textarea></label>
          </div>
          <div class="tax-docs">
            <label class="check" for="p-taxdocs"><input id="p-taxdocs" type="checkbox" checked=${askDocs} onChange=${(e) => setAskDocs(e.target.checked)} />Also ask for tax documents for ${year}</label>
            ${askDocs && html`<div class="tax-doc-list">${TAX_DOCS.map(([id, who, text]) => html`<label class="check" key=${id} for=${`td-${id}`}><input id=${`td-${id}`} type="checkbox" checked=${!!docs[id]} onChange=${(e) => setDocs({ ...docs, [id]: e.target.checked })} />${text}${who === 'owner' ? html` <span class="sub">(personal return)</span>` : ''}</label>`)}</div>
              <p class="hint">Clients can add a photo or a PDF for each one. They arrive under Client answers with the other answers.</p>`}
          </div>
          <div class="backup-actions"><button class="btn primary" disabled=${busy || !rows.length} onClick=${create}>${Icon.link}Create answer link${docRows.length ? ` (${rows.length} items)` : ''}</button></div>`}
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
    return html`<span class="answer-photos">${photos.map((p, i) => (/^data:application\/pdf/.test(p.data)
      ? html`<a key=${i} class="answer-pdf" href=${p.data} download=${p.name || `document-${i + 1}.pdf`} title="Download">PDF · ${p.name || `document ${i + 1}`}</a>`
      : html`<a key=${i} href=${p.data} download=${p.name || `receipt-${i + 1}.jpg`} title="Download"><img src=${p.data} alt=${`Receipt photo ${i + 1}`} /></a>`))}</span>`;
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
        const photos = (await AttachStore.get(cid, ref)).filter((p) => /^data:image\//.test(p.data));
        if (!photos.length) { setError('There is no photo to read on this computer.'); return; }
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
    if (!a.photoKey || a.docs) return null;
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
