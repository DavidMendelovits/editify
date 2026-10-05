# TODOS

## Server-side entitlement check before the first paid feature
- **What:** In the route that does gated work, look up the caller with RevenueCat REST (`GET /v1/subscribers/{supabase uid}`) behind a 60s in-memory cache, and 402 when the entitlement is missing.
- **Why:** `useTier()` reads the client SDK only, so a patched build can use anything "gated". Until then every tier check is cosmetic.
- **Context:** `docs/subscriptions.md` → "The tier is a UI hint". RevenueCat appUserID is already the Supabase uid (`apps/mobile/src/lib/purchases.ts` `syncPurchaseUser`), so `request.userId` is the lookup key. REST beats the webhook here: it's fresh right after purchase and needs no public endpoint or new table.
- **Blocked by:** deciding what Pro and Studio unlock (product call).

## Delete the RevenueCat customer on account deletion
- **What:** `server/src/services/account-service.ts` calls `DELETE /v1/subscribers/{uid}` with a RevenueCat secret key (new Fly secret).
- **Why:** RevenueCat keeps purchase history keyed by the Supabase uid. That's personal data (GDPR, Apple 5.1.1(v)).
- **Context:** Deletion already removes DB rows, media, and the Supabase login. This is the one remaining store of the user's data.
- **Blocked by:** payments PR landing; a RevenueCat secret key.

## Ship 1.1 from release/1.1 with an iOS 18 floor
- **What:** 1.1 ships from the `release/1.1` branch with an iOS 18 floor: the hexagonal engine, a separate `editify-v11` Fly server, and a rehearsed cutover. Main stays on iOS 15.1 for 1.0.
- **Why:** Replaces the old plan to raise main's floor to iOS 26. iOS 18 keeps far more phones, and a second line keeps the 1.0 binary and server untouched while 1.1 bakes.
- **Context:** Plan: `~/.claude/plans/release-1.1-ios18.md`. Main merges forward into `release/1.1`. At launch, `release/1.1` merges back into main.
- **Blocked by:** 1.0 approved and live.

## Measure RAM tier thresholds on a low-memory iPhone
- **Priority:** P2, before the 1.1 App Store release.
- **What:** Replace the provisional TierPolicy numbers (full >= 6 GB, standard 4-6 GB, low < 4 GB) with measured ones, from an A12 phone (XR 3 GB / XS 4 GB) or from PostHog crash data tagged by tier.
- **Why:** The thresholds are guesses. Too high wastes good phones, too low gets jetsam kills mid-export on iOS 18 devices.
- **Context:** `apps/mobile/e2e/lab-run.mjs --udid <device>` can run the S4 export and preview spikes on a real phone.
- **Blocked by:** an A12 test phone, or enough 1.1 beta crash data.

## Server Whisper fallback for iOS 18
- **Priority:** P3.
- **What:** An audio-only upload transcriber behind the Transcriber chain, used when on-device SFSpeechRecognizer isn't good enough.
- **Why:** iOS 18 has no SpeechAnalyzer, and SFSpeech accuracy on long or noisy audio may not hold up.
- **Context:** Needs a consent step, and the `NSSpeechRecognitionUsageDescription` copy changes, since it currently says transcription happens "on this iPhone".
- **Evidence (T10):** `docs/transcriber-score-1.1.md`. On the stand-up memo SFSpeech scored 51.7% WER vs SpeechAnalyzer's 14.6%, with a start error p95 of 4.4 s, so both promote thresholds trip. The doc recommends promoting this TODO.
- **Blocked by:** the T10 SFSpeech vs SpeechAnalyzer score. Only build it if SFSpeech scores poorly.

## Finish on server for exports iOS stops in the background
- **Priority:** P3, deferred by the founder (2026-10-04: "not sure finishing exports that ios stops is the move, punt for later").
- **What:** Offer "Finish on server" when iOS ends a foreground export after the background grace period (`ExportCenter.expiredMessage`, "iOS stopped the export"), not only when the user backgrounds the app.
- **Context:** Built once in #163 (commit 98a6642) and reverted before merge (ff35a7b). Re-applying it is a reason code on the failed event plus `canFinishOnServer` accepting it.

