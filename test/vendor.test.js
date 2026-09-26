// vendor/ holds the site's own copies of its libraries and fonts. They must match the versions
// in package.json: after changing one there, run `npm run vendor`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { plan, OUT } = require('../scripts/vendor.js');

test('vendor/ matches the libraries and fonts in node_modules', (t) => {
  const { files, css } = plan();
  if (files.some((f) => !fs.existsSync(f.from))) return t.skip('run npm install first');
  for (const f of files) {
    const mine = path.join(OUT, f.name);
    assert.ok(fs.existsSync(mine), `vendor/${f.name} is missing (run npm run vendor)`);
    assert.ok(fs.readFileSync(mine).equals(fs.readFileSync(f.from)), `vendor/${f.name} is out of date (run npm run vendor)`);
  }
  assert.equal(fs.readFileSync(path.join(OUT, 'fonts.css'), 'utf8'), css);
});

test('the page loads nothing from outside servers except Google sign-in and Drive', () => {
  const root = path.join(__dirname, '..');
  const page = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.deepEqual(page.match(/(?:src|href)="https?:[^"]+"/g) || [], []);
  for (const f of fs.readdirSync(path.join(root, 'src', 'ui')).map((x) => `src/ui/${x}`).concat('src/app.js')) {
    const urls = fs.readFileSync(path.join(root, f), 'utf8').match(/['"`]https:\/\/[^'"`$]+/g) || [];
    for (const u of urls) assert.match(u, /^.https:\/\/(accounts\.google\.com|www\.googleapis\.com|oauth2\.googleapis\.com)\//, `${f}: ${u}`);
  }
});
