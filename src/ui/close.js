/* Ledger Lens UI: month-end close checklist. */
(function () {
  'use strict';
  const { useState } = React;
  const html = htm.bind(React.createElement);
  const E = window.LedgerEngine;
  const UI = window.LedgerUI;

  const monthName = (key) => new Date(`${key}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const today = () => new Date().toISOString().slice(0, 10);
  const shortDay = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

  // Where to go to work on an automatic step.
  const STEP_TAB = { uncategorized: 'audit', duplicates: 'audit', coding: 'audit', balance: 'audit', unusual: 'audit', closed: 'audit', tieout: 'audit', jobs: 'growth', receipts: 'audit' };

  function CloseTab({ result, checklist, setChecklist, customSteps, setCustomSteps, canSave, goTo }) {
    const months = result.closableMonths || [];
    const [month, setMonth] = useState(months[months.length - 1] || '');
    const [newStep, setNewStep] = useState('');
    if (!month) return html`<section class="panel"><div class="empty">This export does not cover a full month yet.</div></section>`;
    const state = checklist[month] || {};
    const cl = E.closeChecklist(result, month, state, customSteps);
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
                  ${it.auto && !autoDone && STEP_TAB[it.id] ? html` <button class="linkish" onClick=${() => goTo(STEP_TAB[it.id])}>Go to it</button>` : ''}
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
      ${history.length > 0 && html`<section class="panel">
        <div class="panel-head"><h2>Earlier closes</h2></div>
        <ul class="checklist">${history.map((k) => {
          const h = E.closeChecklist(result, k, checklist[k], customSteps);
          return html`<li key=${k}><span class=${`pill ${h.complete ? 'good' : 'medium'}`}>${h.done}/${h.total}</span><div><button class="linkish" onClick=${() => setMonth(k)}>${monthName(k)}</button>${checklist[k].notes ? html`<span class="sub">${checklist[k].notes}</span>` : ''}</div></li>`;
        })}</ul>
      </section>`}
    `;
  }

  Object.assign(UI, { CloseTab });
})();
