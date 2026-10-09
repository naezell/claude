// Encryption with the Ledger Lens passphrase (src/vault.js): passphrase to keys, sealing, opening.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const V = require('../src/vault.js');

const FAST = 1000; // fewer PBKDF2 rounds keep the tests quick; the app uses V.ITERATIONS

const opts = { iterations: FAST };

test('a sealed backup opens with the same passphrase on another device, and with nothing else', async () => {
  const laptop = await V.derive('correct horse battery staple', opts);
  const secret = JSON.stringify({ format: 'ledger-lens-clients', clients: { a: { name: 'Harbor Pine Design Co.' } } });
  const sealed = await V.seal(laptop, secret);
  assert.ok(V.isSealed(sealed));
  assert.doesNotMatch(sealed, /Harbor|ledger-lens-clients/);
  const o = JSON.parse(sealed);
  assert.equal(o.format, 'ledger-lens-sealed');
  assert.deepEqual(o.kdf, { name: 'PBKDF2-SHA256', iterations: FAST, salt: V.SALT });
  assert.equal(o.kid, laptop.kid);
  // The phone only has the passphrase: the same words give the same key and fingerprint.
  const phone = await V.derive('correct horse battery staple', opts);
  assert.equal(phone.kid, laptop.kid);
  assert.equal(await V.open(phone, sealed), secret);
  assert.ok(V.matches(phone, sealed));
  // From the file's own settings, too.
  assert.equal(await V.open(await V.unlock('correct horse battery staple', sealed), sealed), secret);
  await assert.rejects(() => V.unlock('correct horse battery stapler', sealed), (e) => e.wrongPassphrase === true);
  // Other words: a different fingerprint, and it does not open.
  const other = await V.derive('correct horse battery stapler', opts);
  assert.notEqual(other.kid, laptop.kid);
  assert.ok(!V.matches(other, sealed));
  await assert.rejects(() => V.open(other, sealed), /does not match/);
});

test('client ids become opaque record names that depend on the passphrase', async () => {
  const a = await V.derive('a long enough passphrase', opts);
  const b = await V.derive('another long passphrase', opts);
  const name = await V.hid(a, 'harbor pine design co');
  assert.match(name, /^h:[0-9a-f]{32}$/);
  assert.equal(await V.hid(a, 'harbor pine design co'), name);
  assert.notEqual(await V.hid(a, 'riverbend plumbing'), name);
  assert.notEqual(await V.hid(b, 'harbor pine design co'), name);
  assert.equal(a.mac.extractable, false);
});

test('each seal uses a new IV, tampering is detected, and the key cannot be read out', async () => {
  const v = await V.derive('a long enough passphrase', opts);
  const a = await V.seal(v, 'same text');
  const b = await V.seal(v, 'same text');
  assert.notEqual(JSON.parse(a).data, JSON.parse(b).data);
  const o = JSON.parse(a);
  const [iv, body] = o.data.split('.');
  const flipped = body.slice(0, -2) + (body.slice(-2) === 'AA' ? 'AB' : 'AA');
  await assert.rejects(() => V.open(v, JSON.stringify({ ...o, data: `${iv}.${flipped}` })));
  assert.equal(v.key.extractable, false);
  await assert.rejects(() => globalThis.crypto.subtle.exportKey('raw', v.key));
});

test('large client files are compressed before sealing', async () => {
  const v = await V.derive('a long enough passphrase', opts);
  const big = 'Date,Transaction Type,Name,Amount\n'.repeat(20000);
  const sealed = await V.seal(v, big);
  assert.equal(JSON.parse(sealed).zip, true);
  assert.ok(sealed.length < big.length / 10, `${sealed.length} vs ${big.length}`);
  assert.equal(await V.open(v, sealed), big);
});

test('old unencrypted backups are recognized as not sealed', () => {
  assert.equal(V.isSealed(JSON.stringify({ format: 'ledger-lens-clients', clients: {} })), false);
  assert.equal(V.isSealed(JSON.stringify({ format: 'ledger-lens-files', enc: 'gzip', data: '' })), false);
  assert.equal(V.isSealed('not json'), false);
  assert.equal(V.kdfOf('not json'), null);
});

test('weak passphrases are refused with a reason', () => {
  assert.match(V.weakness('short'), /at least 12/);
  assert.match(V.weakness('aaaaaaaaaaaaaaa'), /repeated/);
  assert.match(V.weakness('Password12345'), /less common/);
  assert.equal(V.weakness('blue canoe at seven lakes'), '');
  assert.equal(V.ITERATIONS, 600000);
});
