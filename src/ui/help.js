/* Ledger Lens UI: getting-started guide. */
(function () {
  'use strict';
  const { useState } = React;
  const html = htm.bind(React.createElement);
  const UI = window.LedgerUI;
  const { Icon, useEscape, Firm } = UI;

  const SECTIONS = [
    ['export', 'Export from QuickBooks'],
    ['load', 'Load the files'],
    ['monthly', 'Monthly routine'],
    ['send', 'Send to the client'],
    ['save', 'Saving your work'],
  ];

  function HelpDrawer({ onClose, onOpenClients, onReport }) {
    const [open, setOpen] = useState('export');
    useEscape(onClose);
    const part = (id, body) => html`<section class=${`help-part ${open === id ? 'open' : ''}`} id=${`help-${id}`}>${body}</section>`;
    return html`<div class="scrim" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="help-title">
        <div class="drawer-head"><h2 id="help-title">Getting started</h2><button class="btn" onClick=${onClose}>Close</button></div>
        <nav class="help-nav chips" aria-label="Guide sections">
          ${SECTIONS.map(([id, label], i) => html`<button key=${id} class="chip" aria-pressed=${open === id} onClick=${() => setOpen(id)}><span class="n">${i + 1}</span> ${label}</button>`)}
        </nav>
        <div class="drawer-scroll help">
          ${part('export', html`
            <h3>1. Export from QuickBooks</h3>
            <p>The main file is the <strong>Transaction Detail by Account</strong> report. Everything else is optional but makes the results more exact.</p>
            <h4>QuickBooks Online</h4>
            <ol>
              <li>Go to <strong>Reports</strong> and search for <strong>Transaction Detail by Account</strong>.</li>
              <li>Set <strong>Report period</strong> to at least the last 12 months. Two years (last year plus this year to date) unlocks the year-over-year comparisons.</li>
              <li>Choose <strong>Customize</strong> → <strong>Rows/Columns</strong> → <strong>Change columns</strong> and tick: Date, Transaction Type, Num, Name, Customer (or Customer/Project), Memo/Description, Account, Split and Amount.</li>
              <li>Leave every account included, bank, credit cards, A/R and A/P too; the cash forecast needs them.</li>
              <li>Run the report, then use the <strong>Export</strong> icon → <strong>Export to Excel</strong> (CSV works as well).</li>
            </ol>
            <h4>Worth adding</h4>
            <ul>
              <li><strong>Account List</strong> (Reports → Account List): exact account types instead of guesses from the names.</li>
              <li><strong>Profit and Loss</strong> for the same dates: the audit tab checks the numbers tie to QuickBooks.</li>
              <li><strong>Budget Overview</strong>, if the client keeps a budget: fills in the Budget tab.</li>
              <li><strong>Expenses list with attachments</strong>: on the <strong>Expenses</strong> page, click the gear icon above the list, tick <strong>Attachments</strong>, then Export. Tells the Receipts check which expenses already have a receipt attached.</li>
            </ul>
            <h4>QuickBooks Desktop</h4>
            <p>Reports → Accountant & Taxes → <strong>Transaction Detail by Account</strong>. Use Customize Report to add the same columns, then <strong>Excel</strong> → Create New Worksheet, or save as a CSV file.</p>
          `)}
          ${part('load', html`
            <h3>2. Load the files</h3>
            <ul>
              <li>Press <strong>Upload export</strong> and select all of a client's files at once, or drag them onto the page. Each report is recognized on its own.</li>
              <li>If QuickBooks limits the date range, export each year separately and upload them together. Rows that appear in both are only counted once.</li>
              <li>To add a file later (say the P&L), use <strong>Add export</strong>.</li>
              <li>Settings are remembered per client by the company name at the top of the export, and come back the next time that client's file is loaded.</li>
              <li>The <strong>Clients</strong> button shows every client loaded so far, most urgent first: open flags, balance sheet issues, changes to closed months, cash, and how far the month-end close has got.</li>
              <li>To switch clients, press <strong>Open</strong> next to one in the Clients panel. It reloads the files you last uploaded for them, kept in this browser. Upload new exports when their books have moved on.</li>
              <li>Large exports (tens of thousands of rows) take a few seconds; a note at the top shows progress and the page stays usable meanwhile.</li>
            </ul>
          `)}
          ${part('monthly', html`
            <h3>3. Monthly routine</h3>
            <ol class="routine">
              <li><strong>Upload</strong> the latest exports. Uploading the full history each month is fine. The <strong>Month-end close</strong> tab lists every step below and ticks off the ones the app can check.</li>
              <li><strong>Diagnostic audit</strong>: if the P&L was added, check <em>Ties to QuickBooks</em> first. Then work through uncategorized items, possible duplicates and mismatches, and mark each one <em>Not an issue</em>, <em>Fixed in QuickBooks</em> or <em>Asked the client</em>. Cleared flags stay cleared next month.</li>
              <li><strong>Closed months</strong>: if anything changed in a month you already closed, it is listed at the top of the audit tab. Fix it in QuickBooks or accept it.</li>
              <li><strong>Balance sheet check</strong> and <strong>Unusual activity</strong>, lower on the audit tab: clear money stuck in Undeposited Funds, Opening Balance Equity, credits and old open bills, and confirm anything out of line.</li>
              <li><strong>Job costing gaps</strong>, on the Growth tab: add the customer to job costs that have none, and invoice jobs with costs but no billing.</li>
              <li><strong>Client questions</strong>: send the list, or press <em>Spreadsheet for the client</em> for a file they fill in (answers in the last two columns). When it comes back, upload it or press <em>Load client's answers</em>; answers appear under <strong>Client answers</strong> on the audit tab. Press <em>Mark as asked</em> once sent.</li>
              <li><strong>Receipts</strong>: missing receipts for meals, travel, lodging, gifts and large purchases are listed on the audit tab and included in the questions. To see which already have a receipt attached, also upload the list from QuickBooks' <em>Expenses</em> page with the Attachments column turned on.</li>
              <li>Look over <strong>Cash forecast</strong>, <strong>Trends</strong> and <strong>Vendors</strong> for talking points: slow payers, rising costs, price increases, the tightest week ahead.</li>
              <li>Send the <strong>client report</strong> (next step). Then <strong>close the month</strong> in the Closed months panel, and back up.</li>
            </ol>
          `)}
          ${part('send', html`
            <h3>4. Send to the client</h3>
            <ul>
              <li>Press <strong>Client report</strong> and pick <em>Owner summary</em> (one or two pages) or <em>Full review</em> (with detail tables).</li>
              <li>Type your name under <em>Prepared by</em>. Reports carry the ${Firm.name || 'firm'} name${Firm.logo ? ' and logo' : ''}${Firm.website ? ` and ${Firm.website}` : ''}.</li>
              <li>Download it, open the file in any browser and choose <strong>Print → Save as PDF</strong>. Send the PDF.</li>
              <li>Review the report before sending: the figures come straight from the export, and the flags are leads to check, not confirmed errors.</li>
            </ul>
          `)}
          ${part('save', html`
            <h3>5. Saving your work</h3>
            <ul>
              <li>Client files are read in your browser and never uploaded anywhere.</li>
              <li>Your reviews and settings are saved in this browser on this computer, and so is a copy of each client's latest files for the Open button (turn that off in the Clients panel if you prefer). Clearing browser data, or switching browsers or computers, starts fresh.</li>
              <li>So back up, in the <strong>Clients</strong> panel: pick a <strong>file on this computer</strong> that the app keeps saving to (Chrome and Edge), connect <strong>Google Drive</strong>, or download a backup file now and then. The page reminds you if nothing has been backed up for 30 days. Backups hold reviews and settings, not the QuickBooks files, so keep those where you normally do.</li>
            </ul>
            <p><button class="btn" onClick=${() => { onClose(); onOpenClients(); }}>${Icon.cloud}Open Clients & backup</button></p>
          `)}
          <p class="help-report">Something not working, or a figure that looks wrong? <button class="btn" onClick=${() => { onClose(); onReport(); }}>${Icon.flag}Report a problem</button></p>
        </div>
      </aside>
    </div>`;
  }

  Object.assign(UI, { HelpDrawer });
})();
