# Ledger Lens

A browser-based audit and profitability dashboard for bookkeeping practices. Drop in a QuickBooks **Transaction Detail** export (CSV or Excel) and get:

**Diagnostic Audit**
- **Uncategorized transactions**: anything in Uncategorized Income/Expense/Asset, Ask My Accountant, suspense, or with no account at all. Shows exact CSV row numbers.
- **Potential duplicates**: same payee, same amount and same account within 3 days, or a reference number entered twice. Groups are ranked by dollars at risk.
- **Mismatched entries**: transaction types that conflict with their account (an expense coded to income, a sales receipt coded to expense, a transfer touching the P&L), vendors coded to an unusual category, expenses with no payee, and journal entries whose debits and credits don't balance.
- **Unusual activity**: a month-end variance review. Accounts that moved sharply in the latest full month against the median of the six months before, single payments far above what a payee is usually paid (and above anything they have billed before), and large first payments to someone new. These can be marked reviewed like any flag but don't count against the health score, and the payments feed the client questions.
- A books health score, an issues-by-month chart, and an **account mapping** panel for correcting how any account is classified. Every figure recalculates when you change it.

**Growth & Profitability Insights**
- Revenue, direct cost, gross margin and **net margin after overhead** per **customer** or **project** (sub-customer `Customer:Project`, a Project column, or Class).
- **Customer concentration & risk**: each customer's share of the last 12 months' revenue, top-customer and top-3 share, and an HHI concentration rating. A per-customer risk table combines share, 3-month trend, gross margin, open receivables and days to pay, and flags concentration, slow payers, invoices over 90 days, shrinking or lost customers and low margins. It also shows what monthly profit would be if each customer left, since their job costs go away but overhead stays.
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

**Monthly review workflow**
- Mark each audit flag as *Not an issue*, *Fixed in QuickBooks* or *Asked the client*. Cleared flags drop out of the counts and health score and stay cleared when next month's export is loaded (flags are matched on what the entry is, not on row numbers).
- **Client questions**: turns open uncategorized items, possible double charges, entries needing context, unusual payments, invoices over 90 days old and W-9 requests into a friendly, numbered question list ready to email. One click marks the included flags as asked.
- **Saved clients**: account type corrections, reviewed flags, the cash cushion, benchmark industry and state, and loan and tax inputs are saved per client (matched on the company name in the report header) and restored when their file is loaded again. They are kept in this browser only; export a JSON backup to move them to another computer or share them with a colleague.

**Multiple exports**: upload several CSVs at once (for example one per year), or add one to what is already loaded with **Add export**. Rows repeated across files because date ranges overlap are skipped, and the report periods are combined.

**Client report** comes in three formats:
- **Owner summary**: one or two printed pages with the key numbers, a revenue and cost chart, the 13-week cash chart, what changed, what we recommend and what we need from the client.
- **Full review**: the summary plus detail tables (tie-out, customer profitability and concentration, break-even, vendors, price increases and 1099 review, subscriptions, loan readiness, tax set-aside, benchmarks).
- **Plain text**, as before.

The formatted versions download as a single self-contained HTML file with built-in charts; open it in any browser and print to PDF to send.

**Plain-text report**: a plain-text summary to hand to the client, with an executive summary, each finding, the 13-week forecast, break-even, customer concentration, trends, vendors and 1099 review, benchmarks, loan readiness, tax set-aside, and recommended next steps. Download it as `.txt` or copy it.

All processing happens in the browser. The file is never uploaded anywhere.

## Running it

Open `index.html` in a browser, or serve the folder:

```sh
npx serve .
```

It opens with a sample data set (18 months of a fictional design studio, with seeded bookkeeping issues, a lost customer, a new hire and slowing collections) so every panel has something to show. The same sample is saved at `sample-data/harbor-pine-transaction-detail.csv`, with its Chart of Accounts at `sample-data/harbor-pine-chart-of-accounts.csv` Profit and Loss at `sample-data/harbor-pine-profit-and-loss.csv`, and a 2026 budget at `sample-data/harbor-pine-budget-2026.csv`.

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
| `src/engine.js` | CSV parsing and all analysis (pure JS, runs in Node too) |
| `src/sample.js` | Deterministic sample export generator |
| `src/ui/shared.js` | Helpers and small components shared by the tabs (storage, downloads, chart tokens, inputs) |
| `src/ui/*.js` | One file per tab (`audit`, `growth`, `cash`, `breakeven`, `trends`, `budget`, `vendors`, `benchmarks`, `advisory`) and `drawers.js` for the report, client questions and saved clients |
| `src/app.js` | Top-level app: file loading, state, tabs; mounts the page |
| `test/engine.test.js` | Engine tests |
| `test/ui.test.js` | Interface tests in headless Chromium |

There is no build step. Each UI file is a plain script that reads what it needs from `window.LedgerUI` and adds its own components to it, so `index.html` loads them in order: `shared.js` first, the tabs and drawers, then `app.js`.

## Tests

```sh
npm install      # dev dependencies for the interface tests only
npm test         # engine and interface tests
npm run test:engine
```

The engine tests need nothing installed. The interface tests open `index.html` in headless Chromium through `playwright-core`, serving React, Recharts and htm from `node_modules` so no network is needed. They find Playwright's own Chromium, any build under `PLAYWRIGHT_BROWSERS_PATH`, or the path in `CHROMIUM_PATH`, and skip themselves when none is available.
