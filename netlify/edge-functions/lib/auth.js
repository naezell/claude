// Sign-in checks shared by the edge functions. Plain Web Crypto, so the same code runs on
// Netlify's edge (Deno) and in the Node tests.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const COOKIE = 'll_session';
export const SESSION_DAYS = 30;

const b64url = (bytes) => {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64url = (str) => {
  const s = atob(String(str).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(str).length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

// The allowed list: comma, space or newline separated, case-insensitive.
export function allowedList(value) {
  return new Set(String(value || '').split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter((e) => e.includes('@')));
}

const hmacKey = (secret) => crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

// A session cookie: who signed in and until when, signed with the site's secret.
export async function signSession(email, secret, nowSec = Math.floor(Date.now() / 1000)) {
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  const body = b64url(enc.encode(JSON.stringify({ e: String(email).toLowerCase(), x: nowSec + SESSION_DAYS * 86400 })));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body));
  return `${body}.${b64url(sig)}`;
}

// The signed-in email, or null when the cookie is missing, altered, expired, or the
// person has since been taken off the allowed list.
export async function readSession(value, secret, allowed, nowSec = Math.floor(Date.now() / 1000)) {
  if (!value || !secret) return null;
  const [body, sig] = String(value).split('.');
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), unb64url(sig), enc.encode(body));
    if (!ok) return null;
    const { e, x } = JSON.parse(dec.decode(unb64url(body)));
    if (!e || !x || x < nowSec) return null;
    return allowed.has(e) ? e : null;
  } catch (err) { return null; }
}

export function getCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) {
      // A malformed cookie is treated as no cookie (sign in again) rather than an error page.
      try { return decodeURIComponent(part.slice(i + 1)); } catch (e) { return null; }
    }
  }
  return null;
}

export const sessionCookie = (value) => `${COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax`;
export const clearCookie = () => `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

// Only same-site paths after sign-in, so the login page cannot be used to send people elsewhere.
// Browsers drop tabs and line breaks from addresses ("/\t/evil.example" becomes "//evil.example"),
// so the path is resolved the way a browser would and must stay on this site.
export function safeNext(next) {
  if (typeof next !== 'string' || !/^\/(?![/\\])/.test(next) || /[\u0000-\u001f\u007f\\]/.test(next)) return '/';
  try {
    const base = 'https://ledger-lens.invalid';
    const u = new URL(next, base);
    return u.origin === base ? u.pathname + u.search + u.hash : '/';
  } catch (e) { return '/'; }
}

// Google's signing keys, cached for an hour.
let jwksCache = null;
export async function googleKeys(fetchFn = fetch, nowMs = Date.now()) {
  if (jwksCache && jwksCache.until > nowMs) return jwksCache.keys;
  const res = await fetchFn('https://www.googleapis.com/oauth2/v3/certs');
  if (!res.ok) throw new Error(`Google keys unavailable (${res.status})`);
  const { keys } = await res.json();
  jwksCache = { keys, until: nowMs + 3600e3 };
  return keys;
}
export const resetKeyCache = () => { jwksCache = null; };

// Checks a Google ID token ("Sign in with Google") and returns the verified email.
export async function verifyGoogleToken(token, { clientId, keys, nowSec = Math.floor(Date.now() / 1000) }) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const header = JSON.parse(dec.decode(unb64url(parts[0])));
  const claims = JSON.parse(dec.decode(unb64url(parts[1])));
  if (header.alg !== 'RS256') throw new Error('unexpected algorithm');
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error('unknown signing key');
  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, unb64url(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new Error('bad signature');
  if (claims.iss !== 'accounts.google.com' && claims.iss !== 'https://accounts.google.com') throw new Error('wrong issuer');
  if (claims.aud !== clientId) throw new Error('token is for another app');
  if (!claims.exp || claims.exp < nowSec - 60) throw new Error('token expired');
  if (claims.email_verified !== true && claims.email_verified !== 'true') throw new Error('email not verified');
  return String(claims.email).toLowerCase();
}

// Paths anyone may load: the sign-in page and what it needs.
// The client portal (portal page, its script and the sealing helper, and the two endpoints the
// client uses) is public: the client has no sign-in, and the data is sealed with the key in
// their link. Mark's portal endpoints stay behind sign-in.
export const PUBLIC_PATHS = ['/login', '/login.html', '/login.js', '/portal', '/portal.html', '/portal.js', '/src/sealed.js', '/api/portal/q', '/api/portal/answer', '/auth/verify', '/auth/logout', '/src/config.js', '/assets/7d-logo.png', '/assets/7d-mark.png', '/favicon.ico'];
// Ticket screenshots (already blanked out) are shown in GitHub issues, so they open without
// sign-in; each has a long random name that can't be guessed.
const HEALTH_ASSETS = new Set(['/health-check', '/health-check.html', '/src/advisory-pages.css', '/src/health-check.js',
  '/src/statement-input.js', '/src/statement-reports.js', '/src/csv-input.js', '/vendor/xlsx.full.min.js']);
export const PUBLIC_PREFIXES = ['/api/ticket/img/', '/api/health-check/'];
export const isPublic = (path) => PUBLIC_PATHS.includes(path) || HEALTH_ASSETS.has(path) || PUBLIC_PREFIXES.some((p) => path.startsWith(p) && !path.includes('..'));
