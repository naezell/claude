/* Ledger Lens UI: backup to Google Drive. */
(function () {
  'use strict';
  const { useState, useEffect } = React;
  const UI = window.LedgerUI;
  const { safeStore, ClientStore, Backup } = UI;
  const { FileStore, AttachStore } = window.LedgerStore;

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
    },
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
          let pulled = 0, remote = null;
          if (f) {
            const text = await (await this.api(`${API}/${f.id}?alt=media`)).text();
            pulled = Backup.restore(text, true);
            try { remote = JSON.parse(text); } catch (e) { remote = null; }
          }
          const body = Backup.build();
          const pushed = !remote || sameData(remote) !== sameData(JSON.parse(body));
          if (pushed) await this.upload(body);
          const files = await this.syncFiles();
          const at = new Date().toISOString();
          safeStore.set('ll.drive.lastSaved', at);
          Backup.mark('Google Drive');
          this.set({ busy: '', lastSaved: at, lastPulled: pulled + files.down });
          return { pulled, pushed, filesUp: files.up, filesDown: files.down };
        } catch (e) {
          if (/not found/i.test(e.message)) { safeStore.set('ll.drive.fileId', ''); this.set({ fileId: null }); }
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
        if (r && String(r.appProperties.savedAt || '') >= at) continue;
        const files = (await FileStore.get(id)) || [];
        const photos = await AttachStore.forClient(id);
        const body = await pack(JSON.stringify({ format: 'ledger-lens-files', client: id, savedAt: at, filesSavedAt: (idx[id] || {}).savedAt || '', photosAt: stamps[id] || '', files, photos }));
        if (body.length > MAX_UPLOAD) { this.set({ error: `${clients[id].name || 'A client'}'s files are too large to sync; upload them on the other device.` }); continue; }
        const meta = { appProperties: { [TAG.key]: FILES_TAG, client: h, savedAt: at } };
        if (r) await this.multipart('PATCH', `${UPLOAD}/${r.id}?uploadType=multipart&fields=id`, meta, body);
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
        const data = await unpack(await (await this.api(`${API}/${r.id}?alt=media`)).text());
        if (!data || data.client !== id) continue;
        if (data.files && data.files.length && String(data.filesSavedAt || '') > String((idx[id] || {}).savedAt || '')) await FileStore.putSynced(id, data.files, data.filesSavedAt);
        if (data.photosAt && String(data.photosAt) > String(stamps[id] || '')) await AttachStore.putClient(id, data.photos || {}, data.photosAt);
        moved.down++;
      }
      return moved;
    },
    setAuto(on) { safeStore.set('ll.drive.auto', on ? 'on' : 'off'); this.set({ auto: on }); },
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
  // Exports are large text and compress well: gzip, then base64 so the file stays plain JSON.
  async function pack(text) {
    if (typeof CompressionStream === 'undefined') return text;
    const gz = new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    let bin = '';
    for (let i = 0; i < gz.length; i += 0x8000) bin += String.fromCharCode.apply(null, gz.subarray(i, i + 0x8000));
    return JSON.stringify({ format: 'ledger-lens-files', enc: 'gzip', data: btoa(bin) });
  }
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
    if (!Drive.state.auto || !Drive.connected()) return;
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
