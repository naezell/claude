// Runs before every request: only people on the allowed list, signed in with Google, get
// the app. Everyone else is sent to the sign-in page (pages) or refused (files).
import { COOKIE, allowedList, getCookie, isPublic, readSession } from './lib/auth.js';

export default async (request, context) => {
  const url = new URL(request.url);
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
