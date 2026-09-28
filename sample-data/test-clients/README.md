# Test clients

Three fictional businesses for trying Ledger Lens on something other than the built-in sample. They cover January 2025 (Greenway: January 2024) to August 2026, are built as proper double-entry books (so they tie to their own Profit and Loss), and have bookkeeping problems planted in them. The list below is the answer key: what to look for, and where.

Regenerate with `node scripts/make-test-clients.js` (the same files every run).

## How to load them

Upload a client's files together (select all four, or drag them onto the page):

| Riverbend Plumbing & Heating | Bloom & Basil Cafe | Greenway Landscape Co. |
| --- | --- | --- |
| `riverbend-transaction-detail.csv` | `bloom-basil-transaction-detail.csv` (or the Excel copy, `.xlsx`, if you have it) | `greenway-transaction-detail.csv` |
| `riverbend-chart-of-accounts.csv` | `bloom-basil-chart-of-accounts.csv` | `greenway-chart-of-accounts.csv` |
| `riverbend-profit-and-loss.csv` | `bloom-basil-profit-and-loss.csv` | `greenway-profit-and-loss.csv` |
| `riverbend-expenses-with-attachments.csv` | `bloom-basil-expenses-with-attachments.csv` | `greenway-expenses-with-attachments.csv` |

Then load the others the same way: each is remembered separately, and all appear under **Clients** and on **Home**.

## Riverbend Plumbing & Heating LLC

A plumbing contractor: about 40 homeowner service calls a month (paid on the spot, deposited weekly), commercial jobs billed by milestone and tracked by Customer:Job, 7.25% sales tax on parts, payroll for 3-4 techs, a truck loan, and busy winters.

**Diagnostic audit**
- Ties to the QuickBooks P&L exactly.
- 4 uncategorized: a Zelle payment to "J Ramirez" ($650), an Amazon charge, a remote deposit ($925) and a Lowe's charge in Ask My Accountant.
- 2 duplicates: Ferguson bill F2606-4 entered twice ($4,000+), and a Shell fuel charge twice on the same day.
- Mismatches: a $5,000 savings transfer coded to Bank Fees; two card charges with no payee.
- **Balance sheet check:** $2,600+ in Undeposited Funds, including a March check that never made it into a deposit; the credit card with a $3,200 credit (paid twice in August); Sales Tax Payable negative (Q1 2026 paid twice); Hillside HOA with a $1,450 credit (payment recorded twice); a Winsupply bill open 150 days because it was paid by a separate check.
- **Receipts:** 5 missing: two crew lunches, the trade-show hotel and dinner, and holiday gift baskets.
- **Unusual activity:** a $4,860 transmission from a shop never used before.

**Growth & profitability:** customers are Customer:Job commercial clients plus many one-time homeowners. **Job costing gaps:** about $14,000 of materials bought on the card with no job, and Oak Ridge Senior Living with $3,240 of materials and nothing billed yet (a new job). Subscriptions: ServiceTitan and Jobber both paid (overlap), Google Workspace and Microsoft 365 (overlap), Netflix on the business card.

**Cash forecast:** cash dips below zero in October-November, driven by payroll, the tax payments and Cedar Point Elementary paying in about 4 months ($8,196 over 90 days).

**Vendors:** price increases from the landlord (rent $2,600 to $2,850), ServiceTitan and Verizon. **1099 review:** the landlord and the two subcontractors (Precision Electric, Mike Delaney Excavating), and in 2026 the transmission shop; not the supply houses, insurer, utility or lender.

**Trends:** revenue is up on last year but the margin is down, from the added technician's wages and the transmission. Pinecrest Library is a big new client; two finished commercial jobs show as no longer billed.

**Closed months test:** load `riverbend-transaction-detail.csv`, then in **Closed months** close the books through **July 2026**. Now upload `riverbend-transaction-detail-september-update.csv`: it lists three changes: a deleted April crew lunch, an edited May description, and a June phone bill changed from $318.45 to $418.45.

