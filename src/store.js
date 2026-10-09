/* Ledger Lens: where saved clients are kept in this browser.
 *
 * Each client's settings and reviews are one record in IndexedDB, which has far more room than
 * localStorage (which stops at about 5 MB and used to fail without a word). A copy is kept in
 * memory so the rest of the app can read synchronously; every change is written straight
 * through, and a failed write is reported through `status` instead of being lost silently.
 *
 * If IndexedDB is not available, localStorage is used; if neither is, clients are kept in memory
 * for this visit only and the status says so. Other open tabs are told about each change.
 *
 * Everything is encrypted with the Ledger Lens passphrase (src/lock.js) before it is written:
 * each record's value is sealed, and records are named by an HMAC of the client id ("h:…")
 * instead of the id itself, which is made from the company name. Nothing loads until the page is
 * unlocked. Data saved before encryption is converted, and the readable copy deleted, the first
 * time the page is unlocked. Writes are queued so they reach the database in order.
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
  // Basic-storage fallback (no IndexedDB): one sealed copy of everything.
  const SEALED_KEY = 'll.clients.sealed';
  const Lock = window.LedgerLock;
  const isSealed = (v) => window.LedgerVault.isSealed(v);
  const sealJson = (v) => Lock.seal(JSON.stringify(v));
  const openJson = async (v) => JSON.parse(await Lock.open(v));
  // Record names for client ids under the current key, kept so each is worked out once.
  let names = new Map();
  const nameOf = async (id) => { if (!names.has(id)) names.set(id, await Lock.hid(id)); return names.get(id); };
  // One write at a time, in order (sealing is asynchronous, a transaction must not wait on it).
  let queue = Promise.resolve();
  const enqueue = (fn) => { const run = queue.then(fn, fn); queue = run.catch(() => {}); return run; };
  const OPEN_TIMEOUT = 4000;

  // Converts a record saved under an older schema to the current one.
  // Schema 1 is the first, so there is nothing to convert yet. A later step looks like:
  //   if (from < 2) p = { ...p, newField: defaultFor(p) };
  function upgrade(profile, from) { // eslint-disable-line no-unused-vars
    return profile;
  }

  // Two saved profiles hold the same things (the save time aside).
  const same = (a, b) => {
    const strip = (p) => { const { updatedAt, ...rest } = p || {}; return JSON.stringify(rest); }; // eslint-disable-line no-unused-vars
    return strip(a) === strip(b);
  };

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
      // Saving what is already saved changes nothing. Without this, a client reloaded after a
      // sync would be saved again as "newer" and bounce between devices.
      if (cache[id] && same(cache[id], profile)) return;
      cache[id] = { ...profile, updatedAt: new Date().toISOString() };
      this.forgetRemoval(id);
      this.write({ [id]: cache[id] });
      this.changed({ ids: [id] });
    },
    remove(id) {
      if (!id || !(id in cache)) return;
      delete cache[id];
      this.markRemoved(id, new Date().toISOString());
      this.write({ [id]: null });
      FileStore.remove(id);
      AttachStore.removeClient(id);
      this.changed({ ids: [id] });
    },
    // Clients forgotten on purpose, { id: when }, so syncing doesn't bring them back from
    // another device. Kept for a year.
    removed() {
      const r = { ...removedList };
      const cutoff = new Date(Date.now() - 365 * 864e5).toISOString();
      for (const [id, at] of Object.entries(r)) if (String(at) < cutoff) delete r[id];
      return r;
    },
    markRemoved(id, at) { const r = this.removed(); if (!r[id] || r[id] < at) { r[id] = at; removedList = r; saveMeta('removed', r); } },
    forgetRemoval(id) { const r = this.removed(); if (r[id]) { delete r[id]; removedList = r; saveMeta('removed', r); } },
    // Import keeps whichever copy of each client was updated more recently. With `removed`
    // (from a sync), clients forgotten on the other device after their last change go here too.
    merge(incoming, removed, info) {
      const changes = {};
      const gone = { ...this.removed() };
      for (const [id, at] of Object.entries(removed || {})) {
        if (typeof at !== 'string') continue;
        if (!gone[id] || gone[id] < at) { gone[id] = at; this.markRemoved(id, at); }
        if (cache[id] && String(cache[id].updatedAt || '') <= at) { delete cache[id]; changes[id] = null; FileStore.remove(id); AttachStore.removeClient(id); }
      }
      for (const [id, p] of Object.entries(incoming || {})) {
        if (!p || typeof p !== 'object') continue;
        if (removed && gone[id] && String(p.updatedAt || '') <= gone[id]) continue;
        if (!cache[id] || String(p.updatedAt || '') > String(cache[id].updatedAt || '')) { cache[id] = p; changes[id] = p; if (gone[id]) this.forgetRemoval(id); }
      }
      const n = Object.keys(changes).length;
      if (n) { this.write(changes); this.changed({ ...(info || {}), ids: Object.keys(changes) }); }
      return n;
    },

    // Writes changed records (null = delete) wherever clients are kept.
    write(changes) {
      if (this.status.where === 'indexeddb' && db) {
        return enqueue(async () => {
          const rows = [];
          for (const [id, p] of Object.entries(changes)) rows.push([await nameOf(id), p ? await sealJson({ id, profile: p }) : null]);
          let tx;
          try {
            tx = db.transaction('clients', 'readwrite');
            const st = tx.objectStore('clients');
            for (const [name, sealed] of rows) { if (sealed) st.put(sealed, name); else st.delete(name); }
          } catch (e) { this.setStatus({ error: describe(e) }); return false; }
          return done(tx).then(() => {
            this.setStatus({ error: '', savedAt: new Date().toISOString() });
            if (channel) { try { channel.postMessage({ ids: Object.keys(changes) }); } catch (e) { /* ignore */ } }
            this.askToKeep();
            return true;
          }, (e) => { this.setStatus({ error: describe(e) }); return false; });
        });
      }
      if (this.status.where === 'localstorage') return saveBasic();
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
      return putFiles(id, files, info);
    },
    index() { return { ...fileIndex }; },
    // Files that came from another device: kept with that device's save time, so the two
    // agree on which copy is newer.
    putSynced(id, files, savedAt) {
      if (!id || !this.available() || !this.enabled() || !files || !files.length) return Promise.resolve(false);
      return putFiles(id, files, { names: files.map((f) => f.name), savedAt, bytes: files.reduce((n, f) => n + f.text.length, 0) });
    },
    // Resolves with [{ name, text }], or null when nothing is saved.
    get(id) {
      if (!id || !db || !fileIndex[id]) return Promise.resolve(null);
      return enqueue(async () => {
        const name = await nameOf(id);
        const r = await req(db.transaction('files', 'readonly').objectStore('files').get(name));
        return r ? ((await openJson(r)).files || null) : null;
      }).catch(() => null);
    },
    remove(id) {
      if (!id || !db || !fileIndex[id]) return Promise.resolve(false);
      const next = { ...fileIndex };
      delete next[id];
      return enqueue(async () => {
        const name = await nameOf(id);
        const index = await sealJson(next);
        const tx = db.transaction(['files', 'meta'], 'readwrite');
        tx.objectStore('files').delete(name);
        tx.objectStore('meta').put(index, 'fileIndex');
        await done(tx);
        fileIndex = next; this.changed(); ClientStore.estimate();
        return true;
      }).catch(() => false);
    },
    clear() {
      if (!db) return Promise.resolve(false);
      return enqueue(async () => {
        const index = await sealJson({});
        const tx = db.transaction(['files', 'meta'], 'readwrite');
        tx.objectStore('files').clear();
        tx.objectStore('meta').put(index, 'fileIndex');
        await done(tx);
        fileIndex = {}; this.changed(); ClientStore.estimate();
        return true;
      }).catch(() => false);
    },
  };

  // Saves one client's files and the updated index, both sealed.
  function putFiles(id, files, info) {
    return enqueue(async () => {
      const next = { ...fileIndex, [id]: info };
      const name = await nameOf(id);
      const [body, index] = [await sealJson({ files }), await sealJson(next)];
      const tx = db.transaction(['files', 'meta'], 'readwrite');
      tx.objectStore('files').put(body, name);
      tx.objectStore('meta').put(index, 'fileIndex');
      await done(tx);
      fileIndex = next; FileStore.changed(); ClientStore.estimate();
      return true;
    }).catch((e) => { ClientStore.setStatus({ error: describe(e) }); return false; });
  }

  // Small lists that name clients (forgotten clients, photo times), kept sealed in `meta`.
  let removedList = {};
  let stampList = {};
  function saveMeta(key, value) {
    if (ClientStore.status.where === 'localstorage') return saveBasic();
    if (!db) return Promise.resolve(false);
    return enqueue(async () => {
      const sealed = await sealJson(value);
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put(sealed, key);
      await done(tx);
      return true;
    }).catch(() => false);
  }
  // Without IndexedDB: one sealed copy of the clients and the two lists in localStorage.
  function saveBasic() {
    return enqueue(async () => {
      const sealed = await sealJson({ clients: cache, removed: removedList, stamps: stampList });
      try { localStorage.setItem(SEALED_KEY, sealed); } catch (e) { ClientStore.setStatus({ error: describe(e) }); return false; }
      ClientStore.setStatus({ error: '', savedAt: new Date().toISOString() });
      return true;
    });
  }

  // Photos clients attach to their answers in the portal, kept per client and question:
  // key "<client id>|<question ref>", value [{ name, data (a JPEG data URL) }]. Not in backup
  // files, but synced to Google Drive with the client's exports.
  const AttachStore = {
    // When each client's photos last changed, { id: when }, so a sync knows which copy is newer.
    stamps() { return { ...stampList }; },
    stamp(clientId, at) { const s = this.stamps(); if (at) s[clientId] = at; else delete s[clientId]; stampList = s; saveMeta('attachStamp', s); },
    put(clientId, ref, photos) {
      if (!db || !clientId || !photos || !photos.length) return Promise.resolve(false);
      return enqueue(async () => {
        const name = await nameOf(clientId);
        const sealed = await sealJson(photos);
        const tx = db.transaction('attachments', 'readwrite');
        tx.objectStore('attachments').put(sealed, `${name}|${ref}`);
        await done(tx);
        return true;
      }).then(() => { this.stamp(clientId, new Date().toISOString()); ClientStore.estimate(); return true; }, (e) => { ClientStore.setStatus({ error: describe(e) }); return false; });
    },
    // Every photo for one client, { ref: photos }.
    forClient(clientId) {
      if (!db || !clientId) return Promise.resolve({});
      return enqueue(async () => {
        const name = await nameOf(clientId);
        const st = db.transaction('attachments', 'readonly').objectStore('attachments');
        const range = IDBKeyRange.bound(`${name}|`, `${name}|\uffff`);
        const [keys, values] = await Promise.all([req(st.getAllKeys(range)), req(st.getAll(range))]);
        const out = {};
        for (let i = 0; i < keys.length; i++) out[String(keys[i]).slice(name.length + 1)] = await openJson(values[i]);
        return out;
      }).catch(() => ({}));
    },
    // Photos that came from another device, replacing this client's.
    putClient(clientId, photos, at) {
      if (!db || !clientId) return Promise.resolve(false);
      return enqueue(async () => {
        const name = await nameOf(clientId);
        const rows = [];
        for (const [ref, list] of Object.entries(photos || {})) if (Array.isArray(list) && list.length) rows.push([`${name}|${ref}`, await sealJson(list)]);
        const tx = db.transaction('attachments', 'readwrite');
        const st = tx.objectStore('attachments');
        st.delete(IDBKeyRange.bound(`${name}|`, `${name}|\uffff`));
        for (const [k, v] of rows) st.put(v, k);
        await done(tx);
        return true;
      }).then(() => { this.stamp(clientId, at); return true; }, () => false);
    },
    get(clientId, ref) {
      if (!db) return Promise.resolve([]);
      return enqueue(async () => {
        const name = await nameOf(clientId);
        const v = await req(db.transaction('attachments', 'readonly').objectStore('attachments').get(`${name}|${ref}`));
        return v ? openJson(v) : [];
      }).catch(() => []);
    },
    remove(clientId, ref) {
      if (!db) return Promise.resolve(false);
      return enqueue(async () => {
        const name = await nameOf(clientId);
        const tx = db.transaction('attachments', 'readwrite');
        tx.objectStore('attachments').delete(`${name}|${ref}`);
        await done(tx);
        return true;
      }).then(() => { this.stamp(clientId, new Date().toISOString()); return true; }, () => false);
    },
    removeClient(clientId) {
      if (!db || !clientId) return Promise.resolve(false);
      return enqueue(async () => {
        const name = await nameOf(clientId);
        const tx = db.transaction('attachments', 'readwrite');
        tx.objectStore('attachments').delete(IDBKeyRange.bound(`${name}|`, `${name}|\uffff`));
        await done(tx);
        return true;
      }).then(() => { this.stamp(clientId, null); return true; }, () => false);
    },
  };

  function legacyClients() {
    try { return JSON.parse(safeStore.get(LEGACY_KEY) || 'null') || null; } catch (e) { return null; }
  }

  async function loadFromDb() {
    // Nothing is opened before the passphrase is typed.
    await Lock.ready;
    db = await openDb();
    const tx = db.transaction(['clients', 'meta'], 'readonly');
    const [keys, values, schema, index, removedRec, stampRec] = await Promise.all([
      req(tx.objectStore('clients').getAllKeys()),
      req(tx.objectStore('clients').getAll()),
      req(tx.objectStore('meta').get('schema')),
      req(tx.objectStore('meta').get('fileIndex')),
      req(tx.objectStore('meta').get('removed')),
      req(tx.objectStore('meta').get('attachStamp')),
    ]);
    const from = typeof schema === 'number' ? schema : SCHEMA;
    // Records from before encryption: named by the client id, readable. Converted below.
    const plainKeys = [];
    for (let i = 0; i < keys.length; i++) {
      const v = values[i];
      if (isSealed(v)) {
        const { id, profile } = await openJson(v);
        cache[id] = upgrade(profile, from);
        names.set(id, String(keys[i]));
      } else if (v && typeof v === 'object') {
        cache[keys[i]] = upgrade(v, from);
        plainKeys.push(keys[i]);
      }
    }
    const plainIndex = index && !isSealed(index);
    fileIndex = !index ? {} : plainIndex ? index : await openJson(index);
    removedList = isSealed(removedRec) ? await openJson(removedRec) : legacyList('ll.removed');
    stampList = isSealed(stampRec) ? await openJson(stampRec) : legacyList('ll.attachStamp');
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
    for (const k of plainKeys) changes[k] = cache[k];
    if (from !== SCHEMA) Object.assign(changes, cache);
    if (Object.keys(changes).length) await ClientStore.write(changes);
    if (plainKeys.length) {
      const dtx = db.transaction('clients', 'readwrite');
      for (const k of plainKeys) dtx.objectStore('clients').delete(k);
      await done(dtx);
    }
    if (schema !== SCHEMA) { const stx = db.transaction('meta', 'readwrite'); stx.objectStore('meta').put(SCHEMA, 'schema'); await done(stx); }
    if (plainIndex || !index) await saveMeta('fileIndex', fileIndex);
    if (!isSealed(removedRec)) { await saveMeta('removed', removedList); safeStore.remove('ll.removed'); }
    if (!isSealed(stampRec)) { await saveMeta('attachStamp', stampList); safeStore.remove('ll.attachStamp'); }
    await sealPlainFiles();
    if (legacy) safeStore.remove(LEGACY_KEY);
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel('ledger-lens-clients');
      channel.onmessage = (ev) => {
        if (ev.data && ev.data.fileIndex) { fileIndex = ev.data.fileIndex; FileStore.changed(true); return; }
        const ids = (ev.data && ev.data.ids) || [];
        if (!ids.length || !db) return;
        enqueue(async () => {
          for (const id of ids) {
            const v = await req(db.transaction('clients', 'readonly').objectStore('clients').get(await nameOf(id)));
            if (v) cache[id] = (await openJson(v)).profile; else delete cache[id];
          }
        }).then(() => ClientStore.changed({ remote: true }), () => { /* ignore */ });
      };
    }
  }

  function legacyList(key) {
    try { return JSON.parse(safeStore.get(key) || '{}') || {}; } catch (e) { return {}; }
  }

  // Exports and photos saved before encryption: sealed under the opaque names, one at a time
  // (they can be large), and the readable copies deleted.
  async function sealPlainFiles() {
    const plain = (store) => new Promise((resolve, reject) => {
      const out = [];
      const r = db.transaction(store, 'readonly').objectStore(store).openCursor();
      r.onsuccess = () => { const c = r.result; if (!c) { resolve(out); return; } if (!isSealed(c.value)) out.push(c.key); c.continue(); };
      r.onerror = () => reject(r.error);
    });
    for (const k of await plain('files')) {
      const v = await req(db.transaction('files', 'readonly').objectStore('files').get(k));
      const name = await nameOf(String(k));
      const sealed = await sealJson(v && v.files ? { files: v.files } : { files: [] });
      const tx = db.transaction('files', 'readwrite');
      tx.objectStore('files').put(sealed, name);
      tx.objectStore('files').delete(k);
      await done(tx);
    }
    for (const k of await plain('attachments')) {
      const v = await req(db.transaction('attachments', 'readonly').objectStore('attachments').get(k));
      const cut = String(k).lastIndexOf('|');
      const name = await nameOf(String(k).slice(0, cut));
      const sealed = await sealJson(v || []);
      const tx = db.transaction('attachments', 'readwrite');
      tx.objectStore('attachments').put(sealed, `${name}${String(k).slice(cut)}`);
      tx.objectStore('attachments').delete(k);
      await done(tx);
    }
  }

  // A new passphrase: every record is opened with the old key and sealed again with the new one,
  // under the new opaque names. Runs in the write queue so nothing is written in between.
  Lock.resealers.push((oldKeys, newKeys, commit) => enqueue(async () => {
    const V = window.LedgerVault;
    if (ClientStore.status.where === 'localstorage') {
      localStorage.setItem(SEALED_KEY, await V.seal(newKeys, JSON.stringify({ clients: cache, removed: removedList, stamps: stampList })));
      commit();
      return;
    }
    if (!db) { commit(); return; }
    const nameFor = async (id) => V.hid(newKeys, id);
    const back = new Map([...names.entries()].map(([id, n]) => [n, id]));
    for (const id of Object.keys(cache)) if (!names.has(id)) back.set(await V.hid(oldKeys, id), id);
    const all = (store) => { const st = db.transaction(store, 'readonly').objectStore(store); return Promise.all([req(st.getAllKeys()), req(st.getAll())]); };
    const reseal = async (v) => V.seal(newKeys, await V.open(oldKeys, v));
    for (const store of ['clients', 'files', 'attachments']) {
      const [keys, values] = await all(store);
      const rows = [];
      for (let i = 0; i < keys.length; i++) {
        const k = String(keys[i]);
        const cut = store === 'attachments' ? k.lastIndexOf('|') : k.length;
        const id = back.get(k.slice(0, cut));
        if (id == null) continue;
        rows.push([keys[i], `${await nameFor(id)}${k.slice(cut)}`, await reseal(values[i])]);
      }
      const tx = db.transaction(store, 'readwrite');
      for (const [oldKey, newKey, v] of rows) { tx.objectStore(store).delete(oldKey); tx.objectStore(store).put(v, newKey); }
      await done(tx);
    }
    const meta = [];
    for (const [key, value] of [['fileIndex', fileIndex], ['removed', removedList], ['attachStamp', stampList]]) meta.push([key, await V.seal(newKeys, JSON.stringify(value))]);
    const tx = db.transaction('meta', 'readwrite');
    for (const [key, v] of meta) tx.objectStore('meta').put(v, key);
    await done(tx);
    names = new Map();
    commit();
  }));
  // Pending writes finish before the page locks.
  Lock.flushers.push(() => queue);

  ClientStore.ready = loadFromDb().catch(async (e) => {
    db = null;
    await Lock.ready;
    // IndexedDB is unavailable: fall back to localStorage, or memory if that is blocked too.
    const sealed = safeStore.get(SEALED_KEY);
    if (sealed) {
      try {
        const all = await openJson(sealed);
        Object.assign(cache, all.clients || {});
        removedList = all.removed || {};
        stampList = all.stamps || {};
      } catch (err) { /* unreadable: start empty rather than overwrite silently */ }
    }
    const legacy = legacyClients();
    if (legacy) Object.assign(cache, legacy);
    const probe = safeStore.set('ll.probe', '1');
    safeStore.remove('ll.probe');
    ClientStore.status.where = probe ? 'localstorage' : 'memory';
    ClientStore.status.fallbackReason = describe(e);
    if (!probe) ClientStore.status.error = 'this browser is not letting the site save anything, so clients are kept only until the page is closed';
    // A readable copy from before encryption is sealed, then removed.
    if (probe && legacy) { await saveBasic(); safeStore.remove(LEGACY_KEY); }
  }).then(() => {
    ClientStore.setStatus({});
    if (ClientStore.count()) ClientStore.askToKeep(); else ClientStore.estimate();
  });

  window.LedgerStore = { ClientStore, FileStore, AttachStore, safeStore };
})();
