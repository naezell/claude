/* Ledger Lens UI: backup to Google Drive. */
(function () {
  'use strict';
  const { useState, useEffect } = React;
  const UI = window.LedgerUI;
  const { safeStore, ClientStore, Backup } = UI;
  const { FileStore, AttachStore } = window.LedgerStore;
  const Vault = window.LedgerVault;

  // Signs in with Google in the browser and keeps one backup file in the user's Drive. The
  // drive.file scope only reaches files this app created, never the rest of the Drive.
  // Needs a Google OAuth client ID in src/config.js and the app served from an address that
  // client allows (see docs/google-drive-setup.md); without one the feature stays hidden.
  const GIS_URL = 'https://accounts.google.com/gsi/client';
  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const API = 'https://www.googleapis.com/drive/v3/files';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
  const FILE_NAME = 'Ledger Lens backup.json';
  const TAG = { key: 'ledgerLens', value: 'clients-backup' };
  const FILES_TAG = 'client-files';
  // Drive's one-step upload takes up to 5 MB; compressed exports are far below that.
  const MAX_UPLOAD = 4.5 * 1024 * 1024;
  const SYNC_EVERY = 3 * 60 * 1000;

  const cfg = () => window.LedgerConfig || {};
  const clientId = () => String(cfg().googleClientId || '').trim();
  const origins = () => (Array.isArray(cfg().googleOrigins) ? cfg().googleOrigins : []).map((o) => String(o).replace(/\/+$/, ''));
  // Google refuses sign-in from addresses not registered on the client, so only offer it there.
  const originAllowed = () => !origins().length || origins().includes(window.location.origin);

  const Drive = {
    state: {
      token: null,
      expires: 0,
      busy: '',
      error: '',
      fileId: safeStore.get('ll.drive.fileId') || null,
      lastSaved: safeStore.get('ll.drive.lastSaved') || null,
      auto: safeStore.get('ll.drive.auto') !== 'off',
      account: safeStore.get('ll.drive.used') === 'yes',
      // The backup passphrase: null while not needed, else { mode: 'create' | 'unlock', reason }.
      // While it is set nothing is read from or written to Drive.
      needPass: null,
      locked: true,
    },
    // The key from the passphrase ({ key, salt, iterations }), kept in memory and, when Mark
    // chooses, in this browser as a key the page can use but not read out (see KeyStore).
    vault: null,
    listeners: new Set(),
    set(patch) {
      Object.assign(this.state, patch);
      this.listeners.forEach((fn) => fn({ ...this.state }));
    },
    enabled() { return !!clientId() && originAllowed(); },
    // Set up, but this copy of the page is at another address: where to go instead.
    elsewhere() { return clientId() && !originAllowed() ? origins()[0] : null; },
    connected() { return !!this.state.token && Date.now() < this.state.expires - 60e3; },

    // Load Google's sign-in library ahead of the click, so the sign-in window opens straight
    // from the button press instead of being caught by the popup blocker.
    gis: null,
    prepare() {
      if (!this.enabled()) return Promise.resolve(null);
      if (window.google && window.google.accounts && window.google.accounts.oauth2) return Promise.resolve(window.google);
      if (!this.gis) {
        this.gis = new Promise((resolve, reject) => {
          const el = document.createElement('script');
          el.src = GIS_URL;
          el.async = true;
          const timer = setTimeout(() => reject(new Error('timeout')), 15000);
          el.onload = () => { clearTimeout(timer); window.google && window.google.accounts ? resolve(window.google) : reject(new Error('missing')); };
          el.onerror = () => { clearTimeout(timer); reject(new Error('blocked')); };
          document.head.appendChild(el);
        }).catch((e) => {
          this.gis = null;
          throw new Error(`Google sign-in could not load (${e.message}). If the app is open inside claude.ai, open it from its own web address instead.`);
        });
      }
      return this.gis;
    },

    tokenClient: null,
    pending: null,
    async connect() {
      this.set({ busy: 'Connecting to Google Drive…', error: '' });
      try {
        const google = await this.prepare();
        if (!this.tokenClient) {
          this.tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: clientId(),
            scope: SCOPE,
            callback: (resp) => {
              const p = this.pending; this.pending = null;
              if (!p) return;
              if (resp && resp.access_token) p.resolve(resp); else p.reject(new Error((resp && (resp.error_description || resp.error)) || 'sign-in failed'));
            },
            error_callback: (err) => {
              const p = this.pending; this.pending = null;
              if (p) p.reject(new Error(err && err.type === 'popup_closed' ? 'the Google window was closed' : err && err.type === 'popup_failed_to_open' ? 'the browser blocked the Google window; allow pop-ups for this page and try again' : (err && err.message) || 'sign-in failed'));
            },
          });
        }
        const resp = await new Promise((resolve, reject) => {
          this.pending = { resolve, reject };
          this.tokenClient.requestAccessToken({ prompt: this.state.account ? '' : 'consent' });
        });
        safeStore.set('ll.drive.used', 'yes');
        this.set({ token: resp.access_token, expires: Date.now() + (+resp.expires_in || 3600) * 1000, account: true });
        this.set({ busy: '' });
        if (!this.vault) { this.vault = await KeyStore.get(); this.set({ locked: !this.vault }); }
        // Bring in the other devices' work before this one writes anything.
        await this.sync();
        return true;
      } catch (e) {
        this.set({ busy: '', error: `Could not connect: ${e.message}.` });
        return false;
      }
    },
    disconnect() {
      const t = this.state.token;
      if (t && window.google && window.google.accounts && window.google.accounts.oauth2) window.google.accounts.oauth2.revoke(t, () => {});
      this.set({ token: null, expires: 0, error: '' });
    },

    async api(url, opts) {
      if (!this.connected()) { this.set({ token: null }); throw new Error('Google Drive needs to be connected again'); }
      const res = await fetch(url, { ...(opts || {}), headers: { Authorization: `Bearer ${this.state.token}`, ...((opts && opts.headers) || {}) } });
      if (res.status === 401) { this.set({ token: null }); throw new Error('the Google sign-in expired; connect again'); }
      if (!res.ok) {
        let msg = `Google Drive answered ${res.status}`;
        try { const j = await res.json(); if (j && j.error && j.error.message) msg = j.error.message; } catch (e) { /* not JSON */ }
        throw new Error(msg);
      }
      return res;
    },
    // Finds the backup this app made before, wherever the user has moved it in their Drive.
    async locate() {
      const q = `appProperties has { key='${TAG.key}' and value='${TAG.value}' } and trashed = false`;
      const res = await this.api(`${API}?q=${encodeURIComponent(q)}&spaces=drive&orderBy=modifiedTime desc&fields=files(id,name,modifiedTime)`);
      const files = (await res.json()).files || [];
      const f = files[0] || null;
      safeStore.set('ll.drive.fileId', f ? f.id : '');
      this.set({ fileId: f ? f.id : null, remoteModified: f ? f.modifiedTime : null });
      return f;
    },
    // The whole backup file, written over the copy in Drive (or created the first time).
    async upload(body) {
      let res;
      if (this.state.fileId) {
        res = await this.api(`${UPLOAD}/${this.state.fileId}?uploadType=media&fields=id,modifiedTime`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
      } else {
        res = await this.multipart('POST', `${UPLOAD}?uploadType=multipart&fields=id,modifiedTime`, { name: FILE_NAME, mimeType: 'application/json', appProperties: { [TAG.key]: TAG.value } }, body);
      }
      const f = await res.json();
      safeStore.set('ll.drive.fileId', f.id);
      this.set({ fileId: f.id });
      return f;
    },
    multipart(method, url, meta, body) {
      const boundary = `ll${Math.random().toString(36).slice(2)}`;
      const text = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
      return this.api(url, { method, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: text });
    },

    // Two-way sync: bring in what changed on the other devices (newer copy of each client wins,
    // clients forgotten there are forgotten here), then write this device's copy back if Drive
    // is missing anything, then the same for each client's QuickBooks files and receipt photos.
    running: null,
    again: false,
    async sync() {
      if (!this.connected()) return null;
      if (this.running) { this.again = true; return this.running; }
      this.running = (async () => {
        this.set({ busy: 'Syncing with Google Drive…', error: '' });
        try {
          const f = await this.locate();
          let pulled = 0, remote = null, sealedRemote = false, text = null;
          if (f) text = await (await this.api(`${API}/${f.id}?alt=media`)).text();
          // Nothing moves until there is a key that fits the backup in Drive.
          if (!this.vault || (text && Vault.isSealed(text) && !this.keyFor(text))) {
            const mode = text && Vault.isSealed(text) ? 'unlock' : 'create';
            // A key that no longer fits means the passphrase was changed on another device.
            const changed = !!this.vault;
            if (this.vault) { this.vault = null; await KeyStore.clear(); }
            this.set({ busy: '', locked: true, needPass: { mode, reason: changed ? 'changed' : mode === 'create' && text ? 'upgrade' : '' } });
            return null;
          }
          if (text) {
            sealedRemote = Vault.isSealed(text);
            // A backup from before encryption is read once, then replaced by a sealed copy below.
            const plain = sealedRemote ? await Vault.open(this.keyFor(text), text) : text;
            pulled = Backup.restore(plain, true);
            try { remote = JSON.parse(plain); } catch (e) { remote = null; }
          }
          const body = Backup.build();
          const pushed = !remote || !sealedRemote || this.force || sameData(remote) !== sameData(JSON.parse(body));
          if (pushed) {
            const f2 = await this.upload(await Vault.seal(this.vault, body));
            // Drive keeps earlier versions of a file: the readable ones from before encryption
            // (or sealed with an old passphrase) are deleted once the sealed copy is in place.
            if (f && (!sealedRemote || this.force)) await this.purgeVersions(f2.id);
          }
          const files = await this.syncFiles();
          this.force = false;
          this.previous = null;
          const at = new Date().toISOString();
          safeStore.set('ll.drive.lastSaved', at);
          Backup.mark('Google Drive');
          this.set({ busy: '', lastSaved: at, lastPulled: pulled + files.down });
          return { pulled, pushed, filesUp: files.up, filesDown: files.down };
        } catch (e) {
          if (/not found/i.test(e.message)) { safeStore.set('ll.drive.fileId', ''); this.set({ fileId: null }); }
          if (e.wrongPassphrase) { this.vault = null; await KeyStore.clear(); this.set({ locked: true, needPass: { mode: 'unlock', reason: 'changed' } }); }
          this.set({ busy: '', error: `Not synced: ${e.message}.` });
          return null;
        }
      })();
      try { return await this.running; } finally {
        this.running = null;
        if (this.again) { this.again = false; setTimeout(() => this.sync(), 0); }
      }
    },
    // Kept for the buttons and anything else that asked for a save or a restore: both sync now.
    save() { return this.sync().then((r) => !!r); },
    restore() { return this.sync().then((r) => (r ? r.pulled + r.filesDown : null)); },

    // Each client's exports and receipt photos go in their own Drive file, named by a scrambled
    // id (no client name in Drive's file list), and are only moved when one side is newer.
    async syncFiles() {
      const moved = { up: 0, down: 0 };
      if (!FileStore.available() || !FileStore.enabled()) return moved;
      const q = `appProperties has { key='${TAG.key}' and value='${FILES_TAG}' } and trashed = false`;
      const list = (await (await this.api(`${API}?q=${encodeURIComponent(q)}&spaces=drive&pageSize=1000&fields=files(id,appProperties,modifiedTime)`)).json()).files || [];
      const remote = new Map();
      for (const f of list) {
        const k = f.appProperties && f.appProperties.client;
        if (k && (!remote.has(k) || String(f.appProperties.savedAt || '') > String(remote.get(k).appProperties.savedAt || ''))) remote.set(k, f);
      }
      const idx = FileStore.index(), stamps = AttachStore.stamps(), clients = ClientStore.all(), removed = ClientStore.removed();
      const localAt = (id) => [(idx[id] || {}).savedAt || '', stamps[id] || ''].sort().pop();
      const byHash = {};
      for (const id of Object.keys(clients)) byHash[await hashId(id)] = id;
      const gone = {};
      for (const id of Object.keys(removed)) gone[await hashId(id)] = id;
      for (const [h, id] of Object.entries(byHash)) {
        const at = localAt(id);
        if (!at) continue;
        const r = remote.get(h);
        // Skipped when Drive already has this copy or a newer one, sealed with the current key.
        // Copies from before encryption, or sealed with an earlier passphrase, are sent again.
        const sealedNow = r && r.appProperties.sealed === this.vault.salt;
        if (r && sealedNow && !this.force && String(r.appProperties.savedAt || '') >= at) continue;
        if (r && !sealedNow && String(r.appProperties.savedAt || '') > at) continue; // brought down first, below
        const files = (await FileStore.get(id)) || [];
        const photos = await AttachStore.forClient(id);
        const body = await Vault.seal(this.vault, JSON.stringify({ format: 'ledger-lens-files', client: id, savedAt: at, filesSavedAt: (idx[id] || {}).savedAt || '', photosAt: stamps[id] || '', files, photos }));
        if (body.length > MAX_UPLOAD) { this.set({ error: `${clients[id].name || 'A client'}'s files are too large to sync; upload them on the other device.` }); continue; }
        const meta = { appProperties: { [TAG.key]: FILES_TAG, client: h, savedAt: at, sealed: this.vault.salt } };
        if (r) {
          await this.multipart('PATCH', `${UPLOAD}/${r.id}?uploadType=multipart&fields=id`, meta, body);
          if (!sealedNow || this.force) await this.purgeVersions(r.id);
        }
        else await this.multipart('POST', `${UPLOAD}?uploadType=multipart&fields=id`, { name: `Ledger Lens files ${h.slice(0, 8)}.json`, mimeType: 'application/json', ...meta }, body);
        moved.up++;
      }
      for (const [h, r] of remote) {
        const id = byHash[h];
        if (!id) {
          // A client forgotten on purpose: its files go from Drive too.
          if (gone[h]) await this.api(`${API}/${r.id}`, { method: 'DELETE' });
          continue;
        }
        if (String(r.appProperties.savedAt || '') <= localAt(id)) continue;
        const raw = await (await this.api(`${API}/${r.id}?alt=media`)).text();
        const sealedWith = Vault.isSealed(raw) ? this.keyFor(raw) : null;
        if (Vault.isSealed(raw) && !sealedWith) continue; // from a passphrase this device no longer has
        const data = sealedWith ? JSON.parse(await Vault.open(sealedWith, raw)) : await unpack(raw);
        if (!data || data.client !== id) continue;
        if (data.files && data.files.length && String(data.filesSavedAt || '') > String((idx[id] || {}).savedAt || '')) await FileStore.putSynced(id, data.files, data.filesSavedAt);
        if (data.photosAt && String(data.photosAt) > String(stamps[id] || '')) await AttachStore.putClient(id, data.photos || {}, data.photosAt);
        moved.down++;
        // A copy from before encryption: sync again straight away so it is replaced by a sealed one.
        if (r.appProperties.sealed !== this.vault.salt) this.again = true;
      }
      return moved;
    },
    setAuto(on) { safeStore.set('ll.drive.auto', on ? 'on' : 'off'); this.set({ auto: on }); },

    // The passphrase Mark typed: a new one (first device, or a backup from before encryption)
    // or the one that opens the backup already in Drive. Then sync.
    async usePassphrase(pass, remember) {
      const need = this.state.needPass;
      if (!need) return false;
      this.set({ busy: need.mode === 'create' ? 'Locking the backup…' : 'Unlocking the backup…', error: '' });
      try {
        if (need.mode === 'create') {
          const weak = Vault.weakness(pass);
          if (weak) throw new Error(weak);
          this.vault = await Vault.create(pass);
        } else {
          const f = await this.locate();
          const text = f ? await (await this.api(`${API}/${f.id}?alt=media`)).text() : null;
          if (!text || !Vault.isSealed(text)) { this.set({ busy: '', needPass: { mode: 'create', reason: '' } }); return false; }
          this.vault = await Vault.unlock(pass, text);
        }
        if (remember) await KeyStore.put(this.vault); else await KeyStore.clear();
        this.set({ busy: '', needPass: null, locked: false });
        return !!(await this.sync());
      } catch (e) {
        this.vault = null;
        this.set({ busy: '', error: e.wrongPassphrase ? 'That passphrase does not open the backup. Use the one you set on your other device.' : `${e.message}` });
        return false;
      }
    },
    // A new passphrase: everything in Drive is sealed again with it. The other devices ask for
    // the new one at their next sync.
    async changePassphrase(pass, remember) {
      const weak = Vault.weakness(pass);
      if (weak) { this.set({ error: weak }); return false; }
      this.set({ busy: 'Locking the backup with the new passphrase…', error: '' });
      // The old key still opens what is in Drive until this sync has sealed it all again.
      this.previous = this.vault;
      this.vault = await Vault.create(pass);
      if (remember) await KeyStore.put(this.vault); else await KeyStore.clear();
      this.force = true;
      this.set({ busy: '', locked: false, needPass: null });
      return !!(await this.sync());
    },
    // Deletes every stored version of a file except the newest (best effort: Drive keeps the
    // newest one regardless, and an old version left behind is retried at the next change).
    async purgeVersions(fileId) {
      try {
        const list = (await (await this.api(`${API}/${fileId}/revisions?fields=revisions(id)&pageSize=200`)).json()).revisions || [];
        for (const r of list.slice(0, -1)) await this.api(`${API}/${fileId}/revisions/${r.id}`, { method: 'DELETE' });
      } catch (e) { /* the sealed copy is in place either way */ }
    },
    // The key that opens a sealed file: the current one, or during a passphrase change the old one.
    keyFor(text) {
      if (this.vault && Vault.matches(this.vault, text)) return this.vault;
      if (this.previous && Vault.matches(this.previous, text)) return this.previous;
      return null;
    },
    // Forgets the key on this device: the passphrase is asked for at the next sync.
    async lock() {
      this.vault = null;
      await KeyStore.clear();
      this.set({ locked: true, needPass: this.connected() ? { mode: 'unlock', reason: '' } : null });
    },
  };

  // The backup key, remembered in this browser. IndexedDB stores the CryptoKey object itself,
  // which was made non-extractable: scripts can use it to seal and open, but cannot read it, and
  // it never leaves this device. Separate from the clients database so its upgrades stay simple.
  const KeyStore = {
    db() {
      return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') { reject(new Error('no IndexedDB')); return; }
        const r = indexedDB.open('ledger-lens-vault', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('keys');
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    },
    async run(mode, fn) {
      try {
        const db = await this.db();
        return await new Promise((resolve, reject) => {
          const tx = db.transaction('keys', mode);
          const req = fn(tx.objectStore('keys'));
          tx.oncomplete = () => { db.close(); resolve(req && req.result); };
          tx.onerror = () => { db.close(); reject(tx.error); };
        });
      } catch (e) { return null; }
    },
    async get() {
      const v = await this.run('readonly', (s) => s.get('drive'));
      return v && v.key && v.salt ? v : null;
    },
    put(vault) { return this.run('readwrite', (s) => s.put({ key: vault.key, salt: vault.salt, iterations: vault.iterations }, 'drive')); },
    clear() { return this.run('readwrite', (s) => s.delete('drive')); },
  };

  // The parts of a backup two devices must agree on (not when it was written).
  const sameData = (d) => {
    const sorted = (o) => Object.keys(o || {}).sort().map((k) => [k, o[k]]);
    return JSON.stringify([sorted(d && d.clients), sorted(d && d.removed)]);
  };
  async function hashId(id) {
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`ledger-lens|${id}`)));
    return [...bytes.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Client files from before encryption: gzip, then base64. Only read now (see Vault.seal).
  async function unpack(text) {
    let obj;
    try { obj = JSON.parse(text); } catch (e) { return null; }
    if (!obj || obj.enc !== 'gzip') return obj;
    if (typeof DecompressionStream === 'undefined') throw new Error('this browser is too old to read files synced from the other device');
    const bytes = Uint8Array.from(atob(obj.data), (c) => c.charCodeAt(0));
    const out = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    return JSON.parse(out);
  }

  // Automatic sync while connected: a few seconds after a change here, every few minutes, and
  // when the page comes back into view (the other device may have changed something).
  let timer = null;
  const soon = (ms) => {
    if (!Drive.state.auto || !Drive.connected() || Drive.state.needPass) return;
    clearTimeout(timer);
    timer = setTimeout(() => { if (Drive.connected()) Drive.sync(); }, ms);
  };
  // Changes made in another open tab are synced by that tab; changes a sync brought in need no
  // sync back.
  ClientStore.listeners.add((info) => { if (!info.remote && !info.synced && !Drive.running) soon(4000); });
  FileStore.listeners.add(() => { if (!Drive.running) soon(4000); });
  setInterval(() => { if (typeof document === 'undefined' || document.visibilityState !== 'hidden') soon(0); }, SYNC_EVERY);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Date.now() - Date.parse(Drive.state.lastSaved || 0) > 30e3) soon(0);
    });
  }

  function useDrive() {
    const [state, setState] = useState(() => ({ ...Drive.state }));
    useEffect(() => {
      Drive.listeners.add(setState);
      return () => Drive.listeners.delete(setState);
    }, []);
    return state;
  }

  Object.assign(UI, { Drive, useDrive });
})();
