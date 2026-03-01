#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_PATH="$SCRIPT_DIR/JobTriageSafari.xcodeproj"
SCHEME="${SCHEME:-JobTriageSafari}"
CONFIGURATION="${CONFIGURATION:-Debug}"
DERIVED_DATA_DIR="${DERIVED_DATA_DIR:-$HOME/Library/Developer/Xcode/DerivedData/JobTriageSafari-current}"
APP_NAME="${APP_NAME:-JobTriageSafari.app}"
APP_BUNDLE_ID="${APP_BUNDLE_ID:-com.arnavps.jobtriagesafari}"
EXTENSION_BUNDLE_ID="${EXTENSION_BUNDLE_ID:-${APP_BUNDLE_ID}.Extension}"
INSTALL_PARENT_DIR="${INSTALL_PARENT_DIR:-$HOME/Applications}"
INSTALL_APP_PATH="$INSTALL_PARENT_DIR/$APP_NAME"
BUILT_APP_PATH="$DERIVED_DATA_DIR/Build/Products/$CONFIGURATION/$APP_NAME"
EXTENSION_PRODUCT_NAME="${EXTENSION_PRODUCT_NAME:-JobTriageSafariExtension.appex}"
INSTALL_APPEX_PATH="$INSTALL_APP_PATH/Contents/PlugIns/$EXTENSION_PRODUCT_NAME"
BUILT_APPEX_PATH="$BUILT_APP_PATH/Contents/PlugIns/$EXTENSION_PRODUCT_NAME"

log() {
  printf '[safari-build] %s\n' "$*"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

add_unique_path() {
  local candidate="$1"
  local existing
  for existing in "${REMOVAL_APPS[@]-}"; do
    if [[ "$existing" == "$candidate" ]]; then
      return 0
    fi
  done
  REMOVAL_APPS+=("$candidate")
}

remove_app_copy() {
  local app_path="$1"
  if [[ "$app_path" != *.app || ! -d "$app_path" ]]; then
    return 0
  fi

  log "Removing app copy: $app_path"
  rm -rf "$app_path"
}

collect_registered_app_paths() {
  local appex_path=""
  while IFS=$'\t' read -r _ _ _ appex_path; do
    if [[ -z "$appex_path" ]]; then
      continue
    fi

    case "$appex_path" in
      *.appex)
        ;;
      *)
        continue
        ;;
    esac

    local host_app="${appex_path%/Contents/PlugIns/*}"
    if [[ "$host_app" == *.app ]]; then
      add_unique_path "$host_app"
    fi
  done < <(pluginkit -m -A -D -v -i "$EXTENSION_BUNDLE_ID" 2>/dev/null || true)
}

collect_named_app_paths() {
  local base_dir=""
  local app_path=""
  for base_dir in "/Applications" "$HOME/Applications"; do
    if [[ ! -d "$base_dir" ]]; then
      continue
    fi

    while IFS= read -r -d '' app_path; do
      add_unique_path "$app_path"
    done < <(find "$base_dir" -maxdepth 1 -type d \
      \( -name 'JobTriageSafari*.app' -o -name 'Job Triage Safari*.app' \) -print0)
  done
}

cleanup_old_installations() {
  REMOVAL_APPS=()

  collect_registered_app_paths
  collect_named_app_paths

  if [[ "${#REMOVAL_APPS[@]}" -eq 0 ]]; then
    log "No previously installed app copies were found."
    return 0
  fi

  log "Removing older installed versions before installing the new build..."
  local app_path=""
  for app_path in "${REMOVAL_APPS[@]}"; do
    if [[ "$app_path" == "$BUILT_APP_PATH" ]]; then
      continue
    fi

    # Best-effort unregister before deleting app bundle.
    local appex_path="$app_path/Contents/PlugIns/$EXTENSION_PRODUCT_NAME"
    if [[ -d "$appex_path" ]]; then
      pluginkit -r "$appex_path" >/dev/null 2>&1 || true
    fi

    remove_app_copy "$app_path"
  done
}

main() {
  require_cmd xcodebuild
  require_cmd pluginkit
  require_cmd ditto
  require_cmd open

  mkdir -p "$INSTALL_PARENT_DIR"

  log "Syncing extension resources..."
  "$SCRIPT_DIR/sync-extension-files.sh"

  log "Building ${SCHEME} (${CONFIGURATION})..."
  xcodebuild \
    -project "$PROJECT_PATH" \
    -scheme "$SCHEME" \
    -configuration "$CONFIGURATION" \
    -destination 'platform=macOS' \
    -derivedDataPath "$DERIVED_DATA_DIR" \
    build

  if [[ ! -d "$BUILT_APP_PATH" ]]; then
    printf 'Built app not found at: %s\n' "$BUILT_APP_PATH" >&2
    exit 1
  fi

  cleanup_old_installations

  log "Installing newest build to: $INSTALL_APP_PATH"
  rm -rf "$INSTALL_APP_PATH"
  ditto "$BUILT_APP_PATH" "$INSTALL_APP_PATH"

  if [[ -d "$INSTALL_APPEX_PATH" ]]; then
    pluginkit -a "$INSTALL_APPEX_PATH" >/dev/null 2>&1 || true
  fi

  if [[ -d "$BUILT_APPEX_PATH" ]]; then
    pluginkit -r "$BUILT_APPEX_PATH" >/dev/null 2>&1 || true
  fi
  remove_app_copy "$BUILT_APP_PATH"

  log "Launching installed app..."
  open -a "$INSTALL_APP_PATH"

  log "Registered entries after install:"
  pluginkit -m -A -D -v -i "$EXTENSION_BUNDLE_ID" || true
}

main "$@"
