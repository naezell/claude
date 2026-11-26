import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import E from '../../../src/engine.js';
import Reports from '../../../src/statement-reports.js';

const AUTH = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const REVOKE = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
const USAGE = 'com.intuit.quickbooks.accounting';
const DAY = 864e5;
const ID = /^[0-9]{1,30}$/;
const STATE = /^[A-Za-z0-9_-]{43}$/;
const MAX_CONNECTIONS = 25;
const today = (ts) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ts);
const dateOffset = (date, days) => new Date(Date.parse(date + 'T00:00:00Z') + days * DAY).toISOString().slice(0, 10);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const anError = (message, status = 400) => Object.assign(new Error(message), { status });
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export function qboConfig(env, prefix = 'QBO') {
  const client = env.get(prefix + '_CLIENT_ID'), secret = env.get(prefix + '_CLIENT_SECRET');
  const origin = env.get('ADVISORY_ORIGIN');
  const key = env.get('QBO_STORAGE_KEY') || '';
  if (!client || !secret || !origin || !/^[0-9a-f]{64}$/i.test(key)) return null;
  let url;
  try { url = new URL(origin); } catch { return null; }
  if (url.protocol !== 'https:' || url.origin !== origin) return null;
  const grader = prefix === 'QBO_GRADER';
  const suffix = grader ? '/api/health-check/qbo-callback' : '/api/qbo/callback';
  return { client, secret, origin, redirect: origin + suffix, key: Buffer.from(key, 'hex'), sandbox: env.get(prefix + '_ENVIRONMENT') !== 'production' };
}

function seal(config, id, data) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', config.key, iv);
  cipher.setAAD(Buffer.from(id));
  const content = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), content]).toString('base64url');
}
function open(config, id, box) {
  const data = Buffer.from(box, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', config.key, data.subarray(0, 12));
  decipher.setAAD(Buffer.from(id));
  decipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]));
}

