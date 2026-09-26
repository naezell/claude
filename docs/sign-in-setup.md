# Sign-in for the Netlify site

The site at https://7d-ledger-lens.netlify.app only opens for people on an allowed list, signed in with their Google account. Everyone else sees the sign-in page; the app's files are not sent to them at all.

## How it works

- `netlify/edge-functions/gate.js` runs before every request. A valid, unexpired session cookie for an allowed email lets the request through; otherwise pages redirect to `/login` and files get a 401.
- `login.html` shows the **Sign in with Google** button (the same Google Cloud client as the Drive backup).
- `netlify/edge-functions/auth.js` receives Google's signed ID token at `/auth/verify`, checks Google's signature, that the token is for this app, not expired, and the email verified, then checks the email against the list. An allowed person gets a session cookie (HttpOnly, Secure, 30 days). `/auth/logout` clears it.
- Taking an email off the list ends that person's access at their next click, even with a cookie still set.
- If the settings below are missing, nobody gets in.

## Settings (Netlify → the project → Project configuration → Environment variables)

| Variable | Value |
| --- | --- |
| `ALLOWED_EMAILS` | The Google email addresses allowed in, separated by commas. |
| `GOOGLE_CLIENT_ID` | The OAuth client ID from Google Cloud (same as in `src/config.js`). |
| `SESSION_SECRET` | A long random value (at least 32 characters). Changing it signs everyone out. |

Changes to the variables apply from the next deploy. Add them as ordinary variables with all scopes: on the free plan a value marked **Contains secret values** is not saved or not passed to edge functions, and sign-in then reports "not configured".

## Adding or removing someone

1. Add or remove their email in `ALLOWED_EMAILS`, then redeploy.
2. While the Google Cloud app is in **Testing**, a new person must also be added under **Audience → Test users** in Google Cloud, or Google refuses the sign-in before the site sees it.
