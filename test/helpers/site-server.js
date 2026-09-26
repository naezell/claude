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

function start() {
  const headers = siteHeaders();
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    if (p === '/login') p = '/login.html';
    const file = path.join(DIST, path.normalize(p));
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, headers); res.end('not found'); return; }
    res.writeHead(200, { ...headers, 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, headers })));
}

module.exports = { build, start, siteHeaders };
