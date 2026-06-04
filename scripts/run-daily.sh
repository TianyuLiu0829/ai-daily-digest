#!/bin/sh
cd "$(dirname "$0")/.."
if [ -x "/Applications/Codex.app/Contents/Resources/node" ]; then
  /Applications/Codex.app/Contents/Resources/node scripts/generate-digest.js
elif command -v node >/dev/null 2>&1; then
  node scripts/generate-digest.js
elif [ -x "/opt/homebrew/bin/node" ]; then
  /opt/homebrew/bin/node scripts/generate-digest.js
else
  /usr/local/bin/node scripts/generate-digest.js
fi
