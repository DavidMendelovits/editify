# Thread
Goal: Ship Editify as a real mobile app I can hand to someone
Updated: 2026-09-23

## Where I left off
Editify 1.0.0 is on TestFlight. Builds 1 and 2 are both processed and valid, signed under Maja Ventures SL (Apple team F9R8TK7W79), App Store Connect app 6814607865. The Expo project moved to the `editify` org (901bf170-…); the old dfordavey project id is dead. David and Marta can install now through the internal group; Victoria and marta@folch.org sit in an external group that needs a build to clear Beta App Review first.

1.0.0 will ship WITH RevenueCat subscriptions and PostHog analytics, which reversed the earlier plan and made the paperwork much larger. Neither TestFlight build contains either SDK, so the submission build still has to be made.

State at checkpoint: `dm/funny-hawking-n3ddlv` · 21 commits ahead of main, none pushed · last commit 8b44607

## Next smallest action
Fill the three legal placeholders so the public pages can go live:
`grep -rn 'VERIFY:\|{{FILL_' docs/privacy-policy.md docs/terms-of-service.md docs/support.md`
They are Maja Ventures SL's registered address, a public contact email, and which PostHog entity/region. The `/privacy`, `/terms` and `/support` routes deliberately return 503 until that grep is empty.

## Open loops
- **Paid Applications Agreement** — the long pole. Nothing with in-app purchase can be released until Maja Ventures completes it with banking and tax details. Only David can start it.
- **RevenueCat and PostHog keys are in no EAS build profile.** `billingAvailable` is false without `EXPO_PUBLIC_REVENUECAT_IOS_KEY`, so a submitted build would show a paywall with no plans while declaring IAP — a 3.1.2 rejection by construction. PostHog is likewise inert. Both go in the production profile's `env` in apps/mobile/eas.json.
- **Server not deployed from this branch.** `account.js` is absent from the routes on the running Fly machine, so the account-deletion endpoint Apple requires does not exist in production. The Fly secret itself is now correctly named.
- **Four of six 3.1.2 gaps closed.** Privacy and terms links are in the app now. Still open: nothing is actually gated behind a subscription, and the paywall hardcodes a 7-day trial claim that can be false for a returning Apple ID.
- **App Privacy declaration and age rating** unanswered in App Store Connect. The declaration must wait until the SDK keys are set, so it describes the binary actually submitted. The age rating needs a human to read Apple's live generative-AI question.
- **UI verification unfinished** — editor title row (ac589ed), iPad keyboard path, home-indicator insets, sticker sheet after-state, and an end-to-end run of the ported scripts/screenshots.sh.

## Parked (deliberately not doing)
- Re-adding Sign in with Apple. Email+password is the primary path, so guideline 4.8 is satisfied.
- Public TestFlight link. External testers are invited by email instead.

## Gotchas worth not relearning
- Run `eas` from `apps/mobile`, never the repo root — it fails and leaves a stray root `app.json`.
- `eas submit` ignores `EXPO_ASC_*` env vars; it needs all three `ascApiKey*` values in eas.json. Write them in temporarily and restore the file.
- Apple's API cannot create app records (`POST /v1/apps` is forbidden) or beta review details. Everything else in the listing is settable.
- Internal TestFlight groups only accept App Store Connect team users; external groups take any email but require Beta App Review.
- Verify every build by downloading the IPA and running `strings` over `main.jsbundle`: `editify-dm.fly.dev` present, `localhost:3001` absent.
