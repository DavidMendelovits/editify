# Open items after the 1.0 submission (October 2026)

What was left open when Editify 1.0 went to App Review on 30 September 2026
(build 8, submitted with the Creator subscription), and the findings behind the
upload work, which until now only lived in scratch files.

## Release and store

- **CI preview builds fail on the share extension.** Preview builds use ad hoc
  signing, and `com.editify.app.share-extension` has no ad hoc profile yet.
  EAS only creates a new target's first profile interactively, and the `!`
  prompt in Claude Code isn't a TTY, so run this once in a real terminal from
  `apps/mobile`:
  `EXPO_NO_CAPABILITY_SYNC=1 EXPO_ASC_API_KEY_PATH=… EXPO_ASC_KEY_ID=SRUPW83V7R EXPO_ASC_ISSUER_ID=… EXPO_APPLE_TEAM_ID=F9R8TK7W79 EXPO_APPLE_TEAM_TYPE=COMPANY_OR_ORGANIZATION eas build -p ios --profile preview --no-wait`.
  Generate the extension profile, reuse the distribution certificate, and
  include both registered iPhones. Production signing already works
  non-interactively.
- **RevenueCat offering.** The App Store product id is `creator`, not
  `editify.creator.monthly`. The `default` offering's `creator_monthly` package
  has to have the App Store product `creator` attached, and the `creator`
  entitlement too, or the paywall shows "Plans could not load right now".
  This hasn't been confirmed since the submission.
- **The iOS 26 minimum is dropped.** `wip/ios26-deployment-target` parked an
  `expo-build-properties` change setting `ios.deploymentTarget` to 26.0. The
  device-first work is not taking it, so that branch can be deleted.
- **Subscription group display name** reads "Editify Pro Subscriptions". The
  plan is now Creator; rename it to "Editify" before Studio exists.

## Screenshots (uploaded as drafts, replace later)

Twelve were uploaded (6 iPhone 6.9", 6 iPad 13") from the user's stand-up
clips. To fix:

- The style memory screen is nearly empty: no learned style is shown, because
  running the analysis uploads footage to Gemini.
- Captions are small at the default size.
- The footage shows identifiable performers and venue signage. Decide whether
  that's acceptable on a public listing.
- The iOS Live Text button and the iPad window-resize grabber are visible in
  some shots.

## App bugs found while making screenshots

- On iPhone, Send in the agent chat opens the "IMPROVED PROMPT" panel instead
  of sending; you have to tap "send original".
- On iPhone, the home project cards don't fill the width (about 180px gap on the
  right; `app/index.tsx`, projectGrid).
- The project card's clip count includes caption clips ("76 clips" for 7 video
  clips and 69 captions).
- The export screen's "9:16 MASTER" box is an empty placeholder.
- The iPad editor leaves a large empty area under the timeline.
- Proxies are 540p and look soft when cropped to 9:16.

## Privacy and data

- **Account deletion doesn't purge PostHog.** The app calls
  `posthog.identify(accountId)`, so events and crash diagnostics are linked to
  the account. The privacy policy says deletion doesn't yet remove them
  automatically. Add a PostHog person delete to `deleteUserData`.
- **Delete the RevenueCat customer on account deletion** (already in TODOS.md).
- **Server-side entitlement check** before the first paid feature (already in
  TODOS.md). It's also an open product call what Creator gates: the pricing card
  says Free gets "basic editing" and Creator gets "AI editing".

## Big video imports

Measured on an iPhone 15 Pro Max over home Wi-Fi to a local server:

- A 1.38 GB 4K clip took about 5 minutes to upload (about 4.6 MB/s), then
  **another 4 to 5 minutes** of server-side proxy encoding before it was usable.
- At 10 Mbps upstream, 1 to 2.5 GB is 13 to 33 minutes. Six minutes of 4K can be
  as much as 4.5 GB depending on bitrate.

Already shipped (#114): streaming raw-body upload (`POST /assets/raw`), byte
progress, a 2 GB cap with an early `Content-Length` check, and native crash
capture.

**Corrections from the Codex review**: `expo-image-picker` 17.0.11 already
hands back the original (Current plus Passthrough). Re-encoding at pick time
was not the cost. A background URLSession survives suspension, but it isn't a
speed guarantee.

**Risks still open in the upload path:**

- No resume, and every POST mints a new asset id, so a retry after a lost
  response makes a duplicate asset.
- Auth happens once per request. A background upload that starts late can carry
  an expired Supabase JWT.
- Fly's idle timeout and deploys during long uploads are untested.
- Originals, derivatives and SQLite share one 500 GB volume, with no quota or
  free-space admission check.

## Editing while a clip uploads ("local-first")

Findings from reading the code:

- Every server-side AI input reads `asset.originalPath`; nothing server-side
  reads the proxy. So the proxy encode doesn't block the AI. Only the
  import-time transcript waits behind it (`queueAssetWork`).
- A timeline clip can't exist before the server has an asset row: ops are
  server-authoritative, and `applyOperations` rejects asset ids not linked to
  the project.
- With the clip local-only, the transcript tools error, and **remove silence and
  remove words are actively wrong**: a clip with no transcript reads as silent.
- An audio-first upload (a few MB) makes every speech tool work during the
  upload. A small on-device video proxy adds faces and scene detection, but
  brings real correctness risk: analysis caches are keyed only by asset id,
  plus fps, rotation and HDR mismatches, and exports could pick up the stub.

Recommended order:

1. Run transcription (and face tracking) before or alongside the proxy encode.
   About 10 lines; transcripts arrive about 5 minutes sooner.
2. Placeholder asset: `POST /assets` with the picker's metadata creates the row
   with status `uploading`, then the bytes are streamed into that id. The id
   is stable across retries, which also fixes duplicates.
3. Gates: export returns 409 "clips still uploading", `list_assets` exposes
   status, and transcript tools report "still uploading" instead of treating
   the clip as silent.
4. Local preview: play the phone's file for clips that aren't ready yet.
5. Audio first: a native AVAssetExportSession M4A module (needs a new build),
   an `analysis_path` column, and caches tagged with their source.
6. Skip the on-device video proxy. Audio first plus local preview covers most of
   the value.

## Other

- Four demo projects with no owner were left in the payments worktree's local
  `server/data/editify.db`. They go away with the worktree.
