# Turning on Google Drive sync

Ledger Lens can keep its saved clients (review marks, account corrections and settings) in a file in the user's own Google Drive, saved automatically after each change. It needs two things that only the owner of the Google account can set up:

1. **The app on its own web address.** Google only lets sign-in run on addresses registered in step 2. The claude.ai link can't be used for this, because claude.ai pages are not allowed to load Google's sign-in.
2. **A Google sign-in key (OAuth client ID)** tied to that address.

Both are free. Allow about 20 minutes.

Until then, the app still works: **Saved clients & backup → Save backup file** writes one file with everything in it. With [Google Drive for desktop](https://www.google.com/drive/download/) installed, save that file into the Google Drive folder and it syncs like any other file.

## 1. Put the app online (Netlify)

The Netlify project **7d-ledger-lens** already exists (`https://7d-ledger-lens.netlify.app`), with a `netlify.toml` in the repository. If it is live, skip to step 2. Otherwise:

1. Sign up at [netlify.com](https://www.netlify.com) (the free plan is enough).
2. Open the project, go to **Deploys**, and drag in the site folder (run `sh scripts/build-site.sh` and drag `dist/`). Or link the repository under **Project configuration → Build & deploy → Link repository**, so every update goes live on its own; the settings come from `netlify.toml`.
3. Netlify gives the site an address like `https://7d-ledger-lens.netlify.app`. Rename it under **Site configuration → Change site name**.
4. Optional: use an address on the firm's own domain, such as `https://app.7dbusinesssolutions.com`, under **Domain management**.

Client files are still read in the browser and never uploaded. Netlify only serves the page.

## 2. Create the Google sign-in key

1. Open [console.cloud.google.com](https://console.cloud.google.com), signed in with the Google account whose Drive should hold the backup.
2. Create a project, for example **7D Ledger Lens**.
3. **APIs & Services → Library**: search for **Google Drive API** and choose **Enable**.
4. **APIs & Services → OAuth consent screen** (called **Google Auth Platform** in newer consoles):
   - User type **External**. App name **7D Ledger Lens**, plus a support email.
   - Scopes / Data access: add `.../auth/drive.file`. This scope only lets the app see files it created itself, not the rest of the Drive.
   - Audience / Test users: add the Gmail or Google Workspace address that will use the app. Leaving the app in **Testing** is fine for a few users. Google shows a "Google hasn't verified this app" screen at first sign-in; choose **Continue**.
5. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type **Web application**.
   - **Authorized JavaScript origins**: the site address from step 1, for example `https://7d-ledger-lens.netlify.app`, with no trailing slash. Add the custom domain too if you set one up.
   - Redirect URIs: none needed.
6. Copy the **Client ID**. It ends in `.apps.googleusercontent.com`. It is not a secret; it only works from the addresses listed above.

## 3. Add the key to the app

In `src/config.js`, set:

```js
window.LedgerConfig = Object.assign({
  googleClientId: '1234567890-abc123.apps.googleusercontent.com',
}, window.LedgerConfig);
```

Redeploy (drag the folder in again, or push to Git if Netlify is connected).

## Using it

**Clients → Connect Google Drive** on each device (laptop, phone). Approve access in the Google window. The app then keeps the devices in sync through the user's Drive:

- Connecting first brings in what is already in Drive, then writes this device's work back. Each client's newest copy wins; a client forgotten on one device is forgotten on the others.
- Saved clients (reviews, settings, checklists) are in `Ledger Lens backup.json`. Each client's QuickBooks files and receipt photos are in their own `Ledger Lens files <code>.json` (compressed, named by a scrambled id, not the client's name), so **Open** works on the other device without uploading again.
- With **Sync automatically** ticked, it syncs a few seconds after each change, every three minutes, and when the page comes back into view. **Sync now** does it on demand. A sync with nothing new writes nothing.
- You can move the files to any folder and the app still finds them. Google Drive keeps earlier versions (right-click → File information → Manage versions).
- For safety, Google asks again each time the page is opened. A device that synced before shows a **Sync paused** banner with a one-tap **Connect**.

## The backup passphrase (encryption)

Everything the app puts in Drive is encrypted on the device first, so Google (or anyone who gets
into the Google account) only sees scrambled files.

- **First device:** after **Connect Google Drive**, the app asks for a **backup passphrase** (at
  least 12 characters; a short sentence works well) and to type it twice. Nothing is written to
  Drive until it is set. **Write it down and keep it somewhere safe**: nobody can recover it.
- **Each other device:** after connecting, type the same passphrase once. Leave **Remember on
  this device** ticked on your own laptop and phone; untick it on a shared computer, and it is
  asked for every time.
- **Change passphrase** (Clients → Google Drive) locks everything in Drive again with a new one.
  The other devices ask for the new passphrase at their next sync.
- **Forget passphrase here** removes it from that device only.
- **Lost passphrase:** the copy in Drive can't be opened, but the clients saved on each device
  are untouched. On any device that still syncs (or after **Change passphrase** there), the
  backup is written again with the new passphrase.
- Backups made before encryption are read once and replaced with encrypted copies at the first
  sync, and the older readable versions in Drive's version history are deleted at the same time
  (the same happens after **Change passphrase**).
- How it works: AES-256-GCM, with the key derived from the passphrase by PBKDF2-SHA256 (600,000
  rounds) and a random salt stored in each file. The passphrase itself is never stored or sent
  anywhere; the derived key is kept in the browser in a form scripts can use but cannot read out.
