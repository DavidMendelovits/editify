#!/bin/bash
# Release gate: a Release simulator build wired to the local gate servers only.
#
#   build-app.sh <checkout> <tag> <api-port>
#     1.0 (stored, rebuilt only when the 1.0 binary changes):  build-app.sh "$V10_WT" v10 3161
#     1.1 (every gate, at the commit being shipped):          build-app.sh "$V11_WT" v11 3163
#
# Writes $GATE_DIR/apps/Editify-<tag>-<sha>.app and exits non-zero unless the bundle carries the
# local auth and API URLs and no production Supabase or editify-v11 URL.
#
# Gotchas this handles (each one has bitten a gate run):
# - Local Release builds ignore shell EXPO_PUBLIC_*: the env goes into ios/.xcode.env.local too.
# - Metro's shared cache bakes stale URLs into a Release bundle: fresh TMPDIR + --reset-cache.
# - EXUpdatesEnabled NO, so an OTA from a real channel can't replace the local bundle.
# - EDITIFY_SKIP_POSTHOG_UPLOAD=1 (1.0 has no switch: posthog-local-patch.py strips the upload).
# - Ad-hoc signing (CODE_SIGN_IDENTITY=-), or uploads from the app fail on the simulator.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
: "${GATE_DIR:?set GATE_DIR to a scratch directory}"
WT=$1; tag=$2; port=$3
API=http://localhost:$port AUTH=http://localhost:3164 KEY=local-fake-anon
sha=$(git -C "$WT" rev-parse --short HEAD)
cd "$WT/apps/mobile"
export LANG=en_US.UTF-8 CI=1 NODE_ENV=production EDITIFY_SKIP_POSTHOG_UPLOAD=1
export TMPDIR="$GATE_DIR/tmp-$tag"; rm -rf "$TMPDIR"; mkdir -p "$TMPDIR"
export EXPO_PUBLIC_API_URL=$API EXPO_PUBLIC_SUPABASE_URL=$AUTH EXPO_PUBLIC_SUPABASE_KEY=$KEY
printf 'EXPO_PUBLIC_API_URL=%s\nEXPO_PUBLIC_SUPABASE_URL=%s\nEXPO_PUBLIC_SUPABASE_KEY=%s\n' $API $AUTH $KEY > .env.local
npx expo prebuild --clean --platform ios > "$GATE_DIR/build-$tag-prebuild.log" 2>&1
cd ios
[ -f ../plugins/with-posthog-upload-switch.js ] || python3 "$here/posthog-local-patch.py"
plutil -replace EXUpdatesEnabled -bool NO Editify/Supporting/Expo.plist
{ echo 'export EXTRA_PACKAGER_ARGS="--reset-cache"'; echo 'export NODE_ENV=production'; echo 'export EDITIFY_SKIP_POSTHOG_UPLOAD=1'
  echo "export EXPO_PUBLIC_API_URL=$API EXPO_PUBLIC_SUPABASE_URL=$AUTH EXPO_PUBLIC_SUPABASE_KEY=$KEY"; } >> .xcode.env.local
xcodebuild -workspace Editify.xcworkspace -scheme Editify -configuration Release -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath "$GATE_DIR/dd-$tag" ARCHS=arm64 ONLY_ACTIVE_ARCH=YES \
  CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM= PROVISIONING_PROFILE_SPECIFIER= \
  EDITIFY_SKIP_POSTHOG_UPLOAD=1 build > "$GATE_DIR/build-$tag-xcodebuild.log" 2>&1
tail -2 "$GATE_DIR/build-$tag-xcodebuild.log"
rm -f ../.env.local
APP="$GATE_DIR/dd-$tag/Build/Products/Release-iphonesimulator/Editify.app"
# Hermes packs strings back to back, so grep the raw bytes. editify-dm.fly.dev appears once, as legal.ts's LEGAL_ORIGIN.
grep -a -o -E "https?://localhost:[0-9]+|[a-z0-9-]+\.supabase\.co|editify-[a-z0-9]+\.fly\.dev" "$APP/main.jsbundle" | sort | uniq -c
grep -a -q "http://localhost:3164" "$APP/main.jsbundle" || { echo "bundle lacks the local auth URL"; exit 1; }
grep -a -q "http://localhost:$port" "$APP/main.jsbundle" || { echo "bundle lacks the local API URL"; exit 1; }
if grep -a -q -E "[a-z0-9-]+\.supabase\.co|editify-v11\.fly\.dev" "$APP/main.jsbundle"; then echo "bundle mentions production auth or the v11 API"; exit 1; fi
mkdir -p "$GATE_DIR/apps"
out="$GATE_DIR/apps/Editify-$tag-$sha.app"; rm -rf "$out"; ditto "$APP" "$out"
echo "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$out/Info.plist") $out"
echo BUILD-OK
