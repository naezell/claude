/* Sign-in page: shows the Google button and sends its answer to /auth/verify. Kept in its own
   file so the page can run under a strict Content-Security-Policy (no inline scripts). */
(function () {
  var params = new URLSearchParams(location.search);
  var next = params.get('next') || '/';
  if (!/^\/(?![\/\\])/.test(next)) next = '/';
  var msg = document.getElementById('msg');
  var show = function (text, error) { msg.textContent = text; msg.className = 'msg' + (error ? ' error' : ''); };
  if (params.get('signedout')) show('You are signed out.');
  var clientId = (window.LedgerConfig || {}).googleClientId;
  function start() {
    if (params.get('signedout')) google.accounts.id.disableAutoSelect();
    google.accounts.id.initialize({
      client_id: clientId,
      auto_select: !params.get('signedout'),
      callback: function (resp) {
        show('Checking…');
        fetch('/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: resp.credential }), credentials: 'same-origin' })
          .then(function (r) { return r.json().then(function (body) { return { ok: r.ok, body: body }; }); })
          .then(function (r) {
            if (r.ok) { show('Signed in as ' + r.body.email + '.'); location.replace(next); }
            else show(r.body.error || 'Sign-in failed.', true);
          })
          .catch(function () { show('Could not reach the sign-in service. Check the connection and try again.', true); });
      },
    });
    google.accounts.id.renderButton(document.getElementById('button'), { theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill' });
  }
  var s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  s.onload = start;
  s.onerror = function () { show('Google sign-in could not load. Check the connection or any ad blocker, then reload.', true); };
  document.head.appendChild(s);
})();
