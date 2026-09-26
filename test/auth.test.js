// Sign-in checks used by the Netlify edge functions (netlify/edge-functions/lib/auth.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { webcrypto } = require('crypto');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'netlify', 'edge-functions', 'lib', 'auth.js')).href);
const SECRET = 'x'.repeat(40);
const b64url = (buf) => Buffer.from(buf).toString('base64url');

// A stand-in for Google: an RSA key pair, its public key as a JWKS, and signed ID tokens.
async function fakeGoogle() {
  const pair = await webcrypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = await webcrypto.subtle.exportKey('jwk', pair.publicKey);
  const keys = [{ ...jwk, kid: 'k1', alg: 'RS256', use: 'sig' }];
  const token = async (claims, { kid = 'k1', key = pair.privateKey } = {}) => {
    const h = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
    const p = b64url(JSON.stringify(claims));
    const sig = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', key, Buffer.from(`${h}.${p}`));
    return `${h}.${p}.${b64url(sig)}`;
  };
  return { keys, token, pair };
}

test('sessions: signed, expiring, tamper-proof, and cut off when an email is removed', async () => {
  const A = await load();
  const allowed = A.allowedList('Mark@Example.com, owner@example.com\nthird@example.com');
  assert.deepEqual([...allowed].sort(), ['mark@example.com', 'owner@example.com', 'third@example.com']);
  const now = 1_800_000_000;
  const v = await A.signSession('Mark@example.com', SECRET, now);
  assert.equal(await A.readSession(v, SECRET, allowed, now + 60), 'mark@example.com');
  assert.equal(await A.readSession(v, SECRET, allowed, now + 31 * 86400), null, 'expires after 30 days');
  assert.equal(await A.readSession(v, 'y'.repeat(40), allowed, now), null, 'another secret');
  const [body, sig] = v.split('.');
  const forged = Buffer.from(JSON.stringify({ e: 'intruder@example.com', x: now + 1e6 })).toString('base64url');
  assert.equal(await A.readSession(`${forged}.${sig}`, SECRET, A.allowedList('intruder@example.com'), now), null, 'altered body');
  assert.equal(await A.readSession(`${body}.${sig.slice(0, -2)}AA`, SECRET, allowed, now), null, 'altered signature');
  assert.equal(await A.readSession(v, SECRET, A.allowedList('owner@example.com'), now), null, 'removed from the list');
  assert.equal(await A.readSession('', SECRET, allowed, now), null);
  assert.equal(await A.readSession('garbage', SECRET, allowed, now), null);
  await assert.rejects(() => A.signSession('a@b.c', 'short'), /at least 32/);
});

test('Google ID tokens: signature, app, issuer, expiry and verified email are all checked', async () => {
  const A = await load();
  const g = await fakeGoogle();
  const now = 1_800_000_000;
  const good = { iss: 'https://accounts.google.com', aud: 'client-1', exp: now + 600, email: 'Mark@Example.com', email_verified: true };
  const opts = { clientId: 'client-1', keys: g.keys, nowSec: now };
  assert.equal(await A.verifyGoogleToken(await g.token(good), opts), 'mark@example.com');
  await assert.rejects(async () => A.verifyGoogleToken(await g.token({ ...good, aud: 'other-app' }), opts), /another app/);
  await assert.rejects(async () => A.verifyGoogleToken(await g.token({ ...good, iss: 'evil.example' }), opts), /issuer/);
  await assert.rejects(async () => A.verifyGoogleToken(await g.token({ ...good, exp: now - 3600 }), opts), /expired/);
  await assert.rejects(async () => A.verifyGoogleToken(await g.token({ ...good, email_verified: false }), opts), /not verified/);
  await assert.rejects(async () => A.verifyGoogleToken(await g.token(good, { kid: 'nope' }), opts), /unknown signing key/);
  // Signed by someone else's key but claiming Google's key id.
  const other = await fakeGoogle();
  await assert.rejects(async () => A.verifyGoogleToken(await other.token(good), opts), /bad signature/);
  // Payload edited after signing.
  const t = await g.token(good);
  const [h, , s] = t.split('.');
  const edited = `${h}.${b64url(JSON.stringify({ ...good, email: 'intruder@example.com' }))}.${s}`;
  await assert.rejects(() => A.verifyGoogleToken(edited, opts), /bad signature/);
  await assert.rejects(() => A.verifyGoogleToken('not-a-token', opts), /malformed/);
});

