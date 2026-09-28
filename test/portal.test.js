// The client portal's server side (netlify/functions/lib/portal.mjs) and the sealing helper
// (src/sealed.js).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const Seal = require('../src/sealed.js');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'netlify', 'functions', 'lib', 'portal.mjs')).href);

// Netlify Blobs in memory.
function memoryStore() {
  const m = new Map();
  return {
    m,
    async get(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; },
    async setJSON(k, v) { m.set(k, JSON.stringify(v)); },
    async delete(k) { m.delete(k); },
    async list() { return { blobs: [...m.keys()].map((key) => ({ key })) }; },
  };
}

async function setup(opts = {}) {
  const { portalHandler } = await load();
  const store = memoryStore();
  let clock = 1_800_000_000_000;
  const handle = portalHandler({ store, now: () => clock, verifySession: async (req) => (req.headers.get('cookie') === 'ok' ? 'mark@example.com' : null), ...opts });
  const call = async (method, action, body, { mark = false, query = '' } = {}) => {
    const res = await handle(new Request(`https://site.test/api/portal/${action}${query}`, {
      method, headers: { 'Content-Type': 'application/json', ...(mark ? { cookie: 'ok' } : {}) }, body: body == null ? undefined : JSON.stringify(body),
    }));
    return { status: res.status, body: await res.json() };
  };
  return { store, call, tick: (ms) => { clock += ms; }, now: () => clock };
}

test('sealing: only the key in the link opens it, and changed data is refused', async () => {
  const { id, key } = Seal.newLink();
  assert.match(id, Seal.ID_PATTERN);
  assert.match(key, Seal.KEY_PATTERN);
  assert.deepEqual(Seal.fromHash(`#${id}.${key}`), { id, key });
  assert.equal(Seal.fromHash(`#${id}`), null);
  const sealed = await Seal.seal(key, { q: 'What was the $86.44 Amazon charge?' });
  assert.ok(!sealed.includes('Amazon'));
  assert.deepEqual(await Seal.open(key, sealed), { q: 'What was the $86.44 Amazon charge?' });
  await assert.rejects(Seal.open(Seal.newLink().key, sealed));
  const [iv, body] = sealed.split('.');
  const flipped = `${iv}.${body.slice(0, -2)}${body.slice(-2) === 'AA' ? 'AB' : 'AA'}`;
  await assert.rejects(Seal.open(key, flipped));
});

test('portal: Mark creates, the client reads and answers, Mark collects and it is deleted', async () => {
  const { call, store } = await setup();
  const { id, key } = Seal.newLink();
  const box = await Seal.seal(key, { questions: [{ ref: 'Q-1', question: 'What was this?' }] });
  // Creating needs Mark signed in.
  assert.equal((await call('POST', 'create', { id, box, expiresAt: Date.now() * 2 })).status, 401);
  const made = await call('POST', 'create', { id, box, expiresAt: 1_800_000_000_000 + 30 * 864e5 }, { mark: true });
  assert.equal(made.status, 200);
  // Stored under a hash of the id, and only sealed data.
  assert.equal(store.m.size, 1);
  const [storedKey, storedValue] = [...store.m.entries()][0];
  assert.ok(!storedKey.includes(id));
  assert.ok(!storedValue.includes('What was this'));
  // The client reads it without signing in.
  const q = await call('GET', 'q', null, { query: `?id=${id}` });
  assert.equal(q.status, 200);
  assert.deepEqual(await Seal.open(key, q.body.box), { questions: [{ ref: 'Q-1', question: 'What was this?' }] });
  assert.equal(q.body.answers, null);
  const answers = await Seal.seal(key, { answers: [{ ref: 'Q-1', answer: 'Printer paper' }] });
  assert.equal((await call('POST', 'answer', { id, answers })).status, 200);
  // Mark's inbox needs sign-in, then returns the sealed answers.
  assert.equal((await call('POST', 'inbox', { ids: [id] })).status, 401);
  const inbox = await call('POST', 'inbox', { ids: [id] }, { mark: true });
  assert.equal(inbox.body.items.length, 1);
  assert.deepEqual(await Seal.open(key, inbox.body.items[0].answers), { answers: [{ ref: 'Q-1', answer: 'Printer paper' }] });
  // Collected: gone from the site, and the link no longer opens.
  assert.equal((await call('POST', 'done', { id }, { mark: true })).status, 200);
  assert.equal(store.m.size, 0);
  assert.equal((await call('GET', 'q', null, { query: `?id=${id}` })).status, 404);
  assert.deepEqual((await call('POST', 'inbox', { ids: [id] }, { mark: true })).body.gone, [id]);
});

test('portal: links expire, are capped at 45 days, and a new link replaces the old one', async () => {
  const { call, tick, store, now } = await setup();
  const a = Seal.newLink();
  const box = await Seal.seal(a.key, { x: 1 });
  const made = await call('POST', 'create', { id: a.id, box, expiresAt: now() + 400 * 864e5 }, { mark: true });
  assert.equal(made.body.expiresAt, now() + 45 * 864e5);
  const b = Seal.newLink();
  await call('POST', 'create', { id: b.id, box: await Seal.seal(b.key, { x: 2 }), expiresAt: now() + 864e5, replaces: a.id }, { mark: true });
  assert.equal((await call('GET', 'q', null, { query: `?id=${a.id}` })).status, 404);
  assert.equal(store.m.size, 1);
  tick(2 * 864e5);
  assert.equal((await call('GET', 'q', null, { query: `?id=${b.id}` })).status, 404);
  assert.equal(store.m.size, 0);
});

test('portal: refuses bad ids, oversized answers and endless resubmits', async () => {
  const { call, now } = await setup();
  const { MAX_ANSWERS_BYTES, MAX_SUBMISSIONS } = await load();
  assert.equal((await call('GET', 'q', null, { query: '?id=short' })).status, 400);
  assert.equal((await call('POST', 'answer', { id: 'x', answers: 'y' })).status, 400);
  const { id, key } = Seal.newLink();
  await call('POST', 'create', { id, box: await Seal.seal(key, {}), expiresAt: now() + 864e5 }, { mark: true });
  const big = `${'A'.repeat(16)}.${'B'.repeat(MAX_ANSWERS_BYTES + 2048)}`;
  assert.equal((await call('POST', 'answer', { id, answers: big })).status, 413);
  const ok = await Seal.seal(key, { answers: [] });
  for (let i = 0; i < MAX_SUBMISSIONS; i++) assert.equal((await call('POST', 'answer', { id, answers: ok })).status, 200);
  assert.equal((await call('POST', 'answer', { id, answers: ok })).status, 429);
  // Mark's actions are never open to the public.
  for (const action of ['create', 'inbox', 'done']) assert.equal((await call('POST', action, {})).status, 401, action);
});

test('the portal page and its two endpoints are public; everything else of the portal needs sign-in', async () => {
  const A = await import(pathToFileURL(path.join(__dirname, '..', 'netlify', 'edge-functions', 'lib', 'auth.js')).href);
  for (const p of ['/portal', '/portal.js', '/src/sealed.js', '/api/portal/q', '/api/portal/answer']) assert.ok(A.isPublic(p), p);
  for (const p of ['/api/portal/create', '/api/portal/inbox', '/api/portal/done', '/src/ui/portal.js']) assert.ok(!A.isPublic(p), p);
});
