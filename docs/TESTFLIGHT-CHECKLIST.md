# TestFlight external testing checklist

Goal: get an iOS build of Editify through App Review's TestFlight beta review so
people outside the team can install it. External TestFlight builds get a
lighter review than a store release, but they are still reviewed against the
App Store Review Guidelines, so the app has to behave like a submittable app.

Accounts: the first pass ships under David's personal Apple Developer account.
Moving to a company account later means transferring the app record and
re-issuing certificates and provisioning profiles, so the bundle identifier and
everything tied to it should be chosen once, now (section 1).

Status legend: `[ ]` todo, `[~]` in progress, `[x]` done.

## 0. What exists today (findings from the code)

- Expo SDK 54 app, EAS project already configured (`apps/mobile/app.json`, `apps/mobile/eas.json`), bundle id `com.editify.app`, owner `dfordavey`.
- Sign-in is Supabase email/password plus Google (`apps/mobile/app/sign-in.tsx`). There is no Sign in with Apple.
- Sign-out exists (`apps/mobile/app/index.tsx`). There is no way for a user to delete their account or their uploaded media.
- `app.json` declares no `icon`, no `splash`, and no `ios.buildNumber`. There are no image assets in `apps/mobile` at all.
- Photo library and microphone usage strings are set through the `expo-image-picker` and `expo-audio` plugins. `ITSAppUsesNonExemptEncryption` is already `false`.
- Backend is a single Fly machine (`fly.toml`) with SQLite and media on one volume, verifying Supabase JWTs (`server/src/auth.ts`).
- Data scoping: every store falls back to `user_id = ? OR user_id IS NULL`, so any legacy or shared-token row is visible to every signed-in user (`server/src/db/project-store.ts`, `asset-store.ts`, `render-store.ts`).
- `PUT /agent/provider` is a global setting with no per-user scope (`server/src/routes/agent.ts`). Any signed-in user can switch the model provider for everyone, and the provider chip exposes `claude-cli` and `codex-cli` options in the UI.
- Crash and feedback reports can be filed as public GitHub issues on `DavidMendelovits/editify` (`server/src/services/telemetry-service.ts`), including the user's error text and comment.
- Uploaded media is transcribed with a local Whisper model; chat prompts and transcripts go to Anthropic or OpenAI depending on the configured provider.

## 1. Apple developer account and identifiers

- [ ] Confirm the Apple Developer Program membership on David's account is active and Agreements, Tax, and Banking show the free-app agreement accepted (a pending agreement blocks TestFlight uploads).
- [ ] Register the App ID `com.editify.app` in Certificates, Identifiers & Profiles with these capabilities: Sign in with Apple, Associated Domains (only if universal links are wanted). Decide now whether to keep this bundle id for the eventual company account; transferring an app between accounts keeps the bundle id, so it is fine to keep it.
- [ ] Create the app record in App Store Connect: name "Editify" (check availability, it may be taken and require a different display name), primary language, bundle id, SKU.
- [ ] Let EAS manage signing: `eas credentials -p ios` or the first `eas build` will create the distribution certificate and App Store provisioning profile. Store the credentials on EAS so they survive the account move.
- [ ] Add an App Store Connect API key with App Manager role and wire it to `eas submit` (`eas.json` `submit.production` is currently empty).

## 2. App binary requirements (App Review will reject without these)

