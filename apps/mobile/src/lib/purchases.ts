import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import Purchases, { INTRO_ELIGIBILITY_STATUS, type CustomerInfo, type PurchasesPackage } from 'react-native-purchases';

/**
 * Subscriptions. Prices, trials and storefront conversions live in App Store
 * Connect / Play Console and are surfaced through RevenueCat — this file never
 * hardcodes an amount, it renders whatever the store says for the user's
 * region. See docs/subscriptions.md for the products to create.
 */
export type Tier = 'free' | 'creator' | 'studio';

/** A package, and whether this store account can still get its intro offer. */
export interface Plan { pkg: PurchasesPackage; introEligible: boolean }

/** RevenueCat entitlement identifiers, richest first: a user can hold both. Studio is not sold at launch. */
const TIERS: Array<Exclude<Tier, 'free'>> = ['studio', 'creator'];

const apiKey = Platform.select({
  ios: process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY,
  android: process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY,
});

/** False until the keys are set, which is what dev builds and Expo web run as. */
export const billingAvailable = Boolean(apiKey);

export function tierOf(info: CustomerInfo): Tier {
  return TIERS.find((tier) => info.entitlements.active[tier]) ?? 'free';
}

// One observer owns the tier and whether the store user matches the signed-in
// one; screens subscribe to snapshots, the same shape the Supabase session uses.
const listeners = new Set<() => void>();
let current: Tier = 'free';
let ready = false;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function publish(next: Tier): void {
  if (next === current) return;
  current = next;
  listeners.forEach((listener) => listener());
}

function setReady(next: boolean): void {
  if (next === ready) return;
  ready = next;
  listeners.forEach((listener) => listener());
}

export const currentTier = (): Tier => current;
/** True once the store user is the signed-in account; buying or restoring before that would credit the last one. */
export const purchasesReady = (): boolean => ready;

let configured = false;
/** `null` until the first sync, so the first session always counts as a change. */
let requested: string | undefined | null = null;
let chain: Promise<void> = Promise.resolve();

/**
 * Called by the root layout on every session change so entitlements follow the
 * Editify account rather than the device: the same purchase restores on a new
 * phone, and signing out drops back to the anonymous RevenueCat user. Calls run
 * one at a time, in order, and a failure (offline) leaves the tier free and
 * buying disabled rather than rejecting.
 */
export function syncPurchaseUser(userId: string | undefined): Promise<void> {
  if (!apiKey) return Promise.resolve();
  if (userId !== requested) {
    // The last account's tier must not show for a frame under the new one.
    requested = userId;
    setReady(false);
    publish('free');
  }
  chain = chain
    .then(async () => await sync(apiKey, userId))
    .catch((error: unknown) => { console.warn('[purchases] could not sync the store user', error); });
  return chain;
}

async function sync(key: string, userId: string | undefined): Promise<void> {
  if (!configured) {
    Purchases.configure({ apiKey: key, ...(userId ? { appUserID: userId } : {}) });
    Purchases.addCustomerInfoUpdateListener((info) => { if (ready) publish(tierOf(info)); });
    configured = true;
  } else if (userId) {
    await Purchases.logIn(userId);
  } else {
    // Throws when the current user is already anonymous, which is a no-op here.
    await Purchases.logOut().catch(() => undefined);
  }
  const tier = tierOf(await Purchases.getCustomerInfo());
  // A newer session queued behind this one owns the result.
  if (userId !== requested) return;
  publish(tier);
  setReady(true);
}

export function useTier(): Tier {
  return useSyncExternalStore(subscribe, currentTier);
}

export function usePurchasesReady(): boolean {
  return useSyncExternalStore(subscribe, purchasesReady);
}

/**
 * The packages in the current offering, cheapest first, each with its intro
 * eligibility. Apple grants an intro offer once per subscription group per
 * Apple ID, so a returning buyer must not be promised a trial. Unknown counts
 * as not eligible: an unkept promise is worse than a plain price.
 */
export async function getPlans(): Promise<Plan[]> {
  if (!apiKey) return [];
  const offerings = await Purchases.getOfferings();
  const packages = [...(offerings.current?.availablePackages ?? [])]
    .sort((a, b) => a.product.price - b.product.price);
  const eligibility = await Purchases.checkTrialOrIntroductoryPriceEligibility(packages.map((pkg) => pkg.product.identifier))
    .catch((): Partial<Record<string, { status: INTRO_ELIGIBILITY_STATUS }>> => ({}));
  return packages.map((pkg) => ({
    pkg,
    introEligible: eligibility[pkg.product.identifier]?.status === INTRO_ELIGIBILITY_STATUS.INTRO_ELIGIBILITY_STATUS_ELIGIBLE,
  }));
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

/** Whether this plan opens with a free trial the account can still get. */
export function hasFreeTrial({ pkg, introEligible }: Plan): boolean {
  return introEligible && pkg.product.introPrice?.price === 0;
}

/**
 * "1 week free, then €12.00/month", "€1.00 for 1 month, then €12.00/month", or
 * just the price when there is no intro offer or the account already used it.
 * Every number comes from the store.
 */
export function priceLabel(pkg: PurchasesPackage, introEligible: boolean): string {
  const { priceString, introPrice, subscriptionPeriod } = pkg.product;
  const recurring = `${priceString}/${periodName(subscriptionPeriod)}`;
  if (!introPrice || !introEligible) return recurring;
  const unit = introPrice.periodUnit.toLowerCase();
  const span = (count: number) => `${count} ${unit}${count === 1 ? '' : 's'}`;
  if (introPrice.price === 0) return `${span(introPrice.periodNumberOfUnits)} free, then ${recurring}`;
  // Paid up front for one period, or pay-as-you-go per period for `cycles` of them.
  if (introPrice.cycles <= 1) return `${introPrice.priceString} for ${span(introPrice.periodNumberOfUnits)}, then ${recurring}`;
  return `${introPrice.priceString}/${unit} for ${span(introPrice.cycles * introPrice.periodNumberOfUnits)}, then ${recurring}`;
}

/** ISO 8601 durations are all the store sends: P1M, P1Y, P1W. */
function periodName(period: string | null): string {
  const unit = period?.slice(-1);
  if (unit === 'Y') return 'year';
  if (unit === 'W') return 'week';
  if (unit === 'D') return 'day';
  return 'month';
}
