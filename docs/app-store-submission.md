# Editify: App Store Connect submission pack

Everything needed to fill in App Store Connect for Editify 1.0.0, in the order the forms ask for it. Every claim about the app is traceable to code in this repo; file references are given where it matters. Anything unresolved is marked **VERIFY:** with the exact question.

Build facts this pack assumes (from `apps/mobile/app.json`, `apps/mobile/eas.json`):

- Bundle id `com.editify.app`, version `1.0.0`, build number from EAS (`appVersionSource: remote`)
- `ios.supportsTablet: true`, orientation `default` (portrait and landscape)
- `ITSAppUsesNonExemptEncryption: false` already set, so the export-compliance question is answered by the build
- Apple Team `F9R8TK7W79`, EAS project `901bf170-2dbf-4ff7-ae24-68218ac5d18c`
- Permissions requested: photo library (import clips) and microphone (voiceover). Camera is explicitly disabled.
- OTA JavaScript updates via `expo-updates` against `https://u.expo.dev/901bf170-...`

---

## 0. The one thing that will get this rejected

The App Privacy answers in section 2 must say that **user video and audio content is collected**. Editify uploads the full original file the user picks to `https://editify-dm.fly.dev` (`apps/mobile/src/lib/pick.ts` -> `uploadAsset` in `apps/mobile/src/lib/api.ts` -> `POST /assets` in `server/src/routes/assets.ts`, which streams the part straight to `assetsRoot/<id>/original.<ext>`). Originals do **not** stay on the device. The "devices keep original footage local and upload proxies first" line in `SPEC-WAVE3.md` §D is a stated future direction, not shipped behaviour.

The second thing: the app sends a session event log to the server automatically about once a minute, with no prompt and no opt-out (`apps/mobile/src/lib/telemetry.ts`, `FLUSH_INTERVAL = 60_000`). That is collected usage and diagnostic data and must be disclosed.

---

## 1. Listing copy

### 1.1 App name (limit 30)

```text
Editify: AI Video Editor
```

24 characters. Alternate if you want the name alone: `Editify` (7).

### 1.2 Subtitle (limit 30)

```text
Cut, caption, export by chat
```

28 characters.

### 1.3 Promotional text (limit 170)

Editable without a new build, so keep it for what is new or seasonal.

```text
Import a clip, describe the edit, watch every cut happen on a real timeline. Transcript trimming, word-timed captions, voiceover and 4K export. First release.
```

158 characters.

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

2502 characters. Re-run the counter in section 7 after any edit.

### 1.5 Keywords (limit 100, comma separated, no spaces after commas)

Words already in the app name and subtitle are indexed from there, so they are not repeated here.

```text
subtitles,transcript,reels,shorts,tiktok,timeline,trim,voiceover,silence,4k,vlog,podcast,filler
```

95 characters. Apple counts the commas, and there are no spaces after them.

If you drop the app name to plain `Editify`, replace `filler` with `video,editor` (99 characters), because the field is then carrying the whole category signal on its own.

### 1.6 What's New in this version (1.0.0)

```text
First release.

Editify is a video editor with an assistant that drives the same timeline you do. Import clips, cut by transcript, caption to the word, add sounds, stickers and voiceover, then render up to 4K.

Tell us what breaks: there is a "send feedback" button on the home screen and in the editor.
```

### 1.7 Support URL and Marketing URL

- **Support URL is mandatory.** App Store Connect will not let you submit without one, and it must resolve to a real page with a way to contact you. A GitHub Pages page with a contact email and a short FAQ satisfies this.
- **Marketing URL is optional.** Leave it blank for 1.0.0 rather than pointing it at a placeholder.

**We do not appear to have either today.** There is no marketing site in this repo, and `editify-dm.fly.dev` serves the app itself behind auth, not a public page. See section 3 for the hosting recommendation, which covers the support page, the privacy policy and the terms in one move.

VERIFY: does Maja Ventures already own a domain that should host these? If yes, use it and skip the GitHub Pages route.

### 1.8 Categories

| | Category | Why |
|---|---|---|
| Primary | **Photo & Video** | The app is a video editor. This is where competitors rank and where the buying intent is. |
| Secondary | **Productivity** | Defensible: the product is a tool for producing a deliverable, and the assistant framing reads as productivity. |

Graphics & Design is the other plausible secondary, but it skews toward static design tools and would put Editify next to illustration apps. Productivity is the better second net.

### 1.9 Age rating questionnaire

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
| In-app purchases or ads | **No** | No IAP, no ad SDK anywhere in `apps/mobile/package.json`. |
| Tracking / advertising identifiers | **No** | No IDFA, no ATT prompt, no analytics SDK. |

