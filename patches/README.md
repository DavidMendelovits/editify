# Patches

Applied by `patch-package` from the root `postinstall` script, so every `npm ci` /
`npm install` (local, CI, the Fly Dockerfile, and EAS Build, which installs at the
workspace root) gets them. Each patch is pinned to the exact version in its file name;
when that dependency is upgraded, patch-package fails the install until the patch is
redone or dropped.

## expo-image-picker+17.0.11

`ios/MediaHandler.swift`, the video fast path (`handleVideo(from:)`). It only runs when
`PHAsset.fetchAssets` succeeds: with full Photos access, or Limited with the clip inside
the selection. Since Editify asks for full access (on-device export plan, decision 1),
that is now the common case. Upstream it calls
`PHAssetResourceManager.writeData(for:toFile:options: nil)`: no network access and no
error handling, so picking an iCloud-only video failed with PHPhotosErrorDomain 3164.

The patch passes `PHAssetResourceRequestOptions` with `isNetworkAccessAllowed = true`
and wraps the fast path in `do/catch`; on any error it deletes the partial file and
falls through to the existing slow path (`loadFileRepresentation`).

Drop it once upstream does the same.
