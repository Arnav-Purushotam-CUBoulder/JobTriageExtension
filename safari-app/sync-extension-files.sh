#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST_DIR="$ROOT_DIR/safari-app/JobTriageSafariExtension/Resources"
ENV_FILE="$ROOT_DIR/.env"
PROFILE_FILE="$ROOT_DIR/profile.local.json"

mkdir -p "$DEST_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  cat > "$ENV_FILE" <<'EOF'
OPENAI_API_KEY=
EOF
  echo "Created $ENV_FILE with OPENAI_API_KEY placeholder."
fi

if [[ ! -f "$PROFILE_FILE" ]]; then
  cat > "$PROFILE_FILE" <<'EOF'
{
  "full_name": "",
  "email": "",
  "phone": "",
  "current_city": "",
  "current_state": "",
  "address": "",
  "postal_code": "",
  "linkedin": "",
  "work_authorization": "",
  "github": "",
  "portfolio": "",
  "skills": [],
  "experience": [
    {
      "company_name": "",
      "role_title": "",
      "start_date": "",
      "end_date": "",
      "description": ""
    },
    {
      "company_name": "",
      "role_title": "",
      "start_date": "",
      "end_date": "",
      "description": ""
    }
  ]
}
EOF
  echo "Created $PROFILE_FILE with profile placeholders."
fi

cp "$ROOT_DIR/manifest.json" "$DEST_DIR/manifest.json"
cp "$ROOT_DIR/content.js" "$DEST_DIR/content.js"
cp "$ROOT_DIR/worker.js" "$DEST_DIR/worker.js"
cp "$ROOT_DIR/icon1.png" "$DEST_DIR/icon1.png"
cp "$ENV_FILE" "$DEST_DIR/.env"
cp "$PROFILE_FILE" "$DEST_DIR/profile.local.json"
cp "$ROOT_DIR/profile-editor.html" "$DEST_DIR/profile-editor.html"
cp "$ROOT_DIR/profile-editor.css" "$DEST_DIR/profile-editor.css"
cp "$ROOT_DIR/profile-editor.js" "$DEST_DIR/profile-editor.js"

echo "Synced extension resources (including .env and profile assets) to: $DEST_DIR"
