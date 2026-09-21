import * as Application from 'expo-application';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';

/**
 * What a tester reads off the screen to say which build they are holding.
 *
 * The version and build number come from `expo-application`, which reads
 * `CFBundleShortVersionString` and `CFBundleVersion` straight out of the
 * running app's Info.plist, so they always describe the binary in hand. That
 * matters for EAS builds: with `appVersionSource: remote` the build number is
 * assigned by EAS at build time and is never written into the embedded Expo
 * config, so `Constants.expoConfig.ios.buildNumber` is null there. Both values
 * are null on web, where there is no native bundle; the version then falls back
 * to the one in app.json and the build number is left off.
 *
 * The `updateId` suffix identifies the JS that is loaded. In a release build it
 * starts out as the id of the embedded manifest and changes once an OTA update
 * is applied, which is what distinguishes updates within a single native build.
 * It is null where expo-updates is not running the bundle (dev builds, web),
 * and the suffix is then omitted.
 */
function describeVersion(): string {
  const version = Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? '0.0.0';
  const build = Application.nativeBuildVersion;
  const update = Updates.updateId?.replace(/-/g, '').slice(0, 7);
  return `v${version}${build ? ` (${build})` : ''}${update ? ` · ${update}` : ''}`;
}

export const appVersion = describeVersion();
