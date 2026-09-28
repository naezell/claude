// The client portal's endpoints (see lib/portal.mjs), with records in Netlify Blobs.
import { getStore } from '@netlify/blobs';
import { portalHandler } from './lib/portal.mjs';
import { COOKIE, allowedList, getCookie, readSession } from '../edge-functions/lib/auth.js';

export default async (request) => {
  const handle = portalHandler({
    store: getStore({ name: 'portal', consistency: 'strong' }),
    verifySession: (req) => readSession(getCookie(req, COOKIE), Netlify.env.get('SESSION_SECRET'), allowedList(Netlify.env.get('ALLOWED_EMAILS'))),
  });
  return handle(request);
};

export const config = { path: '/api/portal/*' };
