#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
RUNTIME_DIR="${DIGEST_RUNTIME_DIR:-$HOME/Library/Application Support/AI Daily Digest}"

mkdir -p "$RUNTIME_DIR"
rsync -a --delete \
  --exclude digest.log \
  --exclude digest.err.log \
  --exclude .digest-state.json \
  --exclude .digest-last-input.json \
  --exclude .digest-last-output.json \
  --exclude .digest-last-render.json \
  "$ROOT_DIR/" "$RUNTIME_DIR/"