**Expected rating: 4+.**

Two things to watch:

- **VERIFY:** Apple's current questionnaire has a question about apps whose core feature is a chatbot or generative AI. Editify's assistant is an AI chat interface that returns free text written by Anthropic's model (the provider configured on the production server). Read that question in the live form and answer it honestly; a yes there can push the rating to 12+ or 13+. Do not guess from this table.
- **VERIFY:** if the answer to the UGC question is read more broadly (the app does let a user put arbitrary imported footage and typed caption text on screen), the safe answer is still No, because nothing is published or shared. Confirm against the question's own help text in the form.

---

## 2. App Privacy ("nutrition label")

Determined empirically. Sources for each line are named. No third-party analytics, crash-reporting or advertising SDK exists in this app: `apps/mobile/package.json` contains no Sentry, Amplitude, Mixpanel, PostHog, Firebase, Bugsnag, Crashlytics, Segment or Datadog dependency, and a grep for those names across `apps/mobile` and `server/src` returns nothing. The diagnostics described below are all first-party, to our own server.

**Answer "Yes, we collect data from this app."**
**Answer "No" to tracking on every single item.** There is no ATT prompt and no advertising identifier is read anywhere.

### 2.1 Contact Info

| Item | Collected | Linked to user | Used for tracking | Purposes |
|---|---|---|---|---|
| **Email Address** | Yes | Yes | No | App Functionality |
| **Name** | Yes | Yes | No | App Functionality |

Email: `supabase.auth.signUp` / `signInWithPassword` in `apps/mobile/app/sign-in.tsx`; Google sign-in returns it too. Name: only when the user chooses Google; Google's id token carries profile fields and Supabase stores them on the login record. Editify never reads or displays the name, but it is stored in our own Supabase project, so declare it. Mark it as such and do **not** claim it is optional, because it is unavoidable on the Google path.

VERIFY: confirm in the Supabase dashboard which fields the Google provider actually persists into `auth.users.raw_user_meta_data` for this project (typically `name`, `picture`, `email`). If a picture URL is stored, no extra label item is needed, but the privacy policy should keep mentioning it.

### 2.2 Identifiers

| Item | Collected | Linked to user | Used for tracking | Purposes |
|---|---|---|---|---|
| **User ID** | Yes | Yes | No | App Functionality, Analytics |
| Device ID | **No** | | | |

User ID is the Supabase `sub` claim, verified server-side in `server/src/auth.ts` and written to `projects.user_id`, `assets.user_id` and `reports.user_id`. It is also attached to diagnostic reports (`server/src/routes/telemetry.ts` passes `request.userId` into `TelemetryService.ingest`), which is why Analytics is listed as a second purpose.

Device ID is genuinely not collected. The telemetry `sessionId` is regenerated from `Date.now()` plus randomness on every app launch (`apps/mobile/src/lib/telemetry.ts`) and never persisted, so it is not a device or user identifier.

### 2.3 User Content

| Item | Collected | Linked to user | Used for tracking | Purposes |
|---|---|---|---|---|
| **Photos or Videos** | Yes | Yes | No | App Functionality |
| **Audio Data** | Yes | Yes | No | App Functionality |
| **Customer Support** | Yes | Yes | No | App Functionality, Analytics |
| **Other User Content** | Yes | Yes | No | App Functionality |

- Photos or Videos: full original files, uploaded on import. See section 0. Clips submitted to "learn my style" are additionally uploaded to Google's Gemini API, which is configured and active on the production server (`GEMINI_API_KEY` is set on `editify-dm`). That is third-party processing of user video, so it belongs in the policy (`docs/privacy-policy.md` §2 and §5) even though Apple's label has no separate item for it: the item stays **Photos or Videos, collected, linked, App Functionality**.
- Audio Data: voiceover recordings from the microphone (`apps/mobile/src/components/editor/VoiceSheet.tsx` uploads the recording through the same `uploadAsset`), plus the audio track inside every imported video, plus speech transcripts derived from it by a local Whisper process on the server (`server/src/services/transcript-service.ts`).
- Customer Support: the free-text feedback the user types in the report sheet, sent to `POST /telemetry` and, when a GitHub token is configured, filed as an issue (`server/src/services/telemetry-service.ts`).
- Other User Content: project titles, caption text, sticker and callout text, clip labels, and the chat messages the user sends to the assistant.

### 2.4 Usage Data

| Item | Collected | Linked to user | Used for tracking | Purposes |
|---|---|---|---|---|
| **Product Interaction** | Yes | Yes | No | Analytics, App Functionality |

