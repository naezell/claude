// Runs before every request: only people on the allowed list, signed in with Google, get
// the app. Everyone else is sent to the sign-in page (pages) or refused (files).
import { COOKIE, allowedList, getCookie, isPublic, readSession } from './lib/auth.js';

export default async (request, context) => {
  const url = new URL(request.url);
  if (url.pathname === '/health-check.html' || url.pathname === '/health-check') {
    const original = await context.next();
    const headers = new Headers(original.headers);
    headers.delete('X-Frame-Options');
    headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self' https://www.7dbusinesssolutions.com https://7dbusinesssolutions.com");
    return new Response(original.body, { status: original.status, headers });
  }
  if (isPublic(url.pathname)) return context.next();
  const secret = Netlify.env.get('SESSION_SECRET');
  const allowed = allowedList(Netlify.env.get('ALLOWED_EMAILS'));
  const email = await readSession(getCookie(request, COOKIE), secret, allowed);
  if (email) {
    const res = await context.next();
    res.headers.set('Cache-Control', 'private, no-store');
    return res;
  }
  const wantsPage = url.pathname === '/' || url.pathname.endsWith('.html') || (request.headers.get('accept') || '').includes('text/html');
  if (wantsPage) return Response.redirect(new URL(`/login?next=${encodeURIComponent(url.pathname + url.search)}`, url), 302);
  return new Response('Sign in required', { status: 401, headers: { 'Cache-Control': 'no-store' } });
};

export const config = { path: '/*' };
