# iOS App Store launch plan (Shipaton 2026)

Goal: Editify live on the iOS App Store before the Shipaton deadline,
September 30, 2026, 11:45 pm PDT, with a RevenueCat-powered purchase.

Decisions already made:

- **iOS App Store only.** Google Play personal accounts need a 14-day closed
  test with 12 testers before production, which cannot finish in time. The Mac
  App Store uses the same Apple account and review, and Expo has no macOS
  target. A web deploy does not qualify.
- **Ship under David's personal Apple Developer account.** The seller name will
  be his legal name; an individual account cannot alias it. Transfer the app to
  a company account after the hackathon (section 10).
- **RevenueCat gates renders.** One auto-renewing subscription unlocks
  full-resolution export. Everything else stays free so reviewers can exercise
  the editor without paying.
- **Buy a domain now.** Privacy, support, and deletion pages plus the API
  hostname all hang off it.

Status legend: `[ ]` todo, `[~]` in progress, `[x]` done.

## Timeline (17 days from September 13)

| Days | Dates | Work |
| --- | --- | --- |
| 1 to 4 | Sep 13 to 16 | Sections 2, 3, 4, 5: data scope, auth, RevenueCat, assets, web pages |
| 5 to 6 | Sep 17 to 18 | Sections 6, 7: App Store Connect record, IAP product, internal TestFlight on device |
| 7 | Sep 19 | Section 8: submit for review. Hard target Sep 20 |
| 8 to 14 | Sep 20 to 26 | Fix rejections, resubmit. Budget two review rounds |
| 15 to 17 | Sep 27 to 30 | Release, Devpost submission with demo video. Anything still in review on Sep 27 is at risk |

Store review takes one to three days per round. First submissions with in-app
purchases are rejected often, usually for the paywall, missing terms, or the
purchase not restoring. The IAP product is reviewed with the binary and must be
attached to the version.

## 0. What exists today (findings from the code)

- Expo SDK 54, EAS project configured (`apps/mobile/app.json`, `apps/mobile/eas.json`), bundle id `com.editify.app`, owner `dfordavey`.
- Sign-in is Supabase email/password plus Google (`apps/mobile/app/sign-in.tsx`). No Sign in with Apple.
- Sign-out exists (`apps/mobile/app/index.tsx`). No account deletion.
- `app.json` has no `icon` and no `splash`. No image assets exist in `apps/mobile`.
- Photo library and microphone usage strings come from the `expo-image-picker` and `expo-audio` plugins. `ITSAppUsesNonExemptEncryption` is `false`.
- Backend is one Fly machine (`fly.toml`), SQLite and media on one volume, Supabase JWTs verified in `server/src/auth.ts`.
- Every store falls back to `user_id = ? OR user_id IS NULL`, so unowned rows are visible to every signed-in user (`server/src/db/project-store.ts`, `asset-store.ts`, `render-store.ts`).
- `PUT /agent/provider` is global with no per-user scope (`server/src/routes/agent.ts`). The provider chip exposes `claude-cli` and `codex-cli`.
- Crash and feedback reports can become public GitHub issues with user text (`server/src/services/telemetry-service.ts`).
- Render is `POST /projects/:id/render` in `server/src/routes/projects.ts`, the natural place for the entitlement check.
- No purchase code anywhere yet.

## 1. Accounts and identifiers (day 1, mostly waiting)

- [ ] Apple Developer Program active on David's account; Agreements, Tax, and Banking shows the **Paid Applications** agreement accepted. Paid agreement needs bank and tax forms and can take a day or two to activate. Without it the subscription cannot be created. Start this first.
- [ ] Register App ID `com.editify.app` with Sign in with Apple and In-App Purchase capabilities.
- [ ] Create the app record in App Store Connect. Check the name "Editify" is available; have a fallback like "Editify Video" ready.
- [ ] Create an App Store Connect API key (App Manager) and put it in EAS for `eas submit`. `eas.json` `submit.production` is empty today.
- [ ] Let EAS create the distribution cert and App Store profile on first build; keep credentials on EAS so they survive the transfer.
- [ ] Create the RevenueCat project, add the iOS app with the bundle id, and generate the App Store Connect In-App Purchase key plus the shared secret for RevenueCat.
- [ ] Buy the domain (check `editify.app` and `editify.com`, WHOIS privacy on). Register it somewhere transferable to the company later.

## 2. Data scope and multi-tenancy (days 1 to 2, must land before strangers use the backend)

