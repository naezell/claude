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
  // Tax forms often come as PDFs; each is kept as it is, up to this size.
  var MAX_PDF = 1.5 * 1024 * 1024;
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
      if (file.type === 'application/pdf') {
        if (file.size > MAX_PDF) { reject(new Error(file.name + ' is too large (over 1.5 MB). Take a photo of it instead.')); return; }
        var reader = new FileReader();
        reader.onload = function () { resolve({ name: file.name, data: String(reader.result) }); };
        reader.onerror = function () { reject(new Error(file.name + ' could not be read.')); };
        reader.readAsDataURL(file);
        return;
      }
      if (!/^image\//.test(file.type)) { reject(new Error(file.name + ' is not a photo or a PDF.')); return; }
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
    ((previous && previous.answers) || []).forEach(function (a) { answers[a.ref] = { answer: a.answer || '', photos: a.photos || [], category: a.category || '', job: a.job || '' }; });
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

    var cards = [];
    var deck = data.questions.some(function (q) { return q.coding && q.coding.length; });
    var position = 0;
    data.questions.forEach(function (q) {
      var state = answers[q.ref] || (answers[q.ref] = { answer: '', photos: [], category: '', job: '' });
      var thumbs = el('div', { class: 'thumbs' });
      var id = 'a-' + q.ref;
      function drawThumbs() {
        thumbs.textContent = '';
        state.photos.forEach(function (p, i) {
          thumbs.appendChild(el('span', { class: 'thumb' + (/^data:application\/pdf/.test(p.data) ? ' pdf' : '') }, [
            /^data:application\/pdf/.test(p.data) ? el('span', { class: 'pdf-name', text: 'PDF · ' + p.name }) : el('img', { src: p.data, alt: 'Photo ' + (i + 1) }),
            el('button', { type: 'button', 'aria-label': 'Remove photo ' + (i + 1), text: '×', onclick: function () { state.photos.splice(i, 1); drawThumbs(); refreshProgress(); } }),
          ]));
        });
      }
      var file = el('input', { type: 'file', accept: q.docs ? 'image/*,application/pdf' : 'image/*', multiple: 'multiple', id: 'f-' + q.ref, onchange: function (e) {
        var files = Array.prototype.slice.call(e.target.files || [], 0, MAX_PHOTOS - state.photos.length);
        e.target.value = '';
        Promise.all(files.map(shrink)).then(function (ps) { state.photos = state.photos.concat(ps).slice(0, MAX_PHOTOS); drawThumbs(); refreshProgress(); }, function (err) { status(err.message, true); });
      } });
      var ta = el('textarea', { id: id, placeholder: q.coding ? 'Optional details' : 'Your answer', maxlength: 4600, oninput: function (e) { state.answer = e.target.value; refreshProgress(); } });
      ta.value = state.answer;
      var fields = null;
      if (q.coding && q.coding.length) {
        var picker = el('select', { id: 'c-' + q.ref, onchange: function (e) { state.category = e.target.value; refreshProgress(); } }, [
          el('option', { value: '', text: 'Choose a category' }),
        ].concat(q.coding.map(function (name) { return el('option', { value: name, text: name }); })));
        picker.value = state.category;
        var job = el('input', { id: 'j-' + q.ref, maxlength: 100, placeholder: 'e.g. Oak Street', oninput: function (e) { state.job = e.target.value; refreshProgress(); } });
        job.value = state.job;
        fields = el('div', { class: 'coding' }, [el('label', { for: picker.id, text: 'What kind of transaction was it?' }), picker, el('label', { for: job.id, text: 'Job or project (optional)' }), job]);
      }
      var card = el('section', { class: 'q' }, [
        el('p', { class: 'topic', text: q.topic }),
        el('label', { class: 'text question-title', for: id, tabindex: '-1', text: q.question }),
        fields,
        ta,
        el('div', { class: 'row' }, [
          el('label', { class: 'btn', for: 'f-' + q.ref }, [document.createTextNode(q.docs ? 'Add a photo or PDF of it' : q.receipt ? 'Add a photo of the receipt' : 'Add a photo'), file]),
          thumbs,
        ]),
      ]);
      cards.push(card);
      app.appendChild(card);
      drawThumbs();
    });

    var progress, back, next;
    function hasAnswer(a) { return a && (a.answer.trim() || a.category || a.job.trim() || a.photos.length); }
    function refreshProgress() {
      if (!progress) return;
      var count = data.questions.filter(function (q) { return hasAnswer(answers[q.ref]); }).length;
      progress.textContent = (position + 1) + ' of ' + cards.length + ' · ' + count + ' answered';
    }
    function showCard(index, focus) {
      if (index < 0 || index >= cards.length) return;
      position = index;
      cards.forEach(function (card, i) { card.hidden = i !== position; });
      back.disabled = position === 0;
      next.disabled = position === cards.length - 1;
      refreshProgress();
      if (focus) cards[position].querySelector('.question-title').focus();
    }
    if (deck) {
      progress = el('p', { class: 'hint deck-progress', role: 'status' });
      back = el('button', { class: 'btn', type: 'button', text: 'Previous', onclick: function () { showCard(position - 1, true); } });
      next = el('button', { class: 'btn', type: 'button', text: 'Next', onclick: function () { showCard(position + 1, true); } });
      app.insertBefore(progress, cards[0]);
      app.appendChild(el('div', { class: 'row deck-controls' }, [back, next]));
      cards.forEach(function (card) {
        var start;
        card.addEventListener('touchstart', function (e) {
          start = e.touches.length === 1 && !e.target.closest('button,input,select,textarea,label') ? e.touches[0] : null;
        }, { passive: true });
        card.addEventListener('touchend', function (e) {
          if (!start) return;
          var end = e.changedTouches[0];
          var dx = end.clientX - start.clientX;
          if (Math.abs(dx) >= 55 && Math.abs(dx) > Math.abs(end.clientY - start.clientY) * 1.4) showCard(position + (dx < 0 ? 1 : -1), true);
          start = null;
        }, { passive: true });
      });
      showCard(0, false);
    }
    var msg = el('div', { role: 'status' });
    function status(text, bad) { msg.className = 'msg ' + (bad ? 'error' : 'good'); msg.textContent = text; }
    var send = el('button', { class: 'btn primary', type: 'button', text: previous ? 'Send updated answers' : 'Send answers', onclick: function () {
      var list = data.questions.map(function (q) { var a = answers[q.ref]; return { ref: q.ref, answer: a.answer.trim(), photos: a.photos, category: a.category, job: a.job.trim() }; })
        .filter(function (a) { return hasAnswer(a); });
      if (!list.length) { status('Choose a category, type an answer, or add a photo first.', true); return; }
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
