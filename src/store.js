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
  // 1: clients and meta. 2: adds files (each client's exports, for one-click Open).
  // 3: adds attachments (receipt photos clients send through the portal).
  const DB_VERSION = 3;
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
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
        if (!db.objectStoreNames.contains('attachments')) db.createObjectStore('attachments');
      };
      r.onsuccess = () => {
        clearTimeout(timer);
        const db = r.result;
        // Another tab loading a newer version of the page needs this connection closed. This tab
        // then can no longer save, so it says so.
        db.onversionchange = () => {
          db.close();
          ClientStore.setStatus({ error: 'Ledger Lens was updated in another tab. Reload this page to keep saving' });
        };
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
      FileStore.remove(id);
      AttachStore.removeClient(id);
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

  // Each client's exports as uploaded (the text of each file), so a client can be reopened
  // without finding the files again. Kept only in IndexedDB; a small index of what is saved is
  // kept in memory so the Clients panel can show it right away.
  let fileIndex = {};
  const FileStore = {
    listeners: new Set(),
    available() { return ClientStore.status.where === 'indexeddb' && !!db && !ClientStore.status.error; },
    // The bookkeeper can turn keeping files off in the Clients panel.
    enabled() { return safeStore.get('ll.keepFiles') !== 'off'; },
    setEnabled(on) { safeStore.set('ll.keepFiles', on ? 'on' : 'off'); if (!on) this.clear(); else this.changed(true); },
    // { names, savedAt, bytes } for a client, or null.
    info(id) { return (id && fileIndex[id]) || null; },
    changed(remote) {
      if (!remote && channel) { try { channel.postMessage({ fileIndex }); } catch (e) { /* ignore */ } }
      this.listeners.forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } });
    },
    // files: [{ name, text }]. Resolves true once saved.
    put(id, files) {
      if (!id || !this.available() || !this.enabled() || !files.length) return Promise.resolve(false);
      const info = { names: files.map((f) => f.name), savedAt: new Date().toISOString(), bytes: files.reduce((n, f) => n + f.text.length, 0) };
      // Reopening a client saves the same files again; skip that.
      const had = fileIndex[id];
      if (had && had.bytes === info.bytes && had.names.join('\n') === info.names.join('\n')) return Promise.resolve(true);
      const next = { ...fileIndex, [id]: info };
      try {
        const tx = db.transaction(['files', 'meta'], 'readwrite');
        tx.objectStore('files').put({ files }, id);
        tx.objectStore('meta').put(next, 'fileIndex');
        return done(tx).then(() => { fileIndex = next; this.changed(); ClientStore.estimate(); return true; }, (e) => { ClientStore.setStatus({ error: describe(e) }); return false; });
      } catch (e) { ClientStore.setStatus({ error: describe(e) }); return Promise.resolve(false); }
    },
    // Resolves with [{ name, text }], or null when nothing is saved.
    get(id) {
      if (!id || !db || !fileIndex[id]) return Promise.resolve(null);
      try {
        return req(db.transaction('files', 'readonly').objectStore('files').get(id)).then((r) => (r && r.files) || null, () => null);
      } catch (e) { return Promise.resolve(null); }
    },
    remove(id) {
      if (!id || !db || !fileIndex[id]) return Promise.resolve(false);
      const next = { ...fileIndex };
      delete next[id];
      try {
        const tx = db.transaction(['files', 'meta'], 'readwrite');
        tx.objectStore('files').delete(id);
        tx.objectStore('meta').put(next, 'fileIndex');
        return done(tx).then(() => { fileIndex = next; this.changed(); ClientStore.estimate(); return true; }, () => false);
      } catch (e) { return Promise.resolve(false); }
    },
    clear() {
      if (!db) return Promise.resolve(false);
      try {
        const tx = db.transaction(['files', 'meta'], 'readwrite');
        tx.objectStore('files').clear();
        tx.objectStore('meta').put({}, 'fileIndex');
        return done(tx).then(() => { fileIndex = {}; this.changed(); ClientStore.estimate(); return true; }, () => false);
      } catch (e) { return Promise.resolve(false); }
    },
  };

  // Photos clients attach to their answers in the portal, kept per client and question:
  // key "<client id>|<question ref>", value [{ name, data (a JPEG data URL) }]. Not in backups.
  const AttachStore = {
    put(clientId, ref, photos) {
      if (!db || !clientId || !photos || !photos.length) return Promise.resolve(false);
      try {
        const tx = db.transaction('attachments', 'readwrite');
        tx.objectStore('attachments').put(photos, `${clientId}|${ref}`);
        return done(tx).then(() => { ClientStore.estimate(); return true; }, (e) => { ClientStore.setStatus({ error: describe(e) }); return false; });
      } catch (e) { return Promise.resolve(false); }
    },
    get(clientId, ref) {
      if (!db) return Promise.resolve([]);
      try { return req(db.transaction('attachments', 'readonly').objectStore('attachments').get(`${clientId}|${ref}`)).then((v) => v || [], () => []); } catch (e) { return Promise.resolve([]); }
    },
    remove(clientId, ref) {
      if (!db) return Promise.resolve(false);
      try { const tx = db.transaction('attachments', 'readwrite'); tx.objectStore('attachments').delete(`${clientId}|${ref}`); return done(tx).then(() => true, () => false); } catch (e) { return Promise.resolve(false); }
    },
    removeClient(clientId) {
      if (!db || !clientId) return Promise.resolve(false);
      try {
        const tx = db.transaction('attachments', 'readwrite');
        const range = IDBKeyRange.bound(`${clientId}|`, `${clientId}|\uffff`);
        tx.objectStore('attachments').delete(range);
        return done(tx).then(() => true, () => false);
      } catch (e) { return Promise.resolve(false); }
    },
  };

  function legacyClients() {
    try { return JSON.parse(safeStore.get(LEGACY_KEY) || 'null') || null; } catch (e) { return null; }
  }

  async function loadFromDb() {
    db = await openDb();
    const tx = db.transaction(['clients', 'meta'], 'readonly');
    const [keys, values, schema, index] = await Promise.all([
      req(tx.objectStore('clients').getAllKeys()),
      req(tx.objectStore('clients').getAll()),
      req(tx.objectStore('meta').get('schema')),
      req(tx.objectStore('meta').get('fileIndex')),
    ]);
    fileIndex = index || {};
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
        if (ev.data && ev.data.fileIndex) { fileIndex = ev.data.fileIndex; FileStore.changed(true); return; }
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

  window.LedgerStore = { ClientStore, FileStore, AttachStore, safeStore };
})();
