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
| | | `greenway-customer-contact-list.csv` (addresses, for route density) |
| | | `greenway-voided-deleted.csv` (Voided/Deleted Transactions report, for the Fraud risk tab) |
| | | `greenway-employee-details.csv` (payroll employee list with direct deposit, for the Fraud risk tab) |
| | | `greenway-chase-statement-jul-aug-2026.csv` and `greenway-amex-statement-jul-aug-2026.csv` (card statements, for the Credit cards tab) |

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

- **Route density** (needs `greenway-customer-contact-list.csv`): 40 route customers (billed in 3+ months). Streets with three or more: Oak Ridge Dr (8 homes), Willow Bend Rd (5), Wabash Ave (3 businesses) and Maple Hollow Ct (3). About half are alone on their street; the neighbor-discount list shows homes alone in the busiest ZIP codes. Maple Ridge HOA has only a PO box (no site address) and Riverside Church is missing from the list. The HOAs are billed to their management company's office, with the property in the shipping address.
- **Profit playbook:** about 160 fuel stops, 80 hardware-store runs, $1,478 of delivery and restocking fees (mostly Rock Solid Stone), Rock Solid Stone as the vendor to negotiate with, 14 new customers at about $230 of advertising each.

**Fraud risk tab** (the last two checks need `greenway-voided-deleted.csv` and `greenway-employee-details.csv`; add them with *Add export*). One planted case for each check, all in the 12 months to August 2026:
- **Skipped invoice numbers:** #5532 and #5533 are missing; the voided/deleted report shows Jenna deleted both on June 18, 2026. **Skipped check number:** #3595 (a spoiled check, also in the report).
- **Voided invoices and credits:** invoice #6423 to Ellis Residence voided; a $1,850 credit memo to Bauer Residence, **refunded** by check two days later.
- **Deleted sales and payments:** the two invoices, the voided one, and a deleted $1,840 payment from Walnut Creek Condos.
- **Regular customer who stopped being billed:** Kingsley Residence, nothing since May 2026, on Oak Ridge Dr with seven other customers (crews are still on that street).
- **Materials outran the price:** Castle Rock Winery's tasting room patio, billed $6,000 with $13,240 of pavers (2.2 times). **Materials with no job:** $2,860 of pavers from Rock Solid Stone with no job.
- **Vendor spike:** Prairie Stone & Mulch, usually $300-500 a month, then $4,813 in July and $5,236 in August.
- **Look-alike vendor:** "Site One Landscape Supply" next to the real SiteOne Landscape Supply. **New vendor paid only by check:** DR Landscape Services, three checks of $2,450-2,480, all **just under $2,500**.
- **Sundays and holidays:** Home Depot on Memorial Day, Lowe's on July 4, Shell and QuikTrip on Sundays. **Round amounts:** Casey's charges of $100, $80, $120 and $100. **Big fill-ups:** three Shell charges of $198-236.
- **Payroll outside the runs:** a $1,500 bonus by journal entry and a $1,240 manual paycheck to Dan Ortiz. **Employee paid outside payroll:** four $150 "reimbursement" checks to Dan Ortiz. **Shared bank account:** Dan Ortiz and Mike Dawson are paid into the same account.
- The number-pattern (Benford) check comes out clear.

**Credit cards tab** (add the two statement files with *Add export*): the books have one card, Chase Ink (4410). The statements show 11 charges not in QuickBooks: two on the Chase card (Amazon $86.42 on July 22, Harbor Freight $129.99 on August 14) and all 9 on an Amex card the books don't have, used by Tom Greenway and Dan Ortiz. The WEX charge entered twice on July 21 shows as in QuickBooks but on no statement.

**Month-end close:** the checklist adds landscaping steps; *Every maintenance and snow contract billed* is open for August 2026. **Benchmarks** start on Landscaping Services (NAICS 561730).
