/* Ledger Lens UI: month-end close checklist. */
(function () {
  'use strict';
  const { useState } = React;
  const html = htm.bind(React.createElement);
  const E = window.LedgerEngine;
  const UI = window.LedgerUI;
  const { Arrange } = UI;

  const monthName = (key) => new Date(`${key}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const today = () => new Date().toISOString().slice(0, 10);
  const shortDay = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

  // Where to go to work on an automatic step.
  const REVIEW_TARGETS = {
    uncategorized: { tab: 'audit', part: 'uncategorized' },
    duplicates: { tab: 'audit', part: 'duplicates' },
    coding: { tab: 'audit', part: 'mismatches' },
    balance: { tab: 'audit', part: 'balance' },
    unusual: { tab: 'audit', part: 'unusual' },
    jobs: { tab: 'growth', part: 'jobcosts' },
    contractbilling: { tab: 'landscape', part: 'contracts' },
    equipbuys: { tab: 'assets' },
    receipts: { tab: 'audit', part: 'receipts' },
    depreciation: { tab: 'assets' },
    tieout: { tab: 'audit', part: 'tieout' },
  };
  const CLOSE_TARGET = { tab: 'audit', part: 'closed' };

  function MonthlyWorkflow({ close, hasPnl, sample, portal, onLoad, onReview, onClose, onReport }) {
    const items = close ? close.items : [];
    const review = items.filter((it) => !it.done && Object.hasOwn(REVIEW_TARGETS, it.id));
    const remaining = items.filter((it) => !it.done && it.id !== 'report').length;
    const first = review[0] && REVIEW_TARGETS[review[0].id];
    const count = (n, name) => `${n} ${name}${n === 1 ? '' : 's'}`;
    const steps = [
      ['Load reports', hasPnl ? 'Transaction Detail and P&L loaded' : 'Add a matching P&L to check the totals', sample ? null : onLoad],
      ['Review exceptions', review.length ? `${count(review.length, 'check')} open` : 'Open the diagnostic audit', () => onReview(first)],
      ['Close month', !close ? 'Load an export covering a full month' : portal && portal.status === 'waiting' ? 'Waiting for client answers' : remaining ? `${count(remaining, 'step')} left before reporting` : 'Close steps complete', onClose],
      ['Prepare client report', items.some((it) => it.id === 'report' && it.done) ? 'Marked as sent' : remaining ? 'Review the close before sending' : 'Open report preview', onReport],
    ];
    return html`<nav class="monthly-workflow panel" aria-labelledby="monthly-workflow-title">
      <div class="panel-head"><h2 id="monthly-workflow-title">${close ? `Monthly workflow · ${monthName(close.month)}` : 'Monthly workflow'}</h2></div>
      <ol>${steps.map(([label, detail, action]) => html`<li key=${label}>
        ${action ? html`<button class="linkish" onClick=${action}>${label}</button>` : html`<strong>${label}</strong>`}
        <span class="sub">${detail}</span>
      </li>`)}</ol>
    </nav>`;
  }

  function CloseTab({ result, month, setMonth, close: cl, checklist, setChecklist, customSteps, setCustomSteps, canSave, goTo, onQuestions, onReport }) {
    const months = result.closableMonths || [];
    const [newStep, setNewStep] = useState('');
    if (!month) return html`<section class="panel"><div class="empty">This export does not cover a full month yet.</div></section>`;
    const state = checklist[month] || {};
    const update = (patch) => setChecklist((prev) => ({ ...prev, [month]: { ...(prev[month] || {}), ...patch } }));
    const tick = (id, on) => {
      const done = { ...(state.done || {}) };
      if (on) done[id] = today(); else delete done[id];
      update({ done });
    };
    const addStep = () => {
      const label = newStep.trim();
      if (!label) return;
      setCustomSteps((prev) => [...prev, { id: `c${Date.now().toString(36)}`, label }]);
      setNewStep('');
    };
    const pct = cl.total ? Math.round((cl.done / cl.total) * 100) : 0;
    const history = Object.keys(checklist).filter((k) => k !== month && checklist[k] && Object.keys(checklist[k].done || {}).length).sort().reverse();
    return html`
      <${Arrange} page="close" parts=${[
        ["checklist", "Month-end checklist", html`
        <section class="panel">
          <div class="panel-head">
            <h2>Month-end close: ${monthName(month)}</h2>
            <span class=${`pill ${cl.complete ? 'good' : cl.done ? 'medium' : 'low'}`}>${cl.complete ? 'Complete' : `${cl.done} of ${cl.total} done`}</span>
            <p>The standard close, step by step. Steps marked <em>checked by the app</em> tick themselves when this export shows them clear; everything can also be ticked by hand. Saved with the client${canSave ? '' : ' (with the sample data, only until the page is reloaded)'}.</p>
            <label class="field spacer close-month" for="close-month">Month<select id="close-month" class="select" value=${month} onChange=${(e) => setMonth(e.target.value)}>
              ${months.slice().reverse().map((m) => html`<option key=${m} value=${m}>${monthName(m)}</option>`)}
            </select></label>
          </div>
          <div class="panel-body" style=${{ paddingBottom: 0 }}>
            <div class="meter" role="progressbar" aria-valuenow=${pct} aria-valuemin="0" aria-valuemax="100" aria-label="Close progress"><span style=${{ width: `${pct}%`, background: cl.complete ? 'var(--good)' : 'var(--accent)' }}></span></div>
          </div>
          <ul class="checklist close-list">
            ${cl.items.map((it) => {
              const autoDone = it.auto && it.auto.status === 'clear';
              return html`<li key=${it.id} class=${it.done ? 'done' : ''}>
                <input type="checkbox" id=${`step-${it.id}`} checked=${it.done} disabled=${autoDone && !it.doneAt} title=${autoDone && !it.doneAt ? 'Done: the app shows this clear' : ''} onChange=${(e) => tick(it.id, e.target.checked)} />
                <div>
                  <label for=${`step-${it.id}`}>${it.label}</label>
                  <span class="sub">
                    ${it.auto ? html`<span class=${`pill ${autoDone ? 'good' : 'medium'}`}>${autoDone ? 'Clear' : it.auto.note}</span> <span class="hint">checked by the app</span>` : ''}
                    ${it.doneAt ? html`<span class="hint">Ticked ${shortDay(it.doneAt)}</span>` : ''}
                    ${!it.done && (REVIEW_TARGETS[it.id] || it.id === 'closed') ? html` <button class="linkish" onClick=${() => goTo(REVIEW_TARGETS[it.id] || CLOSE_TARGET)}>Go to it</button>` : ''}
                    ${!it.done && it.id === 'questions' ? html` <button class="linkish" onClick=${onQuestions}>Open question list</button>` : ''}
                    ${!it.done && it.id === 'report' ? html` <button class="linkish" onClick=${onReport}>Preview report</button>` : ''}
                    ${it.custom ? html` <button class="linkish" onClick=${() => setCustomSteps((prev) => prev.filter((c) => c.id !== it.id))}>Remove step</button>` : ''}
                  </span>
                </div>
              </li>`;
            })}
          </ul>
          <div class="panel-body close-extra">
            <div class="add-step">
              <label class="field" for="new-step">Add a step for this client (every month)<input id="new-step" class="text" value=${newStep} placeholder="e.g. Reconcile the PayPal account" onInput=${(e) => setNewStep(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') addStep(); }} /></label>
              <button class="btn" onClick=${addStep} disabled=${!newStep.trim()}>Add step</button>
            </div>
            <label class="field" for="close-notes">Notes for ${monthName(month)}<textarea id="close-notes" class="text" rows="3" value=${state.notes || ''} placeholder="Anything to remember about this month's close" onInput=${(e) => update({ notes: e.target.value })}></textarea></label>
          </div>
        </section>
        `],
        ["history", "Earlier closes", html`
        ${history.length > 0 && html`<section class="panel">
          <div class="panel-head"><h2>Earlier closes</h2></div>
          <ul class="checklist">${history.map((k) => {
            const h = E.closeChecklist(result, k, checklist[k], customSteps);
            return html`<li key=${k}><span class=${`pill ${h.complete ? 'good' : 'medium'}`}>${h.done}/${h.total}</span><div><button class="linkish" onClick=${() => setMonth(k)}>${monthName(k)}</button>${checklist[k].notes ? html`<span class="sub">${checklist[k].notes}</span>` : ''}</div></li>`;
          })}</ul>
        </section>`}
        `],
      ]} />
    `;
  }

  Object.assign(UI, { CloseTab, MonthlyWorkflow });
})();
