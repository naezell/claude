// Problem tickets: Mark flags a part of the app, and this files it as a GitHub issue in the
// app's repository, where Claude picks it up. The screenshot comes already blanked out (amounts
// and names are replaced in the browser before the picture is taken, see src/ui/ticket.js), and
// is kept in Netlify Blobs under a long random id so the issue can show it.
//
//   POST /api/ticket          { tab, tabLabel, section, sectionLabel, comment, details, image? }   Mark (signed in)
//   GET  /api/ticket/img/<id>.jpg                                                                  public (unguessable id)

export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
export const MAX_COMMENT = 5000;
export const KEEP_DAYS = 120;
const IMG_ID = /^[A-Za-z0-9_-]{32}$/;
const JPEG = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/;

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

const clip = (v, n) => String(v == null ? '' : v).replace(/\r/g, '').slice(0, n);
// Plain text for GitHub markdown: no HTML, no @mentions that would ping people, no images.
const plain = (v, n) => clip(v, n).replace(/[<>]/g, (c) => (c === '<' ? '‹' : '›')).replace(/@(?=\w)/g, '@​').replace(/!\[/g, '!​[');

function newId() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_');
}

// `store`: Netlify Blobs (get, setJSON, delete, list). `verifySession(request)` resolves to the
// signed-in email or null. `token`/`repo`: where issues go. `send`: fetch, replaceable in tests.
export function ticketHandler({ store, verifySession, token, repo, send = fetch, now = () => Date.now() }) {
  const sweep = async () => {
    try {
      const { blobs } = await store.list();
      for (const b of blobs || []) {
        const rec = await store.get(b.key, { type: 'json' });
        if (!rec || rec.createdAt + KEEP_DAYS * 864e5 < now()) await store.delete(b.key);
      }
    } catch (e) { /* cleanup is best effort */ }
  };

  return async (request) => {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/ticket\/?/, '');
    try {
      const img = path.match(/^img\/([A-Za-z0-9_-]+)\.jpg$/);
      if (img && request.method === 'GET') {
        if (!IMG_ID.test(img[1])) return json(404, { error: 'Not found' });
        const rec = await store.get(img[1], { type: 'json' });
        if (!rec || rec.createdAt + KEEP_DAYS * 864e5 < now()) return json(404, { error: 'Not found' });
        const bytes = Uint8Array.from(atob(rec.data), (c) => c.charCodeAt(0));
        return new Response(bytes, { status: 200, headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400', 'X-Robots-Tag': 'noindex' } });
      }

      if (path !== '' || request.method !== 'POST') return json(404, { error: 'Not found' });
      const who = await verifySession(request);
      if (!who) return json(401, { error: 'Sign in required' });
      if (!token || !repo) return json(503, { error: 'Tickets are not set up on the site yet. Use Email the report instead.' });
      const text = await request.text();
      if (text.length > MAX_IMAGE_BYTES * 1.4 + 64 * 1024) return json(413, { error: 'The picture is too large. Send it without the picture.' });
      let t;
      try { t = JSON.parse(text); } catch (e) { return json(400, { error: 'bad request' }); }
      const comment = plain(t.comment, MAX_COMMENT).trim();
      if (!comment) return json(400, { error: 'Say what is wrong first.' });

      let imageUrl = '';
      if (t.image) {
        const m = JPEG.exec(String(t.image));
        if (!m) return json(400, { error: 'The picture could not be read.' });
        if (m[1].length * 0.75 > MAX_IMAGE_BYTES) return json(413, { error: 'The picture is too large. Send it without the picture.' });
        const id = newId();
        await store.setJSON(id, { data: m[1], createdAt: now() });
        imageUrl = `${url.origin}/api/ticket/img/${id}.jpg`;
        if (Math.random() < 0.2) await sweep();
      }

      const tabLabel = plain(t.tabLabel || t.tab || 'Unknown tab', 80);
      const sectionLabel = plain(t.sectionLabel || '', 120);
      const where = sectionLabel ? `${tabLabel} › ${sectionLabel}` : `${tabLabel} (whole page)`;
      const ids = [t.tab, t.section].filter(Boolean).map((x) => plain(x, 60).replace(/`/g, '')).join(' / ');
      const firstLine = comment.split('\n')[0];
      const title = `${where}: ${firstLine.length > 70 ? `${firstLine.slice(0, 67)}…` : firstLine}`;
      // App version, browser, recent errors (src/diagnostics.js): no client names or figures.
      const details = clip(t.details, 4000).replace(/`{3,}/g, "'''").trim();
      const body = [
        `**Where:** ${where}${ids ? ` (\`${ids}\`)` : ''}`,
        `**From:** ${plain(who, 120)}`,
        '',
        '**What is wrong:**',
        comment.split('\n').map((l) => `> ${l}`).join('\n'),
        '',
        imageUrl ? `![Screenshot of the flagged part](${imageUrl})\n\n_Amounts and names were blanked out before the picture was taken. The picture is deleted after ${KEEP_DAYS} days._` : '_No picture was sent._',
        '',
        details ? `<details><summary>Technical details</summary>\n\n\`\`\`text\n${details}\n\`\`\`\n\n</details>` : '',
        '',
        '---',
        '_Filed from Ledger Lens with Flag a problem. Claude proposes a fix here; reply **go** to have it built._',
      ].join('\n');

      const res = await send(`https://api.github.com/repos/${repo}/issues`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ledger-lens-tickets', 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, body, labels: ['ticket'] }),
      });
      if (!res.ok) return json(502, { error: `GitHub did not accept the ticket (${res.status}). Use Email the report instead.` });
      const issue = await res.json();
      return json(200, { ok: true, number: issue.number });
    } catch (e) {
      return json(500, { error: 'Something went wrong. Please try again.' });
    }
  };
}
