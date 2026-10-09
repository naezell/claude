# Ledger Lens

A browser-based audit and profitability dashboard for bookkeeping practices. Drop in a QuickBooks **Transaction Detail** export (CSV or Excel) and get:

**Diagnostic Audit**
- **Uncategorized transactions**: anything in Uncategorized Income/Expense/Asset, Ask My Accountant, suspense, or with no account at all. Shows exact CSV row numbers.
- **Potential duplicates**: same payee, same amount and same account within 3 days, or a reference number entered twice. Groups are ranked by dollars at risk.
- **Mismatched entries**: transaction types that conflict with their account (an expense coded to income, a sales receipt coded to expense, a transfer touching the P&L), vendors coded to an unusual category, expenses with no payee, and journal entries whose debits and credits don't balance.
- **Balance sheet check**: problems a P&L review never shows, from the account balances in a "by Account" export: money waiting in Undeposited Funds (and for how long), a leftover Opening Balance Equity, accounts with the wrong sign (overdrawn bank, overpaid card, negative A/R, A/P, loan or sales tax), customers with credits in receivables, vendors with debits in payables, bills open more than 90 days (often paid as a separate expense, so the cost counts twice) and invoices open more than 120 days. Each comes with what to do and can be marked reviewed. **Show balances** lists every balance sheet account.
- **Closed months**: after reporting a month, close the books through it. The app keeps a small fingerprint of each closed month with the client's settings. Every later export is compared against it: edited, recoded, deleted and backdated entries are listed by month, with the accounts that moved. Fix them in QuickBooks or accept them as the new closed numbers. Months a shorter export does not cover are skipped, not reported as deleted.
- **Receipts**: expenses from the last 12 months that need a receipt: lodging and gifts at any amount, meals, entertainment and travel of $75 or more (IRS substantiation rules), one-off purchases of $2,500 or more (not bills, which come with the vendor's invoice, and not repeating payments like rent), and optionally anything over the firm's own limit. With an Attachments column in the export, or the list from QuickBooks' Expenses page exported with Attachments turned on, each one shows as attached or missing. Missing receipts go into the client questions.
- **Unusual activity**: a month-end variance review. Accounts that moved sharply in the latest full month against the median of the six months before, single payments far above what a payee is usually paid (and above anything they have billed before), and large first payments to someone new. These can be marked reviewed like any flag but don't count against the health score, and the payments feed the client questions.
- A books health score, an issues-by-month chart, and an **account mapping** panel for correcting how any account is classified. Every figure recalculates when you change it.

**Growth & Profitability Insights**
- Revenue, direct cost, gross margin and **net margin after overhead** per **customer** or **project** (sub-customer `Customer:Project`, a Project column, or Class).
- **Customer concentration & risk**: each customer's share of the last 12 months' revenue, top-customer and top-3 share, and an HHI concentration rating. A per-customer risk table combines share, 3-month trend, gross margin, open receivables and days to pay, and flags concentration, slow payers, invoices over 90 days, shrinking or lost customers and low margins. It also shows what monthly profit would be if each customer left, since their job costs go away but overhead stays.
- **Job costing gaps**: when the business tags job costs to customers or projects, lists cost of goods sold with no job attached (and suggests the job when that vendor's other costs all go to one), jobs with costs but nothing billed, and jobs billed with no costs when most jobs have them. When job costs are not tagged at all, it says so, since customer profit is then revenue only.
- **Recurring SaaS & subscription detection**: finds steady weekly, monthly, quarterly and annual software charges, annualizes them, and flags overlapping tools (for example Asana + Monday.com), multiple charges per month (extra seats), price increases and consumer services on the business card. Estimates the annual savings.

**Cash Forecast**
- A **13-week cash flow forecast** built from the export: open invoices are collected on each customer's own median days-to-pay (measured from their payment history, not the invoice terms), customers who bill monthly keep billing, open bills are paid on each vendor's usual timing, and monthly costs like payroll, rent and software are projected forward.
- Repeating payments that never show as expenses are projected too: owner draws, loan principal, and sales-tax or payroll-tax remittances.
- Starting cash comes from the bank accounts' beginning balance plus period activity. You can override it and set a minimum cash cushion. The tool warns about weeks below the cushion or below zero and names what lands in the lowest week.
- **What if?** Stack changes and see the effect before they happen: a customer paying later, losing a customer, sales up or down, a new monthly cost such as a hire or lease, a one-time payment, or one-time money in such as loan proceeds. Every figure on the tab updates and the chart keeps the baseline for comparison. Changes are not saved or used in the client report.
- Receivables aging, a payment-speed chart per customer, and open invoice and bill schedules. Invoices over 90 days old are left out unless you include them. Open bills that the audit flags as possible duplicates are marked so nobody pays them twice.

**Break-even**
- Break-even revenue per month, margin of safety, contribution margin, and monthly revenue against the break-even line. COGS accounts and customer-tagged costs count as variable; everything else is fixed (adjustable through Account mapping).
- A **what-if panel**: change prices, variable costs or fixed costs and see the new profit and break-even side by side with today. It also shows how much work you could lose at a higher price and still match today's profit, and the revenue needed to hit a target monthly profit.

**Trends**
- Month-by-month or quarter-by-quarter revenue, job costs, overhead, net income, margins, cost mix, days to collect (DSO) and month-end cash.
- A "What changed" list in plain language: the last 3 months against the same months a year earlier (or the 3 months before when there is less than a year of history), overhead changes with the accounts behind them, slowing collections, lost and new customers, and software creep.
- The largest cost-account moves and customer changes, with partial months at the edges of the export faded and left out of comparisons.

**Budget**
- Upload the client's QuickBooks **Budget Overview** export (recognized automatically), or build a budget from last year's actuals month by month with growth rates for revenue and costs.
- Year-to-date budget against actual for revenue, costs and net income, monthly revenue and net income charts, where the year lands if the rest goes to budget, and every account's difference with favorable and over-budget flags. Accounts with actuals but no budget are listed too.

**Vendors**
- Vendor spending over the last 12 months (payroll excluded), with each vendor's share, type (job cost or overhead), 3-month trend, how fast they get paid, open bills and payment method.
- Bills coming due each forecast week against the projected cash balance, payables aging, and days to pay vendors (DPO) next to days to collect (DSO).
- **Vendor price increases**: vendors that charge a steady amount (rent, software, services) and have raised it, with the old and new price, when it changed and the yearly cost. The total becomes the price rise the business would need on its own sales to hold profit steady. Amounts that vary job to job are not treated as a price.
- Flags vendors paid well before 30-day terms and estimates the cash that paying on day 30 would keep in the business.
- **1099 contractor review**: vendors paid by check or bank transfer at or above the threshold for each calendar year ($600 for payments through 2025, $2,000 from 2026), with the likely form (1099-NEC, or 1099-MISC for rent). Card-only vendors and likely corporations are marked separately. It is a screening list; a W-9 settles each case.

**Benchmarks**
- Compares the client's last 12 months of revenue, profit, profit margin and expenses with regional peers in the same industry and state.
- Live figures come from the Intuit QuickBooks benchmark service through the viewer's own claude.ai **Intuit QuickBooks** connector (`benchmarking_against_industry`). Around 30 common small-business industries are built in; any NAICS code can be entered.
- Without the connector (for example when the file is opened locally), peer figures from any source, such as an RMA report or a trade survey, can be entered by hand. Either way the comparison flows into the client report.

**Chart of Accounts**: upload the client's Account List (Chart of Accounts) export alongside the transactions, in the same batch or with **Add export**. Its account types (Bank, Credit Card, Long Term Liabilities, Equity, Cost of Goods Sold, and so on) replace the guesses made from account names everywhere, and Account mapping shows where each type came from. Manual corrections still win.

**Tax & lending**
- **Loan readiness**: cash available for debt service over the last 12 months (net income plus interest and non-cash costs, plus any owner add-backs) against existing loan payments found in the export, giving the debt service coverage ratio lenders use (most want 1.25 or more). A loan calculator shows the monthly payment and coverage after a proposed loan, and the largest loan that keeps coverage at 1.25.
- A **lender readiness checklist** built from the rest of the analysis: how current the books are, open uncategorized items and duplicates, profitability, coverage, revenue trend, customer concentration, cash cushion, old receivables, and owner draws against profit.
- **Tax set-aside**: profit so far this year, a projection for the full year, the amount to hold back at an editable rate (defaults by business type), estimated payments found in the export or entered by hand, and the remaining quarterly payments (Apr 15, Jun 15, Sep 15, Jan 15) checked against the cash forecast. S corporations get a salary-versus-distributions check.
- **Safe owner pay**: how much more the owner can take over the next 13 weeks while every week stays above the cash cushion after tax payments and expected draws.
- These are planning estimates, not tax, legal or lending advice, and the page says so.

**Ties to QuickBooks**: add the client's Profit and Loss export for the same dates and the audit tab compares income, cost of goods sold, expenses and net income, then account by account, with a hint for each difference (missing from the export, treated as balance sheet, or entries outside the date range). The client report states whether the numbers tie.

**Payee names**: bank-feed spellings of the same business ("AMZN Mktp US*2K41", "Amazon.com") are merged for vendor spend, subscriptions, the 1099 review and the duplicate and coding checks. When the Name field is blank, a cleaned bank memo names the payee.

**Month-end close**: a checklist tab for each client and month: feeds reviewed, bank and card reconciliations, uncategorized items, duplicates, miscoded entries, the balance sheet check, unusual activity, job costs, payroll, sales tax (when the client has a sales tax account), the tie-out to the QuickBooks P&L, client questions, the client report, and closing the month. Steps the app can check tick themselves when the export shows them clear, with a link to the place to fix them; the rest are ticked by hand with the date. Add steps a client needs every month, and keep notes per month. Earlier closes are listed below.

**All-clients dashboard**: the **Clients** button lists every client whose export has been loaded, most urgent first: status (a closed month changed, needs attention, due for review, in progress, closed), month-end close progress, open items by kind, closed-through month, cash today and the lowest point ahead, and revenue and net income for the last 12 months. The figures are a short summary saved when each client's export was last analyzed; load a client's latest export to refresh them. Backups live in the same panel.

**Monthly review workflow**
- Mark each audit flag as *Not an issue*, *Fixed in QuickBooks* or *Asked the client*. Cleared flags drop out of the counts and health score and stay cleared when next month's export is loaded (flags are matched on what the entry is, not on row numbers).
- **Client answers by spreadsheet**: the questions also download as a spreadsheet (CSV, opens in Excel, Numbers or Google Sheets) with a reference on each row and blank *Your answer* and *Receipt sent?* columns. When the client sends it back (CSV or Excel), upload it with the exports or load it from the questions panel: answers are matched by reference and listed under **Client answers** on the audit tab, answered questions drop out of the next list, and receipts marked sent stop counting as missing.
- **Client questions**: turns open uncategorized items, possible double charges, entries needing context, unusual payments, invoices over 90 days old and W-9 requests into a friendly, numbered question list ready to email. One click marks the included flags as asked.
- **Saved clients** (in the **Clients** panel): account type corrections, reviewed flags, the cash cushion, benchmark industry and state, and loan and tax inputs are saved per client (matched on the company name in the report header) and restored when their file is loaded again. They are kept in this browser only; export a JSON backup to move them to another computer or share them with a colleague.

**Firm branding**: the app header, client reports, client questions and plain-text report carry the bookkeeping firm's name, logo, colors and website, set in `src/firm.js`. The logo is embedded in each downloaded report, so reports stay self-contained.

**Getting started guide**: the **Help** button opens a step-by-step guide covering which QuickBooks reports to export (Online and Desktop), loading them, a monthly routine, sending reports and backups. First-time visitors see a welcome note pointing to it.

**Backups**: in the **Clients** panel. **File on this computer** (Chrome and Edge): pick a file once and the app saves every client's settings and reviews to it after each change, with no account; after a reload the browser asks once before writing again. **Use an existing backup file** restores from a file saved earlier and keeps saving there. Other browsers get the manual option: **Save backup file** downloads everything to one file and **Restore from file** loads it, and reminds you when nothing has been backed up for 30 days. With a Google sign-in key set in `src/config.js` and the app on its own web address, it also connects to **Google Drive** to sync devices (laptop and phone): `Ledger Lens backup.json` holds the saved clients, and one compressed file per client holds its QuickBooks files and receipt photos. It pulls the other devices' changes before writing (newest copy of each client wins, removals carry over) after each change, every three minutes and when the page comes back into view. Everything is **encrypted before it leaves the device** with a backup passphrase Mark sets once and types once on each device (AES-256-GCM, key derived with PBKDF2), so Google only stores scrambled files; the passphrase is never stored or sent anywhere, and **Change passphrase** re-locks everything. Backups made before encryption are replaced automatically at the first sync. It uses the `drive.file` scope, so it can only see the file it created. Setup steps are in [docs/google-drive-setup.md](docs/google-drive-setup.md).

**Multiple exports**: upload several CSVs at once (for example one per year), or add one to what is already loaded with **Add export**. Rows repeated across files because date ranges overlap are skipped, and the report periods are combined.

**Client report** comes in three formats:
- **Owner summary**: one or two printed pages with the key numbers, a revenue and cost chart, the 13-week cash chart, what changed, what we recommend and what we need from the client.
- **Full review**: the summary plus detail tables (tie-out, balance sheet check, changes to closed months, job costing gaps, customer profitability and concentration, break-even, vendors, price increases and 1099 review, subscriptions, loan readiness, tax set-aside, benchmarks).
- **Plain text**, as before.

The formatted versions download as a single self-contained HTML file with built-in charts; open it in any browser and print to PDF to send.

**Plain-text report**: a plain-text summary to hand to the client, with an executive summary, each finding, the 13-week forecast, break-even, customer concentration, trends, vendors and 1099 review, benchmarks, loan readiness, tax set-aside, and recommended next steps. Download it as `.txt` or copy it.

All processing happens in the browser. The file is never uploaded anywhere.

## Running it

The live site is on Netlify (project `7d-ledger-lens`). `netlify.toml` tells Netlify to run `scripts/build-site.sh`, which copies the files into `dist/` and adds the page wrapper (doctype, viewport, favicon) a normal web host needs. Nothing is compiled. The build also stamps the commit into `src/version.js`, which problem reports quote.

The Netlify site asks for sign-in: only Google accounts on an allowed list get in, checked on Netlify's servers before any of the app is sent (see [docs/sign-in-setup.md](docs/sign-in-setup.md)).

Locally, open `index.html` in a browser, or serve the folder:

```sh
npx serve .
```

It opens with a sample data set (18 months of a fictional design studio, with seeded bookkeeping issues, a lost customer, a new hire and slowing collections) so every panel has something to show. The same sample is saved at `sample-data/harbor-pine-transaction-detail.csv`, with its Chart of Accounts at `sample-data/harbor-pine-chart-of-accounts.csv` Profit and Loss at `sample-data/harbor-pine-profit-and-loss.csv`, a 2026 budget at `sample-data/harbor-pine-budget-2026.csv`, and an Expenses list with attachments at `sample-data/harbor-pine-expenses-with-attachments.csv`.

Two more fictional clients for testing, a plumbing contractor and a cafe, are in `sample-data/test-clients/` with an answer key of what each should turn up (see its README). Regenerate them with `node scripts/make-test-clients.js`.

## Exporting from QuickBooks

1. **Reports → Transaction Detail by Account** (or Transaction List by Date / Transaction Detail).
2. For exact account types, also export **Reports → Account List** (the Chart of Accounts), to check the numbers, the **Profit and Loss** for the same dates, and the **Budget Overview** if the client keeps a budget. Upload them together; each is recognized automatically.
3. **Customize → Rows/Columns** and include at least: Date, Transaction Type, Num, Name, Customer, Memo/Description, Account (if offered), Split and Amount. Debit/Credit columns also work. Include the balance-sheet accounts (bank, A/R, A/P, credit cards) so the cash forecast can see open invoices, bills and bank balances.
4. Set the date range, then **Export** to Excel or CSV. Both work; the Excel reader loads only when an Excel file is uploaded. Twelve months or more unlocks the year-over-year comparisons in Trends; if QuickBooks limits the range, export each year separately and upload them together.

The parser skips the report title rows, section headers and "Total for…" lines. In the "by Account" layout each entry appears once per account it touches; Ledger Lens collapses these to one entry so nothing is counted twice.

## Project layout

| Path | Purpose |
| --- | --- |
| `index.html` | Page shell, styles, library loading |
| `vendor/` | The site's own copies of React, Recharts 3, htm, the Excel reader and the IBM Plex fonts (refresh with `npm run vendor`) |
| `src/diagnostics.js` | Recent errors and the "Report a problem" text; loads first, and shows a plain message if the app never starts |
| `src/store.js` | Where saved clients are kept: IndexedDB, falling back to localStorage, with save errors reported |
| `src/work.js`, `src/worker.js` | Reading files and analyzing large exports in a background worker, with the same work done on the page where workers are unavailable |
| `src/version.js` | Which build this is (replaced by the site build) |
| `src/engine.js` | CSV parsing and all analysis (pure JS, runs in Node too) |
| `src/sample.js` | Deterministic sample export generator |
| `src/config.js` | Settings for this copy (Google sign-in key for Drive backup) |
| `src/firm.js` | The firm's name, website, colors and logo (from `assets/`) |
| `src/ui/shared.js` | Helpers and small components shared by the tabs (storage, downloads, chart tokens, inputs) |
| `src/ui/drive.js` | Google Drive sync between devices (sign-in, two-way sync of clients, files and photos) |
| `src/ui/localfile.js` | Backup to a file on this computer (File System Access API) |
| `src/ui/help.js` | Getting-started guide |
| `src/ui/home.js` | Home: the landing page with every client and what is waiting on the bookkeeper or the client |
| `src/ui/arrange.js` | Customize: moving and hiding sections on each page, and tabs |
| `src/ui/close.js` | Month-end close checklist |
| `src/ui/problem.js` | "Report a problem" panel, and the fallback shown if part of the page crashes |
| `src/ui/*.js` | One file per tab (`audit`, `growth`, `cash`, `breakeven`, `trends`, `budget`, `vendors`, `benchmarks`, `advisory`) and `drawers.js` for the report, client questions and saved clients |
| `src/app.js` | Top-level app: file loading, state, tabs; mounts the page |
| `test/engine.test.js` | Engine tests |
| `test/ui.test.js` | Interface tests in headless Chromium |
| `test/auth.test.js` | Sign-in checks and the Netlify edge functions |
| `test/site.test.js` | The built site over HTTP with Netlify's headers: nothing blocked by the security policy |
| `test/vendor.test.js` | `vendor/` matches `package.json`, and the page loads nothing from other servers |
| `test/test-clients.test.js` | The two test clients: files match the generator, planted problems are found |
| `netlify/edge-functions/` | Sign-in gate, sign-in and sign-out (Netlify only) |
| `login.html`, `login.js` | Sign-in page |
| `portal.html`, `portal.js`, `src/sealed.js` | The client's answer page, and the sealing (encryption) it shares with the app |
| `src/ui/portal.js` | Answer links: creating, emailing, collecting answers and receipt photos |
| `netlify/functions/` | The portal's server side: sealed records in Netlify Blobs |

There is no build step. Each UI file is a plain script that reads what it needs from `window.LedgerUI` and adds its own components to it, so `index.html` loads them in order: `diagnostics.js` first, the libraries from `vendor/`, `store.js`, `work.js`, `shared.js`, the tabs and drawers, then `app.js`.

To change the logo, replace `assets/7d-logo.png` (full logo, used on reports) and `assets/7d-mark.png` (square mark, used in the header), then rebuild the embedded copies in `src/firm.js`:

```sh
node -e "const fs=require('fs'),u=(f)=>'data:image/png;base64,'+fs.readFileSync(f).toString('base64');let s=fs.readFileSync('src/firm.js','utf8');s=s.replace(/logo: '[^']*'/,\"logo: '\"+u('assets/7d-logo.png')+\"'\").replace(/mark: '[^']*'/,\"mark: '\"+u('assets/7d-mark.png')+\"'\");fs.writeFileSync('src/firm.js',s)"
```

## Changes and deployment

`main` is what runs on the live site. Work happens on a separate branch and comes in through a pull request; GitHub runs all the tests on it (`.github/workflows/tests.yml`) before it can be merged. Netlify is linked to `main`, so a merged change goes live a minute or two later. The build settings come from `netlify.toml`, and the sign-in settings live in Netlify's environment variables (see [docs/sign-in-setup.md](docs/sign-in-setup.md)).

### Saved clients

Each client's settings and reviews are one record in the browser's IndexedDB database (`src/store.js`), which has far more room than localStorage. A copy of each client's latest files is kept there too (`FileStore`), so **Open** in the Clients panel reloads them in one click; the bookkeeper can turn that off, and forgetting a client deletes its files. Files are not part of backups. Clients saved by earlier versions in localStorage are moved over on first load. If a save fails, a red banner says so and points to a backup. Records carry a schema version: when the shape of a saved client changes, raise `SCHEMA` and add a conversion step to `upgrade` there.

### Libraries

The page loads nothing from other servers except Google (sign-in and Drive). To update a library, change its version in `package.json`, run `npm install` and `npm run vendor`, and commit `vendor/`. A test fails if the two drift apart.

### Large files

Files are recognized and parsed in a background worker (`src/worker.js`), and exports with 8,000 rows or more (`backgroundRows` in `src/config.js`) are analyzed there too, so the page stays responsive and shows progress. On a 108,000-row export the longest freeze drops from about 2 seconds to 0.3, and a review click from 0.5 to 0.1. Pages opened straight from a file (`file://`) cannot start workers and do the same work on the page.

### Lender-ready package

On the Tax & lending tab, once the client has asked for a loan package, *Create lender-ready package* builds a report for the bank: the loan request, the measures underwriters test (debt service coverage, coverage with the new loan, current and quick ratios, debt to EBITDA) against usual targets, income statements by year plus the last 12 months, cash available for debt service, a balance summary and debt schedule, monthly figures, receivables and payables aging, largest customers, and the documents a lender will also ask for. Before it goes out it lists problems a lender would catch (wages without employer payroll taxes, payroll taxes out of line or unpaid, balance sheet issues, open flags, changed closed months, draws above profit, loans without interest). The lender copy leaves those notes out; the bookkeeper's copy includes them.

### Client portal (answer links)

From **Client questions**, *Create answer link* seals the open questions in the browser and stores them on the site under a random id; the key to open them is only in the link (after the `#`, which browsers never send to a server). Mark emails the link from his own address. The client answers on `/portal`, with optional receipt photos (shrunk in their browser), and the answers are sealed with the same key. Ledger Lens collects them on load, every few minutes, and on *Check for answers*, files them under Client answers, and deletes the site's copy. Links expire after 30 days (45 at most); a new link replaces the client's previous one. The site never holds anything it can read. `test/portal.test.js` covers the server side, and `test/site.test.js` the whole round trip in a browser.

### Security headers

`netlify.toml` sends a Content-Security-Policy: the browser runs only this site's own scripts, plus Google's sign-in script, and the page may only talk to this site and Google (sign-in and Drive). Nothing on the site may use inline scripts or `eval`, which is why the sign-in page's code is in `login.js`. `test/site.test.js` serves the built site with these headers and fails if anything is blocked. If you add an outside service, add its address to the policy.

### Problem reports

"Report a problem" (page footer, Help, and the crash screen) opens an email to `supportEmail` in `src/config.js` with the person's description, the build, browser, storage state and recent errors, and no client data. Nothing is sent automatically.

## Tests

```sh
npm install      # dev dependencies for the interface tests only
npm test         # engine and interface tests
npm run test:engine
```

The engine tests need nothing installed. The interface tests open `index.html` in headless Chromium through `playwright-core`, loading the libraries from `vendor/` as the live site does and refusing every outside request, so no network is needed. They find Playwright's own Chromium, any build under `PLAYWRIGHT_BROWSERS_PATH`, or the path in `CHROMIUM_PATH`, and skip themselves when none is available.
