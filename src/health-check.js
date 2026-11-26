(function () {
  'use strict';
  const Reports = window.LedgerStatements;
  const byId = (id) => document.getElementById(id);
  const gradeForm = byId('grade-form');
  const leadForm = byId('lead-form');
  let leadId;

  const request = async (action, data) => {
    const resp = await fetch('/api/health-check/' + action, data
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }
      : { cache: 'no-store' });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(body.error || 'Try again or contact the firm directly.');
    return body;
  };
  const status = (id, text, error = false) => {
    const element = byId(id);
    element.textContent = text;
    element.classList.toggle('error', error);
  };
  function display(grade) {
    byId('grade-title').textContent = grade.tier + ' · ' + grade.score + ' / 100';
    const items = [
      grade.tested ? `${grade.odd} of ${grade.tested} identifiable asset and liability accounts had an unusual balance sign.` : 'Account types are needed to check balance signs.',
      grade.holding ? `${grade.holding} holding or uncategorized accounts with ${Reports.money(grade.holdingTotal, grade.currency)} in combined absolute balances.` : 'No balances appeared in recognized holding or uncategorized accounts.',
      grade.monthsBehind == null ? 'Reconciliation status needs a separate check.' : `${grade.monthsBehind} unreconciled months reported by you.`,
    ];
    byId('grade-details').replaceChildren(...items.map((text) => Object.assign(document.createElement('li'), { textContent: text })));
    byId('grade').hidden = false;
    byId('contact').hidden = false;
    byId('grade-title').focus();
    status('grade-status', 'Your scorecard is ready.');
  }

  gradeForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    event.submitter.disabled = true;
    byId('grade').hidden = true;
    byId('contact').hidden = true;
    try {
      const data = await window.LedgerFiles.readStatement(byId('trial').files[0]);
      const months = byId('months').value;
      display(Reports.cleanupScore(Reports.trialCsv(data), { monthsBehind: months === '' ? null : Number(months) }));
    } catch (e) { status('grade-status', e.message, true); }
    finally { event.submitter.disabled = false; }
  });
  byId('grade-qbo').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try { location.assign((await request('qbo-start', {})).url); }
    catch (e) { status('grade-status', e.message, true); button.disabled = false; }
  });
  leadForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    event.submitter.disabled = true;
    const fields = Object.fromEntries(new FormData(leadForm));
    if (!leadId) leadId = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    try {
      await request('lead', { ...fields, consent: fields.consent === 'on', id: leadId });
      status('lead-status', 'Thank you. Your request was sent to 7D Business Solutions.');
      leadForm.reset();
    } catch (e) { status('lead-status', e.message, true); event.submitter.disabled = false; }
  });

  request('options').then((options) => {
    byId('lead-form').hidden = !options.lead;
    byId('contact-fallback').hidden = !!options.lead;
    if (options.qbo) byId(window.self === window.top ? 'grade-qbo' : 'grade-separate').hidden = false;
  }, () => { /* File grading also works when the connection service is absent. */ });
  const result = new URL(location.href).searchParams.get('qbo');
  if (result === 'ready') request('result').then(({ grade }) => display(grade), (e) => status('grade-status', e.message, true));
  else if (result === 'failed') status('grade-status', 'QuickBooks could not complete this check. Try again or upload your Trial Balance.', true);
})();