export function createQbo({ config, store, fetchFn = fetch, now = () => Date.now() }) {
  const authHeaders = { Authorization: 'Basic ' + Buffer.from(config.client + ':' + config.secret).toString('base64'), Accept: 'application/json' };
  const request = (url, options) => fetchFn(url, { ...options, signal: AbortSignal.timeout(7000) });

  async function exchange(form) {
    const res = await request(TOKEN, { method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
    if (!res.ok) {
      const info = await res.json().catch(() => ({}));
      throw info.error === 'invalid_grant' ? anError('Reconnect this QuickBooks company.', 401) : anError('QuickBooks authorization is temporarily unavailable.', 502);
    }
    const grant = await res.json();
    if (!grant.access_token || !grant.refresh_token || !(Number(grant.expires_in) > 0)) throw anError('QuickBooks returned an incomplete authorization.', 502);
    return { access: grant.access_token, refresh: grant.refresh_token, expires: now() + Number(grant.expires_in) * 1000 };
  }

  async function start(owner, stateValue = randomBytes(32).toString('base64url')) {
    const id = 'state/' + hash(stateValue);
    await store.setJSON(id, { expires: now() + 10 * 60000, box: seal(config, id, { owner }) });
    const params = new URLSearchParams({ client_id: config.client, response_type: 'code', scope: USAGE, redirect_uri: config.redirect, state: stateValue });
    return { url: AUTH + '?' + params, state: stateValue };
  }

  async function finish(params, owner, browserState) {
    const state = params.get('state'), code = params.get('code'), realm = params.get('realmId');
    if (!STATE.test(state || '') || (browserState !== undefined && browserState !== state) || !code || !ID.test(realm || '')) throw anError('QuickBooks did not complete authorization.');
    const id = 'state/' + hash(state);
    const rec = await store.getWithMetadata(id, { type: 'json' });
    if (!rec?.data?.box || rec.data.expires < now() || open(config, id, rec.data.box).owner !== owner) throw anError('The QuickBooks link expired. Start again.');
    const used = await store.setJSON(id, { expires: now() }, { onlyIfMatch: rec.etag });
    if (!used.modified) throw anError('This QuickBooks link has already been used.');
    await store.delete(id);
    return { realm, ...await exchange({ grant_type: 'authorization_code', code, redirect_uri: config.redirect }) };
  }

  async function api(connection, path, params) {
    const base = config.sandbox ? 'https://sandbox-quickbooks.api.intuit.com' : 'https://quickbooks.api.intuit.com';
    const url = new URL(`/v3/company/${connection.realm}/${path}`, base);
    url.search = new URLSearchParams(params);
    const res = await request(url, { headers: { Authorization: 'Bearer ' + connection.access, Accept: 'application/json' } });
    if (res.status === 401 || res.status === 403) throw anError('Reconnect this QuickBooks company or check the connected user’s access.', 401);
    if (!res.ok) throw anError('QuickBooks could not return the requested records.', 502);
    return res.json();
  }

  const companyKey = (owner, realm) => 'company/' + hash(owner) + '/' + realm;
  const listFor = async (owner) => (await store.list({ prefix: 'company/' + hash(owner) + '/' })).blobs;
  async function connectionAt(id) {
    const entry = await store.getWithMetadata(id, { type: 'json' });
    if (!entry?.data?.box) throw anError('Company connection was not found.', 404);
    return { value: open(config, id, entry.data.box), etag: entry.etag };
  }
  const write = (id, value, etag) => store.setJSON(id, { box: seal(config, id, value) }, etag ? { onlyIfMatch: etag } : { onlyIfNew: true });
  const info = (c) => ({ realm: c.realm, name: c.name, reconciledThrough: c.reconciledThrough || '', last: c.last || null });

  async function connect(owner, params) {
    const next = await finish(params, owner);
    const ids = await listFor(owner);
    if (ids.length >= MAX_CONNECTIONS && !ids.some((b) => b.key === companyKey(owner, next.realm))) throw anError('Disconnect a company first. This workspace supports 25 connections.');
    const id = companyKey(owner, next.realm);
    const current = await connectionAt(id).catch((e) => e.status === 404 ? null : Promise.reject(e));
    const details = await api(next, 'companyinfo/' + next.realm);
    const result = await write(id, { ...current?.value, ...next, owner, name: details.CompanyInfo?.CompanyName || 'QuickBooks company', leaseUntil: 0 }, current?.etag);
    if (!result.modified) throw anError('The company connection changed. Connect it again.', 409);
  }

  async function active(id) {
    const entry = await connectionAt(id);
    if (entry.value.expires > now() + 60000) return entry.value;
    if (entry.value.leaseUntil > now()) throw anError('QuickBooks is refreshing this connection. Try again in a moment.', 409);
    const lease = await write(id, { ...entry.value, leaseUntil: now() + 30000 }, entry.etag);
    if (!lease.modified) throw anError('QuickBooks is refreshing this connection. Try again in a moment.', 409);
    const locked = await connectionAt(id);
    if (locked.value.leaseUntil <= now()) throw anError('The connection changed. Try again.', 409);
    let next;
    try { next = { ...locked.value, ...await exchange({ grant_type: 'refresh_token', refresh_token: locked.value.refresh }), leaseUntil: 0 }; }
    catch (e) { await write(id, { ...locked.value, leaseUntil: 0 }, locked.etag); throw e; }
    if (!(await write(id, next, locked.etag)).modified) throw anError('The connection changed. Try again.', 409);
    return next;
  }

  const report = (connection, name, start, end) => api(connection, 'reports/' + name, { start_date: start, end_date: end, ...(name !== 'CashFlow' && name !== 'TrialBalance' ? { accounting_method: 'Accrual' } : {}) });
  async function brief(owner, realm, period) {
    const r = Reports.monthRange(period);
    const c = await active(companyKey(owner, realm));
    const [a, b, bs, oldBs, cf] = await Promise.all([
      report(c, 'ProfitAndLoss', r.start, r.end), report(c, 'ProfitAndLoss', r.priorStart, r.priorEnd),
      report(c, 'BalanceSheet', r.start, r.end), report(c, 'BalanceSheet', r.priorStart, r.priorEnd),
      report(c, 'CashFlow', r.start, r.end).catch((e) => { if (e.status === 401) throw e; return null; }),
    ]);
    return Reports.executiveBrief({
      period, current: Reports.qboProfit(a), prior: Reports.qboProfit(b),
      balance: Reports.qboRows(bs), priorBalance: Reports.qboRows(oldBs), cashFlow: Reports.qboRows(cf),
    });
  }

  async function query(connection, entity, where = '') {
    const all = [];
    const size = 1000;
    for (let start = 1; start <= 4001; start += size) {
      const q = `SELECT * FROM ${entity} ${where} STARTPOSITION ${start} MAXRESULTS ${size}`;
      const result = await api(connection, 'query', { query: q });
      const page = result.QueryResponse?.[entity] || [];
      all.push(...page);
      if (page.length < size) return all;
    }
    throw anError('This company has too many entries for the selected period. Use a shorter range or export from QuickBooks.', 422);
  }

  async function uncategorized(connection, start, end) {
    const where = `WHERE TxnDate >= '${start}' AND TxnDate <= '${end}'`;
    const [accounts, purchases, deposits] = await Promise.all([query(connection, 'Account'), query(connection, 'Purchase', where), query(connection, 'Deposit', where)]);
    const names = new Map(accounts.map((a) => [a.Id, a.FullyQualifiedName || a.Name]));
    return [[purchases, 'Expense', 'AccountBasedExpenseLineDetail'], [deposits, 'Deposit', 'DepositLineDetail']].flatMap(([txns, type, field]) => txns.flatMap((t) => (t.Line || []).flatMap((line) => {
      const detail = line[field], ref = detail?.AccountRef;
      const account = names.get(ref?.value) || ref?.name || '';
      if (!Reports.HOLDING.test(account) || !Number.isFinite(line.Amount) || !line.Amount) return [];
      const payee = t.EntityRef?.name || detail.Entity?.EntityRef?.name || '';
      return [{ date: t.TxnDate, transaction: type + ':' + t.Id, line: line.Id, payee, account, type, amount: line.Amount * (type === 'Deposit' || t.Credit === true ? 1 : -1), memo: line.Description || '' }];
    })));
  }

  async function chaserCsv(owner, realm, period) {
    const r = Reports.monthRange(period);
    const c = await active(companyKey(owner, realm));
    const rows = await uncategorized(c, r.start, r.end);
    const csv = [
      [c.name], ['Transaction Detail by Account'], ['Date', 'Transaction Type', 'Num', 'Name', 'Memo/Description', 'Account', 'Amount'],
      ...rows.map((r) => [r.date, r.type, r.transaction + ':' + (r.line || ''), r.payee, r.memo, r.account, r.amount]),
    ].map((row) => row.map(E.csvCell).join(',')).join('\r\n');
    return { csv, count: rows.length };
  }

  async function edit(owner, realm, reconciledThrough) {
    const id = companyKey(owner, realm);
    if (reconciledThrough && (!/^\d{4}-\d{2}-\d{2}$/.test(reconciledThrough) || !E.parseDate(reconciledThrough) || reconciledThrough > today(now()))) throw anError('Enter a valid reconciliation date through today.');
    const { value, etag } = await connectionAt(id);
    if (value.leaseUntil > now() || !(await write(id, { ...value, reconciledThrough }, etag)).modified) throw anError('The company is being updated. Try again.', 409);
  }

  async function revoke(c) {
    await request(REVOKE, { method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: c.refresh }) }).catch(() => {});
  }

  async function disconnect(owner, realm) {
    const id = companyKey(owner, realm);
    const { value, etag } = await connectionAt(id);
    if (value.leaseUntil > now() || !(await write(id, { ...value, leaseUntil: now() + 30000 }, etag)).modified) throw anError('The company is being updated. Try again.', 409);
    await revoke(value);
    await store.delete(id);
  }

  async function scan(id, date = today(now())) {
    const { value } = await connectionAt(id);
    const due = Reports.monthRange(date.slice(0, 7)).priorEnd;
    const flags = [];
    const uncertain = !value.reconciledThrough;
    if (!uncertain && Number(date.slice(8)) >= 10 && value.reconciledThrough < due) flags.push('Recorded reconciliation date is behind.');
    let count = null, previous = null;
    try {
      const c = await active(id);
      const rows = await uncategorized(c, dateOffset(date, -59), date);
      count = new Set(rows.filter((r) => r.date >= dateOffset(date, -29)).map((r) => r.transaction)).size;
      previous = new Set(rows.filter((r) => r.date < dateOffset(date, -29)).map((r) => r.transaction)).size;
      if (count >= 5 && count >= previous + 4 && count >= previous * 2) flags.push(`Posted uncategorized purchases and deposits rose from ${previous} to ${count}.`);
    } catch (e) {
      flags.push(e.status === 401 ? 'QuickBooks needs to be reconnected.' : 'QuickBooks checks could not complete.');
    }
    const latest = await connectionAt(id);
    if (latest.value.reconciledThrough !== value.reconciledThrough) {
      const index = flags.indexOf('Recorded reconciliation date is behind.');
      if (index >= 0) flags.splice(index, 1);
      if (latest.value.reconciledThrough && Number(date.slice(8)) >= 10 && latest.value.reconciledThrough < due) flags.unshift('Recorded reconciliation date is behind.');
    }
    const last = { date, count, previous, flags };
    if (latest.value.leaseUntil > now() || !(await write(id, { ...latest.value, last }, latest.etag)).modified) throw anError('The company changed during the check. Try again.', 409);
    return last;
  }

  async function grade(params, browserState) {
    const c = await finish(params, 'public-grader', browserState);
    try {
      const date = today(now());
      const [trial, chart] = await Promise.all([report(c, 'TrialBalance', date.slice(0, 4) + '-01-01', date), query(c, 'Account')]);
      const accounts = new Map(chart.map((a) => [a.Id, a]));
      const details = (rows) => rows.flatMap((row) => row.type === 'Section' ? details(row.Rows?.Row || []) : [row]);
      const lines = details(trial.Rows?.Row || []);
      const balances = lines.flatMap((line) => {
        const [label, debit, credit] = line.ColData || [];
        if (!label?.value || /^total\b/i.test(label.value)) return [];
        const d = E.parseAmount(debit?.value), c = E.parseAmount(credit?.value);
        if (d == null && c == null) return [];
        return [{ name: label.value, amount: (d || 0) - (c || 0), side: Reports.normalSide(label.value, accounts.get(label.id)?.AccountType || '') }];
      });
      if (!balances.length) throw anError('QuickBooks did not return readable trial balance rows.', 422);
      return Reports.cleanupScore(balances, { currency: trial.Header?.Currency });
    } finally { await revoke(c); }
  }

  async function saveGrade(id, grade) {
    const key = 'result/' + id;
    await store.setJSON(key, { box: seal(config, key, grade), expires: now() + 5 * 60000 });
  }

  async function takeGrade(id) {
    const key = 'result/' + id;
    const entry = await store.getWithMetadata(key, { type: 'json' });
    if (!entry?.data?.box || entry.data.expires < now()) return null;
    const consumed = await store.setJSON(key, { expires: now() }, { onlyIfMatch: entry.etag });
    if (!consumed.modified) return null;
    await store.delete(key);
    return open(config, key, entry.data.box);
  }

  return { start, connect, brief, chaserCsv, edit, disconnect, scan, grade, saveGrade, takeGrade, listFor, connectionAt, companyKey, info };
}

