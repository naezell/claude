// The client portal's server side. It only ever holds sealed data (see src/sealed.js): the
// questions Mark's browser sealed, and the answers the client's browser sealed. It cannot read
// either. Records live in Netlify Blobs under a hash of the link id, and are deleted when Mark
// collects the answers, when he cancels the link, or when the link expires.
//
//   POST /api/portal/create  { id, box, expiresAt, replaces? }   Mark (signed in)
//   GET  /api/portal/q?id=   → { box, answers?, expiresAt }      client (anyone with the link)
//   POST /api/portal/answer  { id, answers }                     client
//   POST /api/portal/inbox   { ids: [...] } → { items, gone }    Mark
//   POST /api/portal/done    { id }                              Mark

export const MAX_DAYS = 45;
export const MAX_QUESTIONS_BYTES = 512 * 1024;
export const MAX_ANSWERS_BYTES = 4 * 1024 * 1024;
export const MAX_SUBMISSIONS = 25;
const ID = /^[A-Za-z0-9_-]{22}$/;
const SEALED = /^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/;

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

async function hashId(id) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`portal:${id}`));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// `store`: a Netlify Blobs store (get, setJSON, delete, list). `verifySession(request)`
// resolves to the signed-in email or null. `now()` is replaceable for tests.
export function portalHandler({ store, verifySession, now = () => Date.now() }) {
  const load = async (id) => {
    const rec = await store.get(await hashId(id), { type: 'json' });
    if (!rec) return null;
    if (rec.expiresAt < now()) { await store.delete(await hashId(id)); return null; }
    return rec;
  };
  const body = async (request, limit) => {
    const text = await request.text();
    if (text.length > limit) throw Object.assign(new Error('The photos are too large to send together. Remove one or two and try again.'), { status: 413 });
    try { return JSON.parse(text); } catch (e) { throw Object.assign(new Error('not JSON'), { status: 400 }); }
  };
  // Removes expired records; run now and then when Mark creates a link.
  const sweep = async () => {
    try {
      const { blobs } = await store.list();
      for (const b of blobs || []) {
        const rec = await store.get(b.key, { type: 'json' });
        if (!rec || rec.expiresAt < now()) await store.delete(b.key);
      }
    } catch (e) { /* cleanup is best effort */ }
  };

  return async (request) => {
    const url = new URL(request.url);
    const action = url.pathname.replace(/^\/api\/portal\/?/, '');
    try {
      if (action === 'q' && request.method === 'GET') {
        const id = url.searchParams.get('id') || '';
        if (!ID.test(id)) return json(400, { error: 'This link is not complete. Open it from the email again.' });
        const rec = await load(id);
        if (!rec) return json(404, { error: 'This link has expired or the answers were already received.' });
        return json(200, { box: rec.box, answers: rec.answers || null, expiresAt: rec.expiresAt });
      }
      if (action === 'answer' && request.method === 'POST') {
        const { id, answers } = await body(request, MAX_ANSWERS_BYTES + 1024);
        if (!ID.test(id || '') || !SEALED.test(answers || '')) return json(400, { error: 'Something was missing from the answers.' });
        const rec = await load(id);
        if (!rec) return json(404, { error: 'This link has expired or the answers were already received.' });
        if ((rec.submissions || 0) >= MAX_SUBMISSIONS) return json(429, { error: 'These answers have been sent many times already. Please contact your bookkeeper.' });
        await store.setJSON(await hashId(id), { ...rec, answers, answeredAt: now(), submissions: (rec.submissions || 0) + 1 });
        return json(200, { ok: true });
      }

      // Everything else is Mark's, and needs him signed in.
      const who = await verifySession(request);
      if (!who) return json(401, { error: 'Sign in required' });
      if (request.method !== 'POST') return json(405, { error: 'Method not allowed' });

      if (action === 'create') {
        const { id, box, expiresAt, replaces } = await body(request, MAX_QUESTIONS_BYTES + 1024);
        if (!ID.test(id || '') || !SEALED.test(box || '')) return json(400, { error: 'bad request' });
        const until = Math.min(Number(expiresAt) || 0, now() + MAX_DAYS * 864e5);
        if (until <= now()) return json(400, { error: 'bad expiry' });
        if (replaces && ID.test(replaces)) await store.delete(await hashId(replaces));
        await store.setJSON(await hashId(id), { box, createdAt: now(), expiresAt: until, by: who });
        if (Math.random() < 0.25) await sweep();
        return json(200, { ok: true, expiresAt: until });
      }
      if (action === 'inbox') {
        const { ids } = await body(request, 64 * 1024);
        const items = [], gone = [];
        for (const id of (Array.isArray(ids) ? ids : []).slice(0, 500)) {
          if (!ID.test(id)) continue;
          const rec = await load(id);
          if (!rec) gone.push(id);
          else if (rec.answers) items.push({ id, answers: rec.answers, answeredAt: rec.answeredAt });
        }
        return json(200, { items, gone });
      }
      if (action === 'done') {
        const { id } = await body(request, 1024);
        if (!ID.test(id || '')) return json(400, { error: 'bad request' });
        await store.delete(await hashId(id));
        return json(200, { ok: true });
      }
      return json(404, { error: 'Not found' });
    } catch (e) {
      return json(e.status || 500, { error: e.status ? e.message : 'Something went wrong. Please try again.' });
    }
  };
}
