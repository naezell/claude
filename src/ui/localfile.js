/* Ledger Lens UI: backup to a file on this computer. */
(function () {
  'use strict';
  const { useState, useEffect } = React;
  const UI = window.LedgerUI;
  const { safeStore, ClientStore, Backup } = UI;

  // Chrome and Edge can keep writing to one file the user picked (the File System Access
  // API); the app saves there after every change, like the Google Drive backup. Other
  // browsers, and pages shown inside another site, fall back to downloading a backup file.
  const DB = 'll-files', STORE = 'handles', KEY = 'backup';
  const FILE_NAME = 'Ledger Lens backup.json';
  const TYPES = [{ description: 'Ledger Lens backup', accept: { 'application/json': ['.json'] } }];

  function idb(mode, fn) {
    return new Promise((resolve) => {
      let req;
      try { req = indexedDB.open(DB, 1); } catch (e) { resolve(null); return; }
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        try {
          const tx = req.result.transaction(STORE, mode);
          const r = fn(tx.objectStore(STORE));
          tx.oncomplete = () => resolve(r && 'result' in r ? r.result : null);
          tx.onerror = () => resolve(null);
        } catch (e) { resolve(null); }
      };
    });
  }
  const remember = (handle) => idb('readwrite', (s) => (handle ? s.put(handle, KEY) : s.delete(KEY)));
  const recall = () => idb('readonly', (s) => s.get(KEY));

  const inFrame = (() => { try { return window.self !== window.top; } catch (e) { return true; } })();

  const LocalFile = {
    state: {
      handle: null,
      name: safeStore.get('ll.file.name') || '',
      lastSaved: safeStore.get('ll.file.lastSaved') || null,
      auto: safeStore.get('ll.file.auto') !== 'off',
      permission: null,
      busy: '',
      error: '',
    },
    listeners: new Set(),
    set(patch) {
      Object.assign(this.state, patch);
      this.listeners.forEach((fn) => fn({ ...this.state }));
    },
    supported() { return typeof window.showSaveFilePicker === 'function' && !inFrame; },
    ready() { return !!this.state.handle && this.state.permission === 'granted'; },

    // After a reload the file is remembered, but the browser asks again before writing.
    async init() {
      if (!this.supported()) return;
      const handle = await recall();
      if (!handle || typeof handle.queryPermission !== 'function') return;
      let permission = 'prompt';
      try { permission = await handle.queryPermission({ mode: 'readwrite' }); } catch (e) { /* treated as prompt */ }
      this.set({ handle, name: handle.name, permission });
    },
    async use(handle, { restore } = {}) {
      let permission = 'granted';
      if (typeof handle.requestPermission === 'function') {
        try { permission = await handle.requestPermission({ mode: 'readwrite' }); } catch (e) { permission = 'denied'; }
      }
      if (permission !== 'granted') { this.set({ busy: '', error: 'The browser did not allow saving to that file.' }); return null; }
      safeStore.set('ll.file.name', handle.name);
      await remember(handle);
      this.set({ handle, name: handle.name, permission });
      let restored = null;
      if (restore) restored = await this.restore();
      await this.save();
      return restored;
    },
    // Pick where to keep a new backup file.
    async create() {
      this.set({ busy: 'Choosing a file…', error: '' });
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: FILE_NAME, types: TYPES });
        return await this.use(handle);
      } catch (e) {
        this.set({ busy: '', error: e && e.name === 'AbortError' ? '' : `Could not set up the file: ${e.message}.` });
        return null;
      }
    },
    // Keep using a backup file saved earlier (another computer, or before clearing the browser).
    async openExisting() {
      this.set({ busy: 'Choosing a file…', error: '' });
      try {
        const [handle] = await window.showOpenFilePicker({ types: TYPES, multiple: false });
        return await this.use(handle, { restore: true });
      } catch (e) {
        this.set({ busy: '', error: e && e.name === 'AbortError' ? '' : `Could not open the file: ${e.message}.` });
        return null;
      }
    },
    async reconnect() {
      if (!this.state.handle) return false;
      try {
        const permission = await this.state.handle.requestPermission({ mode: 'readwrite' });
        this.set({ permission, error: permission === 'granted' ? '' : 'The browser did not allow saving to the file.' });
        if (permission === 'granted') await this.save();
        return permission === 'granted';
      } catch (e) { this.set({ error: `Could not reconnect: ${e.message}.` }); return false; }
    },
    async save() {
      if (!this.ready()) return false;
      this.set({ busy: 'Saving…', error: '' });
      try {
        const w = await this.state.handle.createWritable();
        await w.write(Backup.build());
        await w.close();
        const at = new Date().toISOString();
        safeStore.set('ll.file.lastSaved', at);
        Backup.mark('computer');
        this.set({ busy: '', lastSaved: at });
        return true;
      } catch (e) {
        this.set({ busy: '', error: `Not saved: ${e.message}. The file may have been moved or deleted; choose it again.` });
        return false;
      }
    },
    async restore() {
      if (!this.state.handle) return null;
      this.set({ busy: 'Reading the backup file…', error: '' });
      try {
        const file = await this.state.handle.getFile();
        const text = await file.text();
        const n = text.trim() ? Backup.restore(text) : 0;
        this.set({ busy: '' });
        return n;
      } catch (e) {
        this.set({ busy: '', error: `Not restored: ${e.message}.` });
        return null;
      }
    },
    async forget() {
      await remember(null);
      safeStore.set('ll.file.name', '');
      this.set({ handle: null, name: '', permission: null, error: '' });
    },
    setAuto(on) { safeStore.set('ll.file.auto', on ? 'on' : 'off'); this.set({ auto: on }); },
  };

  // Automatic saving a few seconds after any saved-client change, while allowed.
  let timer = null;
  ClientStore.listeners.add(() => {
    if (!LocalFile.state.auto || !LocalFile.ready()) return;
    clearTimeout(timer);
    timer = setTimeout(() => { if (LocalFile.ready() && !LocalFile.state.busy) LocalFile.save(); }, 3000);
  });
  LocalFile.init();

  function useLocalFile() {
    const [state, setState] = useState(() => ({ ...LocalFile.state }));
    useEffect(() => {
      LocalFile.listeners.add(setState);
      return () => LocalFile.listeners.delete(setState);
    }, []);
    return state;
  }

  Object.assign(UI, { LocalFile, useLocalFile });
})();