export function qboHandler({ client, config, verifySession }) {
  return async (request) => {
    const url = new URL(request.url);
    const action = url.pathname.split('/').pop();
    if (!config || url.origin !== config.origin) return json(503, { error: 'QuickBooks connection is awaiting setup.' });
    const owner = await verifySession(request);
    if (!owner) return json(401, { error: 'Sign in required.' });
    try {
      if (request.method === 'GET' && action === 'callback') {
        try { await client.connect(owner, url.searchParams); }
        catch { return Response.redirect(config.origin + '/advisory.html?qbo=failed#watchdog', 303); }
        return Response.redirect(config.origin + '/advisory.html?qbo=connected#watchdog', 303);
      }
      if (request.method === 'GET' && action === 'connections') {
        const blobs = await client.listFor(owner);
        const companies = await Promise.all(blobs.map(async (b) => client.info((await client.connectionAt(b.key)).value)));
        return json(200, { companies });
      }
      if (request.method !== 'POST' || request.headers.get('origin') !== config.origin || !request.headers.get('content-type')?.startsWith('application/json')) return json(405, { error: 'Open this action from Ledger Lens.' });
      if (action === 'start') return json(200, { url: (await client.start(owner)).url });
      const payload = await request.text();
      if (payload.length > 2048) return json(413, { error: 'Request is too large.' });
      const { realm, period, date } = JSON.parse(payload);
      if (!ID.test(realm || '')) return json(400, { error: 'Select a QuickBooks company.' });
      if (action === 'brief' || action === 'chaser') Reports.monthRange(period);
      if (action === 'brief') return json(200, { brief: await client.brief(owner, realm, period) });
      if (action === 'chaser') return json(200, await client.chaserCsv(owner, realm, period));
      if (action === 'reconciliation') await client.edit(owner, realm, String(date || ''));
      else if (action === 'disconnect') await client.disconnect(owner, realm);
      else if (action === 'scan') return json(200, { last: await client.scan(client.companyKey(owner, realm)) });
      else return json(404, { error: 'Unknown QuickBooks action.' });
      return json(200, { ok: true });
    } catch (e) { return json(e.status || 400, { error: e.status ? e.message : 'QuickBooks could not complete this request.' }); }
  };
}

export { today };
