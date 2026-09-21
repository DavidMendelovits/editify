import Constants from 'expo-constants';
import * as Updates from 'expo-updates';

/**
 * What a tester reads off the screen to say which build they are holding.
 *
 * `expo-application` is not a dependency, so the version and build number come
 * from the embedded manifest — EAS writes the remote build number into the
 * config at build time (`appVersionSource: remote` in eas.json). `updateId` is
 * null until an OTA update has actually been applied, so a fresh TestFlight
 * install reads "embedded".
 */
function describeVersion(): string {
  const version = Constants.expoConfig?.version ?? '0.0.0';
  const build = Constants.expoConfig?.ios?.buildNumber ?? Constants.expoConfig?.android?.versionCode;
  const update = Updates.updateId ? Updates.updateId.replace(/-/g, '').slice(0, 7) : 'embedded';
  return `v${version}${build ? ` (${build})` : ''} · ${update}`;
}

export const appVersion = describeVersion();