- [ ] **App icon**: add a 1024x1024 PNG with no alpha and reference it as `expo.icon` in `app.json`. Missing icon is a hard upload failure.
- [ ] **Splash screen**: add `expo-splash-screen` config (image, dark background matching the app's dark theme). Without it the launch screen is blank white for a dark app.
- [ ] **Build number**: `eas.json` production already has `autoIncrement: true` with `appVersionSource: remote`, which is enough. Set `expo.version` to the marketing version you want testers to see.
- [ ] **Sign in with Apple** (Guideline 4.8): required because the app offers Google sign-in. Add `expo-apple-authentication`, enable the capability on the App ID, enable the Apple provider in Supabase Auth, and call `supabase.auth.signInWithIdToken({ provider: 'apple' })`. Update `apps/mobile/README.md`, which currently says Apple sign-in is not wired up.
- [ ] **Account deletion** (Guideline 5.1.1(v)): any app with account creation must let the user delete the account in-app. Add a "Delete account" action behind confirmation that calls a new `DELETE /me` endpoint. The server must delete the Supabase user (service role key, server side only), the user's projects, assets and files on the volume, renders, chat history, transcripts, style profiles, and reports.
- [ ] **Privacy policy URL**: required in App Store Connect for TestFlight beta review. Host a page (the Expo web build or a static page on the Fly app works) that covers: account data held by Supabase, uploaded video and audio stored on the server, transcription, prompts sent to Anthropic or OpenAI, crash and feedback reports, retention, and how to delete.
- [ ] **Support URL and contact email** on the App Store Connect record.
- [ ] **Permission strings**: photo library and microphone are covered. Audit whether the app touches anything else that needs a usage description (camera, saving renders to the photo library requires `NSPhotoLibraryAddUsageDescription`). Apple rejects for any missing key at upload time.
- [ ] **Privacy manifest**: Expo SDK 54 bundles `PrivacyInfo.xcprivacy` for its own modules. Confirm `@react-native-google-signin/google-signin`, `@supabase/supabase-js`, and `@react-native-async-storage/async-storage` are on versions that ship manifests, or add required-reason API declarations in `app.json` under `ios.privacyManifests`.
- [ ] **App Privacy nutrition labels** in App Store Connect. Based on the code: Contact Info (email), User Content (photos/videos, audio, other user content), Identifiers (user ID), Diagnostics (crash data), Usage Data (product interaction from the telemetry event log). Mark all as linked to the user and not used for tracking. This must match what the app really does or reviewers reject.
- [ ] **Encryption**: `ITSAppUsesNonExemptEncryption: false` is set, so no export compliance prompt on each build.
- [ ] **Google sign-in on a release build**: confirm the iOS OAuth client, the reversed URL scheme in `app.json`, and the Supabase Google provider client ID list all reference the bundle id that ships. A TestFlight build is signed with the App Store profile, not the dev profile, but Google iOS clients key off the bundle id only, so this should carry over.

## 3. Behaviour reviewers check on the device

- [ ] The app must launch and be usable with a fresh account. Provide a demo account (email and password) in the review notes, or make sign-up work without email confirmation. Right now sign-up sends a Supabase confirmation email; either turn confirmation off for the review window or give the reviewer a pre-confirmed login.
- [ ] Every screen must handle no network and server errors without hanging. The error reporter modal exists; check the sign-in screen and project list when `EXPO_PUBLIC_API_URL` is unreachable.
- [ ] No placeholder content, no "coming soon" buttons, no debug UI. Hide the provider chip's `claude-cli` and `codex-cli` options in production builds or remove the chip; reviewers flag developer-facing controls.
- [ ] iPad: `supportsTablet: true` means the reviewer may test on an iPad. Either verify the layout at iPad sizes and both orientations (`orientation` is `default`) or set `supportsTablet: false` and lock to portrait for this round.
- [ ] Deep links: `scheme: editify` exists. Make sure opening the app from a link does not crash on an unknown route.
- [ ] Media import must work from the Files app and Photos on device. Test large videos (several hundred MB) against the upload path and the Fly machine's memory.
- [ ] Rendering: a render that takes minutes must not look frozen. Confirm the status polling survives backgrounding the app.
- [ ] Nothing in the app mentions Android, web, or other platforms in a way that implies missing iOS features.

## 4. Data scope and multi-tenancy (must fix before strangers share the backend)

- [ ] **Stop leaking null-owner rows.** Change the `OR user_id IS NULL` fallback in `project-store.ts`, `asset-store.ts`, `render-store.ts` so a signed-in user sees only their own rows. Migrate or delete the existing unowned rows on the Fly volume first.
- [ ] **Remove or restrict the shared token** (`EDITIFY_TOKEN`) on the production server. With it set, anyone holding it bypasses per-user scoping. Keep it off in the deployed env or scope it to admin-only routes.
- [ ] **Scope the agent provider setting** per user, or make it server-only configuration. `PUT /agent/provider` currently lets any user change the provider for all users and can switch to CLI providers that run processes on the server.
- [ ] **Media URL auth**: proxies and renders are fetched with `?k=<jwt>`. Check that these URLs are never written into anything shareable (chat history, GitHub issues, logs) since they carry a bearer token.
- [ ] **Telemetry to GitHub**: crash and feedback reports become public issues on the repo with the user's message text. Either make the repo private, stop filing issues in production, or strip user text and store it only in the reports table. Disclose whatever remains in the privacy policy.
- [ ] **Style profile and transcript stores**: confirm they are keyed by asset or project and inherit the owner check, rather than being globally readable.
- [ ] **Storage limits**: add per-user caps on upload size and total storage, and a retention job for renders and originals. One Fly volume with no quota is easy to fill.
- [ ] **Rate limits** on chat, render, and upload endpoints so one tester cannot exhaust the LLM budget or the machine.
- [ ] **Secrets audit**: rotate anything that has been committed or logged. The Supabase publishable key in `supabase.ts` is safe to ship; the service role key and provider API keys must exist only in Fly secrets.
- [ ] Set Supabase Auth: site URL and redirect URLs to production values, password minimum, and enable leaked-password protection.

## 5. Backend readiness for external testers

- [ ] Single Fly machine with `auto_stop_machines = false` is fine for a small beta. Confirm memory headroom for concurrent renders plus Whisper, or move renders to a worker.
- [ ] Take a volume snapshot before opening the beta and set a snapshot schedule.
- [ ] Health check and alerting on `/health` so an outage is noticed before testers report it.
- [ ] Confirm `PUBLIC_BASE_URL` and CORS are correct for the production API host that `eas.json` bakes in.
- [ ] Decide which LLM provider production runs with and fund it; the mock provider should not be what testers get.

## 6. App Store Connect and TestFlight setup

- [ ] Fill in the TestFlight "Test Information": beta app description, feedback email, what to test.
- [ ] Add a screenshot set is not required for TestFlight, but the App Privacy section and Privacy Policy URL are.
- [ ] Review notes: demo login, note that video upload and rendering hit a live server, and that AI editing calls a third-party model API.
- [ ] Age rating questionnaire (user-generated content with no moderation may push the rating up; an in-app way to report content and block users is required for UGC apps under Guideline 1.2 if projects are ever shared between users. Today projects are private per user, so state that in the notes).
- [ ] Create an external tester group and a public TestFlight link, or collect tester emails.

## 7. Build and submit

```bash
# one-time
npm install
cd apps/mobile
eas login
eas build:configure

# build for the store profile and upload
eas build --platform ios --profile production
eas submit --platform ios --latest
```

- [ ] First build: fix any missing usage description or icon errors reported by App Store Connect processing.
- [ ] Internal testing first (up to 100 App Store Connect users, no review) to shake out signing and API URL problems.
- [ ] Submit the build for external testing; beta review usually clears in one to two days.
- [ ] Set up `eas update` channels so JS-only fixes can go out to testers without a new review (already configured in `app.json` with the fingerprint runtime policy).

## 8. Suggested order

1. Data scope fixes and shared-token removal (section 4), then a volume snapshot.
2. Sign in with Apple and account deletion (section 2), because they change auth and need Supabase changes.
3. Icon, splash, privacy policy page, support page.
4. Hide developer controls, iPad decision, on-device testing of import and render.
5. App Store Connect record, privacy labels, review notes.
6. Internal build, then external submission.

## 9. Moving to a company Apple account later

- Transfer the app in App Store Connect once the company account exists; the bundle id, TestFlight history, and reviews move with it. Apps using Sign in with Apple can be transferred, but the Apple user identifiers change teams, so plan a migration window where the server accepts both the old and new transfer identifiers.
- Regenerate signing credentials under the new team with `eas credentials` and update `expo.owner` if the EAS account changes too.
- Google OAuth clients are tied to the bundle id, not the Apple team, so they carry over.
