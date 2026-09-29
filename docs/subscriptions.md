# Subscriptions

Editify sells auto-renewing monthly subscriptions through RevenueCat. The app
never hardcodes a price: it renders whatever the store returns for the user's
storefront, so the US prices below convert to every other currency.

| Plan    | Base price (USD) | Product ID (iOS + Android) | Entitlement | Package           | Trial  | At launch                  |
| ------- | ---------------- | -------------------------- | ----------- | ----------------- | ------ | -------------------------- |
| Free    | 0                | none                       | none        | none              | none   | always                     |
| Creator | 12 / month       | `editify.creator.monthly`  | `creator`   | `creator_monthly` | 7 days | in the offering            |
| Studio  | 29 / month       | `editify.studio.monthly`   | `studio`    | `studio_monthly`  | 7 days | later, not in the offering |

Creator is the plan to launch with. Studio is documented so the ids are settled,
but it is not created in the offering until it ships. `src/lib/purchases.ts`
already resolves the tier richest-first, so a user holding both entitlements
will read as `studio`.

## Setting it up

The prices, the currency conversions and the trial all live in the stores.
Nothing below is configurable from the codebase.

### 1. App Store Connect

1. Subscriptions > new subscription group `Editify` with `editify.creator.monthly`.
   Studio joins the same group when it ships, ranked above Creator.
2. Set the base price on the **United States** storefront at the $12 price
   point, or the closest one App Store Connect offers, and let Apple derive
   every other storefront from it.
3. Check the generated **euro** rows before accepting. Euro prices include VAT
   and US prices do not, so the derived figure will sit above a straight
   conversion (somewhere around 13 to 14 euros). That is expected; override a
   row only if it lands on an odd-looking price point.
4. On Creator add an **Introductory Offer**: type *Free*, duration *1 week*,
   all territories, no end date. That is the 7-day trial, and only users who
   have never subscribed in the group are eligible for it.
5. Fill the localisation display name and description. The paywall renders
   `product.title` and `product.description` straight from the store.

### 2. Google Play Console

`editify.creator.monthly` as a base plan, priced at $12 in the United States
with automatic conversion, plus a 7-day free-trial offer on it.

### 3. RevenueCat

1. Create the project, add the iOS and Android apps, upload the App Store
   Connect in-app purchase key and the Play service account.
2. Entitlement `creator`, attached to `editify.creator.monthly`. Studio later
   gets entitlement `studio` and package `studio_monthly`.
3. One offering, `default`, made current. At launch it holds only
   `creator_monthly` (a custom identifier, so Studio can join it later without
   two packages fighting over the built-in `$rc_monthly`).
4. Copy the two public SDK keys into `apps/mobile/.env` for local builds:

   ```
   EXPO_PUBLIC_REVENUECAT_IOS_KEY=appl_xxx
   EXPO_PUBLIC_REVENUECAT_ANDROID_KEY=goog_xxx
   ```

   EAS builds read `base.env` in `apps/mobile/eas.json`, which every profile
   `extends` (a profile's own `env` is merged on top of it).

   - `development` carries RevenueCat's Test Store key (`test_…`) in its own
     `env`. Purchases go through RevenueCat's test modal, so no App Store setup
     is needed to exercise the paywall. In RevenueCat's Test Store, create a
     `creator` entitlement and a `creator_monthly` package ($12/month, 1-week
     free trial) in the `default` offering: the sample Monthly/Yearly products
     grant no `creator` entitlement, so buying them would not change the tier.
   - `preview` and `production` need the real `appl_` key once App Store Connect
     is connected, in both `eas.json` and EAS env for the `preview` and
     `production` environments: CI's OTA updates read EAS env, not `eas.json`.
     After a production build, check the IPA's `main.jsbundle` contains `appl_`.
   - Never put a `test_` key in a release profile or in EAS env. A release
     build configured with one shows an alert and crashes on purpose.

Without those keys `billingAvailable` is false, the paywall says subscriptions
are app-only, and every user is on `free`. That is what Expo web and any dev
build without the keys run as.

### 4. Rebuild the native app

`react-native-purchases` is a native module, so an OTA update will not pick it
up:

```bash
npm run prebuild -w @editify/mobile
npm run ios -w @editify/mobile
```

## Testing

Sandbox purchases need a StoreKit sandbox account on the device (Settings >
App Store > Sandbox Account) or a Play licence tester. Trials run on an
accelerated clock in sandbox: a 7-day trial renews every 3 minutes, so a
sandbox subscription cancels itself after 6 renewals.

## Gating a feature

```tsx
const tier = useTier();
if (tier === 'free') return <Button onPress={() => router.push('/paywall')}>upgrade</Button>;
```

Nothing is gated yet. The agreed split is Creator for AI editing tools and custom
templates, Studio for advanced AI features and exclusive templates; wiring that
to actual screens is still to do.

### The tier is a UI hint, not a permission

`useTier()` reads RevenueCat's client SDK, and nothing on the server checks it.
That is fine while nothing is gated, but the snippet above only decides what to
draw. Anyone running a patched build can render the gated screen.

So before the first feature is genuinely paid, the server has to be the one
saying no: verify the caller's entitlement in the route that does the work, and
keep `useTier()` for deciding what the UI offers. RevenueCat exposes both a
webhook and a REST lookup for this, and the choice between them depends on
whether the check can tolerate being eventually consistent. Until that exists,
treat every tier check in the app as cosmetic.

### Trial copy follows eligibility

Apple grants an introductory offer once per subscription group per Apple ID, so
a returning buyer is charged immediately. `getPlans()` asks RevenueCat
(`checkTrialOrIntroductoryPriceEligibility`) per package, and the paywall hero,
the button ("start free trial" or "subscribe") and `priceLabel` all follow it.
An unknown answer counts as not eligible. `priceLabel` also shows a paid intro
("$1.00 for 1 month, then $12.00/month") instead of dropping it.

Buy and restore stay disabled until `syncPurchaseUser` has pointed RevenueCat at
the signed-in account (`usePurchasesReady()`): before that, a purchase would be
credited to the previous user. Session changes run one at a time, and a failed
sync leaves the tier free until the next session event retries it.
