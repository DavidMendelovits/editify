/**
 * The TestFlight banner of the 1.1 line (C8, C18), free of React Native so it runs under vitest.
 *
 * Before the cutover, 1.1 TestFlight builds talk to editify-v11, a separate server holding
 * imported copies (tagged beta_copy, deleted at cutover). Testers are told so once, and the
 * banner stays gone once dismissed.
 *
 *   TestFlight? (App Store signed + a sandbox receipt; dev, ad hoc, simulator and App Store
 *               installs never are) ─┐
 *   line? (/health `line`, or the build's API URL when /health can't answer) ─┤
 *   dismissed? (this phone's local storage) ─────────────────────────────────┴─▶ show
 *   force (a local build's EXPO_PUBLIC_TEST_BANNER=force, never in eas.json) ─▶ show unless dismissed
 */

export const TEST_BUILD_BANNER_TEXT = "This test build uses a separate test server. Your 1.0 projects come back at launch, and edits you make here won't carry over.";

/** Local storage key: one per line, so a later test line asks again. */
export const TEST_BANNER_DISMISSED_KEY = 'editify.testBuildBanner.dismissed.1.1';

/** The server line the banner belongs to. */
export const BANNER_LINE = '1.1';

/** The 1.1 line's server host, for when /health can't be asked. */
const V11_HOST = /^https:\/\/editify-v11\.fly\.dev(?:\/|$)/i;

/**
 * Which server line this build talks to: /health's `line` when it answered with one, else
 * what the build's API URL says (editify-v11 is 1.1), else null.
 */
export function serverLine(health: unknown, apiUrl: string): string | null {
  if (health && typeof health === 'object') {
    const { line } = health as { line?: unknown };
    if (typeof line === 'string' && line.length > 0) return line;
  }
  return V11_HOST.test(apiUrl) ? BANNER_LINE : null;
}

/**
 * A TestFlight install: signed for the App Store (no embedded provisioning profile, so not a
 * dev or ad hoc build) and holding a sandbox receipt (an App Store install holds a production one).
 */
export function isTestFlight(input: { appStoreSigned: boolean; receipt: 'sandbox' | 'production' | 'none' | undefined }): boolean {
  return input.appStoreSigned && input.receipt === 'sandbox';
}

export interface BannerInputs {
  testFlight: boolean;
  line: string | null;
  dismissed: boolean;
  /** A local build's flag: show it regardless of the build and line (for screenshots). */
  force?: boolean;
}

export function shouldShowTestBanner({ testFlight, line, dismissed, force }: BannerInputs): boolean {
  if (dismissed) return false;
  if (force) return true;
  return testFlight && line === BANNER_LINE;
}
