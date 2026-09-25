/* Ledger Lens UI: backup to Google Drive. */
(function () {
  'use strict';
  const { useState, useEffect } = React;
  const UI = window.LedgerUI;
  const { safeStore, ClientStore, Backup } = UI;

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

  const clientId = () => String((window.LedgerConfig && window.LedgerConfig.googleClientId) || '').trim();

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
    enabled() { return !!clientId(); },
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
        await this.locate();
        this.set({ busy: '' });
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
    async save() {
      this.set({ busy: 'Saving to Google Drive…', error: '' });
      try {
        const body = Backup.build();
        let res;
        if (this.state.fileId) {
          res = await this.api(`${UPLOAD}/${this.state.fileId}?uploadType=media&fields=id,modifiedTime`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body });
        } else {
          const boundary = `ll${Math.random().toString(36).slice(2)}`;
          const meta = { name: FILE_NAME, mimeType: 'application/json', appProperties: { [TAG.key]: TAG.value } };
          const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
          res = await this.api(`${UPLOAD}?uploadType=multipart&fields=id,modifiedTime`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart });
        }
        const f = await res.json();
        const at = new Date().toISOString();
        safeStore.set('ll.drive.fileId', f.id);
        safeStore.set('ll.drive.lastSaved', at);
        Backup.mark('Google Drive');
        this.set({ busy: '', fileId: f.id, lastSaved: at });
        return true;
      } catch (e) {
        // The file may have been deleted from Drive; start a new one next time.
        if (/not found/i.test(e.message)) { safeStore.set('ll.drive.fileId', ''); this.set({ fileId: null }); }
        this.set({ busy: '', error: `Not saved: ${e.message}.` });
        return false;
      }
    },
    async restore() {
      this.set({ busy: 'Reading the backup from Google Drive…', error: '' });
      try {
        const f = this.state.fileId ? { id: this.state.fileId } : await this.locate();
        if (!f) { this.set({ busy: '', error: 'There is no Ledger Lens backup in this Google Drive yet. Save one first.' }); return null; }
        const res = await this.api(`${API}/${f.id}?alt=media`);
        const n = Backup.restore(await res.text());
        this.set({ busy: '' });
        return n;
      } catch (e) {
        this.set({ busy: '', error: `Not restored: ${e.message}.` });
        return null;
      }
    },
    setAuto(on) { safeStore.set('ll.drive.auto', on ? 'on' : 'off'); this.set({ auto: on }); },
  };

  // Automatic saving: a few seconds after any saved-client change, while connected.
  let timer = null;
  ClientStore.listeners.add(() => {
    if (!Drive.state.auto || !Drive.connected()) return;
    clearTimeout(timer);
    timer = setTimeout(() => { if (Drive.connected() && !Drive.state.busy) Drive.save(); }, 4000);
  });

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
