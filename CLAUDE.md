# Ledger Lens

A QuickBooks review tool for **7D Business Solutions** (Mark, a bookkeeper). He uploads a
client's QuickBooks exports and gets a diagnostic audit, month-end close checklist,
profitability, cash forecast and client reports. Live at https://7d-ledger-lens.netlify.app
behind Google sign-in. The owner of this repo (Nate) is not a developer: explain changes in
plain words, keep replies short (he often reads on a phone), and say what to check on the site.

## Authority

You may merge a pull request into `main` and let it deploy once the GitHub **Tests** check is
green, without waiting for approval. Work on a branch, open a PR, wait for CI, merge, then
confirm the Netlify production deploy for the merge commit is `ready` (Netlify site ID
`b317398a-b8f2-4428-b31c-583ef3c13486`). Don't push straight to `main`.

## Commands

```sh
npm install          # dev dependencies (tests and vendor copies only)
npm test             # everything: engine, interface, sign-in, built site, vendor, test clients
npm run test:engine  # engine only, no browser needed
npm run vendor       # refresh vendor/ after changing a library version in package.json
sh scripts/build-site.sh            # build dist/ as Netlify does
node scripts/make-test-clients.js   # regenerate sample-data/test-clients/
```

Interface tests use headless Chromium through `playwright-core` (in this environment it's at
`/opt/pw-browsers`; never run `playwright install`). A full run takes a few minutes; run a
subset with `node --test --test-name-pattern="..." test/ui.test.js`.

## How it's built

- Static site, **no build step**: `index.html` loads React 18 UMD, Recharts 3 and `htm` from
  `vendor/`, then plain scripts in order: `src/diagnostics.js` first, `config.js`,
  `version.js`, `firm.js`, `engine.js`, `sample.js`, `store.js`, `work.js`, `ui/shared.js`,
  `ui/arrange.js`, the tab and drawer files in `src/ui/`, then `app.js`. UI files share `window.LedgerUI`.
  When adding a script, add its tag in the right place in `index.html`.
- `src/engine.js`: all parsing and analysis, pure functions, runs in Node and the browser
  (and in `src/worker.js`). Put logic here and test it in `test/engine.test.js`.
- `src/store.js`: saved clients in IndexedDB (`ledger-lens`, version 2: `clients`, `meta`,
  `files`) with an in-memory copy. Changing the shape of a saved client means raising `SCHEMA`
  and adding a step to `upgrade()`. Adding an object store means raising `DB_VERSION`.
- `src/work.js` / `src/worker.js`: file reading, and analysis of exports with 8,000+ rows, in a
  Web Worker, with the same work on the page as a fallback (always on `file://`).
- No client data leaves the browser. Only Google (sign-in, Drive backup) is contacted.
- Pages are arranged by the bookkeeper (`src/ui/arrange.js`): each tab passes its movable
  sections to `<${Arrange} page=... parts=${[[id, label, content], ...]} />`; KPI tiles and
  input panels stay outside it. A new section needs a stable id and a plain label there;
  never rename an existing id, or saved layouts lose it. Layouts live in `ll.layout`.
- Branding comes from `src/firm.js`. Settings (Google client ID, support email) are in
  `src/config.js`.

## Rules that tests enforce

- **Nothing loads from other servers** except Google. New libraries go into `package.json`
  (exact versions), then `npm run vendor`, then commit `vendor/`.
- **Content-Security-Policy** in `netlify.toml`: no inline scripts, no inline event handlers,
  no `eval`. `test/site.test.js` serves `dist/` with those headers and fails on any
  violation. A new outside service needs its address added to the policy.
- Every tab must render without errors or sideways scrolling at 1280px and 400px, light and
  dark.
- Problem reports and the saved-client summary must never contain client names, figures or
  file contents.

## Sign-in

Netlify edge functions (`netlify/edge-functions/`) gate every request. Public paths are listed
in `PUBLIC_PATHS` in `lib/auth.js`; a file the sign-in page needs must be added there. Netlify
environment variables `ALLOWED_EMAILS`, `GOOGLE_CLIENT_ID` and `SESSION_SECRET` must be plain
(not secret) values. See `docs/sign-in-setup.md`.

## Style

- Plain JS with `htm` templates, no JSX. Match the surrounding code: small helpers, comments
  that say why, CSS variables for colors (with the dark theme).
- User-facing text is for a bookkeeper: plain words, QuickBooks terms where he'd expect them,
  no jargon.
- After visual changes, screenshot the affected screens at desktop and phone width.
- Commit messages: a short summary line, then what changed and why.
