/* Ledger Lens: encryption with the Ledger Lens passphrase.
 *
 * One passphrase protects everything: the data saved in this browser, backup files and the
 * Google Drive copy. PBKDF2 (SHA-256, 600,000 rounds, as OWASP recommends) turns it into 512
 * bits: an AES-GCM 256-bit key that seals data, and an HMAC-SHA256 key that turns client ids
 * (made from company names) into opaque record names. Both keys are non-extractable, so the
 * page can use them but never read them back out, and neither the keys nor the passphrase are
 * ever stored. `kid` is a short fingerprint of the key (an HMAC of a fixed label) that tells
 * whether a sealed file was made with the same passphrase, without trying to open it.
 *
 * Every device uses the same salt (SALT below) so that the same passphrase gives the same key
 * everywhere, which lets Google Drive and backup files move between Mark's devices. Each sealed
 * file still records its own salt and round count, so these can change later.
 *
 * A sealed value is JSON text:
 *   { format: 'ledger-lens-sealed', v: 2, kdf: { name: 'PBKDF2-SHA256', iterations, salt },
 *     kid, zip: true|false, data: '<iv>.<ciphertext>' }   (base64url; zip = gzip before sealing)
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
  // base64url of "ledger-lens/7d/v1"
  const SALT = 'bGVkZ2VyLWxlbnMvN2QvdjE';
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
  const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

  const canZip = () => typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined' && typeof Blob !== 'undefined' && typeof Response !== 'undefined';
  const gzip = async (bytes) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  const gunzip = async (bytes) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());

  // Why a passphrase is not good enough, or '' when it is.
  function weakness(pass) {
    const p = String(pass || '');
    if (p.length < MIN_LENGTH) return `Use at least ${MIN_LENGTH} characters. A short sentence works well, for example four or five words.`;
    if (/^(.)\1+$/.test(p)) return 'Use something other than one repeated character.';
    if (/^(password|ledgerlens|qwerty|123456)/i.test(p.replace(/\s+/g, ''))) return 'Choose something less common.';
    return '';
  }

  // { key, mac, kid, salt, iterations } from a passphrase.
  async function derive(pass, opts) {
    const salt = (opts && opts.salt) || SALT;
    const iterations = (opts && +opts.iterations) || ITERATIONS;
    const base = await subtle().importKey('raw', enc.encode(String(pass).normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64url(salt), iterations }, base, 512));
    const key = await subtle().importKey('raw', bits.slice(0, 32), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    const mac = await subtle().importKey('raw', bits.slice(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    bits.fill(0);
    const kid = hex(await subtle().sign('HMAC', mac, enc.encode('ledger-lens key id'))).slice(0, 16);
    return { key, mac, kid, salt, iterations };
  }

  // An opaque, stable name for a client id under this key ("h:" and 32 hex characters).
  async function hid(vault, id) {
    return `h:${hex(await subtle().sign('HMAC', vault.mac, enc.encode(`client|${id}`))).slice(0, 32)}`;
  }

  const parse = (text) => { if (typeof text !== 'string') return null; try { const o = JSON.parse(text); return o && o.format === FORMAT ? o : null; } catch (e) { return null; } };
  const isSealed = (text) => !!parse(text);
  function kdfOf(text) {
    const o = parse(text);
    return o && o.kdf && o.kdf.salt ? { salt: String(o.kdf.salt), iterations: +o.kdf.iterations || ITERATIONS } : null;
  }
  const kidOf = (text) => { const o = parse(text); return (o && o.kid) || null; };
  // Whether the file was sealed with this key.
  const matches = (vault, text) => !!(vault && kidOf(text) && kidOf(text) === vault.kid);

  async function seal(vault, plain) {
    let bytes = enc.encode(String(plain));
    const zip = canZip();
    if (zip) bytes = await gzip(bytes);
    const iv = random(12);
    const out = await subtle().encrypt({ name: 'AES-GCM', iv }, vault.key, bytes);
    return JSON.stringify({ format: FORMAT, v: 2, kdf: { name: 'PBKDF2-SHA256', iterations: vault.iterations, salt: vault.salt }, kid: vault.kid, zip, data: `${b64url(iv)}.${b64url(out)}` });
  }

  // The original text. Throws (with `wrongPassphrase`) when the key does not fit.
  async function open(vault, text) {
    const o = parse(text);
    if (!o) throw new Error('not a sealed file');
    const [iv, body] = String(o.data || '').split('.');
    let bytes;
    try {
      bytes = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: unb64url(iv) }, vault.key, unb64url(body)));
    } catch (e) {
      throw Object.assign(new Error('the passphrase does not match the one this was locked with'), { wrongPassphrase: true });
    }
    if (o.zip) {
      if (!canZip()) throw new Error('this browser is too old to read it');
      bytes = await gunzip(bytes);
    }
    return dec.decode(bytes);
  }

  // The key for a sealed file from a passphrase and the file's own salt; throws if it is wrong.
  async function unlock(pass, text) {
    const kdf = kdfOf(text);
    if (!kdf) throw new Error('not a sealed file');
    const vault = await derive(pass, kdf);
    await open(vault, text);
    return vault;
  }

  return { FORMAT, ITERATIONS, MIN_LENGTH, SALT, weakness, derive, hid, isSealed, kdfOf, kidOf, matches, seal, open, unlock };
});
