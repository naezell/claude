/* Ledger Lens: sealing the client portal's questions and answers.
 *
 * Each answer link carries its own random key after the # (https://…/portal#<id>.<key>).
 * Browsers never send that part to the server, so the site only ever stores sealed data it
 * cannot read: the questions are sealed in Mark's browser and opened in the client's, and the
 * answers go back the same way. AES-GCM with a 256-bit key, from the browser's Web Crypto.
 * Runs in the browser (window.LedgerSeal) and in Node for the tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LedgerSeal = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const subtle = () => globalThis.crypto.subtle;
  const b64url = (bytes) => {
    let s = '';
    const a = new Uint8Array(bytes);
    for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const unb64url = (str) => {
    const s = atob(String(str).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(str).length + 3) % 4));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  };
  const random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
  const importKey = (key) => subtle().importKey('raw', unb64url(key), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

  return {
    // A new link: `id` finds the sealed data on the site, `key` opens it and never leaves
    // the link.
    newLink() { return { id: b64url(random(16)), key: b64url(random(32)) }; },
    ID_PATTERN: /^[A-Za-z0-9_-]{22}$/,
    KEY_PATTERN: /^[A-Za-z0-9_-]{43}$/,
    // The id and key from a link's # part, or null.
    fromHash(hash) {
      const m = String(hash || '').replace(/^#/, '').match(/^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/);
      return m ? { id: m[1], key: m[2] } : null;
    },
    async seal(key, value) {
      const iv = random(12);
      const data = new TextEncoder().encode(JSON.stringify(value));
      const out = await subtle().encrypt({ name: 'AES-GCM', iv }, await importKey(key), data);
      return `${b64url(iv)}.${b64url(out)}`;
    },
    // Throws if the key is wrong or the data was changed.
    async open(key, sealed) {
      const [iv, body] = String(sealed || '').split('.');
      const data = await subtle().decrypt({ name: 'AES-GCM', iv: unb64url(iv) }, await importKey(key), unb64url(body));
      return JSON.parse(new TextDecoder().decode(data));
    },
  };
});
