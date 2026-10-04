import { describe, expect, it } from 'vitest';
import { isTestFlight, serverLine, shouldShowTestBanner, TEST_BUILD_BANNER_TEXT } from './test-build-banner';

describe('the 1.1 TestFlight banner', () => {
  it('shows on a TestFlight build of the 1.1 line until dismissed', () => {
    expect(shouldShowTestBanner({ testFlight: true, line: '1.1', dismissed: false })).toBe(true);
    expect(shouldShowTestBanner({ testFlight: true, line: '1.1', dismissed: true })).toBe(false);
  });

  it('stays hidden off TestFlight or on another line', () => {
    expect(shouldShowTestBanner({ testFlight: false, line: '1.1', dismissed: false })).toBe(false);
    expect(shouldShowTestBanner({ testFlight: true, line: '1.0', dismissed: false })).toBe(false);
    expect(shouldShowTestBanner({ testFlight: true, line: 'dev', dismissed: false })).toBe(false);
    expect(shouldShowTestBanner({ testFlight: true, line: null, dismissed: false })).toBe(false);
  });

  it('can be forced for a screenshot, and a dismissal still wins', () => {
    expect(shouldShowTestBanner({ testFlight: false, line: null, dismissed: false, force: true })).toBe(true);
    expect(shouldShowTestBanner({ testFlight: false, line: null, dismissed: true, force: true })).toBe(false);
  });

  it('tells TestFlight from dev, ad hoc, simulator and App Store installs', () => {
    expect(isTestFlight({ appStoreSigned: true, receipt: 'sandbox' })).toBe(true);
    expect(isTestFlight({ appStoreSigned: true, receipt: 'production' })).toBe(false);
    // Dev, ad hoc and simulator builds also report a sandbox receipt path: the signing tells them apart.
    expect(isTestFlight({ appStoreSigned: false, receipt: 'sandbox' })).toBe(false);
    // A binary without the native check never shows it.
    expect(isTestFlight({ appStoreSigned: true, receipt: undefined })).toBe(false);
  });

  it("reads the line from /health, falling back to the build's API URL", () => {
    expect(serverLine({ ok: true, line: '1.1', commit: 'abc' }, 'https://editify-dm.fly.dev')).toBe('1.1');
    expect(serverLine({ ok: true, line: '1.0' }, 'https://editify-v11.fly.dev')).toBe('1.0');
    expect(serverLine(null, 'https://editify-v11.fly.dev')).toBe('1.1');
    expect(serverLine({ ok: true }, 'https://editify-v11.fly.dev/')).toBe('1.1');
    expect(serverLine(null, 'https://editify-dm.fly.dev')).toBeNull();
    expect(serverLine(null, 'https://editify-v11.fly.dev.example.com')).toBeNull();
    expect(serverLine('not json', 'http://localhost:3001')).toBeNull();
  });

  it('says what the plan says, without dashes', () => {
    expect(TEST_BUILD_BANNER_TEXT).toBe("This test build uses a separate test server. Your 1.0 projects come back at launch, and edits you make here won't carry over.");
  });
});
