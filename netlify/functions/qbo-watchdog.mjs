import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';
import { allowedList } from '../edge-functions/lib/auth.js';
import { createQbo, qboConfig, today } from './lib/qbo.mjs';
import { mailSettings, sendAdvisoryMail } from './lib/advisory-mail.mjs';

const central = (date) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hourCycle: 'h23' }).format(date));
const noContent = () => new Response(null, { status: 204 });

export async function watchdog({ env, getStore, at = Date.now(), fetchFn = fetch }) {
  const hour = central(at);
  const settings = qboConfig(env);
  if (!settings || (hour !== 3 && hour !== 7)) return noContent();
  const store = getStore({ name: 'qbo', consistency: 'strong' });
  const client = createQbo({ config: settings, store, fetchFn, now: () => at });
  const allowed = [...allowedList(env.get('ALLOWED_EMAILS'))];
  const date = today(at);

  if (hour === 3) {
    const checks = await Promise.all(allowed.map((owner) => client.listFor(owner)));
    const runs = await Promise.allSettled(checks.flat().map(async ({ key }) => {
      const { value } = await client.connectionAt(key);
      if (value.last?.date !== date) await client.scan(key, date);
    }));
    if (runs.some((r) => r.status === 'rejected')) return new Response('Some QuickBooks companies could not be checked.', { status: 503 });
    const publicStore = getStore({ name: 'health-check', consistency: 'strong' });
    await Promise.all([store, publicStore].map(async (records) => {
      for (const prefix of ['state/', 'result/', 'rate/']) {
        const { blobs } = await records.list({ prefix });
        await Promise.all(blobs.map(async ({ key }) => {
          const record = await records.get(key, { type: 'json' });
          if (record?.expires < at) await records.delete(key);
        }));
      }
    }));
    return noContent();
  }

  const mail = mailSettings(env);
  if (!mail) return noContent();
  await Promise.all(allowed.map(async (owner) => {
    const blobs = await client.listFor(owner);
    const statuses = await Promise.allSettled(blobs.map(async (b) => client.info((await client.connectionAt(b.key)).value)));
    const reviews = statuses.filter((s) => s.status === 'fulfilled' && s.value.last?.date === date && s.value.last.flags.length).length;
    const missed = statuses.filter((s) => s.status !== 'fulfilled' || s.value.last?.date !== date).length;
    if (!reviews && !missed) return;
    const digest = `qbo-watchdog/${date}/` + createHash('sha256').update(owner).digest('hex').slice(0, 32);
    const key = 'digest/' + createHash('sha256').update(owner).digest('hex');
    const sent = await store.getWithMetadata(key, { type: 'json' });
    if (sent?.data?.date === date) return;
    await sendAdvisoryMail(mail, {
      to: owner, id: digest, subject: 'Ledger Lens QuickBooks items to review',
      text: [
        reviews ? `${reviews} QuickBooks ${reviews === 1 ? 'company has' : 'companies have'} new items to review.` : '',
        missed ? `${missed} QuickBooks ${missed === 1 ? 'company did' : 'companies did'} not complete the latest check.` : '',
        settings.origin + '/advisory.html#watchdog',
      ].filter(Boolean).join('\n\n'),
    }, fetchFn);
    await store.setJSON(key, { date }, sent ? { onlyIfMatch: sent.etag } : { onlyIfNew: true });
  }));
  return noContent();
}

export default () => watchdog({ env: Netlify.env, getStore });
// Only the matching local hour runs. The UTC pairs cover Central daylight and standard time.
export const config = { schedule: '0 8,9,12,13 * * *' };
