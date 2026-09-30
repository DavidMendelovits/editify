# Editify: App Store Connect submission pack

Everything needed to fill in App Store Connect for Editify 1.0.0, in the order the forms ask for it. Every claim about the app is traceable to code in this repo; file references are given where it matters. Anything unresolved is marked **VERIFY:** with the exact question.

**App Store Connect record:** app id `6814607865`, SKU `EDITIFY001`, primary locale `en-US`, app record name **`Editify - AI Video editor`** (this is the live name; the pack's earlier recommendation of `Editify: AI Video Editor` was not applied, see section 1.1). The iOS version record is `d3bb2e21-e253-4fe6-877b-f1b95eee544d`, state `PREPARE_FOR_SUBMISSION`. Its version string was created as `1.0` and has been corrected to **`1.0.0`** to match `apps/mobile/app.json`; App Store Connect requires the listing's version string to equal the uploaded build's `CFBundleShortVersionString`.

Build facts this pack assumes (from `apps/mobile/app.json`, `apps/mobile/eas.json`):

- Bundle id `com.editify.app`, version `1.0.0`, build number from EAS (`appVersionSource: remote`)
- `ios.supportsTablet: true`, orientation `default` (portrait and landscape)
- `ITSAppUsesNonExemptEncryption: false` already set, so the export-compliance question is answered by the build
- Apple Team `F9R8TK7W79`, EAS project `901bf170-2dbf-4ff7-ae24-68218ac5d18c`
- Permissions requested: photo library (import clips) and microphone (voiceover). Camera is explicitly disabled.
- OTA JavaScript updates via `expo-updates` against `https://u.expo.dev/901bf170-...`
- **In-app purchases: yes.** Two auto-renewing monthly subscriptions via RevenueCat/StoreKit (`react-native-purchases` 10.10.1 -> native `RevenueCat` 5.90.1). See sections 7 and 8.
- **Third-party analytics: yes.** PostHog (`posthog-react-native` 4.75.0, JavaScript only). See section 2.
- `contentRightsDeclaration` on the app record is `null` — confirmed against the App Store Connect API for app `6814607865` — and must be answered before submission (section 6).

---

## 0. The one thing that will get this rejected

The App Privacy answers in section 2 must say that **user video and audio content is collected**. Editify uploads the full original file the user picks to `https://editify-dm.fly.dev` (`apps/mobile/src/lib/pick.ts` -> `uploadAsset` in `apps/mobile/src/lib/api.ts` -> `POST /assets` in `server/src/routes/assets.ts`, which streams the part straight to `assetsRoot/<id>/original.<ext>`). Originals do **not** stay on the device. The "devices keep original footage local and upload proxies first" line in `SPEC-WAVE3.md` §D is a stated future direction, not shipped behaviour.

The second thing: the app sends a session event log to the server automatically about once a minute, with no prompt and no opt-out (`apps/mobile/src/lib/telemetry.ts`, `FLUSH_INTERVAL = 60_000`). That is collected usage and diagnostic data and must be disclosed.

**The third thing, and it now outranks both: this release ships with in-app subscriptions.** That changes the submission in three ways that have nothing to do with copy.

1. **Nothing can be released until Maja Ventures SL completes the Paid Applications Agreement**, with banking and tax details, and Apple verifies them. That is days to weeks, outside our control, and it is the long pole for the whole launch. Start it before anything else. Section 8.1.
2. **The paywall does not yet satisfy guideline 3.1.2.** There is no privacy policy link and no terms-of-use link anywhere in the app, and no feature is actually gated behind a subscription, so a reviewer who pays gets nothing. Section 7 lists every gap with a file and line.
3. **The App Privacy answers in section 2 were written for an app with no analytics SDK and no purchases.** They have been rewritten. Purchase History and Device ID both flip from No to Yes.

A fourth, smaller: **TestFlight builds 1 and 2 predate both integrations**, so neither can be the submitted build. This was verified, not inferred: `strings` over build 2's downloaded IPA finds **zero** occurrences of `RevenueCat` or `RCPurchases` in the app binary, and zero occurrences of `posthog` in `main.jsbundle`. `react-native-purchases` is native code that no OTA update can deliver, so a fresh production build is required.

---

## 1. Listing copy

**Status (set in App Store Connect via the API, and read back to confirm):** subtitle, promotional text, description, keywords, primary and secondary category are all live on app `6814607865`. App name was left as-is. What's New is not settable on a first version. Support / marketing / privacy URLs are still blank. Per-field notes below.

### 1.1 App name (limit 30)

```text
Editify: AI Video Editor
```

24 characters. Alternate if you want the name alone: `Editify` (7).

**Not applied.** The live App Store Connect name is **`Editify - AI Video editor`** (25 characters), chosen by David. Nothing here renames it. Keep this in mind when editing the keyword field, which depends on whether the name carries the category signal (section 1.5).

### 1.2 Subtitle (limit 30)

```text
Cut, caption, export by chat
```

28 characters.

**Set.** `appInfoLocalizations` (en-US) `subtitle` now reads exactly `Cut, caption, export by chat`.

### 1.3 Promotional text (limit 170)

Editable without a new build, so keep it for what is new or seasonal.

```text
Import a clip, describe the edit, watch every cut happen on a real timeline. Transcript trimming, word-timed captions, voiceover and 4K export. First release.
```

158 characters.

**Set.** Stored verbatim on the 1.0.0 `appStoreVersionLocalizations` (en-US) record.

### 1.4 Description (limit 4000)

Every feature below was checked against code. Do not add to it without doing the same.

```text
Editify is a video editor you can talk to.

Start a project in 9:16 or 16:9, import clips from your photo library or from Files, and build the cut on a real timeline: drag clips, trim the edges, split at the playhead, change speed and volume, close the gaps. Everything the timeline can do, the assistant can do too, because both drive the same editor.

TELL IT WHAT YOU WANT
Type the edit in plain language. Trim the dead air. Cut this to thirty seconds. Caption the whole thing. Every step the assistant takes is listed as it runs, with the result of each one, so you can see what it actually did instead of guessing. Undo, redo, or revert an entire turn.

EDIT BY TRANSCRIPT
Editify transcribes the speech in your clips, then lets you cut by words instead of by frames. Pull out filler words. Strip the silences, with an option that protects laughs and reactions instead of flattening them. Generate captions timed to the words that were actually said.

CAPTIONS THAT LOOK RIGHT
Word-level highlighting on the spoken word. Control size, vertical position, colour, outline, uppercase and emphasis colour. Captions are burned into the render, so they survive wherever you post.

SOUNDS, STICKERS, VOICEOVER
A built-in sound library: whooshes, impacts, pops, clicks, risers, tape stops and two music beds. Emoji stickers, imported image stickers, and check and cross callout cards, dropped at the playhead and dragged into place on the preview. Record a voiceover straight onto the timeline, with the music ducked underneath it.

LOOK AND PACING
Punch-ins, slow pushes and pull-backs per clip. Crossfade and dip-to-black transitions. Style packets that apply a whole look, captions, music, transitions, zoom cadence and pacing, in one move.

LEARN MY STYLE
Point Editify at a handful of videos you already made. It measures cut density, average shot length, loudness and format across them, folds that into one template, and writes a short style brief that every later edit conversation is given. The style screen tells you exactly which analyser is running and whether it uploads your footage anywhere.

EXPORT
Render a 720p, 1080p or 4K master. Keep HDR at 10-bit, or convert to SDR to match the preview exactly.

WHAT YOU SHOULD KNOW
Editify needs an account and an internet connection. Your projects, your imported clips, your transcripts and your renders are stored on the Editify server, not only on your phone. You can delete everything, including your account, from the home screen in one step.
```

2502 characters. Re-run the counter in section 9 after any edit.

**Set.** Stored verbatim on the 1.0.0 `appStoreVersionLocalizations` (en-US) record; read back at 2502 characters.

### 1.5 Keywords (limit 100, comma separated, no spaces after commas)

Words already in the app name and subtitle are indexed from there, so they are not repeated here.

```text
subtitles,transcript,reels,shorts,tiktok,timeline,trim,voiceover,silence,4k,vlog,podcast,filler
```

95 characters. Apple counts the commas, and there are no spaces after them.

If you drop the app name to plain `Editify`, replace `filler` with `video,editor` (99 characters), because the field is then carrying the whole category signal on its own.

**Set, using the `filler` variant above (95 characters).** The live name `Editify - AI Video editor` already contains "AI", "Video" and "editor", so those terms are indexed from the name and the `video,editor` swap would spend 12 characters repeating them. The swap only applies if the name is ever shortened to plain `Editify`.

### 1.6 What's New in this version (1.0.0)

```text
First release.

Editify is a video editor with an assistant that drives the same timeline you do. Import clips, cut by transcript, caption to the word, add sounds, stickers and voiceover, then render up to 4K.

Tell us what breaks: there is a "send feedback" button on the home screen and in the editor.
```

**Not set: the field does not exist yet.** The API rejects any write to `whatsNew` on this version with `409 STATE_ERROR — Attribute 'whatsNew' cannot be edited at this time`. "What's New in This Version" only opens up on an update to an already-released app, so 1.0.0 has no such field. Keep this copy here and use it for 1.0.1.

### 1.7 Support URL and Marketing URL

- **Support URL is mandatory.** App Store Connect will not let you submit without one, and it must resolve to a real page with a way to contact you. A GitHub Pages page with a contact email and a short FAQ satisfies this.
- **Marketing URL is optional.** Leave it blank for 1.0.0 rather than pointing it at a placeholder.

**Still `null` in App Store Connect, but the pages now exist.** `supportUrl`, `marketingUrl` (on the version localization) and `privacyPolicyUrl` (on the app info localization) all read `null` today. The three pages are served by our own API (section 3), so the values to paste are:

```text
Privacy Policy URL:  https://editify-dm.fly.dev/privacy
Terms of Use (EULA): https://editify-dm.fly.dev/terms
Support URL:         https://editify-dm.fly.dev/support
```

They are live only after the next deploy, and the deploy waits on the fill tokens in section 3. Marketing URL stays blank for 1.0.0.

### 1.8 Categories

| | Category | Why |
|---|---|---|
| Primary | **Photo & Video** | The app is a video editor. This is where competitors rank and where the buying intent is. |
| Secondary | **Productivity** | Defensible: the product is a tool for producing a deliverable, and the assistant framing reads as productivity. |

**Set.** `appInfos` primary category is `PHOTO_AND_VIDEO`, secondary is `PRODUCTIVITY`, confirmed by reading the relationships back.

Graphics & Design is the other plausible secondary, but it skews toward static design tools and would put Editify next to illustration apps. Productivity is the better second net.

### 1.9 Age rating questionnaire

**Not answered, deliberately.** The `ageRatingDeclaration` on app info `b13395d6-a514-4ab4-909f-1eea62ca25b5` is untouched and `appStoreAgeRating` is still `null`. The two VERIFY items below need a human reading the live form.

Apple replaced the old questionnaire in 2025 with a set of yes/no questions plus a separate set about in-app capabilities. Answers for Editify:

| Question | Answer | Basis |
|---|---|---|
| Violent content (cartoon, fantasy, realistic) | None | No app-authored content of any kind |
| Sexual content or nudity | None | |
| Profanity or crude humour | None | The app ships no text content beyond interface copy |
| Alcohol, tobacco, drug use or references | None | |
| Horror or fear themes | None | |
| Medical or treatment information | None | |
| Gambling, contests, simulated gambling | No | |
| Unrestricted web access | **No** | The app has no in-app browser. The one outbound link is `Linking.openURL` on a finished render, which opens that file in Safari (`apps/mobile/app/project/[id]/export.tsx`). |
| **User-generated content** | **No** | Users create content, but no user can see another user's content. Every row is scoped to the Supabase user id (`server/src/db/*-store.ts`, `request.userId` in `server/src/auth.ts`), there is no feed, no sharing, no comments and no profiles. Apple's question is about content visible to other users. |
| **In-app chat / messaging between users** | **No** | The only chat is with the editing assistant. |
| **In-app purchases** | **Yes** (changed) | Two auto-renewing monthly subscriptions, `react-native-purchases` in `apps/mobile/package.json`, paywall at `apps/mobile/app/paywall.tsx`. Answering No here is a false declaration. |
| Ads | **No** | No ad SDK anywhere in `apps/mobile/package.json`. |
| Tracking / advertising identifiers | **No** (unchanged, but for new reasons) | No IDFA is read and no ATT prompt is shown. PostHog ships no native module and has no IDFA API; RevenueCat's IDFA path is never called and AdSupport is not linked. Full evidence in section 2.9. |

**Expected rating: 4+.** In-app purchases do not raise the rating by themselves; they change the product's commercial declarations, not its content.

Two things to watch:

- **VERIFY:** Apple's current questionnaire has a question about apps whose core feature is a chatbot or generative AI. Editify's assistant is an AI chat interface that returns free text written by Anthropic's model (the provider configured on the production server). Read that question in the live form and answer it honestly; a yes there can push the rating to 12+ or 13+. Do not guess from this table.
- **VERIFY:** if the answer to the UGC question is read more broadly (the app does let a user put arbitrary imported footage and typed caption text on screen), the safe answer is still No, because nothing is published or shared. Confirm against the question's own help text in the form.

---

## 2. App Privacy ("nutrition label")

**Not entered in App Store Connect.** No data-collection declaration has been submitted; this section is still a plan, not a record of what is filled in.

**Rewritten for the 1.0.0 that ships with subscriptions and analytics.** An earlier version of this pack claimed Editify had "no third-party analytics, crash-reporting or advertising SDK" and "no in-app purchases". Both statements are now false and every table below has been re-derived from the code and from the SDKs' own privacy manifests. Two third-party SDKs are in the binary:

| SDK | Version | Native code? | Evidence |
|---|---|---|---|
| **PostHog** (`posthog-react-native`) | 4.75.0 | **No.** Pure JavaScript. There is no PostHog pod in `apps/mobile/ios/Podfile.lock`, so it ships no native module and no privacy manifest of its own | `apps/mobile/package.json`, `apps/mobile/src/lib/posthog.ts:1` |
| **RevenueCat** (`react-native-purchases`) | 10.10.1, wrapping native `RevenueCat` 5.90.1 and `PurchasesHybridCommon` 19.2.0 | **Yes** | `apps/mobile/ios/Podfile.lock` |

Over-declaring is safe; under-declaring is a rejection. Where the code left a question open, the table below takes the conservative answer and says so.

### 2.0 What each SDK actually sends, established from the code

**PostHog.** The client is constructed in `apps/mobile/src/lib/posthog.ts:18-23` with exactly two options: `captureAppLifecycleEvents: true` and `debug: __DEV__`. It is mounted at `apps/mobile/src/providers/AppProviders.tsx:18` as `<PostHogProvider client={posthog}>` with **no `autocapture` prop passed**. It is gated on two environment variables (`posthog.ts:3-4`); with either unset, `posthog` is `undefined` and the provider is skipped entirely, so a build without them sends PostHog nothing.

**As configured today, that is every build.** Neither `EXPO_PUBLIC_POSTHOG_PROJECT_TOKEN` nor `EXPO_PUBLIC_POSTHOG_HOST` appears in any of the three profiles in `apps/mobile/eas.json`; `development`, `preview` and `production` each carry exactly `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` and `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` and nothing else. A TestFlight or App Store build made right now collects nothing through PostHog. The whole of section 2's PostHog analysis therefore describes the app **once those two variables are set** — which they must be before filing, see 2.11 item 7.

Three findings that matter for the label:

1. **Nothing in the app sends PostHog a custom event.** A grep across `apps/mobile/src` and `apps/mobile/app` finds no `posthog.capture(...)`, no `usePostHog()` and no `posthog.identify(...)`. The app's own `track(...)` — 18 call sites — is first-party telemetry that posts to our server (`apps/mobile/src/lib/event-log.ts`, `apps/mobile/src/lib/telemetry.ts`), not to PostHog. Whatever PostHog receives today is entirely SDK-automatic.
2. **PostHog is never handed the account id.** Because `identify()` is never called, PostHog's `distinct_id` stays the anonymous per-install UUID the SDK generates. That is a vendor-generated persistent identifier, not an OS one.
3. **The integration looks unfinished.** PostHog's own React Native documentation (vendored into this repo at `apps/mobile/.posthog/wizard-spellbook-R3HZaQ/skills/integration-react-native/references/react-native.md`) lists `expo-file-system`, `expo-device` and `expo-localization` as peer dependencies for Expo apps. **None of the three is in `apps/mobile/package.json`** (`expo-application` and `@react-native-async-storage/async-storage` are). Device model, OS locale and on-disk event persistence therefore may not be collected or may fall back to weaker paths. Declare as if they are collected anyway — if the missing packages are added later, the label does not have to change.

**RevenueCat.** Configured in `apps/mobile/src/lib/purchases.ts:50` as `Purchases.configure({ apiKey, appUserID: userId })`, where `userId` is the **Supabase account id** of the signed-in user, re-synced on every session change from `apps/mobile/app/_layout.tsx:49-52` (`logIn` at `purchases.ts:54`, `logOut` at `:57`). Purchases go through StoreKit via `Purchases.purchasePackage` (`purchases.ts:81`); entitlements `creator` and `studio` (Studio is not sold at launch) are read back from `CustomerInfo` (`purchases.ts:14`, `:24-26`). Keys come from `EXPO_PUBLIC_REVENUECAT_IOS_KEY` / `..._ANDROID_KEY` (`purchases.ts:16-19`); without them `billingAvailable` is `false` (`:22`) and the SDK is never configured.

RevenueCat ships its own Apple privacy manifest at `apps/mobile/ios/Pods/RevenueCat/Sources/PrivacyInfo.xcprivacy`, and it declares:

- `NSPrivacyTracking` = **false**
- one collected data type: **Purchase History**, `Linked` false, `Tracking` false, purpose **App Functionality**
- one accessed API category: `NSPrivacyAccessedAPICategoryUserDefaults`, reason `CA92.1`

We must declare Purchase History as **linked**, not as RevenueCat's manifest does, because we pass it the account id. The manifest describes the SDK in the general case; our configuration is the more revealing one, and Apple's label is about our app.

### 2.1 Contact Info

| Item | Collected | Linked to user | Used for tracking | Purposes |
|---|---|---|---|---|
| **Email Address** | Yes | Yes | No | App Functionality |
| **Name** | Yes | Yes | No | App Functionality |

Email: `supabase.auth.signUp` / `signInWithPassword` in `apps/mobile/app/sign-in.tsx`; Google sign-in returns it too. Name: only when the user chooses Google; Google's id token carries profile fields and Supabase stores them on the login record. Editify never reads or displays the name, but it is stored in our own Supabase project, so declare it. Unchanged by the subscription work: neither RevenueCat nor PostHog is given an email address anywhere in the code.

VERIFY: confirm in the Supabase dashboard which fields the Google provider actually persists into `auth.users.raw_user_meta_data` for this project (typically `name`, `picture`, `email`).

### 2.2 Identifiers

| Item | Collected | Linked to user | Used for tracking | Purposes |
|---|---|---|---|---|
| **User ID** | Yes | Yes | No | App Functionality, Analytics |
| **Device ID** | **Yes** (changed) | **Yes** | No | Analytics, App Functionality |

**User ID.** The Supabase `sub` claim, verified server-side in `server/src/auth.ts` and written to `projects.user_id`, `assets.user_id` and `reports.user_id`. It is also attached to diagnostic reports (`server/src/routes/telemetry.ts`). **It is now additionally sent to RevenueCat** as the RevenueCat app-user-id (`apps/mobile/src/lib/purchases.ts:50`, `:54`), which means a third party holds our account identifier alongside that account's purchase history.

**Device ID: this answer flips from No to Yes.** PostHog generates and persists an anonymous per-install identifier and sends it with every event as `distinct_id` / `$device_id`. Apple's definition of Device ID is broad — "any identifier that relates to the device", not only the IDFA — and a persistent vendor-generated install id is the textbook case for it. Tick it.

Linked: **yes, conservatively.** PostHog's own id is anonymous today (no `identify()` call anywhere). But the same person's account id reaches RevenueCat, and RevenueCat and PostHog are commonly joined later by exactly that key. Declaring Device ID as linked costs nothing and survives the day someone adds `posthog.identify(session.user.id)` without re-reading this document. Do not declare it unlinked on the strength of a missing line of code.

The first-party telemetry `sessionId` is still not a device identifier: it is regenerated from `Date.now()` plus randomness on every launch (`apps/mobile/src/lib/telemetry.ts:15`) and never persisted. It is not the reason this row changed; PostHog is.

### 2.3 Purchases

| Item | Collected | Linked to user | Used for tracking | Purposes |
|---|---|---|---|---|
| **Purchase History** | **Yes** (new) | **Yes** | No | App Functionality, Analytics |

Three independent reasons, any one of which would be enough:

- RevenueCat's own privacy manifest declares `NSPrivacyCollectedDataTypePurchaseHistory` (`apps/mobile/ios/Pods/RevenueCat/Sources/PrivacyInfo.xcprivacy`).
- We set the RevenueCat app-user-id to the Supabase account id (`purchases.ts:50`), so RevenueCat's copy of that purchase history is linked to an identified account. This is why our answer is "linked" where RevenueCat's manifest says it is not.
- Our own server receives it too: a completed purchase fires `track('subscribe', next)` at `apps/mobile/app/paywall.tsx:21`, which lands in the first-party event log that is flushed to `POST /telemetry` with `request.userId` attached.

App Functionality is the primary purpose (entitlements decide what the app unlocks). Analytics is listed as a second purpose because of the third bullet.

### 2.4 User Content

| Item | Collected | Linked to user | Used for tracking | Purposes |
|---|---|---|---|---|
| **Photos or Videos** | Yes | Yes | No | App Functionality |
| **Audio Data** | Yes | Yes | No | App Functionality |
| **Customer Support** | Yes | Yes | No | App Functionality, Analytics |
| **Other User Content** | Yes | Yes | No | App Functionality |

- Photos or Videos: full original files, uploaded on import. See section 0. Clips submitted to "learn my style" are additionally uploaded to Google's Gemini API, which is configured and active on the production server. That is third-party processing of user video, so it belongs in the policy (`docs/privacy-policy.md` sections 2 and 5) even though Apple's label has no separate item for it.
- Audio Data: voiceover recordings from the microphone (`apps/mobile/src/components/editor/VoiceSheet.tsx`), plus the audio track inside every imported video, plus speech transcripts derived from it by a local Whisper process on the server (`server/src/services/transcript-service.ts`).
- Customer Support: the free-text feedback the user types in the report sheet, sent to `POST /telemetry` and, when a GitHub token is configured, filed as an issue.
- Other User Content: project titles, caption text, sticker and callout text, clip labels, and the chat messages the user sends to the assistant.

Neither PostHog nor RevenueCat receives any of this. Nothing in the code passes media, transcripts or chat text to either SDK.

### 2.5 Usage Data

| Item | Collected | Linked to user | Used for tracking | Purposes |
|---|---|---|---|---|
| **Product Interaction** | Yes | Yes | No | Analytics, App Functionality |
| **Other Usage Data** | **Yes** (new) | Yes | No | Analytics |

**Product Interaction** now covers two separate pipelines:

1. *First-party*, unchanged: the event log flushed every 60 seconds. Event types enumerated from the `track(...)` call sites: `app_open`, `project_create`, `project_open`, `project_delete`, `account_delete`, `import`, `edit`, `chat_message`, `render_started`, `render_done`, `render_error`, `feedback_open`, `subscribe`, `error`, `console_error`, `api_error`, `api_slow`, `api_offline`. Linked, because the report row records `user_id` whenever the request carries a valid session token.
2. *PostHog*, new: application lifecycle events, enabled explicitly at `apps/mobile/src/lib/posthog.ts:21` (`captureAppLifecycleEvents: true`). That is at minimum "app installed", "app updated", "app opened" and "app backgrounded", each carrying the app version and build.

**Other Usage Data** covers PostHog's **screen views**, which are autocaptured by default — see 2.6, where the default is established from the library's own bundle — and the automatic event properties the SDK attaches (app version, OS version, device type, locale, screen dimensions, timezone offset). Touch events are *not* autocaptured by default and are not declared on that basis.

### 2.6 Autocapture: screens yes, touches no

`AppProviders.tsx:18` mounts `<PostHogProvider client={posthog}>` **without an `autocapture` prop**. Autocapture on React Native covers two different things — screen views, and touch events carrying the accessibility label or text of the element touched — and the omitted prop resolves them differently.

**Settled, from the published `posthog-react-native@4.75.0` bundle** (`dist/PostHogProvider.js`, read from the registry rather than from `node_modules/`, which this worktree's `.ckignore` guard refuses). The two gates are:

```js
var captureTouches = !captureNone && posthog && (captureAll || (autocaptureOptions?.captureTouches));
var captureScreens = !captureNone && posthog && (captureAll || (autocaptureOptions?.captureScreens ?? true));
```

With the prop omitted, `captureAll` and `captureNone` are both false and `autocaptureOptions` is `{}`. So:

| | Default with the prop omitted | Why |
|---|---|---|
| **Screen views** | **Captured** | `captureScreens` falls through to the `?? true` default |
| **Touch events** | **Not captured** | `captureTouches` reads `undefined`, which is falsy, and there is no default |

That is the good outcome: the sensitive half is off. PostHog receives screen names, not the labels of the controls a user pressed — so it is not receiving strings like `subscribe to <product title>` from `apps/mobile/app/paywall.tsx:63`, nor anything derived from project titles or caption text.

Two consequences:

- **For the label:** "Other Usage Data" in 2.5 stands, covering screen views and the SDK's automatic event properties. It is no longer a hedge against an unknown default; it is a description of what is captured.
- **For the code (recommended change, owned by the other session):** set the prop explicitly anyway — `autocapture={{ captureTouches: false, captureScreens: true }}` states today's behaviour outright. The current behaviour is correct but incidental: it depends on a library default that a minor version bump could flip, and nothing in this repo would notice. Writing it down makes it intentional and makes the declaration in 2.5 verifiable against the app's own source rather than against a vendored bundle.

### 2.7 Diagnostics

| Item | Collected | Linked to user | Used for tracking | Purposes |
|---|---|---|---|---|
| **Crash Data** | Yes | Yes | No | App Functionality, Analytics |
| **Performance Data** | Yes | Yes | No | Analytics |
| **Other Diagnostic Data** | Yes | Yes | No | Analytics |

All three are first-party and unchanged by this release. Crash Data: the global error handler posts message, stack and React component stack. Performance Data: request timings (`api_slow` above 2500ms) and session length. Other Diagnostic Data: platform, app version, window and screen size, pixel ratio, time zone; on web additionally user agent, language, network type, CPU cores, device memory, colour scheme and reduced-motion preference, and the route path without the query string.

PostHog is **not** wired to crash reporting — `captureError` in `apps/mobile/src/lib/telemetry.ts:152` does not touch it. If someone later adds PostHog exception capture, nothing in this table changes, but the privacy policy's processor row must then say PostHog receives stack traces.

### 2.8 Still not collected

Do not tick: Location (precise or coarse), Contacts, Health & Fitness, Financial Info, Payment Info, Sensitive Info, Browsing History, Search History, Advertising Data, Emails or Text Messages, Gameplay Content, Credit Info.

**Payment Info specifically stays No.** The app never sees a card. StoreKit takes payment inside Apple's own sheet; RevenueCat receives a receipt, not an instrument. "Purchase History" in 2.3 is the correct item and the only one.

Note on time zone: Apple's Location categories mean latitude and longitude, not time zone, so the device time zone stays under Other Diagnostic Data.

### 2.9 Tracking, and whether ATT is now required

**Verdict: App Tracking Transparency is not required, and every "Used for tracking" answer stays No.** This was checked against the compiled SDK sources in `apps/mobile/ios/Pods`, not assumed.

Apple's definition of tracking is linking data from this app with data from other companies' apps, websites or offline properties **for targeted advertising or advertising measurement**, or sharing it with a data broker. Neither SDK does that here.

Evidence, in the order it should be re-checked if anything changes:

1. **RevenueCat's privacy manifest declares `NSPrivacyTracking` = false** and marks Purchase History `Tracking` false (`apps/mobile/ios/Pods/RevenueCat/Sources/PrivacyInfo.xcprivacy`). Its only accessed-API declaration is UserDefaults.
2. **The IDFA is reachable in RevenueCat's code but is never reached.** `AttributionFetcher.identifierForAdvertisers` (`Pods/RevenueCat/Sources/Attribution/AttributionFetcher.swift:46-58`) has exactly two callers: `SubscriberAttributesManager.swift:221-224`, reached only from `Purchases.attribution.collectDeviceIdentifiers()` (`Pods/RevenueCat/Sources/Purchasing/Purchases/Attribution.swift:97-98`), and `AttributionPoster.swift:57-73`, reached only when the app posts attribution data. A grep across `apps/mobile/src` and `apps/mobile/app` finds **no call to either**. `purchases.ts` calls `configure`, `logIn`, `logOut`, `getCustomerInfo`, `getOfferings`, `purchasePackage`, `restorePurchases` and `addCustomerInfoUpdateListener`, and nothing else.
3. **AdSupport.framework is not linked, so the IDFA would be unavailable even if it were requested.** RevenueCat reaches `ASIdentifierManager` only through `NSClassFromString` on a rot13-mangled name (`Pods/RevenueCat/Sources/Attribution/ASIdManagerProxy.swift:35-48`); with the framework absent the lookup returns nil and the SDK logs `adsupport_not_imported`. Nothing in `app.json` or the Podfile links AdSupport.
4. **Apple Search Ads / AdServices attribution is off by default and not enabled.** `automaticAdServicesAttributionTokenCollection` is initialised to `false` (`Pods/RevenueCat/Sources/Purchasing/Purchases/Attribution.swift:29`) and is only flipped by `enableAdServicesAttributionTokenCollection()` (`:67-68`), which the app never calls.
5. **PostHog cannot read the IDFA at all.** It ships no native module in this project — there is no PostHog entry in `apps/mobile/ios/Podfile.lock` — and the JavaScript SDK has no IDFA API. It is a first-party product-analytics tool reporting to a host we configure (`EXPO_PUBLIC_POSTHOG_HOST`), not an ad network, and we do not join its data with anyone else's.
6. **The app could not show an ATT prompt today even if it wanted to.** There is no `NSUserTrackingUsageDescription` in `apps/mobile/app.json` (`ios.infoPlist` carries only `ITSAppUsesNonExemptEncryption`) and none in the generated `apps/mobile/ios/Editify`. Calling `ATTrackingManager.requestTrackingAuthorization` without that key terminates the app. Do not add the key: an ATT prompt with nothing behind it is itself a rejection under 5.1.2, and it depresses opt-in rates for no gain.

**On the two specific questions asked:**

- *Does PostHog's default autocapture count as tracking?* No. Autocapture governs how much of our own app's usage PostHog records; tracking is about combining that with other companies' data for advertising. Autocapture is a data-minimisation question (see 2.6, where the default turns out to be screen views only), not an ATT trigger.
- *Does the RevenueCat app-user-id count as tracking?* No. It is our own Supabase account id, used to make an entitlement follow an Editify account instead of a device (`purchases.ts:47-59`). It is not an advertising identifier, it is not shared with a data broker, and it is not joined to any other company's data. It **does** make Purchase History and User ID "linked to the user" in 2.2 and 2.3, which is a different question from tracking and is answered Yes there.

**Re-open this verdict if any of these happen:** an ad-network or attribution SDK (AppsFlyer, Adjust, Branch, Meta, TikTok) is added; someone calls `collectDeviceIdentifiers()` or `enableAdServicesAttributionTokenCollection()` to make Apple Search Ads attribution work; or PostHog data is exported into an advertising platform for audience building. Any one of those makes ATT mandatory and flips the tracking answers.

### 2.10 Privacy choices to declare

- **Data is not used for tracking.** Answer No on every item. See 2.9.
- **Account deletion is offered in-app.** Declare it. `DELETE /account` in `server/src/routes/account.ts` erases projects, assets, media on disk, render outputs, diagnostic reports and the Supabase login. Note that it does **not** cancel an App Store subscription — nothing can, except the user in their own account settings — so the deletion copy should not imply otherwise.
- **Privacy Policy URL is mandatory**, and with subscriptions in the binary a **Terms of Use (EULA) URL is effectively mandatory too**. See sections 3 and 7.

### 2.11 Honest gaps to close before you tick the boxes

1. There is no in-app disclosure that a session event log is transmitted automatically, and no way to turn it off. Apple does not require a toggle for first-party diagnostics, but the privacy policy must describe it, and it does (`docs/privacy-policy.md` section 3.3).
2. **There is no in-app disclosure of PostHog at all**, and no opt-out. The policy now names it (`docs/privacy-policy.md` sections 3.3 and 5). An in-app analytics toggle is not required by Apple but would be the cheapest answer to an EU complaint.
3. Crash reports and typed feedback are filed into the GitHub issue tracker. `DavidMendelovits/editify` is private, so nothing a user types becomes a public document.
4. The Gemini style analyser uploads whole video files to Google. `GEMINI_API_KEY` is set on `editify-dm`, so it is live.
5. Media requests carry the session token in the URL query string (`mediaUrl` in `apps/mobile/src/lib/api.ts`). Disclosed in the policy section 10. Worth fixing, not a blocker.
6. **VERIFY: which PostHog region hosts the data.** `EXPO_PUBLIC_POSTHOG_HOST` is a free-form URL and `apps/mobile/.env.example:2` still carries the literal placeholder `https://your-posthog-host`. The privacy policy has to name a controller and a transfer basis, and "PostHog Cloud EU" and "PostHog Cloud US" are different answers. This stays open until the host is chosen. The policy carries the fill token `{{FILL_POSTHOG_ENTITY}}` for it in section 5, and the privacy page will not be served until that token is replaced. Tracked as open question L2 in section 3.
7. **Set the PostHog variables in the production build profile before you file the App Privacy answers, not after.** The declaration is supposed to describe the behaviour of the binary being submitted. Right now `apps/mobile/eas.json` carries neither variable in any profile, so a production build collects nothing through PostHog — and filing section 2 as written would declare collection the shipped binary does not perform. Over-declaring is normally the safe direction, but declaring an SDK that is switched off is a different kind of wrong: it is an inaccurate description of the build, and it invites a reviewer question we cannot answer cleanly. Decide first, then file to match. If PostHog is not going to be configured for 1.0.0, the honest filing drops the PostHog-specific rows (Device ID in 2.2, Other Usage Data in 2.5) and section 5 of the privacy policy loses its PostHog row.

---

## 3. Privacy policy and terms: written, and where to host them

Written and committed:

- `docs/privacy-policy.md`
- `docs/terms-of-service.md`
- `docs/support.md`

Both name Maja Ventures SL as data controller and list the processors actually in use, established by grepping every outbound HTTP call in `server/src`: `api.anthropic.com` (`server/src/agent/providers.ts`), `generativelanguage.googleapis.com` (`server/src/style/analyzers/gemini.ts`), `api.github.com` and `github.com` (`server/src/services/telemetry-service.ts`, `server/src/services/report-media.ts`), the Supabase project at `xvstucurpuwpliowadnh.supabase.co` (auth and JWKS), and Fly.io as the host. `raw.githubusercontent.com` is also called, but only to fetch the Montserrat font file, which carries no user data.

Both files, and the support page, still carry fill tokens: the registered address, the contact email, and the PostHog entity and hosting region. Nothing is published until they are filled, and that is enforced in code rather than remembered: see "The publication gate" below.

### Open questions in the legal documents

These were `VERIFY:` notes written inline in the policy and the terms. They are internal text, the server now refuses to publish a document that still contains one (see the publication gate below), and this file is never served, so they live here instead. Each one says where its answer lands.

| # | Question | Where the answer goes |
|---|---|---|
| L1 | Is Spain the correct forum for Maja Ventures SL? The clause as written says the laws and courts of Spain have exclusive jurisdiction, with the usual carve-out for mandatory consumer law in the user's own country | `docs/terms-of-service.md` section 10, "Governing law". No fill token: the text is already written and only needs confirming or rewriting |
| L2 | Which PostHog entity operates the instance, and which region hosts the data: PostHog Cloud EU, PostHog Cloud US, or an instance we run ourselves? The policy has to name a controller and a transfer basis, and the three answers are not the same answer. Same question as 2.11 item 6 and checklist item 14a, which is where the decision is made | `docs/privacy-policy.md` section 5, the processor table, through the fill token `{{FILL_POSTHOG_ENTITY}}`. Fill it with the legal entity, its country and the region, in the shape the other rows use, for example `PostHog, Inc., USA, PostHog Cloud EU`. Section 3.4 points the reader at that row, so one edit covers both |
| L3 | If the token-in-URL behaviour for media is replaced before launch (checklist item 16, short-lived signed URLs), the paragraph that discloses it has to be rewritten rather than left standing | `docs/privacy-policy.md` section 10, "Security", second paragraph. Only in play if item 16 lands before submission |

### The publication gate

`GET /privacy`, `GET /terms` and `GET /support` answer **503** with a short "Not published yet" page, and serve nothing else, for as long as the rendered document contains a `{{FILL_` token or a `VERIFY:` note. The check runs on the finished HTML inside `renderLegalPage`, the only function that produces it, and it returns a union the route cannot read the HTML out of without handling the refusal (`server/src/services/legal-pages.ts`, `server/src/routes/legal.ts`). No other route is touched, and the server still boots and serves the app normally: a documentation problem should not take the API down.

One command lists everything the gate is still waiting on:

```bash
grep -rn 'VERIFY:\|{{FILL_' docs/privacy-policy.md docs/terms-of-service.md docs/support.md
```

While that prints anything, the three URLs answer 503. When it prints nothing, they serve. The open questions above are tracked separately and are listed by `grep -n 'VERIFY:' docs/app-store-submission.md`; they do not block the gate, because this file is not served.

### Where they are hosted

**Done: the existing Fly server serves all three.** `GET /privacy`, `GET /terms` and `GET /support` render `docs/privacy-policy.md`, `docs/terms-of-service.md` and `docs/support.md` into styled HTML at request time (`server/src/routes/legal.ts`, `server/src/services/legal-pages.ts`), so the served text and the text in this repo cannot drift. The auth hook 401s everything it does not recognise, so the three routes are exempted explicitly through `isLegalRoute` in `server/src/app.ts`, and `server/test/legal.test.ts` holds that open: each page answers 200 as HTML with no credentials while `/projects` still answers 401. The same file covers the publication gate below, using fixture documents so that a document carrying a fill token and one carrying a `VERIFY:` note are both refused, and a clean one is served.

The URLs are `https://editify-dm.fly.dev/privacy`, `/terms` and `/support`. Deploying does not publish them: after a deploy, all three answer **503** with a short "Not published yet" page until the grep above prints nothing. So the order is fill the tokens, run the grep until it is empty, then deploy, then load the three URLs and confirm 200 before pasting them into App Store Connect.

The trade-off taken knowingly: the pages are only up while the Fly machine is (`min_machines_running = 1`, so it does not scale to zero). If Apple's post-launch re-check of the privacy URL ever becomes a worry, a static mirror is the fallback.

### The options that were weighed

| Option | Cost | Effort | Notes |
|---|---|---|---|
| **GitHub Pages from a small public repo** | Free | ~15 minutes | Push the two markdown files plus a one-page support page; enable Pages. URLs look like `https://davidmendelovits.github.io/editify-legal/privacy`. No server change, no DNS, no build step, and Pages renders markdown through Jekyll automatically. |
| Public route on the existing Fly server | Free (machine already running) | ~30 minutes of code | Serve `/privacy`, `/terms` and `/support` as static HTML from Fastify and add them to the `isPublic` predicate in `server/src/auth.ts` so the auth hook lets them through. Keeps one domain, but couples legal pages to app uptime and needs a deploy. |
| Cloudflare Pages | Free | ~20 minutes | Same as GitHub Pages plus a custom domain for free, if Maja Ventures has one. |
| Notion public page | Free | ~5 minutes | Fastest, but the URL is ugly, it is slow to load, and Apple reviewers occasionally flag pages that need JavaScript to render. Avoid. |

**GitHub Pages was the earlier recommendation** and is still the fallback if the Fly route ever proves fragile: free forever, up when the machine is not, no code in this repo. It lost on one point. The pages would have been a second copy of the wording, and a legal document that exists twice eventually says two different things. Serving them from `docs/` keeps one copy and makes an edit to the policy a deploy rather than a copy-paste.

The three URLs, once deployed:

```text
Privacy Policy URL:  https://editify-dm.fly.dev/privacy
Terms of Use (EULA): https://editify-dm.fly.dev/terms
Support URL:         https://editify-dm.fly.dev/support
```

VERIFY: does Maja Ventures own a domain that should front these later? A CNAME now costs one change in App Store Connect instead of two.

Note on the EULA field: if you leave "Terms of Use (EULA)" blank, Apple applies its standard licence agreement, which is acceptable. Supplying `docs/terms-of-service.md` is better because the app has accounts, user content and an AI feature that needs its own disclaimer.

---

## 4. Screenshot plan

### 4.1 Sizes App Store Connect requires

Since April 2025 Apple only requires one iPhone size and one iPad size, and generates the rest.

| Device family | Required size | Pixel dimensions | Count |
|---|---|---|---|
| **iPhone 6.9"** | Required | 1320 x 2868 or 1290 x 2796 portrait (or the transposed landscape) | 1 minimum, upload 6 |
| **iPad 13"** | **Required, because `ios.supportsTablet: true`** | 2064 x 2752 portrait, or 2752 x 2064 landscape | 1 minimum, upload 6 |
| iPhone 6.7" / 6.5" | Optional | | Skip. Apple scales the 6.9" set down. |
| iPad 12.9" | Optional | | Skip. Apple scales the 13" set. |

Maximum is 10 per size. Six is the right number: the first three are what people actually see in the search results carousel.

VERIFY: read the size table in the live Media Manager before exporting. Apple has changed these twice in two years, and the exact accepted pixel dimensions are listed in the upload panel itself.

### 4.2 Orientation

`app.json` sets `orientation: "default"`, so both work. The editor's three-pane layout only appears at 1024px and wider (`apps/mobile/app/project/[id].tsx` switches on `wide`), so:

- iPhone: portrait. The editor stacks preview, timeline, chat, which is the honest phone experience.
- iPad: **landscape**. It is the only place the full preview + timeline + chat dock layout shows, and it is the strongest image in the set.

### 4.3 The six shots, in order, and what story they tell

| # | Screen | What must be visible | The beat |
|---|---|---|---|
| 1 | Editor, mid-edit | Timeline with real filmstrip clips, preview showing a frame with a caption burned over it, chat dock visible | "This is a real editor, not a template filler." Lead with the product. |
| 2 | Chat dock with an agent trace expanded | The user's message, the step feed underneath it (split clip, set speed, close gaps) each with its result | "You describe the edit and watch it happen." This is the differentiator; it must be shot 2. |
| 3 | Cleanup sheet / transcript editing | Transcript words with a silence or filler-word selection, counts of what will be removed | "Cut by words, not by frames." |
| 4 | Preview with captions | Word-level highlight on the active word, clear caption styling | "Captions that look like the ones you already post." |
| 5 | Style packets or Learn my style | The style brief text, or the packet list with the two built-in looks | "It learns how you cut." |
| 6 | Export screen | Resolution options with 4K selected, HDR/SDR choice, a finished render | "It ends with a file you can post." |

Home screen is deliberately not in the set: a list of format cards sells nothing. Sign-in is never a screenshot.

Captions overlaid on screenshots are optional and unlocalised here. If you add them, keep them to four words each and put them at the top so the device chrome does not fight them.

### 4.4 App preview video

Optional and skippable for 1.0.0. If you do one later, shot 2 (describe an edit, watch the trace run, see the timeline change) is the whole video.

---

## 5. App Review notes

Paste this into "Notes" in the App Review Information section. Replace the two placeholders first.

```text
DEMO ACCOUNT
Email:    <<DEMO_EMAIL>>
Password: <<DEMO_PASSWORD>>

This account is pre-confirmed and has one sample project with clips already
imported, so the reviewer can reach the editor without importing anything.

SIGN-IN IS REQUIRED
Editify is a client for a server that stores projects, media and renders. An
account is required for all functionality, because every project and every
uploaded clip is scoped to the signed-in user. Sign-up by email requires an
email confirmation link, so please use the demo account above rather than
creating one. "Continue with Google" also works if you prefer.

ACCOUNT DELETION (guideline 5.1.1(v))
"delete account" is in the header of the home screen, next to "sign out". It
erases the account's projects, imported media files, render outputs and the
login itself in one step, with a confirmation dialog first.

WHERE THE VIDEO LIVES
Editing, transcription and rendering run on our server at
https://editify-dm.fly.dev. When a clip is imported, the original file is
uploaded there. Our App Privacy answers declare video and audio as collected
user content for this reason.

TRYING THE MAIN FEATURES
1. Open the sample project from the home screen. The timeline already has
   clips, so preview playback, dragging, trimming and splitting work
   immediately.
2. To try the assistant, type an instruction in the chat dock on the right,
   for example "trim the silences" or "add captions". Each step it takes is
   listed with its result as it runs. A reply can take 20 to 60 seconds.
3. Transcript features (cut by words, remove silence, captions from speech)
   need a clip that contains speech. The sample project's clips do. If you
   import your own clip, note that transcription and preview generation run in
   the background after the upload; the clip shows a "processing" state for
   up to a minute before those features light up.
4. Export is under "export" in the editor header. A render takes roughly as
   long as the clip, then "download / share master" opens the finished file.

PERMISSIONS
- Photo library: only to let the user pick video clips to import. The app uses
  the system picker and does not request library access unless the OS refuses
  to open the picker without it.
- Microphone: only for the voiceover recorder, reached from the editor. It is
  requested at the moment the user presses record.
- No camera use. No location. No contacts.

ANALYTICS, TRACKING AND PURCHASES
The app contains two third-party SDKs: PostHog, for first-party product
analytics reported to our own PostHog instance, and RevenueCat, which wraps
StoreKit for the subscriptions described below. There is no advertising SDK
and no third-party crash-reporting SDK. No advertising identifier is read by
anything in the app, no ATT prompt is shown, and no data is shared with any
other company for advertising or advertising measurement.

There ARE in-app purchases: two auto-renewing monthly subscriptions. See the
SUBSCRIPTIONS section below.

AI FEATURES
The chat assistant is powered by a large language model API called from our
server. It receives the user's typed instruction, the structure of the
timeline, clip file names and durations, and transcript text. It never
receives the video or audio files themselves. Output is text plus editing
operations that are validated against a fixed schema before being applied; the
model cannot execute anything outside that operation set.

One separate feature, "learn my style", uploads the video files the user picks
to Google's Gemini API so the model can watch them and describe the user's
editing style. The upload is deleted at the end of the run. The style screen
names the analyser in use before the user starts it, and the privacy policy
discloses it.

OVER-THE-AIR UPDATES
The app uses Expo Updates to deliver JavaScript-only bug fixes. Updates never
change the app's purpose, add features outside what is described here, or
introduce native code.
```

VERIFY: create the demo account and pre-seed it with a project containing at least one clip with clear speech. Without that, a reviewer lands on an empty home screen and cannot evaluate the app's main feature.

Confirmed: `ANTHROPIC_API_KEY` is set as a Fly secret on `editify-dm`, so a reviewer gets the real Claude-backed agent, not the deterministic mock director. `GITHUB_TOKEN` and `EDITIFY_TOKEN` are set too.

---

## 6. Pre-submission checklist

Ordered. "David" means it needs a human decision, an account, or a credential. "Automatable" means an agent can do it in this repo.

Already done in App Store Connect (app `6814607865`, version `1.0.0`, both still in `PREPARE_FOR_SUBMISSION`): subtitle, promotional text, description, keywords, primary category, secondary category. Nothing below is affected by that except where noted.

### Blocking: cannot submit without these

| # | Item | Who |
|---|---|---|
| 0 | **Complete the Paid Applications Agreement for Maja Ventures SL** (Account Holder accepts it; banking details; US and EU tax forms; Apple verifies). Nothing with an in-app purchase can be released until this is active, and Apple's verification is days to weeks. **Start this before every other item on this list.** Section 8.1 | David |
| 1 | Fill in the registered address, the privacy contact email and the PostHog entity and region in `docs/privacy-policy.md`, `docs/terms-of-service.md` and `docs/support.md` (6 fill tokens), then deploy. Until `grep -rn 'VERIFY:\|{{FILL_' docs/privacy-policy.md docs/terms-of-service.md docs/support.md` prints nothing, the three pages answer 503 by design. Section 3 | David |
| 2 | ~~Create the public `editify-legal` repo~~ **Done differently.** All three pages are served by the Fly app itself (section 3). Confirm the URLs answer 200 and not 503 once item 1 is deployed | Deploy, then confirm |
| 3 | Create and pre-seed the demo account; put the credentials in the App Review notes | David |
| 4 | ~~Confirm a model API key is set as a Fly secret~~ **Done.** `ANTHROPIC_API_KEY` is set on `editify-dm`; reviewers get the real agent | Done |
| 5 | **Broken today: `SUPABASE_SERVICE_ROLE_KEY` is not set on `editify-dm`.** The deployed secret is misspelled `SUPABASE_SERVICE__ROLE_KEY` (two underscores), so the app reads nothing and "delete account" answers 503, which fails guideline 5.1.1(v). Fix, in this order, then redeploy: `fly secrets set SUPABASE_SERVICE_ROLE_KEY=<value> -a editify-dm` then `fly secrets unset SUPABASE_SERVICE__ROLE_KEY -a editify-dm` | David |
| 6 | Answer the App Privacy questionnaire per section 2. Nothing is entered yet | David |
| 7 | Capture 6 iPhone 6.9" and 6 iPad 13" screenshots per section 4 | David, capture automatable |
| 8 | Upload a 1024x1024 App Store icon with no alpha channel and no rounded corners | David |
| 8a | Answer the age rating questionnaire in the live form (section 1.9). Untouched today | David |
| 8b | Set Support URL, Privacy Policy URL and the EULA field to the three `editify-dm.fly.dev` URLs. All still `null` | Automatable, after item 1 deploys |
| 8c | **Answer `contentRightsDeclaration` on the app record. It is `null`, confirmed against the App Store Connect API for app `6814607865`,** and App Store Connect will not accept a submission without it. The question is whether the app contains, shows or accesses third-party content. Editify ships no third-party content of its own; users import their own footage and nothing is published or shared. The expected answer is that it does **not** use third-party content, but read the live question before answering: it was rewritten in 2025 and now also asks about rights to content the app generates | David |
| 8d | **Create the subscription group and the Creator product** (`editify.creator.monthly`; `editify.studio.monthly` comes later), with localised display name and description, price, the 7-day introductory offer, and a review screenshot. Section 8.3 | David |
| 8e | **Attach the Creator product to the 1.0.0 version submission.** IAP products are reviewed alongside the first build that includes them; a product that is created but not attached does not exist for the reviewer, who then sees an empty paywall. Section 8.4 | David |
| 8f | **Fix the remaining guideline 3.1.2 gaps in the binary** before building: a real gated feature and a truthful free-trial claim. Section 7.1 items 3 and 4. The privacy policy and terms links (item 1) are done | Owner of `apps/mobile/app/paywall.tsx` |
| 8g | **Set up RevenueCat**: entitlement `creator`, one current offering `default` holding only the `creator_monthly` package, and the App Store Connect in-app purchase key uploaded | David |
| 8h | **Add the SDK keys to the production build profile.** `apps/mobile/eas.json` currently carries **none** of the four keys the two SDKs need — all three profiles have only `EXPO_PUBLIC_API_URL` and the two Google client ids. Consequences if this ships as-is: without `EXPO_PUBLIC_REVENUECAT_IOS_KEY`, `billingAvailable` is false (`purchases.ts:22`) and the reviewer's paywall reads "Subscriptions are only available in the Editify app on iOS and Android" with no plans and a dead restore button — an automatic 3.1.2 rejection on a build that also declares in-app purchases. Without `EXPO_PUBLIC_POSTHOG_PROJECT_TOKEN` and `EXPO_PUBLIC_POSTHOG_HOST`, PostHog is never constructed and collects nothing (`posthog.ts:18`). Set them in the `production` profile's `env` block or as EAS environment variables, and do it **before** filing App Privacy (2.11 item 7) and before the production build | David |
| 8i | Create a Sandbox Apple ID and test purchase, restore and upgrade end to end. Section 8.5 | David |
| 8j | **Answer the App Privacy questionnaire including the new rows**: Purchase History (yes, linked) and Device ID (yes, linked), having first settled item 8h so the declaration matches the build. Section 2 | David |
| 9 | Run a production EAS build and submit it to App Store Connect. **TestFlight builds 1 and 2 cannot be used.** Verified against build 2's IPA: no `RevenueCat`/`RCPurchases` strings in the app binary, no `posthog` strings in `main.jsbundle`. `react-native-purchases` is native code that no OTA update can deliver, so a fresh build is mandatory | David (build commands are out of scope for this repo's agents) |

### Should fix before review

| # | Item | Who |
|---|---|---|
| 10 | ~~Resolve the GitHub-issue-tracker visibility question~~ **Done.** The repo is private, so no feedback-sheet warning is needed; the policy now says so | Done |
| 11 | ~~Fix the stale line on the export screen~~ **Done.** The note is now conditional on the API being localhost; a hosted build says rendering runs on the Editify servers (`apps/mobile/app/project/[id]/export.tsx`) | Done |
| 12 | ~~Decide whether the agent provider picker should show `claude-cli` and `codex-cli`~~ **Done.** The picker is gone: the agent always runs on the Anthropic API, so a reviewer never sees a provider choice | Done |
| 13 | ~~Decide whether the "or from the server media folder" section should ship~~ **Done.** The section, and the `GET /assets/importable` call behind it, are now skipped unless the API base URL is localhost | Done |
| 14 | Add privacy policy and terms links to the sign-in screen. **Now upgraded from "nice" to necessary**: the same links are mandatory on the paywall under 3.1.2 (section 7, items 5 and 6), so the URLs have to exist regardless, and putting them on both screens costs nothing | Owner of the mobile app screens |
| 14a | Pin down which PostHog region hosts the data (`EXPO_PUBLIC_POSTHOG_HOST`). The privacy policy has to name the processor and its transfer basis, and PostHog Cloud EU and PostHog Cloud US are different answers. This is blocking, not "should fix", for as long as the privacy page is gated on it: it is fill token `{{FILL_POSTHOG_ENTITY}}` in item 1. Section 2.11 item 6, open question L2 | David |
| 14b | Set `autocapture` explicitly on `PostHogProvider` rather than inheriting the library default. The default was checked and is already the right one (screens captured, touches not), so this is about making it intentional and bump-proof, not about fixing current behaviour. Section 2.6 | Owner of `apps/mobile/src/providers/AppProviders.tsx` |
| 15 | Confirm the Google sign-in flow works in a release (non-dev-client) build. `sign-in.tsx` gates the Google button on not being in Expo Go, which is right, but the release path has not been exercised in this repo's history | David |

### Nice to have

| # | Item | Who |
|---|---|---|
| 16 | Replace token-in-query-string media URLs with short-lived signed URLs, then update `docs/privacy-policy.md` §10 (open question L3 in section 3) | Automatable |
| 17 | Give the user a way to see and clear their diagnostic event log | Automatable |
| 18 | Localise nothing for 1.0.0. English only is the right call; adding a locale multiplies the screenshot work by the number of locales | David |

---

## 7. Guideline 3.1.2 audit of the paywall

Guideline 3.1.2 governs auto-renewing subscriptions and is the single most common cause of a rejection for an app that adds one. Everything it asks for must be visible **in the binary, on the screen where the purchase happens** — a link out to a web page does not satisfy the disclosure requirements, only the two legal links.

The paywall is `apps/mobile/app/paywall.tsx`, reached from the home-screen header button at `apps/mobile/app/index.tsx:83` (it reads `upgrade` on the free tier and the tier name otherwise).

**These are required changes, not changes made by this pack.** `apps/mobile/app/paywall.tsx` and `apps/mobile/src/lib/purchases.ts` are owned by another session and were read only.

| # | 3.1.2 requirement | Status | Evidence / what is missing |
|---|---|---|---|
| 1 | Subscription **title** visible at point of purchase | **Pass** | `paywall.tsx:58` renders `pkg.product.title` straight from the store. Depends on the App Store Connect localisation display name being filled in — see 8.3. |
| 2 | Subscription **duration** visible | **Pass** | `priceLabel` in `purchases.ts:99-106` builds `"<price>/<period>"`, with the period derived from the store's ISO-8601 `subscriptionPeriod` (`periodName`, `:109-114`). Rendered at `paywall.tsx:59`. |
| 3 | **Price per period** visible | **Pass** | Same string. The price is never hardcoded; it is `product.priceString`, so it is correct in every storefront currency. |
| 4 | **Content or services the subscription provides** stated at point of purchase | **FAIL — the most likely rejection** | Two separate problems. (a) The only per-plan description is `pkg.product.description`, and it is rendered conditionally: `{!!pkg.product.description && ...}` at `paywall.tsx:60`. If a store localisation ships without a description, the binary offers a paid plan with no statement of what it buys. (b) More seriously, **nothing in the app is gated** — `docs/subscriptions.md` says so in as many words ("Nothing is gated yet"), and the only consumers of `useTier()` are the paywall itself and the home-screen button label (`index.tsx:34`, `:83`). A reviewer who subscribes and sees no change will reject under 3.1.2 and probably 2.1. |
| 5 | Functional **privacy policy** link in the app | **Pass** | `LegalLinks` (`apps/mobile/src/components/LegalLinks.tsx`) opens `https://editify-dm.fly.dev/privacy` with `Linking.openURL`, and sits in the paywall footer next to the auto-renew paragraph and on the sign-in screen. The URLs come from `apps/mobile/src/lib/legal.ts`, which is also where the App Store Connect values come from. |
| 6 | Functional **terms of use (EULA)** link in the app | **Pass** | Same component, `https://editify-dm.fly.dev/terms`. Both links are on the purchase screen, which is what Apple asks for. |
| 7 | Both links also present in **App Store Connect metadata** | **FAIL** | `privacyPolicyUrl` on the app info localisation and the EULA field are both `null` (section 1.7). With an auto-renewing subscription in the binary, the EULA field stops being the optional convenience described in section 3: either supply `docs/terms-of-service.md` at a public URL or accept Apple's standard EULA, but the privacy policy URL is non-negotiable and neither page is hosted yet. |
| 8 | **Restore purchases** mechanism | **Pass** | `restore()` at `purchases.ts:87-91` calls `Purchases.restorePurchases()`; wired to a visible button at `paywall.tsx:76-78`, with an honest "No subscription found on this account." result at `:28`. It is disabled when `!billingAvailable`, which on a real device is never. |
| 9 | **No non-Apple payment path** for digital content | **Pass** | The only purchase call in the codebase is `Purchases.purchasePackage` (`purchases.ts:81`), which goes through StoreKit via the native RevenueCat 5.90.1 pod. There is no external checkout, no Stripe, no "subscribe on our website" copy, and no outbound link of any kind on the paywall. The web build explicitly throws rather than offering an alternative (`purchases.web.ts:23-25`). |
| 10 | **Auto-renew terms** disclosed | **Pass, with one caveat** | `paywall.tsx:79-82` states that the trial converts unless cancelled at least 24 hours before it ends and that payment is charged to the store account and renews until cancelled there. That is the substance Apple asks for. Caveat: it sits below the restore button at the bottom of a scrolling screen. Apple wants it legible at the point of purchase; consider moving it above the plan cards or repeating it in each card. |
| 11 | Claims in the binary must be true | **FAIL** | `paywall.tsx:43` hardcodes "Every plan starts with a 7-day free trial." Nothing verifies that. The trial is an App Store Connect introductory offer (section 8.3), it applies only to users who have never subscribed in the group, and a returning subscriber will read a promise the store will not honour. `priceLabel` already computes the truthful string per package (`purchases.ts:99-106`, which renders "7 days free, then EUR 12.00/month" only when an intro offer actually exists); the hero should be derived from the packages or dropped. |

### 7.1 The required app changes, shortest form

For whoever owns `apps/mobile/app/paywall.tsx`:

1. ~~Add a **privacy policy link** and a **terms of use (EULA) link** to the paywall~~ **Done.** `LegalLinks` is in the paywall footer next to the auto-renew paragraph and on `sign-in.tsx`, which also closes the 5.1.1 exposure noted in the old checklist item 14. The pages behind them are only live after the next deploy.
2. Make each plan card state **what the plan gives you**, from the app's own copy rather than only from `pkg.product.description`, so an empty store localisation cannot produce a paid plan with no description.
3. Decide and ship **at least one real entitlement difference**, or do not ship subscriptions in 1.0.0. A subscription that unlocks nothing cannot survive review.
4. Derive the **free-trial claim** at `paywall.tsx:43` from the packages instead of hardcoding it, or remove it and let `priceLabel` carry it per plan.
5. Move the **auto-renew disclosure** above the purchase buttons, or repeat it inside each card.
6. Optional but cheap: the purchase button reads "start free trial" for every package (`paywall.tsx:66`), which is the same untrue-for-returning-subscribers claim as item 4. "subscribe" is safe.

Items 1, 3 and 4 are rejection-grade. Items 2, 5 and 6 are the difference between one review round and two.

---

## 8. What subscriptions add to the App Store Connect workflow

None of this existed in the pack before, because the pack assumed a free app. Everything here is new work, and the first item gates all of the others.

### 8.1 The Paid Applications Agreement — the long pole

**Nothing with an in-app purchase can be released until Maja Ventures SL completes the Paid Applications Agreement in App Store Connect, and that is the longest-lead item in this entire submission.** It is not a checkbox. Completing it means:

- An Account Holder (not an Admin, not a developer) accepting the agreement in **Business > Agreements**.
- **Banking details**: a bank account in the company's name, with the country, currency, IBAN/SWIFT and the account holder's legal name matching the Apple Developer entity exactly. A mismatch between "Maja Ventures SL" on the bank account and the developer account name is the usual cause of a multi-week stall.
- **Tax forms**: at minimum the US tax form (W-8BEN-E for a Spanish company), plus Spanish/EU VAT details. Apple's tax questionnaire asks about US business activity and treaty benefits; answering it wrongly is easy to do and slow to correct.
- Apple then verifies the banking information, which takes **days, sometimes weeks**, entirely outside our control.

Practical consequences:

- Start this **first**, before screenshots, before the age-rating form, before anything in section 6. It is the only item whose duration is set by a third party.
- Until the agreement is active, subscription products cannot leave the **Missing Metadata** / **Waiting for Review** limbo, and the app cannot be released even if everything else is perfect.
- If the agreement is going to take longer than the rest of the submission, the honest options are to wait, or to cut the paywall from 1.0.0 and ship subscriptions in 1.1. Cutting is a code change, not a metadata change: `billingAvailable` is false without the RevenueCat keys (`purchases.ts:22`), but the paywall route and the home-screen `upgrade` button would still need removing, or a reviewer will find a dead end.

VERIFY: who is the Account Holder on Apple Developer Team `F9R8TK7W79`, and has the Paid Applications Agreement ever been accepted? Read it in Business > Agreements before assuming either way.

### 8.2 Create the subscription group

Subscriptions live in a group, and the group is what governs upgrade, downgrade and crossgrade behaviour and free-trial eligibility. Editify launches with one plan, Creator; Studio comes later as its alternative, so **both belong in one group** from the start.

- Group name (internal) and **Group Display Name** (user-visible, shown in the user's App Store subscription management): `Editify`.
- Both products in the same group means a Creator subscriber moving to Studio (once it ships) is an **upgrade**, handled by Apple as a prorated switch, and it means the 7-day free trial is available **once per group per Apple ID**, not once per product. That second point is exactly why the hardcoded trial claim in 7/item 11 is wrong.
- Set the **rank** within the group when Studio is added: Studio above Creator, so Apple treats Studio as the upgrade.

### 8.3 Create the two products

Per `docs/subscriptions.md`:

| Plan | Product ID | Duration | Base price (USD) | RevenueCat entitlement | At launch |
|---|---|---|---|---|---|
| Creator | `editify.creator.monthly` | 1 month | 12 | `creator` | yes |
| Studio | `editify.studio.monthly` | 1 month | 29 | `studio` | no, later |

For each product, all of the following are required before it can be submitted:

- **Reference name** (internal) and **Subscription Duration** (1 month).
- **Price**: set the base on the United States storefront at the $12 price point (or the closest one offered) and review the generated table; euro rows include VAT, so they sit above a straight conversion.
- **Localised Display Name and Description** for en-US. These are not decoration: `paywall.tsx:58` and `:60` render them verbatim, so this is where requirement 4 of the 3.1.2 audit is half-satisfied. Write the description as a plain statement of what the plan unlocks.
- **Introductory Offer**: type *Free*, duration *1 week*, all territories, no end date. This is the 7-day trial; it does not exist until it is created here.
- **Review screenshot** (required per product): a screenshot of the paywall as the reviewer will see it. This is separate from the app's own screenshots in section 4.
- **Review notes** per product, if the plan needs explaining.

### 8.4 IAP products are reviewed with the first submission that contains them

A subscription product is not approved on its own schedule. **The first time you submit a build that includes in-app purchases, the products are reviewed alongside the binary**, and both must be attached to the same version submission. Two consequences:

- In the version's **In-App Purchases and Subscriptions** section, explicitly **add both products to the 1.0.0 submission**. Creating them is not the same as submitting them, and a product left unattached simply will not exist for the reviewer — who then sees an empty paywall (`paywall.tsx:52` renders "No plans are available on this account yet.") and rejects the build.
- A rejection of either product is a rejection of the release. The most common product-level rejection is a display name or description that does not match what the app actually delivers, which loops straight back to 7/item 4.

After 1.0.0, product changes are reviewed independently of the binary. Only the first one is coupled.

### 8.5 Sandbox tester accounts

App Review tests purchases in the sandbox, against Apple's own sandbox infrastructure, and never with a real card. Two things to prepare:

- **For our own testing:** create Sandbox Apple IDs in **Users and Access > Sandbox > Testers**, then sign in to them on the device under **Settings > App Store > Sandbox Account**. Do not sign the device's main Apple ID into a sandbox account. `docs/subscriptions.md` already documents the accelerated clock: a 7-day trial renews every 3 minutes in sandbox and the subscription self-cancels after 6 renewals, so a sandbox subscription is gone within about 20 minutes.
- **For the reviewer:** the reviewer uses their own sandbox account and does **not** need credentials from us for the purchase itself. What they do need is the Editify demo account (section 5) to reach the paywall at all, because the app requires sign-in. Say so in the review notes.

Test at minimum, before submitting: purchase Creator, confirm the entitlement arrives; restore on a second install; and confirm the app behaves when `getOfferings` returns nothing. None of this is testable until the RevenueCat key is in the build profile (checklist item 8h) — without it the SDK is never configured and the paywall has nothing to sell.

### 8.6 Review-notes text for the paywall

Append this to the App Review Information notes in section 5.

```text
SUBSCRIPTIONS (guideline 3.1.2)

Editify offers an auto-renewing monthly subscription, Creator, sold
through StoreKit. There is no other way to pay for them and no external
purchase path anywhere in the app.

HOW TO REACH THE PAYWALL
1. Sign in with the demo account above.
2. On the home screen, the button in the header reads "upgrade". Tap it.
3. The paywall lists every plan returned by the store, each with its title,
   its price per month in your storefront's currency, and the free-trial terms.
   Prices are never hardcoded in the app; they come from App Store Connect.

HOW TO TEST A PURCHASE
Use your sandbox Apple ID (Settings > App Store > Sandbox Account). Tap the
button on either plan and complete the StoreKit sheet. The app closes the
paywall and the header button changes from "upgrade" to the name of the plan.

RESTORE
"restore purchases" is at the bottom of the same screen. On an account with no
purchase it reports "No subscription found on this account."

AUTO-RENEW TERMS
The trial length, the price per period, and the auto-renewal and cancellation
terms are all shown on the paywall before the purchase, along with links to our
privacy policy and terms of use.

SUBSCRIPTIONS AND ACCOUNT DELETION
Entitlements follow the Editify account rather than the device, so a purchase
restores on a new phone after signing in. "Delete account" erases the Editify
account and its data; it does not cancel an App Store subscription, which the
user cancels in their own Apple account settings, as the app states.
```

The "along with links to our privacy policy and terms of use" sentence is true from the build that contains `LegalLinks` (7/items 5 and 6). VERIFY before pasting that the build you submit is that one, and that the server has been deployed with the legal routes: a link that 404s is worse than no link.

---

## 9. Verifying the character counts

Counts in section 1 were measured, not estimated. To re-measure after any edit:

```bash
python3 - <<'PY'
import re, pathlib
text = pathlib.Path('docs/app-store-submission.md').read_text()
for i, block in enumerate(re.findall(r'```text\n(.*?)```', text, re.S), 1):
    print(f'block {i}: {len(block.rstrip(chr(10)))} chars')
PY
```

Apple's limits, for reference: app name 30, subtitle 30, promotional text 170, description 4000, keywords 100, what's new 4000, privacy policy URL mandatory, support URL mandatory.