- [ ] Remove the `OR user_id IS NULL` fallback in `project-store.ts`, `asset-store.ts`, `render-store.ts` so a signed-in user sees only their rows. Migrate or delete unowned rows on the Fly volume first. Snapshot the volume before.
- [ ] Unset `EDITIFY_TOKEN` in production or restrict it to admin routes. With it set, the holder bypasses all scoping.
- [ ] Make the agent provider server-side config only. Remove the provider chip from production builds and the `PUT /agent/provider` route, or gate it behind an admin check.
- [ ] Confirm style profiles, transcripts, chat history, and reports inherit the owner check through project or asset lookups.
- [ ] Media URLs carry `?k=<jwt>`. Make sure they never land in chat history, GitHub issues, or logs.
- [ ] Telemetry: stop filing public GitHub issues from production, or make the repo private. Keep reports in the `reports` table.
- [ ] Per-user upload size limit, total storage cap, and a retention job for originals and renders.
- [ ] Rate limits on `/chat`, `/render`, and `/assets` so one user cannot drain the LLM budget or the machine.
- [ ] Rotate any secret that was ever committed or logged. Provider keys and the Supabase service role key live only in Fly secrets.
- [ ] Supabase Auth: production site URL and redirect list, leaked-password protection on, and decide whether email confirmation stays on (see review notes in section 7).

## 3. Auth changes Apple requires (day 2)

- [ ] **Sign in with Apple** (Guideline 4.8, required because Google sign-in is offered). Add `expo-apple-authentication`, enable the Apple provider in Supabase with the Services ID, and call `supabase.auth.signInWithIdToken({ provider: 'apple', token, nonce })`. Show it above Google, with Apple's button style. Update `apps/mobile/README.md`, which says Apple sign-in is not wired up.
- [ ] Store the Apple `sub` on the user record so the transfer-time identifier migration (section 10) is possible.
- [ ] **Account deletion** (Guideline 5.1.1(v)). Add a "Delete account" action behind a confirmation, calling a new `DELETE /me`. The server, using the Supabase service role key, deletes the auth user and every owned project, asset file, proxy, thumbnail, render, chat row, transcript, style profile, and report. Also cancel nothing on the RevenueCat side; subscriptions are managed by Apple, but call RevenueCat's delete-customer endpoint so no orphan customer remains.
- [ ] Sign-out already exists; make sure it also logs out of RevenueCat (`Purchases.logOut()`).

## 4. RevenueCat and the paywall (days 2 to 3)

- [ ] Add `react-native-purchases` and `react-native-purchases-ui`. Both need a native build; the dev client and EAS builds already cover that.
- [ ] Configure `Purchases.configure({ apiKey })` at app start with the RevenueCat iOS public key, then `Purchases.logIn(supabaseUserId)` after sign-in so the RevenueCat app user id equals the Supabase user id.
- [ ] In App Store Connect create one subscription group "Editify Pro" with one auto-renewable product, for example `editify_pro_monthly`. Fill in the localized display name, description, price, and review screenshot. Attach it to the app version before submitting; an unattached product is a common rejection.
- [ ] In RevenueCat create the entitlement `pro`, the offering `default`, and the package pointing at the product. Build the paywall in the RevenueCat dashboard so `RevenueCatUI.presentPaywall()` shows it with no custom UI.
- [ ] Client: before `POST /projects/:id/render` at full resolution, check `customerInfo.entitlements.active.pro`. If missing, present the paywall, then retry.
- [ ] Server: verify the entitlement rather than trusting the client. Either call RevenueCat's REST API `GET /subscribers/{app_user_id}` from the render route, or accept a RevenueCat webhook that writes an `entitlements` table keyed by user id. The webhook is cheaper per render and survives RevenueCat outages.
- [ ] Free tier still renders at 540p proxy quality so reviewers see the export flow without buying.
- [ ] **Restore purchases** button on the paywall and in settings. Apple rejects subscriptions without it.
- [ ] Paywall must show price, billing period, that it auto-renews, and links to Terms of Use and Privacy Policy (Guideline 3.1.2). RevenueCat's paywall templates include these slots; fill them with the real URLs.
- [ ] Add the Terms of Use (EULA) link in the App Store Connect description or use Apple's standard EULA.
- [ ] Test the full flow in the Sandbox with a sandbox Apple ID: purchase, restore, cancel, and the render gate. StoreKit testing in Xcode is not enough; RevenueCat needs a real sandbox receipt.

## 5. Binary requirements (day 3)

