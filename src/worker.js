/* Ledger Lens: the heavy work, off the page's main thread.
 *
 * Reading an export and analyzing a large one can take seconds; done here, the page stays
 * responsive and can show progress. Driven by src/work.js, which falls back to doing the same
 * work on the page where workers are not available.
 *
 * Messages in:  { id, op: 'read', name, text | buffer }   → { text, kind, data }
 *               { id, op: 'data', parsed }                 (keeps the transactions for 'analyze')
 *               { id, op: 'analyze', opts }                → the analysis, without closeBooks
 *               { id, op: 'closeBooks', through }          → the closed-months snapshot
 * Messages out: { id, ok: value } or { id, err: message }
 */
/* global importScripts, LedgerEngine, XLSX */
'use strict';
importScripts('engine.js');
const E = LedgerEngine;

let parsed = null;
let last = null;

// First sheet of a workbook as CSV text, like excelToCsv in src/ui/shared.js.
function excelToCsv(buffer) {
  if (typeof XLSX === 'undefined') importScripts('../vendor/xlsx.full.min.js');
  const wb = XLSX.read(new Uint8Array(buffer), { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error('has no sheets.');
  return XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
}

const ops = {
  read({ text, buffer }) {
    const csv = buffer ? excelToCsv(buffer) : text;
    return { text: csv, ...E.readExport(csv) };
  },
  data(msg) { parsed = msg.parsed; last = null; return true; },
  analyze({ opts }) {
    if (!parsed) throw new Error('no transactions loaded');
    last = E.analyze(parsed, opts);
    const { closeBooks, ...out } = last; // eslint-disable-line no-unused-vars
    // The raw postings behind the profitability figures are only used inside the analysis, and
    // are the largest part of it, so they stay here.
    if (out.profit) out.profit = { ...out.profit, postings: [] };
    return out;
  },
  closeBooks({ through }) {
    if (!last) throw new Error('nothing analyzed yet');
    return last.closeBooks(through);
  },
};

self.onmessage = (ev) => {
  const msg = ev.data || {};
  let reply;
  try { reply = { id: msg.id, ok: ops[msg.op](msg) }; } catch (e) { reply = { id: msg.id, err: (e && e.message) || String(e) }; }
  self.postMessage(reply);
};
