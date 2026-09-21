#!/usr/bin/env bash
#
# App Store screenshots from the iOS Simulator, pointed at the production backend.
#
#   scripts/screenshots.sh                      # sign-in screen only, both sizes
#   scripts/screenshots.sh you@example.com pw   # signs in and walks the screens too
#   scripts/screenshots.sh you@example.com pw PROJECT_ID
#
# What it does, in order: build a Release simulator app with EXPO_PUBLIC_API_URL
# baked in, prove the production URL really is in the JS bundle, boot the two
# device sizes App Store Connect requires, install, launch, and capture PNGs at
# exactly the pixel sizes Apple accepts.
#
# Sizes come from docs/app-store-submission.md section 4.1. Since April 2025
# Apple wants one iPhone 6.9" set and, because app.json sets supportsTablet,
# one iPad 13" set. Everything else it scales down itself.
#
# Env overrides: API_URL, OUT_DIR, DERIVED_DATA, SKIP_BUILD=1, EDITIFY_PROJECT_ID.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOBILE="$REPO_ROOT/apps/mobile"

API_URL="${API_URL:-https://editify-dm.fly.dev}"
BUNDLE_ID="com.editify.app"
URL_SCHEME="editify"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/.screenshots}"
DERIVED_DATA="${DERIVED_DATA:-$OUT_DIR/DerivedData}"
PROJECT_ID="${EDITIFY_PROJECT_ID:-${3:-}}"

EMAIL="${1:-}"
PASSWORD="${2:-}"

# xcodebuild and CocoaPods both choke on a POSIX locale in this repo.
export LANG=en_US.UTF-8

# --- devices -----------------------------------------------------------------
#
# One row per required App Store size:
#   <slug>|<simulator device name>|<expected WxH in pixels>|<backing scale>
#
# The scale turns pixels into the points the Simulator window is laid out in,
# which the tap helper below needs. Pick the device by name, not by UDID, so a
# fresh machine works without editing this file.
DEVICES=(
  "iphone-6.9|iPhone 17 Pro Max|1320x2868|3"
  "ipad-13|iPad Pro 13-inch (M5)|2064x2752|2"
)

# Where the sign-in fields sit, as a fraction of the screen. Measured off the
# captured sign-in screenshots, so re-measure these if sign-in.tsx is relaid out.
# Format: <slug>|<email y>|<password y>|<submit y>   (x is always 0.5, centred)
SIGN_IN_LAYOUT=(
  "iphone-6.9|0.2824|0.3550|0.4093"
  "ipad-13|0.1744|0.2249|0.2630"
)

log() { printf '\n== %s\n' "$*"; }
die() { printf '\nFAILED: %s\n' "$*" >&2; exit 1; }

# --- 1. build ----------------------------------------------------------------
#
# EXPO_PUBLIC_API_URL has to be in the environment of the Xcode "Bundle React
# Native code and images" phase, because babel inlines EXPO_PUBLIC_* at
# transform time. Miss it and apps/mobile/src/lib/api.ts silently falls back to
# http://localhost:3001 and every screenshot shows an app with no server.
APP_PATH="$DERIVED_DATA/Build/Products/Release-iphonesimulator/Editify.app"

if [[ "${SKIP_BUILD:-0}" == "1" && -d "$APP_PATH" ]]; then
  log "Skipping build, reusing $APP_PATH"
else
  log "Building Release simulator app against $API_URL"
  mkdir -p "$OUT_DIR"
  # Metro caches transforms hard. A stale entry can carry the old API URL, so
  # drop the cache whenever the URL we are baking in is not the one from last time.
  STAMP="$OUT_DIR/.api-url"
  if [[ "$(cat "$STAMP" 2>/dev/null || true)" != "$API_URL" ]]; then
    rm -rf "${TMPDIR:-/tmp}metro-cache" 2>/dev/null || true
    printf '%s' "$API_URL" > "$STAMP"
  fi
  EXPO_PUBLIC_API_URL="$API_URL" xcodebuild \
    -workspace "$MOBILE/ios/Editify.xcworkspace" \
    -scheme Editify \
    -configuration Release \
    -sdk iphonesimulator \
    -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath "$DERIVED_DATA" \
    CODE_SIGNING_ALLOWED=NO \
    build
