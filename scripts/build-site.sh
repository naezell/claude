#!/bin/sh
# Builds the standalone website in dist/: the same files the claude.ai page uses, with the
# document wrapper (doctype, charset, viewport, favicon) a normal web host needs.
set -e
cd "$(dirname "$0")/.."
rm -rf dist
mkdir -p dist
cp -r src assets vendor dist/
cp login.html login.js portal.html portal.js advisory.html health-check.html dist/
# Stamp the commit for problem reports (Netlify sets COMMIT_REF; otherwise ask git).
commit="${COMMIT_REF:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"
printf "window.LedgerVersion = { commit: '%s', built: '%s' };\n" "$(printf %s "$commit" | cut -c1-7)" "$(date -u +%Y-%m-%dT%H:%MZ)" > dist/src/version.js
{
  printf '<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n'
  printf '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
  printf '<link rel="icon" type="image/png" href="assets/7d-mark.png">\n'
  cat index.html
  printf '</html>\n'
} > dist/index.html
echo "Built dist/ ($(find dist -type f | wc -l | tr -d ' ') files)"
