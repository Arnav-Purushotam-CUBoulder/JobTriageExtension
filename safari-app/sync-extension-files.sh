#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST_DIR="$ROOT_DIR/safari-app/JobTriageSafariExtension/Resources"

mkdir -p "$DEST_DIR"
cp "$ROOT_DIR/manifest.json" "$DEST_DIR/manifest.json"
cp "$ROOT_DIR/content.js" "$DEST_DIR/content.js"
cp "$ROOT_DIR/worker.js" "$DEST_DIR/worker.js"
cp "$ROOT_DIR/icon1.png" "$DEST_DIR/icon1.png"

echo "Synced extension resources to: $DEST_DIR"
