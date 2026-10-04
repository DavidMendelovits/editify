import { describe, expect, it } from 'vitest';
import { isTestFlight, shouldShowTestBanner, TEST_BUILD_BANNER_TEXT } from './test-build-banner';

describe('the 1.1 TestFlight banner', () => {
  it('shows on a TestFlight build whose server says it is a test server, until dismissed', () => {
    expect(shouldShowTestBanner({ testFlight: true, testServer: true, dismissed: false })).toBe(true);
    expect(shouldShowTestBanner({ testFlight: true, testServer: true, dismissed: true })).toBe(false);
  });

  it('stays hidden off TestFlight, and on TestFlight once the server stops saying test server (cutover)', () => {
    expect(shouldShowTestBanner({ testFlight: false, testServer: true, dismissed: false })).toBe(false);
    // After cutover editify-v11 is still line 1.1, but no longer a test server: no banner.
    expect(shouldShowTestBanner({ testFlight: true, testServer: false, dismissed: false })).toBe(false);
  });

  it('can be forced for a screenshot, and a dismissal still wins', () => {
    expect(shouldShowTestBanner({ testFlight: false, testServer: false, dismissed: false, force: true })).toBe(true);
    expect(shouldShowTestBanner({ testFlight: false, testServer: false, dismissed: true, force: true })).toBe(false);
  });

  it('tells TestFlight from dev, ad hoc, simulator and App Store installs', () => {
    expect(isTestFlight({ appStoreSigned: true, receipt: 'sandbox' })).toBe(true);
    expect(isTestFlight({ appStoreSigned: true, receipt: 'production' })).toBe(false);
    // Dev, ad hoc and simulator builds also report a sandbox receipt path: the signing tells them apart.
    expect(isTestFlight({ appStoreSigned: false, receipt: 'sandbox' })).toBe(false);
    // A binary without the native check never shows it.
    expect(isTestFlight({ appStoreSigned: true, receipt: undefined })).toBe(false);
  });

  it('says what the plan says, without dashes', () => {
    expect(TEST_BUILD_BANNER_TEXT).toBe("This test build uses a separate test server. Your 1.0 projects come back at launch, and edits you make here won't carry over.");
  });
});
