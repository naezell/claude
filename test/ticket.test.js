// Flag a problem, server side (netlify/functions/lib/ticket.mjs): files a GitHub issue, keeps
// the blanked-out picture where the issue can show it, and only for Mark.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'netlify', 'functions', 'lib', 'ticket.mjs')).href);
const JPEG = `data:image/jpeg;base64,${Buffer.from('fake jpeg bytes').toString('base64')}`;

async function setup(opts = {}) {
  const { ticketHandler } = await load();
  const m = new Map();
  const store = {
    async get(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; },
    async setJSON(k, v) { m.set(k, JSON.stringify(v)); },
    async delete(k) { m.delete(k); },
    async list() { return { blobs: [...m.keys()].map((key) => ({ key })) }; },
  };
  const sent = [];
  let clock = 1_800_000_000_000;
  const handle = ticketHandler({
    store, token: 'tok', repo: 'owner/repo', now: () => clock,
    verifySession: async (req) => (req.headers.get('cookie') === 'ok' ? 'mark@example.com' : null),
    send: async (url, init) => { sent.push({ url, init, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ number: 7 }), { status: 201 }); },
    ...opts,
  });
  const call = async (method, p, body, mark = true) => {
    const res = await handle(new Request(`https://site.test/api/ticket${p}`, { method, headers: mark ? { cookie: 'ok' } : {}, body: body == null ? undefined : JSON.stringify(body) }));
    return res;
  };
  return { call, sent, store: m, tick: (ms) => { clock += ms; } };
}

test('ticket: filed as a GitHub issue with where, what and the picture', async () => {
  const { call, sent } = await setup();
  const res = await call('POST', '', { tab: 'cash', tabLabel: 'Cash forecast', section: 'cash:chart', sectionLabel: 'Weekly cash', comment: 'Line stops early <b>@nate</b>', details: 'Version: abc1234', image: JPEG });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, number: 7 });
  assert.equal(sent.length, 1);
  const { url, init, body } = sent[0];
  assert.equal(url, 'https://api.github.com/repos/owner/repo/issues');
  assert.equal(init.headers.Authorization, 'Bearer tok');
  assert.deepEqual(body.labels, ['ticket']);
  assert.equal(body.title, 'Cash forecast › Weekly cash: Line stops early ‹b›@​nate‹/b›');
  assert.ok(!/<b>|@nate/.test(body.body), 'no HTML or mentions');
  assert.match(body.body, /Version: abc1234/);
  assert.match(body.body, /mark@\u200b?example\.com/);
  // The picture opens from the issue without sign-in.
  const img = body.body.match(/https:\/\/site\.test(\/api\/ticket\/img\/[A-Za-z0-9_-]{32}\.jpg)/)[1];
  const got = await call('GET', img.replace('/api/ticket', ''), null, false);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/jpeg');
  assert.equal(Buffer.from(await got.arrayBuffer()).toString(), 'fake jpeg bytes');
});

test('ticket: needs sign-in, a comment and the token; pictures expire', async () => {
  const { call, sent, tick } = await setup();
  assert.equal((await call('POST', '', { comment: 'x' }, false)).status, 401);
  assert.equal((await call('POST', '', { comment: '  ' })).status, 400);
  assert.equal((await call('POST', '', { comment: 'x', image: 'data:image/png;base64,AAAA' })).status, 400);
  assert.equal((await call('GET', '/img/short.jpg', null, false)).status, 404);
  assert.equal(sent.length, 0);
  const none = await setup({ token: '' });
  assert.equal((await none.call('POST', '', { comment: 'x' })).status, 503);
  await call('POST', '', { tabLabel: 'Home', comment: 'x', image: JPEG });
  const img = sent[0].body.body.match(/(\/img\/[A-Za-z0-9_-]{32}\.jpg)/)[1];
  assert.equal(sent[0].body.title, 'Home (whole page): x');
  tick(121 * 864e5);
  assert.equal((await call('GET', img, null, false)).status, 404);
});

test('ticket pictures are public (for the issue); filing a ticket is not', async () => {
  const A = await import(pathToFileURL(path.join(__dirname, '..', 'netlify', 'edge-functions', 'lib', 'auth.js')).href);
  assert.ok(A.isPublic('/api/ticket/img/abcdefghijklmnopqrstuvwxyz012345.jpg'));
  assert.ok(!A.isPublic('/api/ticket'));
  assert.ok(!A.isPublic('/api/ticket/img/../../index.html'));
  assert.ok(!A.isPublic('/src/ui/ticket.js'));
});
