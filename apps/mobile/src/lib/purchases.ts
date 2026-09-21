import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import Purchases, { type CustomerInfo, type PurchasesPackage } from 'react-native-purchases';

/**
 * Subscriptions. Prices, trials and storefront conversions live in App Store
 * Connect / Play Console and are surfaced through RevenueCat — this file never
 * hardcodes an amount, it renders whatever the store says for the user's
 * region. See docs/subscriptions.md for the products to create.
 */
export type Tier = 'free' | 'pro' | 'studio';

/** RevenueCat entitlement identifiers, richest first: a user can hold both. */
const TIERS: Array<Exclude<Tier, 'free'>> = ['studio', 'pro'];

const apiKey = Platform.select({
  ios: process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY,
  android: process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY,
});

/** False until the keys are set, which is what dev builds and Expo web run as. */
export const billingAvailable = Boolean(apiKey);

export function tierOf(info: CustomerInfo): Tier {
  return TIERS.find((tier) => info.entitlements.active[tier]) ?? 'free';
}

// One observer owns the tier; screens subscribe to its snapshots, the same
// shape the Supabase session uses.
type Listener = (tier: Tier) => void;
const listeners = new Set<Listener>();
let current: Tier = 'free';

function publish(next: Tier): void {
  if (next === current) return;
  current = next;
  listeners.forEach((listener) => listener(next));
}

let configured = false;

/**
 * Called by the root layout on every session change so entitlements follow the
 * Editify account rather than the device: the same purchase restores on a new
 * phone, and signing out drops back to the anonymous RevenueCat user.
 */
export async function syncPurchaseUser(userId: string | undefined): Promise<void> {
  if (!apiKey) return;
  if (!configured) {
    Purchases.configure({ apiKey, ...(userId ? { appUserID: userId } : {}) });
    Purchases.addCustomerInfoUpdateListener((info) => publish(tierOf(info)));
    configured = true;
  } else if (userId) {
    await Purchases.logIn(userId);
  } else {
    // Throws when the current user is already anonymous, which is a no-op here.
    await Purchases.logOut().catch(() => undefined);
  }
  publish(tierOf(await Purchases.getCustomerInfo()));
}

export function useTier(): Tier {
  const [tier, setTier] = useState(current);
  useEffect(() => {
    setTier(current);
    listeners.add(setTier);
    return () => { listeners.delete(setTier); };
  }, []);
  return tier;
}

/** The packages in the current offering, cheapest first. */
export async function getPackages(): Promise<PurchasesPackage[]> {
  if (!apiKey) return [];
  const offerings = await Purchases.getOfferings();
  return [...(offerings.current?.availablePackages ?? [])]
    .sort((a, b) => a.product.price - b.product.price);
}

export async function buy(pkg: PurchasesPackage): Promise<Tier> {
  const { customerInfo } = await Purchases.purchasePackage(pkg);
  const tier = tierOf(customerInfo);
  publish(tier);
  return tier;
}

export async function restore(): Promise<Tier> {
  const tier = tierOf(await Purchases.restorePurchases());
  publish(tier);
  return tier;
}

/** The store's own cancel is not an error worth showing. */
export function userCancelled(error: unknown): boolean {
  return Boolean((error as { userCancelled?: boolean } | null)?.userCancelled);
}

/** "7 days free, then €12.00/month" — every number comes from the store. */
export function priceLabel(pkg: PurchasesPackage): string {
  const { priceString, introPrice, subscriptionPeriod } = pkg.product;
  const recurring = `${priceString}/${periodName(subscriptionPeriod)}`;
  if (!introPrice || introPrice.price > 0) return recurring;
  const units = introPrice.periodNumberOfUnits;
  const unit = introPrice.periodUnit.toLowerCase();
  return `${units} ${unit}${units === 1 ? '' : 's'} free, then ${recurring}`;
}

/** ISO 8601 durations are all the store sends: P1M, P1Y, P1W. */
function periodName(period: string | null): string {
  const unit = period?.slice(-1);
  if (unit === 'Y') return 'year';
  if (unit === 'W') return 'week';
  if (unit === 'D') return 'day';
  return 'month';
}
