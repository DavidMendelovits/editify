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

## Reclaim disk from orphaned pre-auth media
- **What:** A one-off script that deletes `user_id IS NULL` projects and non-`sound-*` assets, plus their `assetsRoot/<id>` dirs.
- **Why:** After per-user scoping they're invisible to everyone but still use the Fly volume, which has a hard 500 GB cap.
- **Context:** They were kept on purpose (orphaned, not claimed or deleted) when scoping landed, 2026-09-29. Only the shared token can still reach them.
- **Blocked by:** scoping PR soaking in prod with nobody missing anything.

## Raise the iOS floor to 26 on main after 1.0 is submitted
- **What:** Merge `mobile-capability-lab`'s `expo-build-properties` (`ios.deploymentTarget: "26.0"`) and update the App Store listing to "Requires iOS 26".
- **Why:** The on-device engine is built against iOS 26 only (SpeechAnalyzer, BGContinuedProcessingTask), with no `@available` forks (lab decision 2A).
- **Context:** Held off main on purpose (decision 3A) so the 1.0 binary stays on iOS 15.1. The deployment target change alters the runtime fingerprint, so preview gets a new native build, not an OTA. Plan: `~/.claude/plans/idempotent-beaming-puppy.md`.
- **Blocked by:** 1.0 submitted to App Store review.

## Animated caption styles (CapCut/Mirage parity)
- **What:** Word pop-in, bounce, scale-on-sung and auto emoji as caption styles, drawn by the native CaptionRenderer and by the server's ASS writer.
- **Why:** Short-form creators expect the CapCut/Mirage looks. v1 captions only switch a word's colour when it is sung, so an Editify export reads as static next to theirs.
- **Pros:** Uses the pipeline P2/P3 build anyway: captions are plan data drawn in the compositor, so preview and export animate the same frames.
- **Cons:** Every animation needs a matching ASS form (`\t`, `\fscx`) for the server fallback, or the server has to render those captions as images. The CaptionRenderer's bitmap cache grows with each animation phase.
- **Context:** Start from `captionStyleSchema` (`packages/shared/src/index.ts`) and the render plan's caption entries (`packages/shared/src/render-plan-schema.ts`: `words[].s/e` are already absolute timeline seconds, and `e` is unused in v1). CaptionRenderer caches per caption and animation phase, so the cache key grows from (id, rev, sung-word count, scale) to include the phase. Out of scope in `~/.claude/plans/on-device-export.md`.
- **Depends on:** P2 render plan (`buildRenderPlan`) + P3 CaptionRenderer.