## Bloom & Basil Cafe

A cafe open six days a week: nightly register sales recorded as "Daily POS Sales" (food, drinks and sales tax on separate lines), office catering invoices, weekly Sysco bills, a coffee roaster, payroll every two weeks, monthly sales tax, and an equipment loan. The transaction file also has a Class column.

**Diagnostic audit**
- Ties to the QuickBooks P&L exactly.
- 4 uncategorized: three ATM withdrawals and a hardware store charge.
- 2 duplicates: a Sysco bill paid twice (check and online bill pay), and Hilltop Roasters bill HR-2606X entered twice.
- Mismatches: a $1,500 transfer to the owner's personal account coded to Supplies; a Costco charge coded to Catering Income; the ATM withdrawals with no payee.
- **Balance sheet check:** $5,400 left in Opening Balance Equity; Harborside Law Group with an $842.50 credit (paid an invoice twice); Summit Physical Therapy's April invoice open 137 days.
- **Receipts:** 3 missing: a $9,840 espresso machine, a staff dinner and a trade-show hotel.
- **Unusual activity:** the $9,840 espresso machine (new payee), which was expensed to Repairs & Maintenance rather than recorded as equipment.

**Growth & profitability:** "Daily POS Sales" is about 94% of revenue, and the app treats it as walk-in sales rather than one customer, so concentration reads as diversified. Job costing is not tracked by customer, which the app notes instead of listing gaps. Subscriptions: Square for Restaurants and Toast both paid since January (two registers), Netflix on the business card.

**Vendors:** price increases from Cintas (linens) and Recology (waste). Food costs rise from February 2026 when Sysco raises prices. **1099 review:** only the landlord.

**Trends:** margin down from a year ago, mostly from the espresso machine and higher food costs.

## Greenway Landscape Co.

A Midwest landscaper, about $900,000 a year: 20 maintenance contracts billed on the 1st (April to November, year-round for six commercial sites), installation and hardscape jobs with deposits, irrigation start-ups and winterizations, spring and fall enhancements, and snow removal in winter (six seasonal contracts plus per-push customers). A crew of 9 in season and 4 in winter, paid through Gusto with wages tagged by class; John Deere and Ally loans; a line of credit drawn each March. The transaction file has a Class column (Maintenance, Install, Irrigation, Enhancements, Snow). Ledger Lens recognizes it as a landscaper and adds the **Landscaping** tab.

**Diagnostic audit**
- Ties to the QuickBooks P&L exactly.
- 1 uncategorized: a Farm & Fleet card charge with no payee ($286.40).
- 1 duplicate: a WEX fuel charge entered twice on July 21, 2026 ($612.18).

**Landscaping tab**
- **Off-season cash plan:** the slow months are November to March. Cash bottoms out in April 2027, below the cushion; the plan says how much to set aside in each busy month left. The spring ramp (April) still uses cash, and the three March line-of-credit draws are listed.
- **Profit by service line:** snow & ice loses money after the 2025-26 winter (salt up about 55%, per-push prices cut 15%). The other four lines make money.
- **Contract invoices not sent:** Lakeview Office Park for August 2026 and Sunset Villas HOA for July 2026.
- **Prices not raised in a year:** Maple Ridge HOA, Dr. Patel Dental, Riverside Church and Hartman Residence, unchanged since April 2024. Everyone else went up in 2025 and 2026.
- **Labor through the season:** about 40% of revenue over the year; winter months run 48-62% with the year-round crew; an overtime spike in June 2026.
- **Equipment and fuel:** Exmark Lazer Z #3 repaired four times in 2026 ($4,820); a new $12,480 zero-turn mower coded to Equipment Repairs and $3,150 of backpack blowers coded to Small Tools (both belong in fixed assets). The $8,900 trailer in March 2025 was recorded properly.

**Month-end close:** the checklist adds landscaping steps; *Every maintenance and snow contract billed* is open for August 2026. **Benchmarks** start on Landscaping Services (NAICS 561730).
