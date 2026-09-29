// Problem tickets (see lib/ticket.mjs): filed as GitHub issues, screenshots in Netlify Blobs.
// Needs the Netlify environment variable GITHUB_TOKEN (a fine-grained token that can only
// read and write issues on this repository); GITHUB_REPO defaults to naezell/claude.
import { getStore } from '@netlify/blobs';
import { ticketHandler } from './lib/ticket.mjs';
import { COOKIE, allowedList, getCookie, readSession } from '../edge-functions/lib/auth.js';

export default async (request) => {
  const handle = ticketHandler({
    store: getStore({ name: 'tickets', consistency: 'strong' }),
    verifySession: (req) => readSession(getCookie(req, COOKIE), Netlify.env.get('SESSION_SECRET'), allowedList(Netlify.env.get('ALLOWED_EMAILS'))),
    token: Netlify.env.get('GITHUB_TOKEN'),
    repo: Netlify.env.get('GITHUB_REPO') || 'naezell/claude',
  });
  return handle(request);
};

export const config = { path: ['/api/ticket', '/api/ticket/*'] };
