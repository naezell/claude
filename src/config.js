/* Settings for this copy of Ledger Lens.
   googleClientId: a Google OAuth client ID ("....apps.googleusercontent.com") that turns on
   saving to Google Drive. It only works when the app is served from an address listed on that
   client in Google Cloud; see docs/google-drive-setup.md. Leave it empty to hide the feature. */
window.LedgerConfig = Object.assign({
  googleClientId: '',
}, window.LedgerConfig);
