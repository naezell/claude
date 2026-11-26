const { test } = require('node:test');
const assert = require('node:assert/strict');

function memoryStore() {
  const items = new Map();
  let revision = 0;
  return {
    items,
    async get(key) { return items.get(key)?.data ?? null; },
    async getWithMetadata(key) { return items.get(key) ?? null; },
    async setJSON(key, data, rule = {}) {
      if ((rule.onlyIfNew && items.has(key)) || (rule.onlyIfMatch && items.get(key)?.etag !== rule.onlyIfMatch)) return { modified: false };
      const etag = String(++revision);
      items.set(key, { data, etag });
      return { modified: true, etag };
    },
    async delete(key) { items.delete(key); },
    async list({ prefix }) { return { blobs: [...items.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) }; },
  };
}
const settings = {
  client: 'sandbox-client', secret: 'sandbox-secret', origin: 'https://books.example.com',
  redirect: 'https://books.example.com/api/qbo/callback', key: Buffer.alloc(32, 45), sandbox: true,
};
const record = (date, id) => ({
  Id: id, TxnDate: date, EntityRef: { name: 'Supply store' },
  Line: [{ Id: '1', Amount: 187, AccountBasedExpenseLineDetail: { AccountRef: { value: '8' } } }],
});

test('QuickBooks scopes company access, refreshes once, and watches posted activity', async () => {
  const { createQbo } = await import('../netlify/functions/lib/qbo.mjs');
  const store = memoryStore();
  let at = Date.parse('2026-10-25T11:00:00Z');
  let refreshes = 0;
  const client = createQbo({ config: settings, store, now: () => at, fetchFn: async (input, options) => {
    const url = new URL(input);
    if (url.hostname === 'oauth.platform.intuit.com') {
      const refresh = options.body.get('grant_type') === 'refresh_token';
      if (refresh) { assert.equal(options.body.get('refresh_token'), 'refresh-only-on-server'); refreshes++; }
      return Response.json({ access_token: refresh ? 'new-access-only-on-server' : 'access-only-on-server', refresh_token: refresh ? 'rotated-refresh' : 'refresh-only-on-server', expires_in: 3600 });
    }
    if (url.pathname.endsWith('/companyinfo/123')) return Response.json({ CompanyInfo: { CompanyName: 'Oak Services' } });
    const entity = url.searchParams.get('query').match(/FROM (\w+)/)[1];
    const entries = entity === 'Account' ? [{ Id: '8', Name: 'Ask My Accountant' }]
      : entity === 'Purchase' ? [
        record('2026-09-06', '1'), record('2026-10-03', '2'), record('2026-10-06', '3'),
        record('2026-10-08', '4'), record('2026-10-09', '5'), record('2026-10-12', '6'),
      ] : [];
    assert.equal(options.headers.Authorization, 'Bearer new-access-only-on-server');
    return Response.json({ QueryResponse: { [entity]: entries } });
  } });
  const { url, state } = await client.start('mark@example.com');
  assert.equal(new URL(url).searchParams.get('scope'), 'com.intuit.quickbooks.accounting');
  const params = new URLSearchParams({ code: 'single-use', state, realmId: '123' });
  await assert.rejects(client.connect('other@example.com', params), /expired/);
  await client.connect('mark@example.com', params);
  await assert.rejects(client.connect('mark@example.com', params), /expired/);
  await assert.rejects(client.chaserCsv('other@example.com', '123', '2026-10'), /not found/);
  assert.doesNotMatch(JSON.stringify([...store.items]), /Oak Services|refresh-only-on-server|access-only-on-server/);
  at += 7200000;
  await client.edit('mark@example.com', '123', '2026-08-31');
  const status = await client.scan(client.companyKey('mark@example.com', '123'));
  assert.deepEqual(status.flags, ['Recorded reconciliation date is behind.', 'Posted uncategorized purchases and deposits rose from 1 to 5.']);
  const pull = await client.chaserCsv('mark@example.com', '123', '2026-10');
  const E = require('../src/engine');
  const parsed = E.parseTransactions(pull.csv);
  assert.equal(parsed.meta.company, 'Oak Services');
  assert.equal(E.clientQuestions(E.analyze(parsed)).rows.length, 6);
  assert.equal(refreshes, 1);
});

test('public health leads require consent and share only the prospect’s contact information', async () => {
  const { healthHandler } = await import('../netlify/functions/health-check.mjs');
  const environment = { ADVISORY_ORIGIN: settings.origin, ADVISORY_LEADS_TO: 'inbox@example.com', ADVISORY_MAIL_FROM: 'Firm <contact@example.com>', ADVISORY_RESEND_KEY: 'key' };
  const sent = [];
  const handler = healthHandler({
    env: { get: (k) => environment[k] }, store: memoryStore(), ip: '192.0.2.5',
    fetchFn: async (url, options) => { sent.push(JSON.parse(options.body)); return Response.json({ id: 'mail-id' }); },
  });
  const submit = (consent, origin = settings.origin) => handler(new Request(settings.origin + '/api/health-check/lead', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Jordan', company: 'Company', email: 'owner@example.com', consent, score: 54, report: 'Confidential amounts', id: 'z'.repeat(43) }),
  }));
  assert.equal((await submit(false)).status, 400);
  assert.equal((await submit(true, 'https://other.example.com')).status, 405);
  assert.equal((await submit(true)).status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].reply_to, 'owner@example.com');
  assert.doesNotMatch(sent[0].text, /54|Confidential/);
});