- [ ] **Icon**: 1024x1024 PNG, no alpha, referenced as `expo.icon`. Upload fails without it.
- [ ] **Splash**: `expo-splash-screen` config with a dark background matching the theme.
- [ ] `expo.version` set to `1.0.0`; `eas.json` production already has `autoIncrement: true` with `appVersionSource: remote`.
- [ ] Permission strings: photos and microphone are covered. Add `NSPhotoLibraryAddUsageDescription` if renders get saved to Photos, and a camera string if the picker ever opens the camera.
- [ ] Privacy manifests: Expo 54 ships them for its own modules. Check `@react-native-google-signin/google-signin`, `@supabase/supabase-js`, `@react-native-async-storage/async-storage`, and `react-native-purchases` versions, or declare required-reason APIs under `ios.privacyManifests` in `app.json`.
- [ ] iPad: either verify layouts at iPad sizes in both orientations, or set `supportsTablet: false` and lock to portrait for 1.0. Recommended: portrait, iPhone only, for this round.
- [ ] Remove developer-facing controls (provider chip) from release builds. No placeholder or "coming soon" UI.
- [ ] Every screen handles no network and 5xx without hanging. Check sign-in and the project list with the API unreachable.
- [ ] Deep links: `scheme: editify` must not crash on unknown routes.
- [ ] Large upload test on device (several hundred MB) against the Fly machine's memory.
- [ ] Render status polling survives backgrounding.
- [ ] Point `EXPO_PUBLIC_API_URL` in `eas.json` and `PUBLIC_BASE_URL` in `fly.toml` at `api.<domain>` once DNS is up (`fly certs add api.<domain>`).

## 6. Web pages on the domain (day 3, half a day)

Serve from the Fly app or Cloudflare Pages. Four static pages:

- [ ] `/` landing page with App Store badge (link added once live).
- [ ] `/privacy`: account data in Supabase, uploaded video and audio stored on the server, local transcription, prompts and transcripts sent to the model provider, purchase data via RevenueCat and Apple, crash and feedback reports, retention, deletion.
- [ ] `/terms`: subscription terms, auto-renewal, cancellation through Apple, content ownership.
- [ ] `/support`: contact email plus the account deletion instructions (Apple wants this reachable from the listing too).
- [ ] Update Supabase site URL, redirect URLs, and the Google OAuth consent screen's authorized domain.

## 7. App Store Connect record (days 5 to 6)

- [ ] Metadata: name, subtitle, description, keywords, category (Photo & Video), age rating questionnaire. Projects are private per user, so answer no to user-generated content sharing.
- [ ] Screenshots: 6.7" and 6.5" iPhone sets are required (6.9" if targeting the newest devices). iPad set only if `supportsTablet` stays true. Capture from the simulator via `xcrun simctl io booted screenshot`.
- [ ] Privacy Policy URL, Support URL, marketing URL.
- [ ] App Privacy labels: Contact Info (email), User Content (photos or videos, audio, other), Identifiers (user ID), Purchases, Diagnostics (crash data), Usage Data (product interaction). All linked to the user, none used for tracking.
- [ ] Attach the subscription to the version. Fill the subscription's review screenshot and notes.
- [ ] **Review notes**: a demo account with a confirmed email and password, a note that the app uploads video to a live server and calls a third-party model API, where the paywall is and that sandbox purchases work, and that the free tier renders at proxy quality. If email confirmation stays on, the reviewer cannot self-register, so the demo account is mandatory.
- [ ] Pricing: free app with in-app subscription. Availability: all territories or US only for 1.0.
- [ ] Version release: manual release, so the store goes live on your command once approved.

## 8. Build and submit (day 7, target September 19, no later than September 20)

```bash
npm install
cd apps/mobile
eas login
eas build --platform ios --profile production
eas submit --platform ios --latest
```

- [ ] First build: fix any processing errors from App Store Connect (icon, usage strings, manifests).
- [ ] Internal TestFlight on a real device with the production API and a sandbox purchase before submitting.
- [ ] Submit for review with the IAP attached.
- [ ] On rejection: read the resolution center message, fix the specific item, reply in the resolution center, resubmit the same day. Apple often re-reviews within 24 hours after a reply.
- [ ] After approval: release manually, confirm the listing is live, then update the landing page badge.
- [ ] `eas update` is configured with the fingerprint runtime policy, so JS-only fixes after release go out without review.

## 9. Shipaton submission (by September 30)

- [ ] Devpost entry: App Store link, RevenueCat project confirmed, demo video, description, category picks.
- [ ] Confirm on the Devpost rules page that the app's first public release date falls inside August 1 to September 30. Keep the web deploy labeled as a demo, not a launch.
- [ ] Optional: the HackerNoon writing contest entry.

## 10. Transfer to the company account later

- App transfer in App Store Connect keeps the bundle id, ratings, reviews, and TestFlight history. Usually completes in a day.
- Sign in with Apple identifiers change teams. Apple gives a 60-day window and a migration API; storing the Apple `sub` (section 3) makes the re-key possible.
- Certificates and profiles do not transfer; `eas credentials` regenerates them under the new team. Update `expo.owner` if the EAS account changes.
- Google OAuth clients key off the bundle id and carry over. Supabase needs no change.
- RevenueCat: update the App Store Connect API key and shared secret for the new team in the RevenueCat app settings. Subscribers and entitlements are keyed by app user id and are unaffected.
- Transfer is blocked while the app has an in-app purchase pending review, so do it between releases.
- Move the domain to a company-owned registrar account at the same time.