## Speech pre-prompt says "Nothing is uploaded"
- **Priority:** P2, before any outside tester sees 1.1.
- **What:** The C15 sheet's copy ("Editify writes captions by listening on your iPhone. Nothing is uploaded.") is not true today: the clip is already uploaded and captions still come from server Whisper (option B). Reword it, e.g. "Editify listens on your iPhone to find words in your clips."
- **Context:** `apps/mobile/src/components/SpeechPrompt.tsx`. Flagged by the final 1.1 review.

## Self-healing media
- **Priority:** P3, Server.
- **What:** A missing proxy schedules regeneration instead of returning a 409 (the "not yet" 409 in `server/src/routes/assets.ts`, ~line 626 on release/1.1). A done render whose file is missing goes stale and re-renders (`server/src/routes/renders.ts`, ~line 13).
- **Why:** Today a lost file is a dead end for the user.
- **Context:** Once missing media heals itself, proxies and renders can be pruned to stay under the Fly volume's 500 GB cap.

## Reclaim disk from orphaned pre-auth media
- **What:** A one-off script that deletes `user_id IS NULL` projects and non-`sound-*` assets, plus their `assetsRoot/<id>` dirs.
- **Why:** After per-user scoping they're invisible to everyone but still use the Fly volume, which has a hard 500 GB cap.
- **Context:** They were kept on purpose (orphaned, not claimed or deleted) when scoping landed, 2026-09-29. Only the shared token can still reach them.
- **Blocked by:** scoping PR soaking in prod with nobody missing anything.

## Animated caption styles (CapCut/Mirage parity)
- **What:** Word pop-in, bounce, scale-on-sung and auto emoji as caption styles, drawn by the native CaptionRenderer and by the server's ASS writer.
- **Why:** Short-form creators expect the CapCut/Mirage looks. v1 captions only switch a word's colour when it is sung, so an Editify export reads as static next to theirs.
- **Pros:** Uses the pipeline P2/P3 build anyway: captions are plan data drawn in the compositor, so preview and export animate the same frames.
- **Cons:** Every animation needs a matching ASS form (`\t`, `\fscx`) for the server fallback, or the server has to render those captions as images. The CaptionRenderer's bitmap cache grows with each animation phase.
- **Context:** Start from `captionStyleSchema` (`packages/shared/src/index.ts`) and the render plan's caption entries (`packages/shared/src/render-plan-schema.ts`: `words[].s/e` are already absolute timeline seconds, and `e` is unused in v1). CaptionRenderer caches per caption and animation phase, so the cache key grows from (id, rev, sung-word count, scale) to include the phase. Out of scope in `~/.claude/plans/on-device-export.md`.
- **Depends on:** P2 render plan (`buildRenderPlan`) + P3 CaptionRenderer.

## decodeMono drops leading silence when a clip's audio starts late
- **Priority:** P2, before sync/energy results from 1.1 are trusted on such clips.
- **What:** `Analyzers.decodeMono` (`apps/mobile/modules/editify-engine/ios/Engine/Analyzers.swift`, the `while let (chunk, position) = try chunks.next()` loop) appends each chunk and ignores `position`. When the first audio buffer starts after 0 (an edit list's empty edit, a track that starts 1.5 s in), the samples begin at the first sound, not at the recording's 0, so sync offsets and energy cells shift by the gap. Pad zeros up to `position - startSeconds * rate` before appending (and across any gap), then bump `AnalyzerVersion.decode`, `.sync` and `.energy` in `Core/Analysis.swift` and add a fixture with late-starting audio (the render-golden `asset-edit` spec, `editStart`, already makes one).
- **Why:** `PCMChunks` already reports positions from the recording's start (D19) and words/laughter use them; sync and energy are the parts still off.
- **Context:** Found in the T8 backlog; left out of T8 because the fix touches Core's analyzer versions, which T6/T7 own.
