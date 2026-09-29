// Serves the built site (dist/) over HTTP the way Netlify does: the headers from netlify.toml,
// including the Content-Security-Policy, and /login for login.html. The sign-in gate itself is
// tested separately (auth.test.js), so every page is served without it.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.csv': 'text/csv' };

// The [[headers]] block for "/*" in netlify.toml, as { name: value }.
function siteHeaders() {
  const toml = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
  const block = toml.split('[[headers]]').find((b) => /for = "\/\*"/.test(b)) || '';
  const out = {};
  for (const m of block.matchAll(/^\s*([A-Za-z-]+) = "(.*)"\s*$/gm)) if (m[1] !== 'for') out[m[1]] = m[2];
  return out;
}

function build() { execSync('sh scripts/build-site.sh', { cwd: ROOT, stdio: 'ignore' }); }

// The portal's endpoints, with Netlify Blobs kept in memory and anyone treated as signed in.
async function portalApi() {
  const { pathToFileURL } = require('url');
  const { portalHandler } = await import(pathToFileURL(path.join(ROOT, 'netlify', 'functions', 'lib', 'portal.mjs')).href);
  const m = new Map();
  const store = {
    async get(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; },
    async setJSON(k, v) { m.set(k, JSON.stringify(v)); },
    async delete(k) { m.delete(k); },
    async list() { return { blobs: [...m.keys()].map((key) => ({ key })) }; },
  };
  return { store: m, handle: portalHandler({ store, verifySession: async () => 'mark@example.com' }) };
}

// The ticket endpoint, with GitHub replaced by a list of the issues it would have filed.
async function ticketApi() {
  const { pathToFileURL } = require('url');
  const { ticketHandler } = await import(pathToFileURL(path.join(ROOT, 'netlify', 'functions', 'lib', 'ticket.mjs')).href);
  const m = new Map();
  const issues = [];
  const store = {
    async get(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; },
    async setJSON(k, v) { m.set(k, JSON.stringify(v)); },
    async delete(k) { m.delete(k); },
    async list() { return { blobs: [...m.keys()].map((key) => ({ key })) }; },
  };
  const send = async (url, init) => { issues.push({ url, ...JSON.parse(init.body) }); return new Response(JSON.stringify({ number: issues.length }), { status: 201 }); };
  return { issues, handle: ticketHandler({ store, verifySession: async () => 'mark@example.com', token: 'test-token', repo: 'owner/repo', send }) };
}

async function start() {
  const headers = siteHeaders();
  const portal = await portalApi();
  const ticket = await ticketApi();
  const server = http.createServer(async (req, res) => {
    const api = req.url.startsWith('/api/portal/') ? portal : req.url.startsWith('/api/ticket') ? ticket : null;
    if (api) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const r = await api.handle(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }));
      res.writeHead(r.status, { ...headers, 'Content-Type': r.headers.get('Content-Type') || 'application/json' });
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    if (p === '/login') p = '/login.html';
    if (p === '/portal') p = '/portal.html';
    const file = path.join(DIST, path.normalize(p));
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, headers); res.end('not found'); return; }
    res.writeHead(200, { ...headers, 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, headers, portalStore: portal.store, tickets: ticket.issues })));
}

module.exports = { build, start, siteHeaders };
