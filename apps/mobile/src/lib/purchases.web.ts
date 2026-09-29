import type { PurchasesPackage } from 'react-native-purchases';
import type { Plan, Tier } from './purchases';

/**
 * The browser build has no store to buy from: react-native-purchases needs a
 * native module, and web billing would be a separate Stripe integration. Web
 * stays on the free tier and the paywall says so.
 */
export type { Plan, Tier } from './purchases';

export const billingAvailable = false;

export async function syncPurchaseUser(): Promise<void> {}

export function useTier(): Tier {
  return 'free';
}

/** Never ready: there is no store user to line up with the account. */
export function usePurchasesReady(): boolean {
  return false;
}

export async function getPlans(): Promise<Plan[]> {
  return [];
}

export async function buy(): Promise<Tier> {
  throw new Error('Subscriptions are only available in the Editify app.');
}

export async function restore(): Promise<Tier> {
  return 'free';
}

export function userCancelled(): boolean {
  return false;
}

export function hasFreeTrial(): boolean {
  return false;
}

export function priceLabel(pkg: PurchasesPackage): string {
  return pkg.product.priceString;
}
