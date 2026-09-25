# Ledger Lens

A browser-based audit and profitability dashboard for bookkeeping practices. Drop in a QuickBooks **Transaction Detail** CSV export and get:

**Diagnostic Audit**
- **Uncategorized transactions**: anything in Uncategorized Income/Expense/Asset, Ask My Accountant, suspense, or with no account at all. Shows exact CSV row numbers.
- **Potential duplicates**: same payee, same amount and same account within 3 days, or a reference number entered twice. Groups are ranked by dollars at risk.
- **Mismatched entries**: transaction types that conflict with their account (an expense coded to income, a sales receipt coded to expense, a transfer touching the P&L), vendors coded to an unusual category, expenses with no payee, and journal entries whose debits and credits don't balance.
- A books health score, an issues-by-month chart, and an **account mapping** panel for correcting how any account is classified. Every figure recalculates when you change it.

**Growth & Profitability Insights**
- Revenue, direct cost, gross margin and **net margin after overhead** per **customer** or **project** (sub-customer `Customer:Project`, a Project column, or Class).
- **Recurring SaaS & subscription detection**: finds steady weekly, monthly, quarterly and annual software charges, annualizes them, and flags overlapping tools (for example Asana + Monday.com), multiple charges per month (extra seats), price increases and consumer services on the business card. Estimates the annual savings.

**Client report**: a plain-text summary to hand to the client, with an executive summary, each finding, and recommended next steps. Download it as `.txt` or copy it.

All processing happens in the browser. The file is never uploaded anywhere.

## Running it

Open `index.html` in a browser, or serve the folder:

```sh
npx serve .
```

It opens with a sample data set (a fictional design studio with seeded issues) so every panel has something to show. The same sample is saved at `sample-data/harbor-pine-transaction-detail.csv`.

## Exporting from QuickBooks

1. **Reports → Transaction Detail by Account** (or Transaction List by Date / Transaction Detail).
2. **Customize → Rows/Columns** and include at least: Date, Transaction Type, Num, Name, Customer, Memo/Description, Account (if offered), Split and Amount. Debit/Credit columns also work.
3. Set the date range, then **Export → Export to CSV**.

The parser skips the report title rows, section headers and "Total for…" lines. In the "by Account" layout each entry appears once per account it touches; Ledger Lens collapses these to one entry so nothing is counted twice.

## Project layout

| Path | Purpose |
| --- | --- |
| `index.html` | Page shell, styles, library loading |
| `src/engine.js` | CSV parsing and all analysis (pure JS, runs in Node too) |
| `src/app.js` | React + Recharts dashboard |
| `src/sample.js` | Deterministic sample export generator |
| `test/engine.test.js` | Engine tests |

## Tests

```sh
node --test test/*.test.js
```