The event log flushed every 60 seconds. The tracked event types, enumerated from `track(...)` call sites: `app_open`, `project_create`, `project_open`, `project_delete`, `account_delete`, `import`, `edit`, `chat_message`, `render_started`, `render_done`, `render_error`, `feedback_open`, `error`, `console_error`, `api_error`, `api_slow`, `api_offline`. Several carry a detail string (the format chosen, the operation types applied, the endpoint and status code).

Linked: yes, because the report row records `user_id` whenever the request carries a valid session token.

### 2.5 Diagnostics

| Item | Collected | Linked to user | Used for tracking | Purposes |
|---|---|---|---|---|
| **Crash Data** | Yes | Yes | No | App Functionality, Analytics |
| **Performance Data** | Yes | Yes | No | Analytics |
| **Other Diagnostic Data** | Yes | Yes | No | Analytics |

- Crash Data: the global error handler captures uncaught errors and unhandled rejections and posts message, stack and React component stack.
- Performance Data: request timings (`api_slow` fires above 2500ms), session length in seconds.
- Other Diagnostic Data: platform, app version, window and screen size, pixel ratio, time zone. On the web client only, additionally the user agent, language, network type, CPU cores, device memory, colour scheme and reduced-motion preference. The app deliberately sends the route path without the query string.

### 2.6 Not collected

Do not tick: Location (precise or coarse), Contacts, Health & Fitness, Financial Info, Sensitive Info, Browsing History, Search History, Purchases, Advertising Data, Device ID, Emails or Text Messages, Gameplay Content.

Note on time zone: Editify sends the device time zone as a diagnostic field. Apple's Location categories mean latitude and longitude, not time zone, so this stays under Other Diagnostic Data. VERIFY only if legal wants a more conservative read.

### 2.7 Privacy choices to declare

- **Data is not used for tracking.** Answer No everywhere.
- **Account deletion is offered in-app.** Declare it. It is real: `DELETE /account` in `server/src/routes/account.ts` erases projects, assets, media on disk, render outputs, diagnostic reports and the Supabase login itself.
- **Privacy Policy URL is mandatory.** See section 3.

### 2.8 Honest gaps to close before you tick the boxes

1. There is no in-app disclosure that a session event log is transmitted automatically, and no way to turn it off. Apple does not require a toggle for first-party diagnostics, but the privacy policy must describe it, and it does (`docs/privacy-policy.md` §3.3).
2. Crash reports and typed feedback are filed into the GitHub issue tracker. **`DavidMendelovits/editify` is private** (confirmed September 2026), so nothing a user types or attaches becomes a public document. No warning is needed on the feedback sheet, and `docs/privacy-policy.md` §5 now names the repository and says in plain words that reports are not published.
3. The Gemini style analyser uploads whole video files to Google. **`GEMINI_API_KEY` is set on `editify-dm`, so it is live** (confirmed September 2026). The privacy policy row is now written as a statement rather than a conditional, section 2 of the policy says plainly that this is the one path by which footage leaves our own infrastructure, and the App Review notes below say the same.
4. Media requests carry the session token in the URL query string (`mediaUrl` in `apps/mobile/src/lib/api.ts`), and the export screen hands such a URL to Safari. Disclosed in the policy §10. Worth fixing, not a blocker.

---

## 3. Privacy policy and terms: written, and where to host them

Written and committed:

- `docs/privacy-policy.md`
- `docs/terms-of-service.md`

Both name Maja Ventures SL as data controller and list the processors actually in use, established by grepping every outbound HTTP call in `server/src`: `api.anthropic.com` (`server/src/agent/providers.ts`), `api.openai.com` (same file), `generativelanguage.googleapis.com` (`server/src/style/analyzers/gemini.ts`), `api.github.com` and `github.com` (`server/src/services/telemetry-service.ts`, `server/src/services/report-media.ts`), the Supabase project at `xvstucurpuwpliowadnh.supabase.co` (auth and JWKS), and Fly.io as the host. `raw.githubusercontent.com` is also called, but only to fetch the Montserrat font file, which carries no user data.

Both files contain VERIFY markers for the registered address and contact email. Fill those in before publishing.

### Cheapest ways to host them at a public URL

| Option | Cost | Effort | Notes |
|---|---|---|---|
| **GitHub Pages from a small public repo** | Free | ~15 minutes | Push the two markdown files plus a one-page support page; enable Pages. URLs look like `https://davidmendelovits.github.io/editify-legal/privacy`. No server change, no DNS, no build step, and Pages renders markdown through Jekyll automatically. |
| Public route on the existing Fly server | Free (machine already running) | ~30 minutes of code | Serve `/privacy`, `/terms` and `/support` as static HTML from Fastify and add them to the `isPublic` predicate in `server/src/auth.ts` so the auth hook lets them through. Keeps one domain, but couples legal pages to app uptime and needs a deploy. |
| Cloudflare Pages | Free | ~20 minutes | Same as GitHub Pages plus a custom domain for free, if Maja Ventures has one. |
| Notion public page | Free | ~5 minutes | Fastest, but the URL is ugly, it is slow to load, and Apple reviewers occasionally flag pages that need JavaScript to render. Avoid. |

