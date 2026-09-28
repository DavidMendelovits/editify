# Subscriptions

Editify sells two auto-renewing monthly subscriptions through RevenueCat. The
app never hardcodes a price: it renders whatever the store returns for the
user's storefront, so the euro prices below convert to every other currency.

| Plan   | Base price (EUR) | Product ID (iOS + Android) | RevenueCat entitlement | Trial  |
| ------ | ---------------- | -------------------------- | ---------------------- | ------ |
| Pro    | 12.00 / month    | `editify.pro.monthly`      | `pro`                  | 7 days |
| Studio | 29.99 / month    | `editify.studio.monthly`   | `studio`               | 7 days |

`src/lib/purchases.ts` resolves the tier richest-first, so a user holding both
entitlements is `studio`.

## Setting it up

The prices, the currency conversions and the trial all live in the stores.
Nothing below is configurable from the codebase.

### 1. App Store Connect

1. Subscriptions > new subscription group `Editify` with both products above.
2. For each product set **EUR** as the base price (12.00 and 29.99). App Store
   Connect generates every other storefront from it.
3. Open the generated price table and check the **United States** row before
   accepting it. Apple's automatic conversion works off the VAT-exclusive
   amount, so the suggested USD price will not be a straight 1:1 of the euro
   figure. Override it to the nearest clean US price point if the generated one
   reads badly (12.99 and 32.99 are the usual parity choices, but take whatever
   Apple currently offers next to its suggestion).
4. On each product add an **Introductory Offer**: type *Free*, duration
   *1 week*, all territories, no end date. That is the 7-day trial, and only
   users who have never subscribed in the group are eligible for it.
5. Fill the localisation display name and description. The paywall renders
   `product.title` and `product.description` straight from the store.

### 2. Google Play Console

Same two product IDs as base plans, price set in EUR with automatic conversion,
plus a 7-day free-trial offer on each base plan.

### 3. RevenueCat

1. Create the project, add the iOS and Android apps, upload the App Store
   Connect in-app purchase key and the Play service account.
2. Entitlements `pro` and `studio`, each attached to its product.
3. One offering, `default`, made current, with two packages. They cannot both
   be the built-in `$rc_monthly`, so use custom identifiers `pro_monthly` and
   `studio_monthly`.
4. Copy the two public SDK keys into `apps/mobile/.env`:

   ```
   EXPO_PUBLIC_REVENUECAT_IOS_KEY=appl_xxx
   EXPO_PUBLIC_REVENUECAT_ANDROID_KEY=goog_xxx
   ```

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

Nothing is gated yet. Deciding what Pro and Studio each unlock is a product
call, not a plumbing one.

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

One more claim to make honest at the same time: the paywall hero and the
subscribe button both hardcode a 7-day free trial. Apple grants an introductory
offer once per subscription group per Apple ID, so a returning buyer is charged
immediately while the screen promises a trial. `priceLabel` in
`apps/mobile/src/lib/purchases.ts` already derives the truthful per-package
string from the store, and it also drops a discounted intro offer today, showing
"12/month" where the first month is 1. Both are deliberately left until the
paywall goes live.
