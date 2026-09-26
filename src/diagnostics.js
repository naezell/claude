/* Ledger Lens: keeps a short list of recent errors for "Report a problem".
 *
 * Loaded first, so it also catches a library or script that fails to load. Nothing is sent
 * anywhere: the report is only what the person chooses to email, copy or download. If the page
 * never gets going at all, a plain message with the same report takes its place.
 */
(function () {
  'use strict';
  const MAX = 20;
  const recent = [];
  const trim = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };
  // Shortens a script address to its path on this site, e.g. src/engine.js:120.
  const where = (file, line) => (file ? `${String(file).replace(/^[a-z]+:\/\/[^/]+\//i, '').replace(/^.*\/(src|vendor)\//, '$1/')}${line ? `:${line}` : ''}` : '');

  const Diagnostics = {
    recent,
    note(kind, message, at) {
      recent.push({ time: new Date().toISOString(), kind, message: trim(message, 300), at: at || '' });
      if (recent.length > MAX) recent.shift();
    },
  };

  // The technical details for a report: no client names, figures or file contents.
  function details(extra) {
    const v = window.LedgerVersion || {};
    const store = window.LedgerStore && window.LedgerStore.ClientStore;
    const st = store ? store.status : null;
    const lines = [
      `Version: ${v.commit || 'unknown'}${v.built ? ` (built ${v.built})` : ''}`,
      `Time: ${new Date().toString()}`,
      `Browser: ${navigator.userAgent}`,
      `Window: ${window.innerWidth}×${window.innerHeight}${window.devicePixelRatio ? ` @${window.devicePixelRatio}x` : ''}`,
      `Page: ${location.pathname}`,
    ];
    if (st) lines.push(`Storage: ${st.where}${store.count ? `, ${store.count()} saved client(s)` : ''}${st.usage != null ? `, ${Math.round(st.usage / 1024)} KB used` : ''}${st.persisted ? ', persistent' : ''}${st.error ? `, NOT SAVING: ${st.error}` : ''}${st.fallbackReason ? ` (database: ${st.fallbackReason})` : ''}`);
    for (const [k, val] of Object.entries(extra || {})) if (val) lines.push(`${k}: ${val}`);
    lines.push('', recent.length ? 'Recent errors:' : 'Recent errors: none');
    for (const r of recent.slice(-10)) lines.push(`- ${r.time.slice(11, 19)} ${r.kind}: ${r.message}${r.at ? ` (${r.at})` : ''}`);
    return lines.join('\n');
  }
  // Subject, body and a mailto: link. Email links get cut off past about 2,000 characters, so
  // the body is kept under that; Copy and Download carry the whole thing.
  function draft(description, extra) {
    const to = (window.LedgerConfig || {}).supportEmail || '';
    const subject = 'Ledger Lens problem report';
    const body = `What happened:\n${description || '(please describe)'}\n\n---\n${details(extra)}`;
    let short = body;
    const link = () => `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(short)}`;
    for (let n = body.length; link().length > 1900 && n > 200;) { n = Math.floor(n * 0.9); short = `${body.slice(0, n)}\n…(shortened; use Copy for the full report)`; }
    return { to, subject, body, mailto: to ? link() : '' };
  }
  Diagnostics.details = details;
  Diagnostics.draft = draft;
  window.LedgerProblem = Diagnostics;

  window.addEventListener('error', (e) => {
    const el = e.target;
    // A script, stylesheet or image that failed to load reports on the element, not the window.
    if (el && el !== window && (el.src || el.href)) { Diagnostics.note('did not load', where(el.src || el.href)); return; }
    Diagnostics.note('error', e.message || (e.error && e.error.message) || 'Script error', where(e.filename, e.lineno));
  }, true);
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    Diagnostics.note('error', (r && (r.message || r.name)) || String(r || 'unhandled rejection'));
  });

  // Safety net: if the app has not drawn after 15 seconds, say so in plain HTML with a way to report it.
  setTimeout(() => {
    const root = document.getElementById('root');
    // React replaces the "Loading" placeholder as soon as the app draws.
    if (!root || !root.querySelector('.loading')) return;
    const { subject, body, mailto } = draft('The page did not load.');
    root.innerHTML = '<div style="max-width:560px;margin:15vh auto;padding:24px;font:15px/1.5 system-ui,sans-serif">'
      + '<h1 style="font-size:20px">Ledger Lens did not load</h1>'
      + '<p>Try reloading the page. If it still does not load, send the report below so it can be fixed. Your saved clients are not affected.</p>'
      + '<p><button type="button" id="ll-reload">Reload</button> '
      + (mailto ? '<a id="ll-mail">Email the report</a>' : '') + '</p>'
      + '<pre style="white-space:pre-wrap;font-size:12px;background:#eef1ed;padding:12px;border-radius:8px"></pre></div>';
    root.querySelector('pre').textContent = `${subject}\n\n${body}`;
    document.getElementById('ll-reload').addEventListener('click', () => location.reload());
    const a = document.getElementById('ll-mail');
    if (a) a.href = mailto;
  }, 15000);
})();
