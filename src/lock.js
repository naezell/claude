/* Ledger Lens: the passphrase lock.
 *
 * Nothing about clients is readable until the Ledger Lens passphrase is typed. The page opens on
 * the lock screen (src/ui/lockscreen.js); `unlock()` derives the keys (src/vault.js) and only then
 * does the saved-clients store (src/store.js) open and decrypt what is saved in this browser. The
 * keys live in memory only: closing or reloading the page, "Lock now", or 30 minutes without use
 * forget them. Nothing that could open the data is ever written to the device.
 *
 * What is kept in localStorage `ll.lock` is not secret: the salt, the round count and the key's
 * fingerprint (`kid`), so a wrong passphrase is caught before anything is opened.
 */
(function () {
  'use strict';
  const V = window.LedgerVault;
  const RECORD = 'll.lock';
  const IDLE_MS = 30 * 60 * 1000;

  const read = () => { try { return JSON.parse(localStorage.getItem(RECORD) || 'null'); } catch (e) { return null; } };
  const write = (rec) => { try { localStorage.setItem(RECORD, JSON.stringify(rec)); return true; } catch (e) { return false; } };

  let keys = null;
  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });

  const Lock = {
    IDLE_MS,
    // Resolves once the passphrase has been typed and the keys are in memory.
    ready,
    listeners: new Set(),
    changed() { this.listeners.forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } }); },
    // This browser has a passphrase set ('unlock'), or needs one ('create').
    mode() { return read() ? 'unlock' : 'create'; },
    unlocked() { return !!keys; },
    keys() { return keys; },
    kid() { return keys ? keys.kid : null; },

    // First time on this device: set the passphrase (the same one as on Mark's other devices).
    async create(pass) {
      const weak = V.weakness(pass);
      if (weak) throw new Error(weak);
      const k = await V.derive(pass);
      write({ v: 1, salt: k.salt, iterations: k.iterations, kid: k.kid, setAt: new Date().toISOString() });
      this.use(k);
    },
    async unlock(pass) {
      const rec = read();
      if (!rec) return this.create(pass);
      const k = await V.derive(pass, rec);
      if (k.kid !== rec.kid) throw Object.assign(new Error('That is not the passphrase for this device.'), { wrongPassphrase: true });
      this.use(k);
    },
    use(k) {
      const first = !keys;
      keys = k;
      if (first) { resolveReady(k); this.watchIdle(); }
      this.changed();
    },

    // A new passphrase. `reseal(oldKeys, newKeys)` hooks (the store, Drive) re-lock what they
    // hold; the device record changes only after they all succeed.
    resealers: [],
    async change(pass, derived) {
      if (!keys) throw new Error('Unlock first.');
      const weak = derived ? '' : V.weakness(pass);
      if (weak) throw new Error(weak);
      const next = derived || await V.derive(pass);
      if (next.kid === keys.kid) return false;
      const old = keys;
      // `commit` switches to the new key; the store calls it inside its write queue, so a save
      // waiting behind the re-sealing already uses the new key.
      const commit = () => {
        if (keys === next) return;
        write({ v: 1, salt: next.salt, iterations: next.iterations, kid: next.kid, setAt: new Date().toISOString() });
        keys = next;
      };
      for (const fn of this.resealers) await fn(old, next, commit);
      commit();
      this.changed();
      return true;
    },
    // The passphrase that opens a file made on another device (a Drive backup after the
    // passphrase was changed there): this device switches to it.
    async adopt(pass) {
      const next = await V.derive(pass);
      if (keys && next.kid === keys.kid) return false;
      return this.change(pass, next);
    },

    seal(text) { if (!keys) throw new Error('Ledger Lens is locked'); return V.seal(keys, text); },
    open(text) { if (!keys) throw new Error('Ledger Lens is locked'); return V.open(keys, text); },
    hid(id) { if (!keys) throw new Error('Ledger Lens is locked'); return V.hid(keys, id); },

    // Text from a backup file: plain (made before encryption), sealed with this passphrase, or
    // sealed with another one, in which case Mark is asked for it.
    async openAny(text, what) {
      if (!V.isSealed(text)) return text;
      if (V.matches(keys, text)) return V.open(keys, text);
      const pass = await this.ask(`${what || 'This backup file'} was locked with a different passphrase (from before it was changed, or another device). Type that passphrase to open it.`);
      if (pass == null) throw new Error('it needs the passphrase it was locked with');
      const k = await V.unlock(pass, text).catch((e) => { throw e.wrongPassphrase ? new Error('that passphrase does not open it') : e; });
      return V.open(k, text);
    },
    // Asks for a passphrase in a dialog (drawn by the lock screen). Resolves null if cancelled.
    pending: null,
    ask(message) {
      return new Promise((resolve) => { this.pending = { message, resolve }; this.changed(); });
    },
    answer(pass) { const p = this.pending; this.pending = null; this.changed(); if (p) p.resolve(pass); },

    // Forgets the keys by reloading the page, once pending saves are written.
    flushers: [],
    async lock() {
      for (const fn of this.flushers) { try { await fn(); } catch (e) { /* still lock */ } }
      keys = null;
      location.reload();
    },
    // Forgot the passphrase: this browser's saved Ledger Lens data is deleted so a new one can be
    // set. Copies elsewhere (Drive, backup files) stay locked with the old passphrase.
    async erase() {
      const del = (name) => new Promise((resolve) => { try { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => resolve(); } catch (e) { resolve(); } });
      for (const name of ['ledger-lens', 'll-files', 'ledger-lens-vault']) await del(name);
      try { Object.keys(localStorage).filter((k) => k.startsWith('ll.')).forEach((k) => localStorage.removeItem(k)); } catch (e) { /* ignore */ }
      location.reload();
    },

    // Locks after 30 minutes without use, including time the page spent hidden.
    lastActive: Date.now(),
    watchIdle() {
      if (typeof document === 'undefined') return;
      const touch = () => { this.lastActive = Date.now(); };
      ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach((ev) => document.addEventListener(ev, touch, { passive: true, capture: true }));
      const check = () => { if (keys && Date.now() - this.lastActive > IDLE_MS) this.lock(); };
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
      setInterval(check, 30 * 1000);
    },
  };

  window.LedgerLock = Lock;
})();
