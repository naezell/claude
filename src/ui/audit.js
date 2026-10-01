/* Ledger Lens UI: Diagnostic audit tab. */
(function () {
  'use strict';
  const { useState, useMemo } = React;
  const html = htm.bind(React.createElement);
  const { ResponsiveContainer, BarChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip } = Recharts;
  const E = window.LedgerEngine;
  const { fmtMoney, fmtWhole, counterpartyOf, leafAccount } = E;
  const UI = window.LedgerUI;
  const { useTokens, Icon, Severity, Money, ChartTooltip, ReviewSelect, clearedOf, Arrange, AnswerPhotos, ReceiptRead } = UI;

  // ------------------------------------------------------------ audit tab

  function TieOutPanel({ tie }) {
    return html`<section class="panel">
      <div class="panel-head"><h2>Ties to QuickBooks</h2>
        <span class=${`pill ${tie.ties ? 'good' : 'high'}`}><span class="dot"></span>${tie.ties ? 'Numbers match' : 'Differences found'}</span>
        <p>Compares this analysis with the client's own Profit and Loss report for ${tie.period}${tie.basis ? ` (${tie.basis} basis)` : ''}. ${tie.ties ? 'Every total and account agrees, so the income and expense figures here match QuickBooks.' : 'Resolve these before sharing figures; each difference says where to look.'}${tie.companyMatches ? '' : ' The P&L is for a different company name than the transactions.'}</p>
      </div>
      <div class="panel-body flush"><div class="table-wrap"><table>
        <thead><tr><th>Line</th><th class="num">QuickBooks</th><th class="num">Ledger Lens</th><th class="num">Difference</th></tr></thead>
        <tbody>${tie.lines.map((l) => html`<tr key=${l.label}><td>${l.label}</td><td class="num"><${Money} v=${l.quickbooks} /></td><td class="num"><${Money} v=${l.ledgerLens} /></td>
          <td class="num">${l.ties ? html`<span class="pill good">Ties</span>` : html`<span class="neg num">${fmtMoney(l.diff)}</span>`}</td></tr>`)}
          ${tie.accounts.map((a) => html`<tr key=${`acct-${a.name}`}><td>${a.name}<span class="sub">${a.hint}</span></td><td class="num"><${Money} v=${a.quickbooks} /></td><td class="num"><${Money} v=${a.ledgerLens} /></td><td class="num"><span class="neg num">${fmtMoney(a.diff)}</span></td></tr>`)}
        </tbody>
      </table></div></div>
    </section>`;
  }

  function AuditTab({ result, accountClass, setAccountClass, onReview, onClose, canSave, receiptLimit, setReceiptLimit, onRemoveAnswer, onReadAnswer }) {
    const { audit } = result;
    const [showCleared, setShowCleared] = useState(false);
    const vis = (list) => (showCleared ? list : list.filter((x) => !clearedOf(x)));
    const score = audit.healthScore;
    const scoreColor = score >= 90 ? 'var(--good)' : score >= 75 ? 'var(--warn)' : 'var(--critical)';
    const scoreWord = score >= 90 ? 'Clean' : score >= 75 ? 'Needs cleanup' : 'Significant issues';
    const asked = [...audit.uncategorized, ...audit.duplicates, ...audit.mismatches, ...(result.unusual ? [...result.unusual.flux, ...result.unusual.txns] : []), ...((result.balanceSheet && result.balanceSheet.items) || [])].filter((x) => x.review && x.review.status === 'asked').length;
    return html`
      <section class="kpis" aria-label="Audit summary">
        <div class="kpi">
          <span class="kpi-label">Books health score</span>
          <span class="kpi-value">${score}<span style=${{ fontSize: '14px', color: 'var(--muted)' }}> / 100</span></span>
          <div class="meter"><span style=${{ width: `${score}%`, background: scoreColor }}></span></div>
          <span class="kpi-sub">${scoreWord} · ${audit.flaggedCount} of ${result.entryCount} entries still flagged</span>
        </div>
        <div class=${`kpi ${audit.open.uncategorized ? 'alert' : 'okay'}`}>
          <span class="kpi-label">Uncategorized</span>
          <span class="kpi-value">${audit.open.uncategorized}</span>
          <span class="kpi-sub"><span class="num">${fmtMoney(audit.uncategorizedOpenTotal)}</span> not yet coded</span>
        </div>
        <div class=${`kpi ${audit.open.duplicates ? 'alert' : 'okay'}`}>
          <span class="kpi-label">Potential duplicates</span>
          <span class="kpi-value">${audit.open.duplicates}</span>
          <span class="kpi-sub"><span class="num">${fmtMoney(audit.duplicateOpenExposure)}</span> possibly double-counted</span>
        </div>
        <div class=${`kpi ${audit.open.mismatches ? 'alert' : 'okay'}`}>
          <span class="kpi-label">Mismatched entries</span>
          <span class="kpi-value">${audit.open.mismatches}</span>
          <span class="kpi-sub">${audit.mismatches.filter((m) => m.severity === 'High' && !clearedOf(m)).length} high severity</span>
        </div>
      </section>

      <div class="review-bar">
        <span>Mark each flag as you work through it. Cleared flags stay cleared when you load next month's export.</span>
        <span class="hint">${audit.cleared} cleared · ${asked} asked the client</span>
        ${audit.cleared > 0 && html`<label class="check" for="show-cleared" style=${{ paddingTop: 0 }}><input id="show-cleared" type="checkbox" checked=${showCleared} onChange=${(e) => setShowCleared(e.target.checked)} />Show cleared</label>`}
      </div>

      <${Arrange} page="audit" parts=${[
        ["tieout", "Ties to QuickBooks", html`
        ${result.tieOut && html`<${TieOutPanel} tie=${result.tieOut} />`}
        `],
        ["closed", "Closed months", html`
        <${ClosedMonthsPanel} result=${result} onClose=${onClose} canSave=${canSave} />
        `],
        ["answers", "Client answers", html`
        ${result.answers && result.answers.length > 0 && html`<${AnswersPanel} answers=${result.answers} onReview=${onReview} onRemove=${onRemoveAnswer} onRead=${onReadAnswer} />`}
        `],
        ["bymonth", "Issues by month", html`
        <${IssuesByMonth} audit=${audit} />
        `],
        ["uncategorized", "Uncategorized transactions", html`
        <${UncategorizedPanel} rows=${vis(audit.uncategorized)} open=${audit.open.uncategorized} total=${audit.uncategorizedOpenTotal} onReview=${onReview} />
        `],
        ["duplicates", "Potential duplicates", html`
        <${DuplicatesPanel} groups=${vis(audit.duplicates)} open=${audit.open.duplicates} exposure=${audit.duplicateOpenExposure} onReview=${onReview} />
        `],
        ["mismatches", "Mismatched entries", html`
        <${MismatchPanel} rows=${vis(audit.mismatches)} open=${audit.open.mismatches} onReview=${onReview} />
        `],
        ["balance", "Balance sheet check", html`
        ${result.balanceSheet && result.balanceSheet.available && html`<${BalanceSheetPanel} bs=${result.balanceSheet} vis=${vis} onReview=${onReview} />`}
        `],
        ["receipts", "Receipts", html`
        ${result.receipts && html`<${ReceiptsPanel} rc=${result.receipts} vis=${vis} onReview=${onReview} limit=${receiptLimit} setLimit=${setReceiptLimit} />`}
        `],
        ["unusual", "Unusual activity", html`
        ${result.unusual && html`<${UnusualPanel} u=${result.unusual} vis=${vis} onReview=${onReview} />`}
        `],
        ["mapping", "Account mapping", html`
        <${AccountMapping} accounts=${result.accounts} accountClass=${accountClass} setAccountClass=${setAccountClass} />
        `],
      ]} />
    `;
  }

  function IssuesByMonth({ audit }) {
    const t = useTokens();
    const data = useMemo(() => {
      const m = new Map();
      const bump = (dateStr, key) => {
        const k = dateStr.slice(0, 7);
        if (!m.has(k)) m.set(k, { month: k, uncategorized: 0, duplicates: 0, mismatches: 0 });
        m.get(k)[key]++;
      };
      audit.uncategorized.forEach((r) => bump(r.dateStr, 'uncategorized'));
      audit.duplicates.forEach((g) => bump(g.rows[g.rows.length - 1].dateStr, 'duplicates'));
      audit.mismatches.forEach((r) => bump(r.dateStr, 'mismatches'));
      return [...m.values()].sort((a, b) => a.month.localeCompare(b.month)).map((d) => ({
        ...d,
        label: new Date(`${d.month}-01T00:00:00Z`).toLocaleString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' }),
      }));
    }, [audit]);
    if (!data.length) return null;
    const series = [
      { key: 'uncategorized', label: 'Uncategorized', color: t.s1 },
      { key: 'duplicates', label: 'Duplicate groups', color: t.s2 },
      { key: 'mismatches', label: 'Mismatches', color: t.s3 },
    ];
    return html`<section class="panel">
      <div class="panel-head"><h2>Issues by month</h2><p>Where cleanup work is concentrated. Months with a cluster usually point to a missed bank-feed review.</p></div>
      <div class="panel-body">
        <div class="legend">${series.map((s) => html`<span key=${s.key}><i style=${{ background: s.color }}></i>${s.label}</span>`)}</div>
        <div style=${{ height: 200 }}>
          <${ResponsiveContainer} width="100%" height="100%">
            <${BarChart} data=${data} margin=${{ top: 6, right: 8, bottom: 0, left: -18 }} barCategoryGap="28%">
              <${CartesianGrid} vertical=${false} stroke=${t.grid} />
              <${XAxis} dataKey="label" tickLine=${false} axisLine=${{ stroke: t.axis }} tick=${{ fill: t.muted, fontSize: 12 }} />
              <${YAxis} allowDecimals=${false} tickLine=${false} axisLine=${false} tick=${{ fill: t.muted, fontSize: 12 }} />
              <${Tooltip} cursor=${{ fill: t.surface2 }} content=${html`<${ChartTooltip} rows=${(d) => series.map((s) => ({ label: s.label, value: d[s.key], color: s.color }))} />`} />
              ${series.map((s, i) => html`<${Bar} key=${s.key} dataKey=${s.key} stackId="a" fill=${s.color} stroke=${t.surface} strokeWidth=${2} radius=${i === series.length - 1 ? [4, 4, 0, 0] : 0} isAnimationActive=${false} />`)}
            <//>
          <//>
        </div>
      </div>
    </section>`;
  }

  function UncategorizedPanel({ rows, open, total, onReview }) {
    return html`<section class="panel">
      <div class="panel-head">
        <h2>Uncategorized transactions</h2>
        <span class=${`pill ${open ? 'high' : 'good'}`}>${open} open · ${fmtMoney(total)}</span>
        <p>Posted to Uncategorized Income/Expense, Ask My Accountant, or left without an account. Each needs a category before month-end close.</p>
      </div>
      <div class="panel-body flush">
        ${rows.length ? html`<div class="table-wrap scroll-y"><table>
          <thead><tr><th>Review</th><th>CSV row</th><th>Date</th><th>Type</th><th>Payee</th><th>Memo</th><th>Where it sits</th><th class="num">Amount</th></tr></thead>
          <tbody>${rows.map((r) => html`<tr key=${r.id} class=${clearedOf(r) ? 'cleared' : ''}>
            <td><${ReviewSelect} item=${r} onReview=${onReview} /></td>
            <td class="row-no">${r.line}</td>
            <td class="nowrap num">${r.dateStr}</td>
            <td class="nowrap">${r.type}</td>
            <td>${counterpartyOf(r) || html`<span class="sub">No payee</span>`}</td>
            <td>${r.memo}</td>
            <td>${r.reason}</td>
            <td class="num"><${Money} v=${r.amount} /></td>
          </tr>`)}</tbody>
        </table></div>` : html`<div class="empty">${Icon.check}${open ? 'All open items are hidden.' : 'Nothing left to categorize.'}</div>`}
      </div>
    </section>`;
  }

  function DuplicatesPanel({ groups, open, exposure, onReview }) {
    return html`<section class="panel">
      <div class="panel-head">
        <h2>Potential duplicates</h2>
        <span class=${`pill ${open ? 'high' : 'good'}`}>${open} open · ${fmtMoney(exposure)} exposure</span>
        <p>Same payee, same amount and same account within 3 days, or a reference number entered twice. Common causes: a bank-feed match missed after a manual entry, or a bill entered twice.</p>
      </div>
      <div class="panel-body flush">
        ${groups.length ? groups.map((g) => html`<div class=${`dup-group ${clearedOf(g) ? 'cleared' : ''}`} key=${g.id}>
          <div class="dup-head"><${ReviewSelect} item=${g} onReview=${onReview} /><${Severity} level=${g.confidence} /><strong>${counterpartyOf(g.rows[0]) || g.rows[0].memo || 'No payee'}</strong><span style=${{ color: 'var(--ink-2)' }}>${g.reason}</span><span class="exposure">${fmtMoney(g.exposure)} at risk</span></div>
          <div class="table-wrap"><table class="dup-table"><colgroup><col style=${{ width: '90px' }} /><col style=${{ width: '110px' }} /><col style=${{ width: '150px' }} /><col style=${{ width: '26%' }} /><col /><col style=${{ width: '120px' }} /></colgroup><tbody>${g.rows.map((r) => html`<tr key=${r.id}>
            <td class="row-no" style=${{ paddingLeft: '18px' }}>row ${r.line}</td>
            <td class="nowrap num">${r.dateStr}</td>
            <td class="nowrap">${r.type}${r.num ? ` #${r.num}` : ''}</td>
            <td>${leafAccount(r.account)}</td>
            <td>${r.memo}</td>
            <td class="num"><${Money} v=${r.amount} /></td>
          </tr>`)}</tbody></table></div>
        </div>`) : html`<div class="empty">${Icon.check}No open duplicates.</div>`}
      </div>
    </section>`;
  }

  const monthName = (key) => new Date(`${key}-01T00:00:00Z`).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  // Money that should not be sitting where it is: things a P&L review never shows.
  function BalanceSheetPanel({ bs, vis, onReview }) {
    const items = vis(bs.items);
    const [showBalances, setShowBalances] = useState(false);
    return html`<section class="panel">
      <div class="panel-head">
        <h2>Balance sheet check</h2>
        <span class=${`pill ${bs.open ? 'high' : 'good'}`}>${bs.open ? `${bs.open} to fix` : 'Looks clean'}</span>
        <p>Problems a profit and loss review never shows, as of ${bs.asOf}: payments never deposited, Opening Balance Equity left from setup, accounts with the wrong sign, customer credits and vendor debits, and bills or invoices open long after they were probably settled.</p>
        <button class="btn spacer" onClick=${() => setShowBalances(!showBalances)}>${showBalances ? 'Hide balances' : 'Show balances'}</button>
      </div>
      ${showBalances && html`<div class="panel-body flush"><div class="table-wrap"><table>
        <thead><tr><th>Account</th><th>Type</th><th class="num">Balance</th></tr></thead>
        <tbody>${bs.balances.map((b) => html`<tr key=${b.account}><td>${b.account}</td><td>${BS_ROLE[b.role] || 'Other'}</td><td class="num"><${Money} v=${b.balance} /></td></tr>`)}</tbody>
      </table></div></div>`}
      <div class="panel-body flush">
        ${items.length ? html`<div class="table-wrap"><table>
          <thead><tr><th>Review</th><th>Severity</th><th>Issue</th><th>What to do</th><th class="num">Amount</th></tr></thead>
          <tbody>${items.map((r) => html`<tr key=${r.key} class=${clearedOf(r) ? 'cleared' : ''}>
            <td><${ReviewSelect} item=${r} onReview=${onReview} /></td>
            <td><${Severity} level=${r.severity} /></td>
            <td><strong style=${{ fontWeight: 500 }}>${r.kind}</strong><span class="sub">${r.detail}</span></td>
            <td class="sub-cell">${r.fix}</td>
            <td class="num"><${Money} v=${r.amount} /></td>
          </tr>`)}</tbody>
        </table></div>` : html`<div class="empty">${Icon.check}${bs.open ? 'All open items are hidden.' : 'No balance sheet problems found.'}</div>`}
      </div>
    </section>`;
  }
  const BS_ROLE = { cash: 'Bank', card: 'Credit card', ar: 'Receivables', ap: 'Payables', loan: 'Loan', equity: 'Equity', salestax: 'Sales tax', payrolltax: 'Payroll liabilities', otherbalance: 'Other asset or liability' };

  // Once a month is closed, any later edit to it changes what was already reported.
  function ClosedMonthsPanel({ result, onClose, canSave }) {
    const c = result.closed;
    const months = result.closableMonths || [];
    const latest = months[months.length - 1];
    const [pick, setPick] = useState(latest || '');
    const [confirmReopen, setConfirmReopen] = useState(false);
    if (!latest) return null;
    const changed = c && c.changedMonths > 0;
    const picker = html`<select class="select" style=${{ width: 'auto' }} aria-label="Close through" value=${pick} onChange=${(e) => setPick(e.target.value)}>
      ${months.slice().reverse().map((m) => html`<option key=${m} value=${m}>${monthName(m)}</option>`)}
    </select>`;
    return html`<section class="panel">
      <div class="panel-head">
        <h2>Closed months</h2>
        ${c ? html`<span class=${`pill ${changed ? 'high' : 'good'}`}>${changed ? `${c.changedEntries} change${c.changedEntries === 1 ? '' : 's'} since closing` : `Closed through ${monthName(c.through)}`}</span>` : html`<span class="pill low">Not closed yet</span>`}
        <p>${c
          ? `Books closed through ${monthName(c.through)} on ${String(c.takenAt).slice(0, 10)}. Each time a new export is loaded, those months are compared with what they looked like at closing, so edits, deletions and backdated entries show up here.${c.skippedMonths ? ` ${c.skippedMonths} closed month${c.skippedMonths === 1 ? ' is' : 's are'} not in this export and ${c.skippedMonths === 1 ? 'was' : 'were'} not checked.` : ''}`
          : 'After reviewing and reporting a month, close it here. From then on, any change to those months in a later export (a recoded, edited, deleted or backdated transaction) is listed here, so reported numbers never shift unnoticed.'}${canSave ? '' : ' (With the sample data this is kept only until the page is reloaded; for a client it is saved with their settings.)'}</p>
      </div>
      ${changed && html`<div class="panel-body flush">
        ${c.months.map((m) => html`<div class="closed-month" key=${m.month}>
          <div class="closed-head"><strong>${monthName(m.month)}</strong>
            <span class="sub">${[m.added.length ? `${m.added.length} new or edited` : '', m.removed ? `${m.removed} removed or edited` : ''].filter(Boolean).join(' · ')}</span></div>
          ${m.accounts.length > 0 && html`<div class="chips" style=${{ padding: '0 18px 8px' }}>${m.accounts.slice(0, 8).map((a) => html`<span class="pill ${a.diff > 0 ? 'medium' : 'low'}" key=${a.account}>${a.account} ${a.diff > 0 ? '+' : '−'}${fmtMoney(Math.abs(a.diff))}</span>`)}</div>`}
          ${m.added.length > 0 && html`<div class="table-wrap"><table>
            <thead><tr><th>Date</th><th>Type</th><th>Payee</th><th>Account</th><th>Memo</th><th class="num">Amount</th></tr></thead>
            <tbody>${m.added.map((t, i) => html`<tr key=${i}><td class="nowrap num">${t.dateStr}</td><td class="nowrap">${t.type}${t.num ? ` #${t.num}` : ''}</td><td>${t.name || html`<span class="sub">No payee</span>`}</td><td>${t.account}${t.split ? html`<span class="sub">${t.split}</span>` : ''}</td><td>${t.memo}</td><td class="num"><${Money} v=${t.amount} /></td></tr>`)}</tbody>
          </table></div>`}
        </div>`)}
      </div>`}
      <div class="panel-body closed-actions">
        ${changed
          ? html`<span class="hint">Correct the changes in QuickBooks, or accept them as the new closed numbers:</span><button class="btn primary" onClick=${() => onClose(c.through)}>Accept changes</button>`
          : html`<span class="hint">${c ? 'Move the close forward after reviewing the next month:' : 'Close the books through'}</span>${picker}<button class="btn primary" disabled=${c && pick === c.through} onClick=${() => onClose(pick)}>${c ? 'Update close' : 'Close books'}</button>`}
        ${c && (confirmReopen
          ? html`<span class="confirm">Stop watching closed months? <button class="btn" onClick=${() => { onClose(null); setConfirmReopen(false); }}>Reopen</button><button class="btn" onClick=${() => setConfirmReopen(false)}>Cancel</button></span>`
          : html`<button class="btn" onClick=${() => setConfirmReopen(true)}>Reopen</button>`)}
      </div>
    </section>`;
  }

  // What the client wrote back in the questions spreadsheet.
  function AnswersPanel({ answers, onReview, onRemove, onRead }) {
    const open = answers.filter((a) => !clearedOf(a)).length;
    return html`<section class="panel">
      <div class="panel-head">
        <h2>Client answers</h2>
        <span class=${`pill ${open ? 'medium' : 'good'}`}>${open ? `${open} to act on` : 'All handled'}</span>
        <p>Answers the client sent through the answer link or the questions spreadsheet. Make the change in QuickBooks, then mark each one <em>Fixed in QuickBooks</em> or <em>Not an issue</em>; answered questions are left out of the next question list.</p>
      </div>
      <div class="panel-body flush"><div class="table-wrap"><table>
        <thead><tr><th>Review</th><th>Question</th><th>Client's answer</th><th>Received</th><th></th></tr></thead>
        <tbody>${answers.map((a) => html`<tr key=${a.key} class=${clearedOf(a) ? 'cleared' : ''}>
          <td><${ReviewSelect} item=${a} onReview=${onReview} /></td>
          <td><span class="sub">${a.ref} · ${a.topic}</span>${a.question}</td>
          <td><strong style=${{ fontWeight: 500 }}>${a.answer || html`<span class="sub">No written answer</span>`}</strong>${a.photos && a.photoKey ? html`<${AnswerPhotos} photoKey=${a.photoKey} count=${a.photos} /><${ReceiptRead} answer=${a} onRead=${onRead} />` : a.receipt ? html`<span class="pill good" style=${{ marginTop: '4px' }}>Receipt sent</span>` : ''}${a.via === 'portal' ? html`<span class="sub">Through the answer link</span>` : ''}</td>
          <td class="nowrap num">${a.at || ''}</td>
          <td><button class="btn" onClick=${() => onRemove(a.key)}>Remove</button></td>
        </tr>`)}</tbody>
      </table></div></div>
    </section>`;
  }

  const RECEIPT_STATUS = { Attached: 'good', 'Client sent': 'good', Missing: 'high', Unknown: 'low' };

  // Expenses that need a receipt, and whether one is attached in QuickBooks.
  function ReceiptsPanel({ rc, vis, onReview, limit, setLimit }) {
    const [showAll, setShowAll] = useState(false);
    const rows = vis(showAll ? rc.items : rc.items.filter((x) => x.status !== 'Attached'));
    const c = rc.counts;
    const source = rc.source === 'export' ? 'the Attachments column in the export'
      : rc.source === 'list' ? 'the expense list with attachments' : null;
    return html`<section class="panel">
      <div class="panel-head">
        <h2>Receipts</h2>
        <span class=${`pill ${rc.open ? (c.missing ? 'high' : 'medium') : 'good'}`}>${rc.open ? `${rc.open} needed` : 'All in hand'}</span>
        <p>Expenses since ${rc.since} that need a receipt: lodging and gifts at any amount, meals, entertainment and travel of $75 or more (IRS rules), one-off purchases of $2,500 or more${rc.limit ? `, and anything over ${fmtWhole(rc.limit)}` : ''}. ${source
          ? `Receipt status comes from ${source}: ${c.attached} attached, ${c.missing} missing${c.sent ? `, ${c.sent} sent by the client` : ''}.`
          : 'To see which already have a receipt attached, add the export from QuickBooks\u2019 Expenses page with the Attachments column turned on (gear icon on the list, tick Attachments, then Export).'}</p>
      </div>
      <div class="panel-body receipt-bar">
        <label class="field" for="receipt-limit">Also flag any expense over<div class="money-input"><span>$</span><input id="receipt-limit" inputmode="decimal" value=${limit} placeholder="off" onInput=${(e) => setLimit(e.target.value.replace(/[^0-9.]/g, ''))} /></div></label>
        ${c.attached > 0 && html`<label class="check" for="receipts-all" style=${{ paddingTop: 0 }}><input id="receipts-all" type="checkbox" checked=${showAll} onChange=${(e) => setShowAll(e.target.checked)} />Show ones with receipts too</label>`}
      </div>
      <div class="panel-body flush">
        ${rows.length ? html`<div class="table-wrap scroll-y"><table>
          <thead><tr><th>Review</th><th>Date</th><th>Payee</th><th>Why a receipt</th><th>Receipt</th><th class="num">Amount</th></tr></thead>
          <tbody>${rows.map((r) => html`<tr key=${r.key} class=${clearedOf(r) ? 'cleared' : ''}>
            <td><${ReviewSelect} item=${r} onReview=${onReview} /></td>
            <td class="nowrap num">${r.dateStr}</td>
            <td>${counterpartyOf(r) || html`<span class="sub">No payee</span>`}<span class="sub">${r.account}${r.memo ? ` · ${r.memo}` : ''}</span></td>
            <td><strong style=${{ fontWeight: 500 }}>${r.rule}</strong><span class="sub">${r.why}</span></td>
            <td><span class=${`pill ${RECEIPT_STATUS[r.status]}`}>${r.status === 'Unknown' ? 'Not known' : r.status}</span></td>
            <td class="num"><${Money} v=${r.amount} /></td>
          </tr>`)}</tbody>
        </table></div>` : html`<div class="empty">${Icon.check}${rc.items.length ? 'Every receipt needed is attached or cleared.' : 'No expenses in the last 12 months need a receipt under these rules.'}</div>`}
      </div>
    </section>`;
  }

  // Not errors, so not in the health score: amounts that look out of line and are worth a second look.
  function UnusualPanel({ u, vis, onReview }) {
    const flux = vis(u.flux);
    const txns = vis(u.txns);
    const open = [...u.flux, ...u.txns].filter((x) => !clearedOf(x)).length;
    return html`<section class="panel">
      <div class="panel-head">
        <h2>Unusual activity</h2>
        <span class=${`pill ${open ? 'medium' : 'good'}`}>${open} to look at</span>
        <p>Accounts that moved sharply in ${u.monthLabel} against a typical month (${u.priorLabel}), and single payments well above what a payee is usually paid, or large first payments to someone new. These are not errors, just worth a second look before the books are closed.</p>
      </div>
      <div class="panel-body flush">
        ${flux.length > 0 && html`<div class="table-wrap"><table>
          <thead><tr><th>Review</th><th>Account</th><th class="num">${u.monthLabel}</th><th class="num">Typical month</th><th class="num">Change</th><th>What moved</th></tr></thead>
          <tbody>${flux.map((f) => html`<tr key=${f.key} class=${clearedOf(f) ? 'cleared' : ''}>
            <td><${ReviewSelect} item=${f} onReview=${onReview} /></td>
            <td>${f.account}<span class="sub">${f.cls === 'income' ? 'Income' : f.cls === 'cogs' ? 'Cost of sales' : 'Expense'}</span></td>
            <td class="num">${fmtWhole(f.now)}</td>
            <td class="num">${fmtWhole(f.typical)}</td>
            <td class="num" style=${{ color: f.concern ? 'var(--critical)' : 'var(--good)' }}>${f.up ? '+' : '−'}${fmtWhole(Math.abs(f.diff))}</td>
            <td>${f.detail}</td>
          </tr>`)}</tbody>
        </table></div>`}
        ${txns.length > 0 && html`<div class="table-wrap"><table>
          <thead><tr><th>Review</th><th>Date</th><th>Payee</th><th>Why it stands out</th><th>Account</th><th class="num">Amount</th></tr></thead>
          <tbody>${txns.map((r) => html`<tr key=${r.key} class=${clearedOf(r) ? 'cleared' : ''}>
            <td><${ReviewSelect} item=${r} onReview=${onReview} /></td>
            <td class="nowrap num">${r.dateStr}</td>
            <td>${counterpartyOf(r) || html`<span class="sub">No payee</span>`}<span class="sub">${r.type}</span></td>
            <td><strong style=${{ fontWeight: 500 }}>${r.kind}</strong><span class="sub">${r.detail}</span></td>
            <td>${leafAccount(r.account)}</td>
            <td class="num"><${Money} v=${r.amount} /></td>
          </tr>`)}</tbody>
        </table></div>`}
        ${!flux.length && !txns.length && html`<div class="empty">${Icon.check}${open ? 'All open items are hidden.' : 'Nothing out of the ordinary.'}</div>`}
      </div>
    </section>`;
  }

  function MismatchPanel({ rows, open, onReview }) {
    const kinds = useMemo(() => {
      const m = new Map();
      rows.forEach((r) => m.set(r.kind, (m.get(r.kind) || 0) + 1));
      return [...m.entries()];
    }, [rows]);
    const [filter, setFilter] = useState('All');
    const shown = filter === 'All' ? rows : rows.filter((r) => r.kind === filter);
    return html`<section class="panel">
      <div class="panel-head">
        <h2>Mismatched entries</h2>
        <span class=${`pill ${open ? 'medium' : 'good'}`}>${open} open</span>
        <p>Transaction types that conflict with their account (an expense coded to income, a transfer hitting the P&L), vendors coded inconsistently, missing payees and unbalanced journal entries.</p>
      </div>
      ${rows.length > 0 && html`<div class="panel-body" style=${{ paddingBottom: '12px' }}>
        <div class="chips">
          ${[['All', rows.length], ...kinds].map(([k, n]) => html`<button key=${k} class="chip" aria-pressed=${filter === k} onClick=${() => setFilter(k)}>${k}<span class="n">${n}</span></button>`)}
        </div>
      </div>`}
      <div class="panel-body flush">
        ${rows.length ? html`<div class="table-wrap scroll-y"><table>
          <thead><tr><th>Review</th><th>Severity</th><th>CSV row</th><th>Date</th><th>Payee</th><th>Issue</th><th class="num">Amount</th></tr></thead>
          <tbody>${shown.map((r, i) => html`<tr key=${`${r.id}-${i}`} class=${clearedOf(r) ? 'cleared' : ''}>
            <td><${ReviewSelect} item=${r} onReview=${onReview} /></td>
            <td><${Severity} level=${r.severity} /></td>
            <td class="row-no">${r.line}</td>
            <td class="nowrap num">${r.dateStr}</td>
            <td>${counterpartyOf(r) || html`<span class="sub">No payee</span>`}<span class="sub">${r.type}</span></td>
            <td><strong style=${{ fontWeight: 500 }}>${r.kind}</strong><span class="sub">${r.detail}</span></td>
            <td class="num"><${Money} v=${r.amount} /></td>
          </tr>`)}</tbody>
        </table></div>` : html`<div class="empty">${Icon.check}No coding conflicts found.</div>`}
      </div>
    </section>`;
  }

  const ROLE_LABEL = { cash: 'Bank', card: 'Credit card', ar: 'Receivable', ap: 'Payable', loan: 'Loan', equity: 'Owner equity', salestax: 'Sales tax', payrolltax: 'Payroll tax', otherbalance: 'Other balance sheet' };

  function AccountMapping({ accounts, accountClass, setAccountClass }) {
    const labels = { income: 'Income', cogs: 'Cost of goods sold', expense: 'Expense', balance: 'Balance sheet' };
    const changed = Object.keys(accountClass).length;
    const fromChart = accounts.filter((a) => a.source === 'chart').length;
    return html`<details class="panel mapping">
      <summary>Account mapping ${changed ? html`<span class="pill" style=${{ marginLeft: '8px' }}>${changed} changed by you</span>` : ''}<span style=${{ fontWeight: 400, fontFamily: 'var(--sans)', color: 'var(--muted)', fontSize: '13px', marginLeft: '8px' }}>${fromChart ? `${fromChart} of ${accounts.length} typed from the chart of accounts.` : 'Guessed from account names.'} Correct any that are wrong and every figure updates.</span></summary>
      <div class="table-wrap"><table>
        <thead><tr><th>Account</th><th class="num">Rows</th><th>Treated as</th><th>Source</th></tr></thead>
        <tbody>${accounts.map((a) => {
          const manual = accountClass[a.name] != null;
          return html`<tr key=${a.name}>
          <td>${a.name}${(accountClass[a.name] || a.detected) === 'balance' ? html`<span class="sub">${ROLE_LABEL[a.role] || ''}</span>` : ''}</td>
          <td class="num">${a.count}</td>
          <td>
            <select aria-label=${`Account type for ${a.name}`} value=${accountClass[a.name] || a.detected} onChange=${(e) => {
              const v = e.target.value;
              const next = { ...accountClass };
              if (v === a.detected) delete next[a.name]; else next[a.name] = v;
              setAccountClass(next);
            }}>
              ${Object.entries(labels).map(([k, l]) => html`<option key=${k} value=${k}>${l}</option>`)}
              ${a.detected === 'blank' && html`<option value="blank">Unassigned</option>`}
            </select>
          </td>
          <td class="sub" style=${{ display: 'table-cell' }}>${manual ? 'Changed by you' : a.source === 'chart' ? `Chart of accounts: ${a.type}` : 'Guessed from name'}</td>
        </tr>`;
        })}</tbody>
      </table></div>
    </details>`;
  }

  Object.assign(UI, { AuditTab });
})();
