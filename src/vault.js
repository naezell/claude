/* Ledger Lens: encrypting the Google Drive backup with a passphrase.
 *
 * Mark picks one passphrase and types it once on each device. PBKDF2 (SHA-256, 600,000 rounds,
 * as OWASP recommends) turns it into an AES-GCM 256-bit key; the random salt and round count are
 * stored next to the data in each Drive file so every device derives the same key. The key is
 * made non-extractable: the page can use it but never read it back out, and the passphrase itself
 * is never stored. Google only ever holds the sealed files.
 *
 * A sealed Drive file is JSON:
 *   { format: 'ledger-lens-sealed', v: 1, kdf: { name: 'PBKDF2-SHA256', iterations, salt },
 *     zip: true|false, data: '<iv>.<ciphertext>' }   (base64url; zip = gzip before sealing)
 *
 * Runs in the browser (window.LedgerVault) and in Node for the tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LedgerVault = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const FORMAT = 'ledger-lens-sealed';
  const ITERATIONS = 600000;
  const MIN_LENGTH = 12;
  const subtle = () => globalThis.crypto.subtle;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

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

  const canZip = () => typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined' && typeof Blob !== 'undefined' && typeof Response !== 'undefined';
  const gzip = async (bytes) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  const gunzip = async (bytes) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());

  // Why a passphrase is not good enough, or '' when it is.
  function weakness(pass) {
    const p = String(pass || '');
    if (p.length < MIN_LENGTH) return `Use at least ${MIN_LENGTH} characters. A short sentence works well, for example four or five words.`;
    if (/^(.)\1+$/.test(p)) return 'Use something other than one repeated character.';
    if (/^(password|ledgerlens|ledger lens|qwerty|123456)/i.test(p.replace(/\s+/g, ''))) return 'Choose something less common.';
    return '';
  }

  async function deriveKey(pass, salt, iterations) {
    const base = await subtle().importKey('raw', enc.encode(String(pass).normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
    return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64url(salt), iterations: iterations || ITERATIONS }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  // A new key from a passphrase: { key, salt, iterations }.
  async function create(pass, iterations) {
    const salt = b64url(random(16));
    const it = iterations || ITERATIONS;
    return { key: await deriveKey(pass, salt, it), salt, iterations: it };
  }

  // The key for an existing sealed file, from the passphrase and the file's own salt.
  async function unlock(pass, text) {
    const kdf = kdfOf(text);
    if (!kdf) throw new Error('not a sealed file');
    const vault = { key: await deriveKey(pass, kdf.salt, kdf.iterations), salt: kdf.salt, iterations: kdf.iterations };
    await open(vault, text); // throws when the passphrase is wrong
    return vault;
  }

  const parse = (text) => { try { const o = JSON.parse(text); return o && o.format === FORMAT ? o : null; } catch (e) { return null; } };
  const isSealed = (text) => !!parse(text);
  function kdfOf(text) {
    const o = parse(text);
    return o && o.kdf && o.kdf.salt ? { salt: String(o.kdf.salt), iterations: +o.kdf.iterations || ITERATIONS } : null;
  }
  // Whether `vault` was made from the same salt as the file (same passphrase setup).
  const matches = (vault, text) => { const k = kdfOf(text); return !!(vault && k && k.salt === vault.salt && k.iterations === vault.iterations); };

  async function seal(vault, plain) {
    let bytes = enc.encode(String(plain));
    const zip = canZip();
    if (zip) bytes = await gzip(bytes);
    const iv = random(12);
    const out = await subtle().encrypt({ name: 'AES-GCM', iv }, vault.key, bytes);
    return JSON.stringify({ format: FORMAT, v: 1, kdf: { name: 'PBKDF2-SHA256', iterations: vault.iterations, salt: vault.salt }, zip, data: `${b64url(iv)}.${b64url(out)}` });
  }

  // The original text. Throws a plain-language error when the passphrase does not fit.
  async function open(vault, text) {
    const o = parse(text);
    if (!o) throw new Error('not a sealed file');
    const [iv, body] = String(o.data || '').split('.');
    let bytes;
    try {
      bytes = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: unb64url(iv) }, vault.key, unb64url(body)));
    } catch (e) {
      throw Object.assign(new Error('the backup passphrase does not match the one used to lock this backup'), { wrongPassphrase: true });
    }
    if (o.zip) {
      if (!canZip()) throw new Error('this browser is too old to read the backup');
      bytes = await gunzip(bytes);
    }
    return dec.decode(bytes);
  }

  return { FORMAT, ITERATIONS, MIN_LENGTH, weakness, create, unlock, isSealed, kdfOf, matches, seal, open };
});
