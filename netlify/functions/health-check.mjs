import { createHmac, randomBytes } from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { getCookie } from '../edge-functions/lib/auth.js';
import { createQbo, qboConfig, today } from './lib/qbo.mjs';
import { mailSettings, sendAdvisoryMail } from './lib/advisory-mail.mjs';

const COOKIE = 'll_health_check';
const OPAQUE = /^[A-Za-z0-9_-]{43}$/;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const random = () => randomBytes(32).toString('base64url');
const cookie = (id, seconds) => `${COOKIE}=${id}; Path=/api/health-check; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`;
function json(status, body, stateCookie) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(stateCookie ? { 'Set-Cookie': stateCookie } : {}) } });
}
function redirect(origin, status, stateCookie) {
  return new Response(null, { status: 303, headers: { Location: origin + '/health-check.html?qbo=' + status, 'Cache-Control': 'no-store', 'Set-Cookie': stateCookie } });
}

async function rateLimit(store, id, cap) {
  for (let i = 0; i < 4; i++) {
    const record = await store.getWithMetadata(id, { type: 'json' });
    const count = record?.data?.count || 0;
    if (count >= cap) return false;
    const written = await store.setJSON(id, { count: count + 1, expires: Date.now() + 864e5 }, record ? { onlyIfMatch: record.etag } : { onlyIfNew: true });
    if (written.modified) return true;
  }
  return false;
}

export function healthHandler({ env, store, ip, fetchFn = fetch }) {
  return async (request) => {
    const url = new URL(request.url);
    const origin = env.get('ADVISORY_ORIGIN');
    const action = url.pathname.split('/').pop();
    const qbo = qboConfig(env, 'QBO_GRADER');
    const mail = mailSettings(env);
    const inbox = env.get('ADVISORY_LEADS_TO');
    if (action === 'options' && request.method === 'GET') return json(200, { qbo: !!qbo, lead: !!(mail && inbox && origin) });
    if (!origin || origin !== url.origin) return json(503, { error: 'This service is awaiting setup.' });
    try {
      const client = qbo && createQbo({ config: qbo, store, fetchFn });
      const savedState = getCookie(request, COOKIE);
      if (action === 'qbo-callback' && request.method === 'GET') {
        if (!client || !OPAQUE.test(savedState || '')) return redirect(origin, 'failed', cookie('', 0));
        try {
          const grade = await client.grade(url.searchParams, savedState);
          const id = random();
          await client.saveGrade(id, grade);
          return redirect(origin, 'ready', cookie(id, 300));
        } catch { return redirect(origin, 'failed', cookie('', 0)); }
      }
      if (action === 'result' && request.method === 'GET') {
        if (!OPAQUE.test(savedState || '')) return json(404, { error: 'Start a new QuickBooks health check.' });
        const grade = await client?.takeGrade(savedState);
        if (!grade) return json(404, { error: 'Start a new QuickBooks health check.' });
        return json(200, { grade }, cookie('', 0));
      }
      if (request.method !== 'POST' || request.headers.get('origin') !== origin || !request.headers.get('content-type')?.startsWith('application/json')) return json(405, { error: 'Open this action from the health check.' });
      const rateKey = (label) => 'rate/' + today(Date.now()) + '/' + createHmac('sha256', env.get('SESSION_SECRET') || 'health-check').update(label + ':' + ip).digest('hex');
      if (action === 'qbo-start' && client) {
        if (!await rateLimit(store, rateKey('connect'), 10)) return json(429, { error: 'Too many attempts. Try again tomorrow.' });
        const { url: link, state } = await client.start('public-grader');
        return json(200, { url: link }, cookie(state, 600));
      }
      if (action !== 'lead' || !mail || !inbox) return json(503, { error: 'Use the firm’s website to request a follow-up.' });
      const text = await request.text();
      if (text.length > 2048) return json(413, { error: 'Submission is too large.' });
      const { name, company, email, consent, website, id } = JSON.parse(text);
      if (website) return json(200, { ok: true });
      if (consent !== true || typeof email !== 'string' || email.length > 180 || !EMAIL.test(email) || !OPAQUE.test(id || '')
        || typeof name !== 'string' || !name.trim() || name.length > 100 || typeof company !== 'string' || company.length > 140) {
        return json(400, { error: 'Enter your name and email, and agree to be contacted.' });
      }
      if (!await rateLimit(store, rateKey('lead'), 5)) return json(429, { error: 'Too many requests. Use the firm’s website to get in touch.' });
      await sendAdvisoryMail(mail, {
        to: inbox, replyTo: email, id: 'health-check/' + id, subject: 'New bookkeeping cleanup inquiry',
        text: `A prospect asked to hear from 7D after using the bookkeeping health check.\n\nName: ${name.trim()}\nCompany: ${company.trim()}\nEmail: ${email}\n`,
      }, fetchFn);
      return json(200, { ok: true });
    } catch { return json(503, { error: 'The request could not be completed. Try again or contact the firm directly.' }); }
  };
}

export default (request, context) => healthHandler({
  env: Netlify.env, store: getStore({ name: 'health-check', consistency: 'strong' }), ip: context.ip || 'unknown',
})(request);

export const config = { path: '/api/health-check/*' };