test('cookies, public paths and the after-sign-in redirect', async () => {
  const A = await load();
  const req = { headers: new Map([['cookie', 'a=1; ll_session=abc.def; b=2']]) };
  req.headers.get = req.headers.get.bind(req.headers);
  assert.equal(A.getCookie(req, 'll_session'), 'abc.def');
  assert.match(A.sessionCookie('v'), /HttpOnly; Secure; SameSite=Lax/);
  assert.match(A.clearCookie(), /Max-Age=0/);
  assert.equal(A.safeNext('/?tab=cash'), '/?tab=cash');
  for (const bad of ['//evil.example', 'https://evil.example', '/\\evil.example', '', null]) assert.equal(A.safeNext(bad), '/', String(bad));
  assert.ok(A.isPublic('/login') && A.isPublic('/auth/verify') && A.isPublic('/assets/7d-logo.png'));
  assert.ok(!A.isPublic('/') && !A.isPublic('/src/engine.js') && !A.isPublic('/index.html'));
});

test('edge functions end to end: gate redirects, sign-in sets the cookie, then the app loads', async () => {
  const A = await load();
  const g = await fakeGoogle();
  const env = { SESSION_SECRET: SECRET, GOOGLE_CLIENT_ID: 'client-1', ALLOWED_EMAILS: 'mark@example.com' };
  globalThis.Netlify = { env: { get: (k) => env[k] } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => (String(url).includes('oauth2/v3/certs') ? new Response(JSON.stringify({ keys: g.keys })) : realFetch(url));
  A.resetKeyCache();
  try {
    const dir = pathToFileURL(path.join(__dirname, '..', 'netlify', 'edge-functions')).href;
    const gate = (await import(`${dir}/gate.js`)).default;
    const auth = (await import(`${dir}/auth.js`)).default;
    const next = async () => new Response('the app', { headers: { 'Content-Type': 'text/html' } });
    const ctx = { next };
    // Not signed in: pages go to the sign-in page, files are refused, the sign-in page loads.
    let r = await gate(new Request('https://site.example/?tab=cash', { headers: { accept: 'text/html' } }), ctx);
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), 'https://site.example/login?next=%2F%3Ftab%3Dcash');
    r = await gate(new Request('https://site.example/src/engine.js'), ctx);
    assert.equal(r.status, 401);
    r = await gate(new Request('https://site.example/login'), ctx);
    assert.equal(await r.text(), 'the app');
    // Sign in with a token for an allowed email.
    const now = Math.floor(Date.now() / 1000);
    const good = { iss: 'accounts.google.com', aud: 'client-1', exp: now + 600, email: 'mark@example.com', email_verified: true };
    r = await auth(new Request('https://site.example/auth/verify', { method: 'POST', headers: { origin: 'https://site.example', 'content-type': 'application/json' }, body: JSON.stringify({ credential: await g.token(good) }) }));
    assert.equal(r.status, 200);
    const cookie = r.headers.get('set-cookie');
    assert.match(cookie, /^ll_session=.+; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax$/);
    const value = cookie.split(';')[0];
    r = await gate(new Request('https://site.example/', { headers: { cookie: value, accept: 'text/html' } }), ctx);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), 'the app');
    assert.equal(r.headers.get('cache-control'), 'private, no-store');
    // Someone not on the list, a request from another site, and signing out.
    r = await auth(new Request('https://site.example/auth/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: await g.token({ ...good, email: 'stranger@example.com' }) }) }));
    assert.equal(r.status, 403);
    assert.match((await r.json()).error, /not on the list/);
    r = await auth(new Request('https://site.example/auth/verify', { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' }));
    assert.equal(r.status, 403);
    r = await auth(new Request('https://site.example/auth/logout'));
    assert.equal(r.status, 302);
    assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
    // Taking the email off the list ends the session at the next request.
    env.ALLOWED_EMAILS = 'someone-else@example.com';
    r = await gate(new Request('https://site.example/', { headers: { cookie: value, accept: 'text/html' } }), ctx);
    assert.equal(r.status, 302);
    // Not configured yet: nobody gets in.
    delete env.SESSION_SECRET;
    env.ALLOWED_EMAILS = 'mark@example.com';
    r = await gate(new Request('https://site.example/', { headers: { cookie: value } }), ctx);
    assert.equal(r.status, 302, 'sent to sign in');
    r = await gate(new Request('https://site.example/src/app.js', { headers: { cookie: value } }), ctx);
    assert.equal(r.status, 401);
  } finally {
    globalThis.fetch = realFetch;
    delete globalThis.Netlify;
  }
});
