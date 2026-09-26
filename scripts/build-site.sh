#!/bin/sh
# Builds the standalone website in dist/: the same files the claude.ai page uses, with the
# document wrapper (doctype, charset, viewport, favicon) a normal web host needs.
set -e
cd "$(dirname "$0")/.."
rm -rf dist
mkdir -p dist
cp -r src assets vendor dist/
cp login.html dist/
{
  printf '<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n'
  printf '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
  printf '<link rel="icon" type="image/png" href="assets/7d-mark.png">\n'
  cat index.html
  printf '</html>\n'
} > dist/index.html
echo "Built dist/ ($(find dist -type f | wc -l | tr -d ' ') files)"
