/* Settings for this copy of Ledger Lens.
   googleClientId: the Google OAuth client ID that turns on saving to Google Drive.
   googleOrigins: the web addresses registered on that client in Google Cloud ("Authorized
   JavaScript origins"). Google sign-in only works there, so elsewhere the app points people
   to the first one instead. Empty means any address. See docs/google-drive-setup.md. */
window.LedgerConfig = Object.assign({
  googleClientId: '795017600161-h48rob5ov82tnedqr42kh8h63kduqa9e.apps.googleusercontent.com',
  googleOrigins: ['https://7d-ledger-lens.netlify.app'],
}, window.LedgerConfig);
