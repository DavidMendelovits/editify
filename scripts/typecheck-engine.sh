#!/usr/bin/env bash
# Typechecks the engine's two pods against the iOS SDK at a deployment target (default the
# release/1.1 floor, 18.0), so an iOS 26-only API outside an #available adapter fails here
# instead of in an app build. Core is emitted as the EditifyCore module first, then Engine is
# checked against it. EditifyEngineModule.swift and EditifyPlayerView.swift import
# ExpoModulesCore (not built here); the app build covers them.
#
#   scripts/typecheck-engine.sh [target]     e.g. arm64-apple-ios18.0 (default) or arm64-apple-ios26.0
#   EXTRA_SWIFT_FLAGS="-D EDITIFY_TEST_ADAPTERS" scripts/typecheck-engine.sh
set -euo pipefail
target="${1:-arm64-apple-ios18.0}"
root="$(cd "$(dirname "$0")/.." && pwd)"
ios="$root/apps/mobile/modules/editify-engine/ios"
sdk="$(xcrun --sdk iphoneos --show-sdk-path)"
out="$(mktemp -d)"
trap 'rm -rf "$out"' EXIT
# shellcheck disable=SC2086
xcrun swiftc -emit-module -module-name EditifyCore -parse-as-library -swift-version 5 -sdk "$sdk" -target "$target" \
  ${EXTRA_SWIFT_FLAGS:-} -emit-module-path "$out/EditifyCore.swiftmodule" $(find "$ios/Core" -name '*.swift' | sort)
engine=()
while IFS= read -r file; do engine+=("$file"); done < <(find "$ios/Engine" -name '*.swift' ! -name EditifyEngineModule.swift ! -name EditifyPlayerView.swift | sort)
# shellcheck disable=SC2086
xcrun swiftc -typecheck -continue-building-after-errors -module-name EditifyEngine -swift-version 5 -sdk "$sdk" -target "$target" \
  ${EXTRA_SWIFT_FLAGS:-} -I "$out" "${engine[@]}"
echo "engine typechecks for $target"
