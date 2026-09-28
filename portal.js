/* Client portal page: shows the questions from the bookkeeper and sends back the answers.
 * The questions arrive sealed and are opened here with the key in the link (after the #, so
 * it is never sent to the server); the answers are sealed the same way before they leave.
 * Plain DOM code with no libraries, so the page is small and fast on a phone. Text from the
 * questions is only ever set with textContent. */
(function () {
  'use strict';
  var Seal = window.LedgerSeal;
  var app = document.getElementById('app');
  var MAX_PHOTOS = 3;
  var PHOTO_EDGE = 1600;
  // What the site accepts for one set of answers (MAX_ANSWERS_BYTES in netlify/functions/lib/portal.mjs).
  var MAX_SEALED = 4 * 1024 * 1024;

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'class') n.className = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function fail(text) {
    app.textContent = '';
    app.appendChild(el('h1', { text: 'This link can’t be opened' }));
    app.appendChild(el('p', { text: text }));
    app.appendChild(el('p', { class: 'hint', text: 'If you still need to answer, ask your bookkeeper to send a new link.' }));
  }

  // Shrinks a photo to at most PHOTO_EDGE pixels on its long side, as a JPEG data URL.
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      if (!/^image\//.test(file.type)) { reject(new Error(file.name + ' is not a photo.')); return; }
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var scale = Math.min(1, PHOTO_EDGE / Math.max(img.width, img.height));
        var c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve({ name: file.name.replace(/\.[^.]+$/, '') + '.jpg', data: c.toDataURL('image/jpeg', 0.82) });
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error(file.name + ' could not be read as a photo.')); };
      img.src = url;
    });
  }

  function render(link, data, previous) {
    var answers = {};
    ((previous && previous.answers) || []).forEach(function (a) { answers[a.ref] = { answer: a.answer || '', photos: a.photos || [] }; });
    app.textContent = '';
    app.appendChild(el('header', {}, [
      data.firm && data.firm.logo ? el('img', { src: data.firm.logo, alt: '' }) : null,
      el('div', {}, [
        el('h1', { text: 'Questions from ' + ((data.firm && data.firm.name) || 'your bookkeeper') }),
        el('p', { text: (data.client ? 'For ' + data.client.replace(/\.+$/, '') + '. ' : '') + data.questions.length + ' question' + (data.questions.length === 1 ? '' : 's') + '.' }),
      ]),
    ]));
    if (data.message) app.appendChild(el('div', { class: 'note', text: data.message }));
    if (previous) app.appendChild(el('div', { class: 'msg good', text: 'Your answers were received. You can change them below and send again until your bookkeeper collects them.' }));

    data.questions.forEach(function (q) {
      var state = answers[q.ref] || (answers[q.ref] = { answer: '', photos: [] });
      var thumbs = el('div', { class: 'thumbs' });
      var id = 'a-' + q.ref;
      function drawThumbs() {
        thumbs.textContent = '';
        state.photos.forEach(function (p, i) {
          thumbs.appendChild(el('span', { class: 'thumb' }, [
            el('img', { src: p.data, alt: 'Photo ' + (i + 1) }),
            el('button', { type: 'button', 'aria-label': 'Remove photo ' + (i + 1), text: '×', onclick: function () { state.photos.splice(i, 1); drawThumbs(); } }),
          ]));
        });
      }
      var file = el('input', { type: 'file', accept: 'image/*', multiple: 'multiple', id: 'f-' + q.ref, onchange: function (e) {
        var files = Array.prototype.slice.call(e.target.files || [], 0, MAX_PHOTOS - state.photos.length);
        e.target.value = '';
        Promise.all(files.map(shrink)).then(function (ps) { state.photos = state.photos.concat(ps).slice(0, MAX_PHOTOS); drawThumbs(); }, function (err) { status(err.message, true); });
      } });
      var ta = el('textarea', { id: id, placeholder: 'Your answer', oninput: function (e) { state.answer = e.target.value; } });
      ta.value = state.answer;
      app.appendChild(el('section', { class: 'q' }, [
        el('p', { class: 'topic', text: q.topic }),
        el('label', { class: 'text', for: id, text: q.question }),
        ta,
        el('div', { class: 'row' }, [
          el('label', { class: 'btn', for: 'f-' + q.ref }, [document.createTextNode(q.receipt ? 'Add a photo of the receipt' : 'Add a photo'), file]),
          thumbs,
        ]),
      ]));
      drawThumbs();
    });

    var msg = el('div', { role: 'status' });
    function status(text, bad) { msg.className = 'msg ' + (bad ? 'error' : 'good'); msg.textContent = text; }
    var send = el('button', { class: 'btn primary', type: 'button', text: previous ? 'Send updated answers' : 'Send answers', onclick: function () {
      var list = data.questions.map(function (q) { var a = answers[q.ref]; return { ref: q.ref, answer: a.answer.trim(), photos: a.photos }; })
        .filter(function (a) { return a.answer || a.photos.length; });
      if (!list.length) { status('Type at least one answer or add a photo first.', true); return; }
      send.disabled = true;
      status('Sending…');
      Seal.seal(link.key, { answers: list, sentAt: new Date().toISOString() }).then(function (sealed) {
        if (sealed.length > MAX_SEALED) throw new Error('The photos are too large to send together. Remove one or two and try again.');
        return fetch('/api/portal/answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: link.id, answers: sealed }) })
          .then(function (r) { return r.json().then(function (b) { if (!r.ok) throw new Error(b.error || 'Sending failed.'); }); });
      }).then(function () {
        status('Thank you. Your answers were sent to ' + ((data.firm && data.firm.name) || 'your bookkeeper') + '. You can change them and send again until they are collected.');
        send.textContent = 'Send updated answers';
      }, function (err) {
        status(err.message || 'Sending failed. Check the connection and try again.', true);
      }).then(function () { send.disabled = false; });
    } });
    app.appendChild(el('div', { class: 'row' }, [send]));
    app.appendChild(msg);
    app.appendChild(el('footer', { text: 'Only you and your bookkeeper can read these answers: they are locked with a key that is part of your link. The link works until ' + new Date(data.expiresAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric' }) + '.' }));
  }

  var link = Seal.fromHash(location.hash);
  if (!link) { fail('The link looks incomplete. Open it again from the email; if it was split across lines, copy the whole link.'); return; }
  fetch('/api/portal/q?id=' + encodeURIComponent(link.id), { cache: 'no-store' })
    .then(function (r) { return r.json().then(function (b) { if (!r.ok) throw new Error(b.error || 'The questions could not be loaded.'); return b; }); })
    .then(function (b) {
      return Seal.open(link.key, b.box).then(function (data) {
        data.expiresAt = b.expiresAt;
        var prev = b.answers ? Seal.open(link.key, b.answers).catch(function () { return null; }) : Promise.resolve(null);
        return prev.then(function (p) { render(link, data, p); });
      }, function () { throw new Error('The link looks incomplete. Open it again from the email.'); });
    })
    .catch(function (err) { fail(err.message || 'The questions could not be loaded. Check the connection and reload.'); });
})();
