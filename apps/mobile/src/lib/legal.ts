/**
 * The public legal pages, served by our own API from `docs/` (see
 * `server/src/routes/legal.ts`). These three strings are also what goes into
 * App Store Connect as the Privacy Policy, EULA and Support URLs, so they live
 * in one place and are never written out inline.
 *
 * The host is fixed rather than derived from `EXPO_PUBLIC_API_URL`: the web
 * build sets that to an empty string for same-origin requests, and a relative
 * URL is not something `Linking.openURL` can open from a native app.
 */
const LEGAL_ORIGIN = 'https://editify-dm.fly.dev';

export const PRIVACY_POLICY_URL = `${LEGAL_ORIGIN}/privacy`;
export const TERMS_OF_USE_URL = `${LEGAL_ORIGIN}/terms`;
export const SUPPORT_URL = `${LEGAL_ORIGIN}/support`;
