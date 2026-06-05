#!/bin/sh
cd "$(dirname "$0")/.."
: > digest.err.log

if [ -x "/Applications/Codex.app/Contents/Resources/node" ]; then
  NODE_BIN="/Applications/Codex.app/Contents/Resources/node"
elif command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
elif [ -x "/opt/homebrew/bin/node" ]; then
  NODE_BIN="/opt/homebrew/bin/node"
else
  NODE_BIN="/usr/local/bin/node"
fi

MIDDAY_HOUR="${DIGEST_MIDDAY_HOUR:-10}"
MIDDAY_MINUTE="${DIGEST_MIDDAY_MINUTE:-30}"
FINAL_HOUR="${DIGEST_FINAL_HOUR:-16}"
FINAL_MINUTE="${DIGEST_FINAL_MINUTE:-30}"
TODAY="$(date +%Y-%m-%d)"
NOW_MINUTES="$((10#$(date +%H) * 60 + 10#$(date +%M)))"
MIDDAY_MINUTES="$((10#$MIDDAY_HOUR * 60 + 10#$MIDDAY_MINUTE))"
FINAL_MINUTES="$((10#$FINAL_HOUR * 60 + 10#$FINAL_MINUTE))"
STATE_MARKERS="$("$NODE_BIN" -e "var fs=require('fs');try{var s=JSON.parse(fs.readFileSync('.digest-state.json','utf8'));process.stdout.write((s.middayDate||'')+'|'+(s.finalizedDate||''))}catch(e){process.stdout.write('|')}")"
MIDDAY_DATE="${STATE_MARKERS%%|*}"
FINALIZED_DATE="${STATE_MARKERS#*|}"

if [ "$NOW_MINUTES" -ge "$FINAL_MINUTES" ]; then
  if [ "$FINALIZED_DATE" = "$TODAY" ]; then
    echo "AI Daily Digest final edition already published for $TODAY."
    exit 0
  fi
  "$NODE_BIN" scripts/generate-digest.js --force --final
elif [ "$NOW_MINUTES" -ge "$MIDDAY_MINUTES" ]; then
  if [ "$MIDDAY_DATE" = "$TODAY" ]; then
    echo "AI Daily Digest midday edition already published for $TODAY."
    exit 0
  fi
  "$NODE_BIN" scripts/generate-digest.js --force --midday
else
  "$NODE_BIN" scripts/generate-digest.js
fi