fi

[[ -d "$APP_PATH" ]] || die "no app at $APP_PATH"

# --- 2. prove the bundle points at production --------------------------------
log "Checking the JS bundle"
HOST="${API_URL#*://}"
# grep exits 1 on no match, which is the expected answer for the second one, so
# neither pipeline is allowed to take the script down with it.
prod_hits=$( (strings "$APP_PATH/main.jsbundle" | grep -o "$HOST" || true) | wc -l | tr -d ' ')
local_hits=$( (strings "$APP_PATH/main.jsbundle" | grep -o 'localhost:3001' || true) | wc -l | tr -d ' ')
echo "  $HOST: $prod_hits    localhost:3001: $local_hits"
[[ "$prod_hits" -ge 1 ]] || die "$HOST is not in main.jsbundle"
[[ "$local_hits" -eq 0 ]] || die "main.jsbundle still contains localhost:3001"

# --- helpers -----------------------------------------------------------------

# udid_for <device name> -> the UDID on the newest installed runtime for it.
# simctl lists runtimes oldest first, so the last match is the newest one. The
# trailing " (" keeps "iPhone 17 Pro" from matching "iPhone 17 Pro Max".
udid_for() {
  xcrun simctl list devices available \
    | { grep -F "    $1 (" || true; } \
    | { grep -oE '[0-9A-F]{8}-([0-9A-F]{4}-){3}[0-9A-F]{12}' || true; } \
    | tail -1
}

# shot <udid> <slug> <name> <expected WxH> -> writes OUT_DIR/<slug>-<name>.png
# and refuses to carry on if the pixels are not what Apple accepts.
shot() {
  local udid="$1" slug="$2" name="$3" expect="$4"
  local path="$OUT_DIR/$slug-$name.png"
  xcrun simctl io "$udid" screenshot "$path" >/dev/null 2>&1
  local w h got
  w="$(sips -g pixelWidth "$path" | awk '/pixelWidth/ {print $2}')"
  h="$(sips -g pixelHeight "$path" | awk '/pixelHeight/ {print $2}')"
  got="${w}x${h}"
  [[ "$got" == "$expect" ]] || die "$path is ${got}, App Store Connect wants ${expect}"
  echo "  $path  $got"
}

# The Simulator has no touch injection API. Taps go through the macOS pointer,
# which means cliclick (brew install cliclick) and an Accessibility grant for
# whatever terminal runs this script (System Settings > Privacy & Security >
# Accessibility). Without both, the clicks land nowhere and the run stops here
# rather than saving screenshots of an un-filled form.
require_ui_automation() {
  command -v cliclick >/dev/null || die "cliclick not installed: brew install cliclick"
  osascript -e 'tell application "System Events" to get name of first process whose frontmost is true' >/dev/null 2>&1 \
    || die "this terminal needs Accessibility permission to drive the Simulator"
}

# front_window <device name>: raise that device's Simulator window and echo
# "x y w h" for it, in screen points.
front_window() {
  open -a Simulator >/dev/null 2>&1 || true
  osascript <<OSA
tell application "Simulator" to activate
tell application "System Events" to tell process "Simulator"
  set w to first window whose name starts with "$1"
  perform action "AXRaise" of w
  set {x, y} to position of w
  set {ww, hh} to size of w
  return (x as text) & " " & (y as text) & " " & (ww as text) & " " & (hh as text)
end tell
OSA
}

# tap <device name> <pixel W> <pixel H> <scale> <x fraction> <y fraction>
#
# The Simulator window is the device screen plus a bezel of equal width on the
# left and right and a title bar on top, so the bezel width falls out of the
# width difference and the title bar out of what is left of the height. This
# only holds at 100% zoom (Window > Physical Size, or Cmd-1), which the run
# assumes.
tap() {
  local name="$1" px="$2" py="$3" scale="$4" fx="$5" fy="$6"
  local geom; geom="$(front_window "$name")"
  read -r wx wy ww wh <<<"$geom"
  local dw=$((px / scale)) dh=$((py / scale))
  local bezel=$(( (ww - dw) / 2 ))
  local title=$(( wh - dh - 2 * bezel ))
  local sx sy
  sx=$(awk -v a="$wx" -v b="$bezel" -v d="$dw" -v f="$fx" 'BEGIN{printf "%d", a + b + d * f}')
  sy=$(awk -v a="$wy" -v t="$title" -v d="$dh" -v f="$fy" 'BEGIN{printf "%d", a + t + d * f}')
  cliclick "c:$sx,$sy"
  sleep 0.4
}

