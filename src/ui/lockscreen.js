/* Ledger Lens UI: the lock screen and the passphrase form.
 *
 * The page opens here. Until the Ledger Lens passphrase is typed nothing about clients is opened
 * (src/lock.js, src/store.js); then the app itself is shown. The same form is used to change the
 * passphrase, and when a Drive backup or a backup file was locked with a different one.
 */
(function () {
  'use strict';
  const { useState, useEffect } = React;
  const html = htm.bind(React.createElement);
  const UI = window.LedgerUI;
  const Lock = window.LedgerLock;
  const V = window.LedgerVault;

  const useLock = () => {
    const [, tick] = useState(0);
    useEffect(() => { const f = () => tick((n) => n + 1); Lock.listeners.add(f); return () => Lock.listeners.delete(f); }, []);
  };

  // mode: 'create' (first time on this device), 'change', 'unlock' (open the app), 'other' (a
  // backup locked with a different passphrase). Resolves errors from onSubmit into the form.
  function PassphraseForm({ mode, intro, busy, submitLabel, onSubmit, onCancel }) {
    const [pass, setPass] = useState('');
    const [again, setAgain] = useState('');
    const [show, setShow] = useState(false);
    const [problem, setProblem] = useState('');
    const [working, setWorking] = useState(false);
    const fresh = mode === 'create' || mode === 'change';
    const submit = async (e) => {
      e.preventDefault();
      if (fresh) {
        const weak = V.weakness(pass);
        if (weak) { setProblem(weak); return; }
        if (pass !== again) { setProblem('The two passphrases are not the same.'); return; }
      } else if (!pass) { setProblem('Type the passphrase.'); return; }
      setProblem('');
      setWorking(true);
      try { await onSubmit(pass); } catch (err) { setProblem(err.wrongPassphrase ? 'That passphrase is not right. Check for typos and try again.' : err.message); }
      setWorking(false);
    };
    return html`<form class="passphrase" onSubmit=${submit}>
      ${intro && html`<p>${intro}</p>`}
      ${fresh && html`<p class="hint"><strong>Write it down and keep it safe.</strong> Nobody can recover it, not even the developer. Use the same passphrase on each of your devices.</p>`}
      <label for="pp-1">${fresh ? 'New passphrase' : 'Passphrase'}</label>
      <input id="pp-1" type=${show ? 'text' : 'password'} autocomplete=${fresh ? 'new-password' : 'current-password'} autofocus value=${pass} onInput=${(e) => setPass(e.target.value)} />
      ${fresh && html`<label for="pp-2">Type it again</label>
      <input id="pp-2" type=${show ? 'text' : 'password'} autocomplete="new-password" value=${again} onInput=${(e) => setAgain(e.target.value)} />`}
      <label class="check" for="pp-show"><input id="pp-show" type="checkbox" checked=${show} onChange=${(e) => setShow(e.target.checked)} />Show passphrase</label>
      ${problem && html`<p class="error" role="alert">${problem}</p>`}
      <div class="backup-actions">
        <button class="btn primary" type="submit" disabled=${busy || working}>${working ? 'Working…' : submitLabel}</button>
        ${onCancel && html`<button class="btn" type="button" onClick=${onCancel}>Cancel</button>`}
      </div>
    </form>`;
  }

  // Erasing this browser's data when the passphrase is forgotten, behind a confirmation.
  function Forgot() {
    const [open, setOpen] = useState(false);
    if (!open) return html`<p class="lock-forgot"><button class="link" type="button" onClick=${() => setOpen(true)}>Forgot the passphrase?</button></p>`;
    return html`<div class="lock-forgot">
      <p>It cannot be recovered. You can erase what Ledger Lens saved in this browser and start again with a new passphrase. Your backup file and Google Drive copy stay locked with the old one, so only do this if you have the clients elsewhere or can load their exports again.</p>
      <div class="backup-actions">
        <button class="btn" type="button" onClick=${() => Lock.erase()}>Erase this browser's Ledger Lens data</button>
        <button class="btn" type="button" onClick=${() => setOpen(false)}>Cancel</button>
      </div>
    </div>`;
  }

  // Asked by Lock.ask(): a backup locked with a different passphrase.
  function AskDialog() {
    useLock();
    const p = Lock.pending;
    if (!p) return null;
    return html`<div class="scrim lock-ask"><div class="drawer" role="dialog" aria-modal="true" aria-labelledby="ask-title">
      <div class="drawer-head"><h2 id="ask-title">Passphrase needed</h2></div>
      <div class="drawer-scroll"><div class="panel-body">
        <${PassphraseForm} mode="other" intro=${p.message} submitLabel="Open" onSubmit=${async (pass) => Lock.answer(pass)} onCancel=${() => Lock.answer(null)} />
      </div></div>
    </div></div>`;
  }

  // Shows the app only once the passphrase has been typed and the saved clients are opened.
  function LockScreen({ children }) {
    useLock();
    const [ready, setReady] = useState(false);
    const [problem, setProblem] = useState('');
    useEffect(() => {
      if (!Lock.unlocked()) return;
      UI.ClientStore.ready.then(() => setReady(true), (e) => setProblem(String((e && e.message) || e)));
    }, [Lock.unlocked()]);
    if (Lock.unlocked() && ready) return html`${children}<${AskDialog} />`;
    const mode = Lock.mode();
    return html`<main class="lock-screen" aria-labelledby="lock-title">
      <div class="lock-card">
        <h1 id="lock-title">${UI.Icon && UI.Icon.lock}Ledger Lens</h1>
        ${Lock.unlocked()
          ? html`<p role="status">${problem || 'Opening your clients…'}</p>`
          : mode === 'create'
            ? html`<${PassphraseForm} mode="create" submitLabel="Set passphrase and open"
                intro="Choose a passphrase to protect your clients. Everything Ledger Lens saves on this device, in backup files and in Google Drive is encrypted with it, and you type it each time you open Ledger Lens. Already use Ledger Lens on another device? Use the same passphrase."
                onSubmit=${(pass) => Lock.create(pass)} />`
            : html`<${PassphraseForm} mode="unlock" submitLabel="Unlock"
                intro="Type your passphrase to open your clients. Ledger Lens locks itself after 30 minutes without use."
                onSubmit=${(pass) => Lock.unlock(pass)} />
              <${Forgot} />`}
      </div>
    </main>`;
  }

  Object.assign(UI, { PassphraseForm, LockScreen, useLock });
})();
