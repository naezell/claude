/* Ledger Lens UI: reading receipt photos in the browser (OCR with Tesseract, from vendor/).
 * The photo never leaves the computer. The library (about 15 MB) loads the first time a
 * receipt is read, then stays cached by the browser. What the text means (total, date,
 * gallons...) is worked out by parseReceiptText() in the engine. */
(function () {
  'use strict';
  const UI = window.LedgerUI;
  const base = () => new URL('vendor/tesseract/', window.location.href).href;

  const OCR = {
    // Workers can't start from a file:// page, so reading needs the app's web address.
    available() { return typeof Worker !== 'undefined' && /^https?:$/.test(window.location.protocol); },
    lib: null,
    load() {
      if (window.Tesseract) return Promise.resolve(window.Tesseract);
      if (!this.lib) {
        this.lib = new Promise((resolve, reject) => {
          const el = document.createElement('script');
          el.src = 'vendor/tesseract/tesseract.min.js';
          el.onload = () => (window.Tesseract ? resolve(window.Tesseract) : reject(new Error('the receipt reader did not start')));
          el.onerror = () => reject(new Error('the receipt reader could not load'));
          document.head.appendChild(el);
        }).catch((e) => { this.lib = null; throw e; });
      }
      return this.lib;
    },
    worker: null,
    async start() {
      if (!this.worker) {
        this.worker = this.load().then((T) => T.createWorker('eng', 1, {
          // Paths inside the worker resolve against the worker's own address, so they are absolute.
          workerPath: `${base()}worker.min.js`,
          corePath: `${base()}core`,
          langPath: `${base()}lang`,
          workerBlobURL: false,
          gzip: true,
        })).catch((e) => { this.worker = null; throw e; });
      }
      return this.worker;
    },
    // One photo at a time: reading is heavy, and a phone shouldn't run several at once.
    queue: Promise.resolve(),
    read(image) {
      const job = this.queue.then(async () => {
        const w = await this.start();
        const { data } = await w.recognize(image);
        return data.text || '';
      });
      this.queue = job.catch(() => {});
      return job;
    },
  };

  Object.assign(UI, { OCR });
})();
