/* Ledger Lens: where saved clients are kept in this browser.
 *
 * Each client's settings and reviews are one record in IndexedDB, which has far more room than
 * localStorage (which stops at about 5 MB and used to fail without a word). A copy is kept in
 * memory so the rest of the app can read synchronously; every change is written straight
 * through, and a failed write is reported through `status` instead of being lost silently.
 *
 * If IndexedDB is not available, localStorage is used; if neither is, clients are kept in memory
 * for this visit only and the status says so. Other open tabs are told about each change.
 */
(function () {
  'use strict';

  const safeStore = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
    remove(k) { try { localStorage.removeItem(k); } catch (e) { /* storage unavailable */ } },
  };

  const DB_NAME = 'ledger-lens';
  const DB_VERSION = 1;
  // Version of the saved client records. Raise it, and add a step to `upgrade`, whenever the
  // shape of a saved client changes in a way older data needs converting for.
  const SCHEMA = 1;
  const LEGACY_KEY = 'll.clients.v1';
  const OPEN_TIMEOUT = 4000;

  // Converts a record saved under an older schema to the current one.
  // Schema 1 is the first, so there is nothing to convert yet. A later step looks like:
  //   if (from < 2) p = { ...p, newField: defaultFor(p) };
  function upgrade(profile, from) { // eslint-disable-line no-unused-vars
    return profile;
  }

  const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  const done = (tx) => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('the save was cancelled'));
  });

  function openDb() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined' || !indexedDB) { reject(new Error('IndexedDB is not available')); return; }
      let settled = false;
      const finish = (fn, v) => { if (!settled) { settled = true; fn(v); } };
      const timer = setTimeout(() => finish(reject, new Error('IndexedDB did not open')), OPEN_TIMEOUT);
      let r;
      try { r = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { clearTimeout(timer); finish(reject, e); return; }
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains('clients')) db.createObjectStore('clients');
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      r.onsuccess = () => {
        clearTimeout(timer);
        const db = r.result;
        // Another tab loading a newer version of the page closes this connection cleanly.
        db.onversionchange = () => db.close();
        if (settled) db.close(); else finish(resolve, db);
      };
      r.onerror = () => { clearTimeout(timer); finish(reject, r.error || new Error('IndexedDB did not open')); };
      r.onblocked = () => { /* waits for other tabs to close their connection; the timeout covers a hang */ };
    });
  }

  // Plain words for what went wrong, for the banner and the problem report.
  function describe(e) {
    const name = e && e.name;
    if (name === 'QuotaExceededError') return 'the browser has run out of space for this site';
    if (name === 'InvalidStateError' || name === 'UnknownError') return 'the browser refused to save (private browsing, or storage is blocked for this site)';
    return (e && e.message) || String(e || 'unknown error');
  }

  const cache = {};
  let db = null;
  let channel = null;

  const ClientStore = {
    key: LEGACY_KEY,
    schema: SCHEMA,
    // Told about every change, so a backup elsewhere (a file, Google Drive) can follow along.
    // Listeners get { remote: true } when the change came from another open tab.
    listeners: new Set(),
    // Told when `status` changes.
    statusListeners: new Set(),
    status: { where: 'loading', error: '', savedAt: null, persisted: null, usage: null, quota: null },
    ready: null,

    changed(info) { this.listeners.forEach((fn) => { try { fn(info || {}); } catch (e) { /* a listener failing must not stop saving */ } }); },
    setStatus(patch) {
      this.status = { ...this.status, ...patch };
      this.statusListeners.forEach((fn) => { try { fn(this.status); } catch (e) { /* ignore */ } });
    },

    all() { return JSON.parse(JSON.stringify(cache)); },
    get(id) { return id && cache[id] ? JSON.parse(JSON.stringify(cache[id])) : null; },
    count() { return Object.keys(cache).length; },
    put(id, profile) {
      if (!id) return;
      cache[id] = { ...profile, updatedAt: new Date().toISOString() };
      this.write({ [id]: cache[id] });
      this.changed();
    },
    remove(id) {
      if (!id || !(id in cache)) return;
      delete cache[id];
      this.write({ [id]: null });
      this.changed();
    },
    // Import keeps whichever copy of each client was updated more recently.
    merge(incoming) {
      const changes = {};
      for (const [id, p] of Object.entries(incoming || {})) {
        if (!p || typeof p !== 'object') continue;
        if (!cache[id] || String(p.updatedAt || '') > String(cache[id].updatedAt || '')) { cache[id] = p; changes[id] = p; }
      }
      const n = Object.keys(changes).length;
      if (n) { this.write(changes); this.changed(); }
      return n;
    },

    // Writes changed records (null = delete) wherever clients are kept.
    write(changes) {
      if (this.status.where === 'indexeddb' && db) {
        let tx;
        try {
          tx = db.transaction('clients', 'readwrite');
          const st = tx.objectStore('clients');
          for (const [id, p] of Object.entries(changes)) { if (p) st.put(p, id); else st.delete(id); }
        } catch (e) { this.setStatus({ error: describe(e) }); return Promise.resolve(false); }
        return done(tx).then(() => {
          this.setStatus({ error: '', savedAt: new Date().toISOString() });
          if (channel) { try { channel.postMessage({ ids: Object.keys(changes) }); } catch (e) { /* ignore */ } }
          this.askToKeep();
          return true;
        }, (e) => { this.setStatus({ error: describe(e) }); return false; });
      }
      if (this.status.where === 'localstorage') {
        let ok = false;
        try { localStorage.setItem(LEGACY_KEY, JSON.stringify(cache)); ok = true; } catch (e) { this.setStatus({ error: describe(e) }); }
        if (ok) this.setStatus({ error: '', savedAt: new Date().toISOString() });
        return Promise.resolve(ok);
      }
      if (this.status.where === 'memory' && Object.keys(changes).length) {
        this.setStatus({ error: 'this browser is not letting the site save anything, so clients are kept only until the page is closed' });
      }
      return Promise.resolve(false);
    },

    // Once there is something worth keeping, asks the browser not to clear it when space runs
    // low. Chrome and Edge decide on their own; Firefox may ask once.
    askToKeep() {
      if (this.status.persisted !== null || !this.count()) return;
      this.status.persisted = false;
      const s = typeof navigator !== 'undefined' && navigator.storage;
      if (!s || !s.persist) return;
      Promise.resolve(s.persisted ? s.persisted() : false)
        .then((already) => already || s.persist())
        .then((granted) => this.setStatus({ persisted: !!granted }))
        .catch(() => { /* not supported */ });
      this.estimate();
    },
    estimate() {
      const s = typeof navigator !== 'undefined' && navigator.storage;
      if (!s || !s.estimate) return Promise.resolve(null);
      return s.estimate().then((est) => { this.setStatus({ usage: est.usage || 0, quota: est.quota || 0 }); return est; }).catch(() => null);
    },
    // More than 80% of the space the browser allows this site is in use.
    nearlyFull() { const { usage, quota } = this.status; return !!(quota && usage / quota > 0.8); },
  };

  function legacyClients() {
    try { return JSON.parse(safeStore.get(LEGACY_KEY) || 'null') || null; } catch (e) { return null; }
  }

  async function loadFromDb() {
    db = await openDb();
    const tx = db.transaction(['clients', 'meta'], 'readonly');
    const [keys, values, schema] = await Promise.all([
      req(tx.objectStore('clients').getAllKeys()),
      req(tx.objectStore('clients').getAll()),
      req(tx.objectStore('meta').get('schema')),
    ]);
    const from = typeof schema === 'number' ? schema : SCHEMA;
    keys.forEach((k, i) => { cache[k] = upgrade(values[i], from); });
    ClientStore.status.where = 'indexeddb';
    // Bring over clients saved by earlier versions of the page in localStorage (newer copy wins),
    // store the upgraded records, then free the old space once they are safely written.
    const legacy = legacyClients();
    const changes = {};
    if (legacy) {
      for (const [id, p] of Object.entries(legacy)) {
        if (p && typeof p === 'object' && (!cache[id] || String(p.updatedAt || '') > String(cache[id].updatedAt || ''))) { cache[id] = p; changes[id] = p; }
      }
    }
    if (from !== SCHEMA) Object.assign(changes, cache);
    if (Object.keys(changes).length || schema !== SCHEMA) {
      const wtx = db.transaction(['clients', 'meta'], 'readwrite');
      for (const [id, p] of Object.entries(changes)) wtx.objectStore('clients').put(p, id);
      wtx.objectStore('meta').put(SCHEMA, 'schema');
      await done(wtx);
    }
    if (legacy) safeStore.remove(LEGACY_KEY);
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel('ledger-lens-clients');
      channel.onmessage = (ev) => {
        const ids = (ev.data && ev.data.ids) || [];
        if (!ids.length || !db) return;
        const rtx = db.transaction('clients', 'readonly');
        const st = rtx.objectStore('clients');
        Promise.all(ids.map((id) => req(st.get(id)).then((p) => { if (p) cache[id] = p; else delete cache[id]; })))
          .then(() => ClientStore.changed({ remote: true }), () => { /* ignore */ });
      };
    }
  }

  ClientStore.ready = loadFromDb().catch((e) => {
    db = null;
    // IndexedDB is unavailable: fall back to localStorage, or memory if that is blocked too.
    const legacy = legacyClients();
    if (legacy) Object.assign(cache, legacy);
    const probe = safeStore.set('ll.probe', '1');
    safeStore.remove('ll.probe');
    ClientStore.status.where = probe ? 'localstorage' : 'memory';
    ClientStore.status.fallbackReason = describe(e);
    if (!probe) ClientStore.status.error = 'this browser is not letting the site save anything, so clients are kept only until the page is closed';
  }).then(() => {
    ClientStore.setStatus({});
    if (ClientStore.count()) ClientStore.askToKeep(); else ClientStore.estimate();
  });

  window.LedgerStore = { ClientStore, safeStore };
})();
