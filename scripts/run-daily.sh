#!/bin/sh
cd "$(dirname "$0")/.."
if command -v node >/dev/null 2>&1; then
  node scripts/generate-digest.js
else
  /usr/local/bin/node scripts/generate-digest.js
fi
