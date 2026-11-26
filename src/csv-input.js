/* QuickBooks CSV and money cells, shared by browser uploads and the analysis engine. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LedgerCSV = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const norm = (value) => String(value == null ? '' : value).trim();

  function parseCSV(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function parseAmount(v) {
    let s = norm(v);
    if (!s) return null;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    if (/-$/.test(s)) { neg = true; s = s.slice(0, -1); }
    s = s.replace(/[$,\s]/g, '').replace(/^[A-Z]{3}/, '');
    if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
    if (!/^\d*\.?\d+$/.test(s)) return null;
    const n = parseFloat(s);
    return Math.round((neg ? -n : n) * 100) / 100;
  }

  return { parseCSV, parseAmount };
});
