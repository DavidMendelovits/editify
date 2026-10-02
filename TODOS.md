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

## Pick one HDR delivery policy for both renderers
- **What:** Decide between HLG passthrough and PQ for on-device export, then make server `color.ts` match or label the difference in the export sheet.
- **Why:** iPhones shoot HLG Dolby Vision 8.4. The server's "Keep HDR (BT.2020 PQ)" (`export.tsx:22`, `server/src/media/color.ts`) transcodes to PQ, so the same project would give two different HDR files depending on where it rendered.
- **Context:** Lab spike S4 measures HLG, PQ and SDR outputs (`ffprobe` color tags). Decide with those files in hand.
- **Blocked by:** S4 results.
