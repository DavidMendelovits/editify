#!/usr/bin/env bash
#
# App Store screenshots from the iOS Simulator, pointed at the production backend.
#
#   scripts/screenshots.sh                      # sign-in screen only, both sizes
#   scripts/screenshots.sh you@example.com pw   # signs in and walks the screens too
#   scripts/screenshots.sh you@example.com pw "Project title"
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
# Driving the UI goes through the Simulator's accessibility bridge, which
# publishes the running app's whole tree to macOS: every control is addressed by
# the accessibilityLabel the app already sets, so nothing here depends on where
# a view happens to land on screen. That needs an unlocked GUI session with an
# Accessibility grant for whatever runs this script; `require_ui_automation`
# below proves it rather than assuming it.
#
# Env overrides: API_URL, OUT_DIR, DERIVED_DATA, SKIP_BUILD=1, EDITIFY_PROJECT_ID
# (a project title, as it reads on the home screen).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOBILE="$REPO_ROOT/apps/mobile"

API_URL="${API_URL:-https://editify-dm.fly.dev}"
BUNDLE_ID="com.editify.app"
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
#   <slug>|<simulator device name>|<expected WxH in pixels>
#
# Pick the device by name, not by UDID, so a fresh machine works without
# editing this file.
DEVICES=(
  "iphone-6.9|iPhone 17 Pro Max|1320x2868"
  "ipad-13|iPad Pro 13-inch (M5)|2064x2752"
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

# --- driving the app ---------------------------------------------------------
#
# The Simulator republishes the running app's accessibility tree through the
# macOS AX API, so every control below is found by the accessibilityLabel the
# app already sets. That is why there is no table of screen fractions any more:
# nothing here breaks when a screen is relaid out, only when a label changes.
#
# System Events is the one process that does the driving. It holds the
# Accessibility grant on a normal developer machine, where a separate binary
# like cliclick does not, and posting through it is what makes the difference
# between a click that lands and one that is dropped in silence.

# Escapes a string for an AppleScript double-quoted literal.
as_quote() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

# ax <window prefix> <label substring> <press|look> <fwd|rev>
#
# Prints "<role>|<description>|<value>" for the first control whose label or
# value contains the substring, case-sensitively (the app labels its email field
# "email" while the caption above it reads "EMAIL", and matching loosely picks
# the caption). `rev` walks children last-first, which matters in the editor:
# the chat dock is the last subtree, and a forward walk crosses a couple of
# hundred timeline clips to reach it.
ax() {
  local win target do_press reversed
  win="$(as_quote "$1")"; target="$(as_quote "$2")"
  [[ "${3:-look}" == press ]] && do_press=true || do_press=false
  [[ "${4:-fwd}" == rev ]] && reversed=true || reversed=false
  osascript <<OSA 2>/dev/null || true
on walk(el, target, doPress, reversed)
  tell application "System Events"
    try
      set kids to UI elements of el
    on error
      return ""
    end try
    set n to count of kids
    repeat with i from 1 to n
      set idx to i
      if reversed then set idx to n - i + 1
      set k to item idx of kids
      try
        set r to (role of k) as text
        if r is "AXButton" or r is "AXTextField" or r is "AXTextArea" then
          set d to ""
          try
            set d to (description of k) as text
          end try
          set v to ""
          try
            set v to (value of k) as text
          end try
          set hit to false
          considering case
            if d contains target or v contains target then set hit to true
          end considering
          if hit then
            if doPress then
              try
                perform action "AXScrollToVisible" of k
              end try
              perform action "AXPress" of k
            end if
            return r & "|" & d & "|" & v
          end if
        end if
      end try
      set deeper to my walk(k, target, doPress, reversed)
      if deeper is not "" then return deeper
    end repeat
    return ""
  end tell
end walk

tell application "Simulator" to activate
delay 0.4
tell application "System Events" to tell process "Simulator"
  -- Windows are created asynchronously after a boot, and a device can stay
  -- booted with no window at all, so the lookup waits instead of failing.
  repeat 30 times
    try
      set w to first window whose name starts with "$win"
      return my walk(w, "$target", $do_press, $reversed)
    on error
      delay 1
    end try
  end repeat
  return ""
end tell
OSA
}

press() { ax "$1" "$2" press "${3:-fwd}"; }
ax_value() { ax "$1" "$2" look "${3:-fwd}" | cut -d'|' -f3; }

type_text() {
  osascript -e "tell application \"System Events\" to keystroke \"$(as_quote "$1")\""
  sleep 0.6
}

# fill <window prefix> <label> <text>
#
# Types into a field and then reads it back, because keystrokes into the
# Simulator are not reliably atomic: a long string can arrive with its tail
# missing, which on the sign-in screen means a run that looks fine until the
# server rejects the address. Retries, then gives up loudly rather than
# carrying on with a half-typed field.
fill() {
  local win="$1" label="$2" text="$3" attempt got i
  got=""
  for attempt in 1 2 3; do
    press "$win" "$label" >/dev/null
    sleep 0.8
    # Split so a dropped tail is a second chunk to re-type, not a silent loss.
    type_text "${text:0:${#text}/2}"
    type_text "${text:${#text}/2}"
    sleep 0.6
    got="$(ax_value "$win" "$label")"
    [[ "$got" == "$text" ]] && return 0
    # Wrong contents: clear the field a character at a time before another go.
    # There is no reliable select-all here, and the Simulator reads cmd-arrow as
    # a device rotation rather than a caret move.
    for ((i = 0; i < ${#got} + 4; i++)); do
      osascript -e 'tell application "System Events" to key code 51' >/dev/null 2>&1
    done
  done
  die "could not type '$label' on $win: field reads '${got}'"
}

# The check this replaces asked whether Apple Events worked, which is not the
# permission the run needs: the old tap helper posted CGEvents from cliclick,
# which carries its own Accessibility grant, so the check passed on machines
# where every click was silently discarded and the run saved screenshots of an
# empty form. This one drives the bridge it is about to drive, against the
# window it is about to drive, and stops if the app is not answering.
require_ui_automation() {
  local win="$1"
  osascript -e 'tell application "System Events" to get name of first process whose frontmost is true' >/dev/null 2>&1 \
    || die "no reachable GUI session: unlock the screen and grant this terminal Accessibility"
  [[ -n "$(ax "$win" "email" look)" ]] \
    || die "the accessibility bridge cannot see the sign-in form on $win, so nothing can be driven or verified"
}

# --- 3, 4. boot, install, launch, capture ------------------------------------
mkdir -p "$OUT_DIR"

for row in "${DEVICES[@]}"; do
  IFS='|' read -r slug name size <<<"$row"
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

  require_ui_automation "$name"

  log "Signing in as $EMAIL"
  fill "$name" "email" "$EMAIL"
  fill "$name" "password" "$PASSWORD"
  press "$name" "sign in" >/dev/null
  sleep 8   # Supabase round trip, then the router swaps to the home screen

  # The sign-in form is gone once the session lands. If it is still there the
  # credentials were refused, and going on would only save pictures of a form.
  [[ -z "$(ax "$name" "sign in" look)" ]] \
    || die "still on the sign-in screen after submitting, so the run stops rather than photograph it"

  shot "$udid" "$slug" "02-home" "$size"

  # Navigation is by pressing what a person would press. The deep links this
  # used to use raise an "Open in Editify?" alert whenever the app is already
  # frontmost, and two of those queue up into a modal that swallows every later
  # press, leaving the device wedged until it is erased.
  press "$name" "learn my style" >/dev/null; sleep 4
  shot "$udid" "$slug" "05-style" "$size"
  press "$name" "HOME" >/dev/null; sleep 3

  # The editor is reached through the first project on the home screen, so the
  # run no longer needs a project id handed to it. PROJECT_ID stays supported
  # for picking a specific one out of a longer list.
  project_label="Instagram Reel edit"
  [[ -n "$PROJECT_ID" ]] && project_label="$PROJECT_ID"
  if [[ -n "$(ax "$name" "$project_label" look)" ]]; then
    press "$name" "$project_label" >/dev/null; sleep 10
    shot "$udid" "$slug" "01-editor" "$size"
    press "$name" "export ↗" >/dev/null; sleep 5
    shot "$udid" "$slug" "06-export" "$size"
  else
    echo "  no project named '$project_label' on the home screen"
    echo "  pass a project title as the third argument, or set EDITIFY_PROJECT_ID"
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