**Recommendation: GitHub Pages from a new public repo `editify-legal`.** It is free forever, it is reachable even when the Fly machine is down (which matters, because Apple re-checks the privacy URL after launch), it needs no code in this repo, and it gives you the mandatory support page in the same move. If Maja Ventures owns a domain, point a CNAME at it later without changing the App Store Connect entry more than once.

Three URLs to produce:

```text
Privacy Policy URL:  https://davidmendelovits.github.io/editify-legal/privacy
Terms of Use (EULA): https://davidmendelovits.github.io/editify-legal/terms
Support URL:         https://davidmendelovits.github.io/editify-legal/support
```

VERIFY: exact account name and repo name once created, then paste the real URLs here.

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

NO TRACKING, NO PURCHASES, NO ADS
There is no advertising SDK, no analytics SDK and no third-party
crash-reporting SDK in the app. No IDFA is read and no ATT prompt is shown.
There are no in-app purchases or subscriptions.

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

### Blocking: cannot submit without these

| # | Item | Who |
|---|---|---|
| 1 | Fill in the registered address and privacy contact email in `docs/privacy-policy.md` and `docs/terms-of-service.md` (marked VERIFY) | David |
| 2 | Create the public `editify-legal` repo, publish privacy / terms / support pages, confirm all three URLs load | David, then automatable |
| 3 | Create and pre-seed the demo account; put the credentials in the App Review notes | David |
| 4 | ~~Confirm a model API key is set as a Fly secret~~ **Done.** `ANTHROPIC_API_KEY` is set on `editify-dm`; reviewers get the real agent | Done |
| 5 | **Broken today: `SUPABASE_SERVICE_ROLE_KEY` is not set on `editify-dm`.** The deployed secret is misspelled `SUPABASE_SERVICE__ROLE_KEY` (two underscores), so the app reads nothing and "delete account" answers 503, which fails guideline 5.1.1(v). Fix, in this order, then redeploy: `fly secrets set SUPABASE_SERVICE_ROLE_KEY=<value> -a editify-dm` then `fly secrets unset SUPABASE_SERVICE__ROLE_KEY -a editify-dm` | David |
| 6 | Answer the App Privacy questionnaire per section 2 | David |
| 7 | Capture 6 iPhone 6.9" and 6 iPad 13" screenshots per section 4 | David, capture automatable |
| 8 | Upload a 1024x1024 App Store icon with no alpha channel and no rounded corners | David |
| 9 | Run a production EAS build and submit it to App Store Connect | David (build commands are out of scope for this repo's agents) |

### Should fix before review

| # | Item | Who |
|---|---|---|
| 10 | ~~Resolve the GitHub-issue-tracker visibility question~~ **Done.** The repo is private, so no feedback-sheet warning is needed; the policy now says so | Done |
| 11 | ~~Fix the stale line on the export screen~~ **Done.** The note is now conditional on the API being localhost; a hosted build says rendering runs on the Editify servers (`apps/mobile/app/project/[id]/export.tsx`) | Done |
| 12 | ~~Decide whether the agent provider picker should show `claude-cli` and `codex-cli`~~ **Done.** The picker now drops a CLI option when the server's own probe reports it unavailable (`GET /agent/provider`), so a reviewer sees only the providers the deployed server can actually run | Done |
| 13 | ~~Decide whether the "or from the server media folder" section should ship~~ **Done.** The section, and the `GET /assets/importable` call behind it, are now skipped unless the API base URL is localhost | Done |
| 14 | Add privacy policy and terms links to the sign-in screen. Not strictly required, but it is the cheapest possible answer to a 5.1.1 rejection | Automatable |
| 15 | Confirm the Google sign-in flow works in a release (non-dev-client) build. `sign-in.tsx` gates the Google button on not being in Expo Go, which is right, but the release path has not been exercised in this repo's history | David |

### Nice to have

| # | Item | Who |
|---|---|---|
| 16 | Replace token-in-query-string media URLs with short-lived signed URLs, then update `docs/privacy-policy.md` §10 | Automatable |
| 17 | Give the user a way to see and clear their diagnostic event log | Automatable |
| 18 | Localise nothing for 1.0.0. English only is the right call; adding a locale multiplies the screenshot work by the number of locales | David |

---

## 7. Verifying the character counts

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
