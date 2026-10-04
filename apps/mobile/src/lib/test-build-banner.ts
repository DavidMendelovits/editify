/**
 * The TestFlight banner of the 1.1 line (C8, C18), free of React Native so it runs under vitest.
 *
 * Before the cutover, 1.1 TestFlight builds talk to editify-v11, a separate server holding
 * imported copies (tagged beta_copy, deleted at cutover). Testers are told so once, and the
 * banner stays gone once dismissed.
 *
 *   TestFlight? (App Store signed + a sandbox receipt; dev, ad hoc, simulator and App Store
 *               installs never are) ─┐
 *   test server? (/client-config `testServer: true`, sent only while TEST_SERVER=1) ─┤
 *   dismissed? (this phone's local storage) ─────────────────────────────────────────┴─▶ show
 *   force (a local build's EXPO_PUBLIC_TEST_BANNER=force, never in eas.json) ─▶ show unless dismissed
 *
 * The server decides, not the line: after cutover editify-v11 is the launched 1.1 server (still
 * line 1.1), and App Review installs carry a sandbox receipt too, so keying on the line would keep
 * telling post-launch testers and reviewers this is a test server. No answer means no banner.
 */

export const TEST_BUILD_BANNER_TEXT = "This test build uses a separate test server. Your 1.0 projects come back at launch, and edits you make here won't carry over.";

/** Local storage key: one per line, so a later test line asks again. */
export const TEST_BANNER_DISMISSED_KEY = 'editify.testBuildBanner.dismissed.1.1';

/**
 * A TestFlight install: signed for the App Store (no embedded provisioning profile, so not a
 * dev or ad hoc build) and holding a sandbox receipt (an App Store install holds a production one).
 */
export function isTestFlight(input: { appStoreSigned: boolean; receipt: 'sandbox' | 'production' | 'none' | undefined }): boolean {
  return input.appStoreSigned && input.receipt === 'sandbox';
}

export interface BannerInputs {
  testFlight: boolean;
  /** /client-config said `testServer: true`; false when it said nothing or could not be asked. */
  testServer: boolean;
  dismissed: boolean;
  /** A local build's flag: show it regardless of the build and server (for screenshots). */
  force?: boolean;
}

export function shouldShowTestBanner({ testFlight, testServer, dismissed, force }: BannerInputs): boolean {
  if (dismissed) return false;
  if (force) return true;
  return testFlight && testServer;
}