# --- 3, 4. boot, install, launch, capture ------------------------------------
mkdir -p "$OUT_DIR"

for row in "${DEVICES[@]}"; do
  IFS='|' read -r slug name size scale <<<"$row"
  udid="$(udid_for "$name")"
  [[ -n "$udid" ]] || die "no simulator named '$name'. xcrun simctl list devicetypes"

  log "$name ($slug, $size)"
  xcrun simctl boot "$udid" 2>/dev/null || true
  xcrun simctl bootstatus "$udid" -b >/dev/null

  # A clean install every run, so a stale localhost build can never be the thing
  # that gets photographed.
  xcrun simctl uninstall "$udid" "$BUNDLE_ID" >/dev/null 2>&1 || true
  xcrun simctl install "$udid" "$APP_PATH"
  # Status bar that Apple likes: full bars, full battery, no carrier clutter.
  xcrun simctl status_bar "$udid" override --time "9:41" --batteryState charged --batteryLevel 100 \
    --cellularMode active --cellularBars 4 --wifiMode active --wifiBars 3 2>/dev/null || true
  xcrun simctl launch "$udid" "$BUNDLE_ID" >/dev/null
  sleep 8   # splash, Hermes start, first paint

  shot "$udid" "$slug" "01-sign-in" "$size"

  # --- 5. the signed-in walk -------------------------------------------------
  #
  # Everything past here needs a demo account. Without one the run stops at the
  # sign-in shot, which is the honest thing to hand a reviewer.
  if [[ -z "$EMAIL" || -z "$PASSWORD" ]]; then
    echo "  no credentials given, stopping after the sign-in shot"
    continue
  fi

  require_ui_automation

  layout=""
  for l in "${SIGN_IN_LAYOUT[@]}"; do
    [[ "$l" == "$slug|"* ]] && layout="$l"
  done
  IFS='|' read -r _ y_email y_password y_submit <<<"$layout"
  IFS='x' read -r px py <<<"$size"

  log "Signing in as $EMAIL"
  tap "$name" "$px" "$py" "$scale" 0.5 "$y_email"
  cliclick -w 20 "t:$EMAIL"
  tap "$name" "$px" "$py" "$scale" 0.5 "$y_password"
  cliclick -w 20 "t:$PASSWORD"
  tap "$name" "$px" "$py" "$scale" 0.5 "$y_submit"
  sleep 6   # Supabase round trip, then the router swaps to the home screen

  shot "$udid" "$slug" "02-home" "$size"

  # Deep links beat taps for getting between screens: expo-router owns these
  # paths (apps/mobile/app/*), so openurl lands on the screen directly.
  xcrun simctl openurl "$udid" "$URL_SCHEME:///style"; sleep 4
  shot "$udid" "$slug" "05-style" "$size"

  if [[ -n "$PROJECT_ID" ]]; then
    xcrun simctl openurl "$udid" "$URL_SCHEME:///project/$PROJECT_ID"; sleep 6
    shot "$udid" "$slug" "01-editor" "$size"
    xcrun simctl openurl "$udid" "$URL_SCHEME:///project/$PROJECT_ID/export"; sleep 4
    shot "$udid" "$slug" "06-export" "$size"
  else
    echo "  no project id, skipping the editor and export shots"
    echo "  pass one as the third argument, or set EDITIFY_PROJECT_ID"
  fi

  # Shots 2, 3 and 4 of the plan in docs/app-store-submission.md section 4.3
  # (chat dock with an agent trace expanded, the cleanup sheet, the preview with
  # captions running) all depend on what is on the timeline of that project,
  # so they are still taken by hand. There is nothing to automate against until
  # a demo account exists with footage already imported.
  echo "  shots 2, 3 and 4 of the plan are still manual, see section 4.3"
done

log "Done. PNGs in $OUT_DIR"
ls -1 "$OUT_DIR"/*.png 2>/dev/null || true
