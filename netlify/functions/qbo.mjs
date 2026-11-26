import { getStore } from '@netlify/blobs';
import { createQbo, qboConfig, qboHandler } from './lib/qbo.mjs';
import { COOKIE, allowedList, getCookie, readSession } from '../edge-functions/lib/auth.js';

export default (request) => {
  const settings = qboConfig(Netlify.env);
  return qboHandler({
    config: settings,
    client: settings && createQbo({ config: settings, store: getStore({ name: 'qbo', consistency: 'strong' }) }),
    verifySession: (req) => readSession(getCookie(req, COOKIE), Netlify.env.get('SESSION_SECRET'), allowedList(Netlify.env.get('ALLOWED_EMAILS'))),
  })(request);
};

export const config = { path: '/api/qbo/*' };
