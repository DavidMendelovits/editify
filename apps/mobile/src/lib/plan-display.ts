/**
 * What the paywall cards say. Prices always come from the store; the feature
 * rows are ours, keyed by the tier a package grants.
 */
export type PlanTier = 'free' | 'creator' | 'studio';

export const PLAN_FEATURES: Record<PlanTier, string[]> = {
  free: ['Basic editing tools', 'Access to core features'],
  creator: ['AI editing tools', 'Custom templates'],
  studio: ['Advanced AI features', 'Exclusive templates'],
};

/** RevenueCat package identifiers, as set up in docs/subscriptions.md. */
const PACKAGE_TIERS: Record<string, Exclude<PlanTier, 'free'>> = {
  creator_monthly: 'creator',
  studio_monthly: 'studio',
};

export function tierOfPackage(identifier: string): Exclude<PlanTier, 'free'> | undefined {
  return PACKAGE_TIERS[identifier];
}

/** ISO 8601 durations are all the store sends: P1M, P1Y, P1W. */
export function periodName(period: string | null): string {
  const unit = period?.slice(-1);
  if (unit === 'Y') return 'year';
  if (unit === 'W') return 'week';
  if (unit === 'D') return 'day';
  return 'month';
}

/**
 * The store's price, drawn big: "$12.00" reads as "$12", "12,00 €" as "12 €",
 * and anything with real cents ("$11.99") is left alone.
 */
export function bigPrice(priceString: string, subscriptionPeriod: string | null): { amount: string; period: string } {
  return { amount: priceString.replace(/[.,]00(?!\d)/, ''), period: `/ ${periodName(subscriptionPeriod)}` };
}
