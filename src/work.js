/* Ledger Lens: hands reading and analysis to the background worker (src/worker.js).
 *
 * Where a worker cannot start (a page opened straight from a file, or an old browser) the same
 * work runs on the page instead, so everything still works, only without the progress display.
 * Analysis requests replace each other: while one runs, only the newest waiting request is kept,
 * so clicking through reviews on a large file never queues up stale work.
 */
(function () {
  'use strict';
  const E = window.LedgerEngine;
  const cfg = window.LedgerConfig || {};
  // Exports with at least this many rows are analyzed in the background.
  const BACKGROUND_ROWS = cfg.backgroundRows || 8000;

  let worker = null;
  let broken = typeof Worker === 'undefined' || location.protocol === 'file:';
  let nextId = 1;
  const waiting = new Map();

  function start() {
    if (worker || broken) return worker;
    try {
      worker = new Worker('src/worker.js');
      worker.onmessage = (ev) => {
        const { id, ok, err } = ev.data || {};
        const w = waiting.get(id);
        if (!w) return;
        waiting.delete(id);
        if (err) w.reject(new Error(err)); else w.resolve(ok);
      };
      worker.onerror = (ev) => {
        // The worker itself failed (did not load, or crashed): finish everything on the page.
        if (ev && ev.preventDefault) ev.preventDefault();
        if (window.LedgerProblem) window.LedgerProblem.note('error', `background worker: ${(ev && ev.message) || 'failed'}`);
        broken = true;
        try { worker.terminate(); } catch (e) { /* ignore */ }
        worker = null;
        sentData = null;
        const all = [...waiting.values()];
        waiting.clear();
        all.forEach((w) => w.retry());
      };
    } catch (e) { broken = true; worker = null; }
    return worker;
  }

  // Sends one message; `local` does the same work on the page if the worker is unavailable.
  function call(msg, local) {
    if (!start()) return Promise.resolve().then(local);
    return new Promise((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, { resolve, reject, retry: () => Promise.resolve().then(local).then(resolve, reject) });
      worker.postMessage({ ...msg, id });
    });
  }

  let sentData = null;
  let running = null;
  let queued = null;

  const Work = {
    BACKGROUND_ROWS,
    available() { return !broken; },
    // True when this many rows should be analyzed in the background.
    background(parsed) { return !broken && !!parsed && parsed.transactions.length >= BACKGROUND_ROWS; },

    // Reads one file's text (or an Excel file's bytes): { text, kind, data }.
    read({ text, buffer, excelToCsv }) {
      const local = async () => {
        const csv = buffer ? await excelToCsv(buffer) : text;
        return { text: csv, ...E.readExport(csv) };
      };
      // The bytes are copied, not transferred, so the page can still read them if the worker fails.
      return call(buffer ? { op: 'read', buffer } : { op: 'read', text }, local);
    },

    // Analyzes in the background. Resolves with the result, or with null when a newer request
    // replaced this one before it started.
    analyze(parsed, opts) {
      return new Promise((resolve, reject) => {
        if (queued) queued.resolve(null);
        queued = { parsed, opts, resolve, reject };
        pump();
      });
    },
  };

  function pump() {
    if (running || !queued) return;
    const job = queued;
    queued = null;
    const local = () => E.analyze(job.parsed, job.opts);
    running = (async () => {
      if (sentData !== job.parsed) {
        await call({ op: 'data', parsed: job.parsed }, () => true);
        sentData = job.parsed;
      }
      const out = await call({ op: 'analyze', opts: job.opts }, local);
      // A result made on the page already has closeBooks; one from the worker asks it.
      if (!out.closeBooks) out.closeBooks = (through) => call({ op: 'closeBooks', through }, () => E.analyze(job.parsed, job.opts).closeBooks(through));
      return out;
    })().then(job.resolve, job.reject).finally(() => { running = null; pump(); });
  }

  window.LedgerWork = Work;
})();
