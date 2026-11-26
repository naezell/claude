# Ledger Lens advisory tools

Open **Advisory tools** from Ledger Lens. The brief and the public health check can read local QuickBooks CSV and Excel exports without connecting an account. For a brief, export one full month per file, with columns set to Total only. Use the same accounting basis for both months. A Statement of Cash Flows supplies the cash movement figures. The Balance Sheet supplies the ending bank balance.

The existing **Client questions** drawer can create an encrypted email or text link. After connecting a QuickBooks company, open an existing Ledger Lens client with the same company name to pull posted purchases and deposits for a selected month. This does not replace the client’s uploaded reports. Ledger Lens stores the answers and receipts in the existing client record. Review them before applying changes in QuickBooks.

## Configure QuickBooks and email

Set these values for the production site in Netlify. Keep secrets out of the repo. Start with an Intuit sandbox company.

| Setting | Purpose |
| --- | --- |
| `ADVISORY_ORIGIN` | Exact HTTPS site origin, for example `https://7d-ledger-lens.netlify.app` |
| `QBO_CLIENT_ID`, `QBO_CLIENT_SECRET` | Accounting API app for the signed-in Ledger Lens workspace |
| `QBO_ENVIRONMENT` | Use `production` only with approved production Intuit credentials. Omit for sandbox. |
| `QBO_STORAGE_KEY` | A new randomly generated 32-byte key encoded as 64 hex characters. Changing the key requires reconnecting existing companies. |
| `QBO_GRADER_CLIENT_ID`, `QBO_GRADER_CLIENT_SECRET` | Separate Intuit app for public one-time Trial Balance checks. Leave unset to offer uploads only. |
| `QBO_GRADER_ENVIRONMENT` | Companion environment setting for the public Intuit app |
| `ADVISORY_RESEND_KEY`, `ADVISORY_MAIL_FROM` | Resend key and sender from a verified domain for morning digests and inbound lead emails |
| `ADVISORY_LEADS_TO` | 7D mailbox that should receive opted-in health-check inquiries |

Register `/api/qbo/callback` under the configured site origin as the private app’s exact OAuth redirect URI. Register `/api/health-check/qbo-callback` on the separate public app. The Intuit accounting scope gives the app access to accounting endpoints. These workflows use reads only and store OAuth tokens encrypted. The public check reads a Trial Balance and account types, requests token revocation immediately afterward, and returns aggregate results to the same browser. The client’s uploaded Trial Balance file stays local. Contact requests send the name, company and email only.

The Watchdog runs at 3 a.m. Central. It compares the two latest 30-day windows, flags a spike at five or more posted uncategorized transactions when the count has at least doubled and risen by at least four, and checks access. Starting on day 10 of each month, recorded reconciliation dates older than last month-end trigger a review. The bookkeeper supplies those dates. Bank-feed status and pending bank-feed items are unavailable through the accounting API. The 7 a.m. Central email only goes out for flagged or missed checks. It contains aggregate counts and a link to the sign-in protected dashboard.

## Embed the health check

Add the following on the 7D Business Solutions website. Adjust the height to fit your page layout.

```html
<iframe title="7D bookkeeping health check"
        src="https://7d-ledger-lens.netlify.app/health-check.html"
        width="100%" height="950" loading="lazy"></iframe>
```

The health check can be framed by the 7D domains. Inside a frame, users connect QuickBooks from the standalone page so the OAuth return cookie stays in the same browser context.

Verify in an Intuit sandbox with a sample company, then verify delivery to the firm inbox and test the iframe from the 7D site before distributing it.
