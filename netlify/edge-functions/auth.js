// Sign-in and sign-out. /auth/verify checks the Google ID token from the sign-in page and,
// for an allowed email, sets the session cookie. /auth/logout clears it.
import { allowedList, clearCookie, googleKeys, sessionCookie, signSession, verifyGoogleToken } from './lib/auth.js';

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

export default async (request) => {
  const url = new URL(request.url);
  if (url.pathname === '/auth/logout') {
    return new Response(null, { status: 302, headers: { Location: '/login?signedout=1', 'Set-Cookie': clearCookie(), 'Cache-Control': 'no-store' } });
  }
  if (request.method !== 'POST') return json(405, { error: 'POST only' });
  // Requests from other sites cannot sign anyone in.
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return json(403, { error: 'Wrong origin' });
  const secret = Netlify.env.get('SESSION_SECRET');
  const clientId = Netlify.env.get('GOOGLE_CLIENT_ID');
  const allowed = allowedList(Netlify.env.get('ALLOWED_EMAILS'));
  if (!secret || !clientId || !allowed.size) return json(500, { error: 'Sign-in is not configured on this site yet.' });
  let credential;
  try { ({ credential } = await request.json()); } catch (e) { return json(400, { error: 'Bad request' }); }
  let email;
  try {
    email = await verifyGoogleToken(credential, { clientId, keys: await googleKeys() });
  } catch (e) {
    return json(401, { error: `Google sign-in could not be verified (${e.message}).` });
  }
  if (!allowed.has(email)) return json(403, { error: `${email} is not on the list of people allowed to use this app.` });
  return json(200, { ok: true, email }, { 'Set-Cookie': sessionCookie(await signSession(email, secret)) });
};

export const config = { path: ['/auth/verify', '/auth/logout'] };
