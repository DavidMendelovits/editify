import type { PurchasesPackage } from 'react-native-purchases';
import type { Tier } from './purchases';

/**
 * The browser build has no store to buy from: react-native-purchases needs a
 * native module, and web billing would be a separate Stripe integration. Web
 * stays on the free tier and the paywall says so.
 */
export type { Tier } from './purchases';

export const billingAvailable = false;

export async function syncPurchaseUser(): Promise<void> {}

export function useTier(): Tier {
  return 'free';
}

export async function getPackages(): Promise<PurchasesPackage[]> {
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

export function priceLabel(pkg: PurchasesPackage): string {
  return pkg.product.priceString;
}
